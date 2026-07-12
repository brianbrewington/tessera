# Query Rewrite & Context Scoring — Integration Design

> **Status**: Proposed  
> **Audience**: Developers working on memory-agent routes, MCP tools, or downstream consumers (memory-viewer, agent rule recipes).  
> **Prerequisite**: The embedding re-index and edge extraction experiment should be complete before wiring this in, since rewrite quality is sensitive to embedding quality.

---

## 1. Problem

LightRAG stores knowledge as entity descriptions and relationship statements —
declarative text. When a user or agent asks a *question* ("What is the Church in
Kansas pattern?"), the query embedding lands far from the stored description
("The Church in Kansas analogy describes local prominence...") in embedding
space, especially with smaller models like `nomic-embed-text` (768d).

The result: retrieval returns low-relevance context, the LLM synthesizes a poor
answer, and MCP-connected agents get garbage recall.

## 2. Solution — Two Standalone Modules

Two modules already exist in `src/memory_agent/` with full unit tests. They are
**not yet wired into any route or MCP tool**.

### 2.1 `query_rewrite.py`

Transforms queries before they hit `rag.aquery()`. Six strategies:

| Strategy    | What it does                                           | Requires LLM |
|-------------|--------------------------------------------------------|:---:|
| `none`      | Pass-through — no transformation                       | No  |
| `hyde`      | Generate a hypothetical answer, concatenate with query | Yes |
| `statement` | Convert question to declarative statement (regex first, LLM fallback) | Optional |
| `keywords`  | Extract high-level and low-level keywords via LLM      | Yes |
| `expand`    | Generate 3 alternative phrasings                       | Yes |
| `auto`      | Heuristic: questions → `hyde`, short queries → `keywords`, else `none` | Depends |

**Public API**:

```python
from memory_agent.query_rewrite import rewrite_query, RewriteResult

result: RewriteResult = await rewrite_query(
    query="What is the Church in Kansas pattern?",
    strategy="auto",              # or "none", "hyde", etc.
    chat_func=rag._chat_func,     # any async (prompt, system_prompt) -> str
    hyde_max_tokens=200,
)

result.query          # transformed query string
result.hl_keywords    # optional high-level keywords for QueryParam
result.ll_keywords    # optional low-level keywords for QueryParam
result.meta           # dict with strategy name, timing, intermediates
```

**Key design property**: When `chat_func` is `None` and strategy requires LLM,
falls back to `none` with metadata explaining why. No crashes, no new
dependencies.

### 2.2 `context_scorer.py`

Parses LightRAG's raw context string (which embeds JSON blocks for entities,
relationships, and chunks), scores each element against the original query, and
returns ranked results with quality metrics.

**Public API**:

```python
from memory_agent.context_scorer import score_context, scored_context_to_dict

scored: ScoredContext = score_context(
    query="What is the Church in Kansas pattern?",
    context=raw_context_string,
    max_entities=15,
    max_relationships=10,
    max_chunks=5,
)

scored.entities          # list[ParsedEntity] sorted by relevance_score desc
scored.relationships     # list[ParsedRelationship] sorted by relevance_score desc
scored.chunks            # list[ParsedChunk] sorted by relevance_score desc
scored.quality           # ContextQuality with counts and coverage_score

serializable = scored_context_to_dict(scored)  # -> dict ready for JSON response
```

**Key design property**: Pure function, no LLM calls, no async, no side effects.
Works on the raw context string that `rag.aquery(only_need_context=True)`
already returns today.

---

## 3. Integration Layers

Each layer is opt-in. The default behavior (`QUERY_REWRITE_DEFAULT=none`) is
identical to today's code path.

```
┌───────────────────────────────────────────────────────────────┐
│  MCP Tools (mcp_server.py)                                    │
│  default: rewrite="auto"                                      │
│  ┌──────────────────────┐                                     │
│  │ memory_recall        │──── POST /memory/recall ────┐       │
│  │ memory_recall_raw    │──── POST /memory/recall/raw ─┤      │
│  │ memory_recall_graph  │──── POST /memory/recall/graph┤      │
│  └──────────────────────┘                              │      │
└────────────────────────────────────────────────────────┼──────┘
                                                         │
┌────────────────────────────────────────────────────────┼──────┐
│  REST Routes (memory.py, admin.py)                     │      │
│  default: rewrite from config or "none"                │      │
│  ┌─────────────────────────────────────────────────────▼────┐ │
│  │ 1. Resolve strategy: body.rewrite ?? config.default      │ │
│  │ 2. rewrite_query(query, strategy, chat_func)             │ │
│  │ 3. rag.aquery(rewritten_query, param + keywords)         │ │
│  │ 4. score_context(original_query, raw_context)  [raw only]│ │
│  │ 5. Return response + rewrite_meta + context_quality      │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┼──────────────────────────────────────┐
│  Config (config.py)    │                                      │
│  ┌─────────────────────▼────────────────────────────────────┐ │
│  │ QueryRewriteConfig                                       │ │
│  │   default_strategy: str   (env QUERY_REWRITE_DEFAULT)    │ │
│  │   hyde_max_tokens: int    (env QUERY_REWRITE_HYDE_MAX)   │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 3.1 Config Layer

`QueryRewriteConfig` is already defined in `config.py` (lines 82-84) but is not
a field on `Config` and not instantiated in `load_config()`.

**Changes required**:

1. Add field to `Config` dataclass:
   ```python
   @dataclass(frozen=True)
   class Config:
       # ... existing fields ...
       chunking: ChunkingConfig
       query_rewrite: QueryRewriteConfig    # <-- new
       storage_root: str
       # ...
   ```

2. Instantiate in `load_config()`:
   ```python
   query_rewrite=QueryRewriteConfig(
       default_strategy=os.environ.get("QUERY_REWRITE_DEFAULT", "none"),
       hyde_max_tokens=int(os.environ.get("QUERY_REWRITE_HYDE_MAX_TOKENS", "200")),
   ),
   ```

3. Update `mock_config` fixture in `tests/conftest.py` (which already imports
   `QueryRewriteConfig` but doesn't pass it):
   ```python
   # In mock_config fixture, add to Config() call:
   query_rewrite=QueryRewriteConfig(
       default_strategy="none",
       hyde_max_tokens=200,
   ),
   ```

**Default**: `"none"` — no rewriting. Existing behavior preserved.

### 3.2 Route Layer

Both `memory.py` and `admin.py` already import `rewrite_query` but never call
it. `context_scorer` is not imported at all.

#### 3.2.1 Request Model Changes

Add an optional `rewrite` field to the recall request models:

```python
# memory.py
class RecallRequest(BaseModel):
    query: str
    mode: str = "hybrid"
    top_k: int = 20
    rewrite: str | None = None      # <-- new, optional

class RecallRawRequest(BaseModel):
    query: str
    mode: str = "hybrid"
    top_k: int = 20
    rewrite: str | None = None      # <-- new, optional

# admin.py
class AdminQueryRequest(BaseModel):
    query: str
    mode: str = "hybrid"
    raw: bool = False
    rewrite: str | None = None      # <-- new, optional
```

When `rewrite` is `None`, the handler reads `config.query_rewrite.default_strategy`.
When the config default is `"none"`, this is a no-op pass-through.

#### 3.2.2 Handler Changes — `/memory/recall`

```python
@router.post("/recall")
async def recall(body: RecallRequest, request: Request, agent = ...):
    ws_mgr = request.app.state.workspace_manager
    cfg = request.app.state.config
    rag = await ws_mgr.get_rag(agent.workspace)

    # --- NEW: resolve and apply rewrite ---
    strategy = body.rewrite or cfg.query_rewrite.default_strategy
    chat_func = getattr(rag, "_chat_func", None)
    rw = await rewrite_query(
        body.query,
        strategy=strategy,
        chat_func=chat_func,
        hyde_max_tokens=cfg.query_rewrite.hyde_max_tokens,
    )

    param = QueryParam(mode=body.mode, top_k=body.top_k, max_total_tokens=12000)
    if rw.hl_keywords:
        param.hl_keywords = rw.hl_keywords
    if rw.ll_keywords:
        param.ll_keywords = rw.ll_keywords

    answer = await rag.aquery(rw.query, param=param)

    return {
        "answer": answer,
        "sources": [],
        "rewrite_meta": rw.meta,       # <-- new, additive
    }
```

#### 3.2.3 Handler Changes — `/memory/recall/raw`

Same rewrite preamble, plus scoring:

```python
from memory_agent.context_scorer import score_context, scored_context_to_dict

@router.post("/recall/raw")
async def recall_raw(body: RecallRawRequest, request: Request, agent = ...):
    # ... rewrite preamble same as recall ...

    param = QueryParam(
        mode=body.mode,
        only_need_context=True,
        top_k=body.top_k,
        chunk_top_k=min(body.top_k, 5),
        max_total_tokens=8000,
        max_entity_tokens=2000,
        max_relation_tokens=2000,
    )
    if rw.hl_keywords:
        param.hl_keywords = rw.hl_keywords
    if rw.ll_keywords:
        param.ll_keywords = rw.ll_keywords

    context = await rag.aquery(rw.query, param=param)

    # --- NEW: score context ---
    scored = score_context(body.query, context if isinstance(context, str) else "")
    scored_dict = scored_context_to_dict(scored)

    return {
        "context": context,
        "entities": scored_dict["entities"],
        "relationships": scored_dict["relationships"],
        "chunks": scored_dict["chunks"],
        "context_quality": scored_dict["context_quality"],
        "rewrite_meta": rw.meta,
    }
```

#### 3.2.4 Handler Changes — `/admin/graphs/{agent_id}/query`

Mirror the same pattern for the admin query endpoint. When `body.raw` is true,
apply scoring. Always include `rewrite_meta`.

#### 3.2.5 Backward Compatibility

All new response fields are **additive**. Existing consumers that destructure
only `answer` or `context` will not break:

- `rewrite_meta` — new key, ignored by old consumers
- `context_quality` — new key, ignored by old consumers
- `entities` / `relationships` — already present in the response (currently `[]`),
  now populated with scored data when available
- `chunks` — new key, ignored by old consumers

When `strategy="none"`, the rewrite is a pass-through and `rewrite_meta` is
`{"strategy": "none"}`. The scoring still runs on raw endpoints (it adds
`relevance_score` to each element), which is useful even without rewriting.

### 3.3 MCP Tool Layer

The MCP server (`mcp_server.py`) is a thin HTTP proxy — it calls the REST API.
Three changes:

#### 3.3.1 Add `rewrite` Parameter

```python
@mcp.tool()
async def memory_recall(query: str, mode: str = "hybrid", rewrite: str = "auto") -> str:
    """Query memories with LLM synthesis. ..."""
    async with _client() as client:
        resp = await client.post(
            "/memory/recall",
            json={"query": query, "mode": mode, "rewrite": rewrite},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["answer"]


@mcp.tool()
async def memory_recall_raw(
    query: str, mode: str = "hybrid", top_k: int = 10, rewrite: str = "auto",
) -> str:
    """Query memories without LLM synthesis. ..."""
    async with _client() as client:
        resp = await client.post(
            "/memory/recall/raw",
            json={"query": query, "mode": mode, "top_k": top_k, "rewrite": rewrite},
        )
        resp.raise_for_status()
        data = resp.json()
        # ... format response (see 3.3.2) ...
```

**Default is `"auto"`** for MCP tools. Rationale: agents calling memory via MCP
benefit most from automatic rewriting — they don't have a UI to pick strategies.
The REST API defaults to `"none"` (from config) so explicit API consumers
opt in intentionally.

An agent can still pass `rewrite="none"` to bypass rewriting for a specific
call.

#### 3.3.2 Fix Response Formatting

The current `memory_recall_raw` formats entities using `e['name']`, but the
scored response uses `e['entity']`. The formatter must handle both shapes for
backward compatibility (in case the route changes haven't been deployed yet):

```python
# In memory_recall_raw response formatting:
if data.get("entities"):
    ent_lines = []
    for e in data["entities"]:
        name = e.get("entity", e.get("name", ""))
        etype = e.get("type", "")
        desc = e.get("description", "")
        score = e.get("relevance_score")
        score_str = f" [score: {score:.2f}]" if score is not None else ""
        ent_lines.append(f"  - {name} ({etype}){score_str}: {desc}")
    parts.append(f"Entities:\n" + "\n".join(ent_lines))

if data.get("context_quality"):
    cq = data["context_quality"]
    parts.append(
        f"Quality: {cq['relevant_entities']}/{cq['total_entities']} entities relevant, "
        f"coverage {cq['coverage_score']:.1%}"
    )
```

#### 3.3.3 `memory_recall_graph`

The deep query endpoint (`/memory/recall/graph`) doesn't go through LightRAG's
`aquery` — it reads the NetworkX graph directly. Rewriting is less beneficial
here, but the `rewrite` parameter should still be accepted and forwarded for
consistency. The deep_query module can optionally use the rewritten query for
its keyword matching in future.

---

## 4. Response Contract Changes

### 4.1 `/memory/recall` — `RecallResponse`

```jsonc
{
  "answer": "The Church in Kansas pattern describes...",
  "sources": [],
  "rewrite_meta": {                    // NEW — always present when rewrite is wired
    "strategy": "hyde",
    "original_query": "What is the Church in Kansas pattern?",
    "hypothetical_doc": "The Church in Kansas analogy describes...",
    "generation_ms": 342.1
  }
}
```

### 4.2 `/memory/recall/raw` — `RecallRawResponse`

```jsonc
{
  "context": "-----Entities-----\n...",   // existing: raw LightRAG context string
  "entities": [                            // CHANGED: was always [], now populated
    {
      "entity": "CHURCH IN KANSAS ANALOGY",
      "type": "Concept",
      "description": "The Church in Kansas analogy describes...",
      "relevance_score": 4.5
    }
  ],
  "relationships": [                       // CHANGED: was always [], now populated
    {
      "source": "CHURCH IN KANSAS ANALOGY",
      "target": "LOCAL PROMINENCE",
      "description": "Illustrates the concept of...",
      "relevance_score": 3.0
    }
  ],
  "chunks": [                              // NEW
    {
      "id": "chunk_abc123",
      "content": "In our third session, we discussed...",
      "relevance_score": 2.5
    }
  ],
  "context_quality": {                     // NEW
    "total_entities": 47,
    "total_relationships": 31,
    "total_chunks": 8,
    "relevant_entities": 12,
    "relevant_relationships": 7,
    "relevant_chunks": 4,
    "coverage_score": 0.267
  },
  "rewrite_meta": {                        // NEW
    "strategy": "hyde",
    "original_query": "What is the Church in Kansas pattern?",
    "hypothetical_doc": "...",
    "generation_ms": 342.1
  }
}
```

### 4.3 MCP Tool Output — `memory_recall_raw`

Plain text, structured for agent consumption:

```
Context:
[raw context string, truncated to MAX_RESPONSE_CHARS]

Entities:
  - CHURCH IN KANSAS ANALOGY (Concept) [score: 4.50]: The Church in Kansas...
  - LOCAL PROMINENCE (Concept) [score: 3.00]: A concept describing...

Relationships:
  - CHURCH IN KANSAS ANALOGY -> LOCAL PROMINENCE [score: 3.00]: Illustrates...

Quality: 12/47 entities relevant, coverage 26.7%
```

---

## 5. Test Specifications

All tests follow existing patterns: `pytest`, `pytest-asyncio`, `httpx_mock` for
MCP tools, `TestClient` with mocked app state for routes.

### 5.1 Config Tests — `tests/test_config.py`

| Test ID | Description |
|---------|-------------|
| `test_query_rewrite_config_defaults` | `load_config()` without env vars yields `default_strategy="none"`, `hyde_max_tokens=200` |
| `test_query_rewrite_config_from_env` | Set `QUERY_REWRITE_DEFAULT=hyde` and `QUERY_REWRITE_HYDE_MAX_TOKENS=300`, verify they load |
| `test_query_rewrite_config_in_mock` | Verify `mock_config` fixture includes `query_rewrite` field |

### 5.2 Route Tests — `tests/test_routes_memory.py`

| Test ID | Description |
|---------|-------------|
| `test_recall_without_rewrite` | POST `/memory/recall` without `rewrite` field — verify response has `rewrite_meta` with `strategy: "none"`, answer unchanged |
| `test_recall_with_rewrite_hyde` | POST `/memory/recall` with `"rewrite": "hyde"` — verify `rewrite_meta.strategy` is `"hyde"` and `rewrite_meta.hypothetical_doc` is present |
| `test_recall_raw_returns_scored_entities` | POST `/memory/recall/raw` — verify `entities` is a list of objects with `entity`, `type`, `description`, `relevance_score` keys |
| `test_recall_raw_returns_context_quality` | POST `/memory/recall/raw` — verify `context_quality` is present with expected keys |
| `test_recall_raw_returns_rewrite_meta` | POST `/memory/recall/raw` with `"rewrite": "keywords"` — verify `rewrite_meta.strategy` is `"keywords"` |
| `test_recall_rewrite_none_is_passthrough` | POST `/memory/recall` with `"rewrite": "none"` — verify the exact query string reaches `rag.aquery` (assert on mock) |

### 5.3 Route Tests — `tests/test_routes_admin.py`

| Test ID | Description |
|---------|-------------|
| `test_admin_query_with_rewrite` | POST admin query with `"rewrite": "hyde"` — verify `rewrite_meta` in response |
| `test_admin_query_raw_with_scoring` | POST admin query with `raw=true` — verify scored `entities` and `context_quality` in response |
| `test_admin_query_default_no_rewrite` | POST admin query without `rewrite` — verify strategy resolves to config default (`"none"`) |

### 5.4 MCP Tool Tests — `tests/test_mcp_tools.py`

| Test ID | Description |
|---------|-------------|
| `test_recall_forwards_rewrite_param` | Call `memory_recall("query", rewrite="hyde")` — verify HTTP body contains `"rewrite": "hyde"` |
| `test_recall_default_rewrite_is_auto` | Call `memory_recall("query")` — verify HTTP body contains `"rewrite": "auto"` |
| `test_recall_raw_formats_scored_entities` | Mock response with scored entities (`entity` key, `relevance_score`) — verify formatted output contains entity name and score |
| `test_recall_raw_formats_context_quality` | Mock response with `context_quality` — verify "Quality:" line in output with coverage percentage |
| `test_recall_raw_handles_legacy_response` | Mock response with old-format entities (`name` key, no `relevance_score`) — verify formatting doesn't crash, falls back gracefully |
| `test_recall_raw_forwards_rewrite_param` | Call `memory_recall_raw("query", rewrite="none")` — verify HTTP body contains `"rewrite": "none"` |

### 5.5 Integration Smoke Test — `tests/test_rewrite_integration.py`

A single test that chains the modules end-to-end with a mock RAG:

| Test ID | Description |
|---------|-------------|
| `test_rewrite_then_score_pipeline` | 1) Call `rewrite_query("What is X?", strategy="statement")` → get rewritten query. 2) Construct a fake context string with JSON blocks. 3) Call `score_context(original_query, fake_context)`. 4) Verify entities are sorted by score, quality metrics are sane, and the rewrite metadata captures the original query. No network calls, no LLM — tests module composition only. |

### 5.6 Test Fixtures

The `mock_rag` fixture in `conftest.py` already has `_chat_func = AsyncMock()`.
For rewrite tests that exercise the LLM path, configure the mock:

```python
mock_rag._chat_func.return_value = "A hypothetical answer about the topic."
```

For scoring tests, set `mock_rag.aquery` to return a realistic context string
with embedded JSON blocks (can be copied from a real LightRAG response or
constructed):

```python
mock_rag.aquery.return_value = (
    "-----Entities-----\n"
    "```json\n"
    '{"entity": "FOO", "type": "Concept", "description": "Foo is..."}\n'
    "```\n"
    "-----Relationships-----\n"
    "```json\n"
    '{"entity1": "FOO", "entity2": "BAR", "description": "Foo relates to Bar"}\n'
    "```\n"
)
```

---

## 6. Toggle / Kill-Switch

### Global disable

```bash
# .env or environment
QUERY_REWRITE_DEFAULT=none
```

When the default is `"none"` and no request body specifies `rewrite`:
- `rewrite_query()` returns the original query unchanged
- `score_context()` still runs on raw endpoints (scoring is always useful)
- `rewrite_meta` will be `{"strategy": "none"}`
- No LLM calls are made for rewriting

### Per-request override

Any request can set `"rewrite": "none"` to bypass rewriting regardless of the
global default:

```json
{"query": "What is X?", "mode": "hybrid", "rewrite": "none"}
```

### MCP agent override

Agents can pass `rewrite="none"` to any MCP tool to bypass:

```
memory_recall(query="What is X?", rewrite="none")
```

### No new dependencies

Both modules use only:
- Python stdlib (`re`, `json`, `time`, `logging`, `dataclasses`)
- The existing `chat_func` async callable pattern already on every RAG instance

No new pip packages, no new services, no new ports.

---

## 7. Migration Path

1. **Phase 0 (now)**: Embedding re-index with improved model/extraction runs.
   Do not wire rewrite yet — changing both variables simultaneously makes it
   impossible to attribute improvement.

2. **Phase 1**: Wire config layer + route layer with `QUERY_REWRITE_DEFAULT=none`.
   Deploy. Run retrieval benchmark (`docs/retrieval-benchmark.md`) as baseline.

3. **Phase 2**: Set `QUERY_REWRITE_DEFAULT=auto` (or `hyde`). Re-run benchmark.
   Compare retrieval quality metrics.

4. **Phase 3**: Wire MCP tools with `rewrite="auto"` default. Agent rule recipes
   automatically benefit.

5. **Phase 4**: Tune — adjust `hyde_max_tokens`, try different strategies per
   query type, consider adding strategy auto-detection based on workspace
   characteristics (narrative-heavy vs structured data).
