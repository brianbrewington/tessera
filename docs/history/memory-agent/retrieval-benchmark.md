# Retrieval Quality Benchmark

A methodology for measuring and optimizing retrieval quality across LightRAG's
query modes in the memory-agent system.

---

## 1. Goals & Hypothesis

The memory-agent wraps LightRAG and exposes recall endpoints. Response *sizes*
have been fixed, but retrieval **quality** — whether the right entities and
chunks surface for a given query — is untested.

**Goals**:

1. Measure baseline retrieval quality across LightRAG's 5 query modes
2. Compare embedding-driven retrieval (`VECTOR` chunk pick, naive/mix modes) vs
   graph-structure retrieval (`WEIGHT` chunk pick, local/global modes)
3. Find optimal parameters (`top_k`, `chunk_top_k`, `cosine_threshold`) for the
   recall endpoints
4. Quantify how chunk granularity (token size at ingest) affects retrieval

**Hypothesis**: For our conversational, narrative-heavy teaching logs, embedding
similarity should dominate over graph-degree scoring. Mix mode (embeddings +
graph) should outperform pure graph modes. The `VECTOR` chunk pick method should
beat `WEIGHT` because our data is more narrative than structured.

---

## 2. Test Set — 18 Queries in 4 Categories

Ground truth lives in [`tests/benchmark/golden_set.json`](../tests/benchmark/golden_set.json).
All queries are drawn from actual prof-mercer data (teaching sessions with
Brian, Sophia, Kirk, etc.).

### A. Factual Recall (5 queries)

These test direct entity and fact retrieval:

| ID | Query | Key Expected Entities | Rationale |
|----|-------|-----------------------|-----------|
| factual-01 | What is the bedroom door analogy? | bedroom door analogy, defense in depth | Auth teaching session — layered security metaphor |
| factual-02 | Who is Brian Brewington? | Brian Brewington, Prof Mercer | Person entity + associated teaching contexts |
| factual-03 | What embedding model does the system use? | nomic-embed-text, 768 | Technical config — model name and dimensions |
| factual-04 | What entity types does extraction define? | Person, Concept, Lesson, Wisdom | Extraction prompt / config listing |
| factual-05 | What is the dead-drop protocol? | dead-drop, file-based, cross-terminal | File-based coordination and cross-terminal memory |

### B. Relational (5 queries)

These test whether retrieval can surface *connections* between entities:

| ID | Query | Key Expected Entities | Rationale |
|----|-------|-----------------------|-----------|
| relational-01 | How does Prof Mercer relate to Sophia? | Prof Mercer, Sophia, seeds, soil | Seeds/soil metaphor — pedagogy vs wisdom |
| relational-02 | What teaching methods does Mercer use for auth topics? | Prof Mercer, authentication, entangled identity | Side-by-side code comparison, entangled identity problem |
| relational-03 | What connects Lean Startup and memory system design? | Lean Startup, painted door | Painted door experiment connection |
| relational-04 | How do Kirk and Brian relate in architecture decisions? | Kirk, Brian, gRPC, HTTP | gRPC vs HTTP discussion, BB-064 reference |
| relational-05 | What tools does the MCP server expose? | MCP, memory_recall, memory_stash | MCP server tool listing |

### C. Temporal/Narrative (4 queries)

These test whether retrieval handles time-anchored and sequential data:

| ID | Query | Key Expected Entities | Rationale |
|----|-------|-----------------------|-----------|
| temporal-01 | What happened in the February 6 teaching session? | February 6, seeds, soil | Date-anchored session retrieval |
| temporal-02 | How did the memory system design evolve? | memory system, Lean Startup, feature gate | Evolution arc across sessions |
| temporal-03 | What was taught about gRPC vs HTTP and when? | gRPC, HTTP, protocol | Feb 8 session protocol tradeoffs |
| temporal-04 | What corrections did Brian make during sessions? | Brian, 1408, correction | 1408-dim correction, edge pair vs node pair |

### D. Exploratory (4 queries)

These test open-ended queries that should surface multiple related concepts:

| ID | Query | Key Expected Entities | Rationale |
|----|-------|-----------------------|-----------|
| exploratory-01 | What analogies has Mercer used and which stuck? | bedroom door, seeds, soil, fossils | Multiple analogies across sessions |
| exploratory-02 | Key lessons about building memory systems for AI agents? | three-tier, watcher, context | Architecture patterns and lessons |
| exploratory-03 | What went wrong or was surprising? | llama3.2, feature gate, qwen | Unexpected outcomes during development |
| exploratory-04 | What pedagogical principles guide Mercer's teaching? | Socratic, scaffolding, PhD advisor | Teaching methodology entities |

### Ground Truth Format

Each query in `golden_set.json` contains:

```json
{
  "id": "factual-01",
  "category": "factual",
  "query": "What is the bedroom door analogy?",
  "expected_entities": [
    {"name": "bedroom door analogy", "relevance": 2},
    {"name": "defense in depth", "relevance": 2},
    {"name": "Brian Brewington", "relevance": 1}
  ],
  "expected_chunk_keywords": ["bedroom door", "defense in depth", "authentication"],
  "notes": "Should retrieve the auth teaching session chunk about layered security"
}
```

- **relevance**: 0 = not relevant, 1 = marginally relevant, 2 = highly relevant
- **expected_chunk_keywords**: keywords that must appear in the retrieved context
- Entity matching uses case-insensitive substring comparison

---

## 3. Metrics

### Entity Precision@K

```
Precision@K = |retrieved_entities ∩ expected_entities| / K
```

How many of the returned entities are relevant? Higher = less noise.

### Entity Recall@K

```
Recall@K = |retrieved_entities ∩ expected_entities| / |expected_entities|
```

What fraction of expected entities were found? Higher = fewer misses.

### NDCG@K (Normalized Discounted Cumulative Gain)

```
DCG@K  = Σᵢ₌₁ᴷ  relᵢ / log₂(i + 1)
NDCG@K = DCG@K / IDCG@K
```

Rewards relevant results that appear earlier in the ranking. Uses the
`relevance` scores from the golden set (0/1/2).

### MRR (Mean Reciprocal Rank)

```
MRR = (1/N) × Σ 1/rank_first_relevant
```

How quickly does the first relevant result appear? Higher = relevant content
surfaces sooner.

### Chunk Keyword Recall

```
Chunk_KW_Recall = |found_keywords| / |expected_keywords|
```

What fraction of expected keywords appear in the retrieved context text?
Measures whether the right *chunks* (not just entities) are being selected.

### Response Size

```
context_length = len(context_text)  # characters
```

Raw size of the returned context. Useful for monitoring token budget usage.

### Latency

```
latency_ms = wall_clock_time_ms
```

End-to-end request time. Important for real-time recall during conversations.

---

## 4. Experiment Matrix

### Phase 1 — Mode Comparison (5 configs × 18 queries = 90 calls)

Compare LightRAG's 5 query modes with fixed parameters:

| Config | Mode | top_k | chunk_top_k | Pick Method | Threshold |
|--------|------|-------|-------------|-------------|-----------|
| p1-naive | naive | 20 | 5 | VECTOR | 0.2 |
| p1-local | local | 20 | 5 | VECTOR | 0.2 |
| p1-global | global | 20 | 5 | VECTOR | 0.2 |
| p1-hybrid | hybrid | 20 | 5 | VECTOR | 0.2 |
| p1-mix | mix | 20 | 5 | VECTOR | 0.2 |

**What this tests**: Which retrieval strategy works best for our data?
- `naive` = direct chunk vector search only
- `local` = entity vector search → graph traversal → chunk retrieval
- `global` = relation vector search → community summaries → chunk retrieval
- `hybrid` = local + global combined
- `mix` = hybrid + naive (graph + direct chunk search)

### Phase 2 — Chunk Pick Method (6 configs × 18 queries = 108 calls)

Test the core embedding-vs-graph hypothesis:

| Config | Mode | Pick Method | What It Tests |
|--------|------|-------------|---------------|
| p2-local-vector | local | VECTOR | Embedding similarity for chunk selection |
| p2-local-weight | local | WEIGHT | Graph degree ranking for chunk selection |
| p2-hybrid-vector | hybrid | VECTOR | Embedding similarity + both graph modes |
| p2-hybrid-weight | hybrid | WEIGHT | Graph degree + both graph modes |
| p2-mix-vector | mix | VECTOR | Full pipeline with embedding chunk pick |
| p2-mix-weight | mix | WEIGHT | Full pipeline with graph degree chunk pick |

> **Important**: `kg_chunk_pick_method` is a LightRAG **constructor** parameter.
> Changing it requires restarting the gateway with `KG_CHUNK_PICK_METHOD=WEIGHT`
> (or `VECTOR`). Run Phase 2 twice — once with each setting — and merge results.

### Phase 3 — Parameter Sweeps (12 configs × 18 queries = 216 calls)

Using the best mode from Phase 1, sweep key parameters:

**top_k sweep** (entity/relation vector retrieval count):

| Config | top_k | chunk_top_k | Hypothesis |
|--------|-------|-------------|------------|
| p3-topk5 | 5 | 5 | Too few seeds → low recall |
| p3-topk10 | 10 | 5 | Moderate recall |
| p3-topk20 | 20 | 5 | Current default |
| p3-topk40 | 40 | 5 | More seeds → higher recall, possibly lower precision |

**chunk_top_k sweep** (direct chunk retrieval count — naive/mix modes):

| Config | top_k | chunk_top_k | Hypothesis |
|--------|-------|-------------|------------|
| p3-ctopk3 | 20 | 3 | Fewer chunks → higher precision |
| p3-ctopk5 | 20 | 5 | Current default |
| p3-ctopk10 | 20 | 10 | More chunks → higher recall |
| p3-ctopk20 | 20 | 20 | Max chunks — recall ceiling test |

**cosine_threshold sweep** (minimum similarity for VDB results):

| Config | Threshold | Hypothesis |
|--------|-----------|------------|
| p3-cosine0.1 | 0.1 | Very permissive — more results, possibly noisy |
| p3-cosine0.2 | 0.2 | Current default |
| p3-cosine0.3 | 0.3 | More selective — fewer but more relevant results |
| p3-cosine0.4 | 0.4 | Aggressive filtering — may miss relevant results |

> **Important**: `cosine_threshold` is a LightRAG **constructor** parameter.
> Changing it requires restarting the gateway with `COSINE_THRESHOLD=0.3`.
> Run each threshold config separately.

### Phase 4 — Chunk Size (3 configs, requires re-ingestion)

Test chunk granularity at ingestion time:

| Config | chunk_token_size | Tradeoff |
|--------|------------------|----------|
| p4-chunk300 | 300 | Fine-grained — more chunks, better precision, higher overhead |
| p4-chunk600 | 600 | Balanced |
| p4-chunk1200 | 1200 | Current default — fewer, larger chunks |

Phase 4 requires re-ingesting all documents. See [Appendix](#8-appendix--re-ingestion-for-chunk-size-tests).

### Total Call Budget

| Phase | Configs | Queries | API Calls |
|-------|---------|---------|-----------|
| 1 | 5 | 18 | 90 |
| 2 | 6 | 18 | 108 |
| 3 | 12 | 18 | 216 |
| 4 | 3 | 18 | 54 |
| **Total** | **26** | **18** | **~468** |

Each API call hits both `/memory/recall/raw` and `/memory/recall/graph`,
so actual HTTP requests are ~936.

---

## 5. Benchmark Harness

The benchmark script lives at [`scripts/benchmark.py`](../scripts/benchmark.py).

### Running the Benchmark

```bash
# Full run (all phases)
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET

# Phase 1 only (mode comparison)
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET \
  --phase 1 \
  --verbose

# Phase 3 with custom best-mode from Phase 1
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET \
  --phase 3 \
  --best-mode mix

# All flags
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET \
  --agent-id prof-mercer \
  --golden-set tests/benchmark/golden_set.json \
  --output benchmark_results.json \
  --phase 1 2 3 \
  --best-mode hybrid \
  --verbose
```

### What It Does

1. Loads `golden_set.json` and validates query structure
2. Authenticates via `POST /auth/token`
3. For each config × query:
   - Calls `POST /memory/recall/raw` with `{query, mode, top_k}` → context text + latency
   - Calls `POST /memory/recall/graph` with `{query, top_k, include_chunks: true}` → structured entities
   - Extracts entity names from the raw context's `-----Entities-----` section
   - Merges graph entities with context-extracted entities
   - Matches returned entities against expected (case-insensitive substring)
   - Matches context text against expected chunk keywords
   - Computes per-query Precision@K, Recall@K, NDCG@K, MRR, chunk keyword recall
4. Aggregates metrics per config and per query category
5. Writes full results to JSON and prints a markdown summary table

### Output Format

The JSON output file contains:

```json
{
  "timestamp": "2026-02-21T18:30:00Z",
  "gateway": "http://localhost:9820",
  "agent_id": "prof-mercer",
  "phases": [1, 2, 3],
  "num_queries": 18,
  "num_configs": 23,
  "total_calls": 414,
  "elapsed_seconds": 245.3,
  "aggregate_by_config": [
    {
      "config_name": "p1-hybrid",
      "num_queries": 18,
      "avg_precision": 0.450,
      "avg_recall": 0.680,
      "avg_ndcg": 0.720,
      "avg_mrr": 0.850,
      "avg_chunk_keyword_recall": 0.740,
      "avg_context_length": 4200,
      "avg_latency_ms": 320,
      "error_count": 0
    }
  ],
  "aggregate_by_category": {
    "factual": {"avg_precision": 0.55, "avg_recall": 0.80, ...},
    "relational": {"avg_precision": 0.40, "avg_recall": 0.65, ...}
  },
  "results": [
    {
      "query_id": "factual-01",
      "config_name": "p1-hybrid",
      "entity_names": ["bedroom door analogy", "defense in depth", ...],
      "context_length": 3800,
      "latency_ms": 280,
      "entity_precision_at_k": 0.50,
      "entity_recall_at_k": 0.75,
      "ndcg_at_k": 0.82,
      "mrr": 1.0,
      "chunk_keyword_recall": 0.67,
      "error": null
    }
  ]
}
```

### Manual Spot-Checking with curl

```bash
# Get a token
TOKEN=$(curl -s http://localhost:9820/auth/token \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"prof-mercer","secret":"'$AUTH_SECRET'"}' \
  | jq -r '.access_token')

# recall/raw — raw context without LLM synthesis
curl -s http://localhost:9820/memory/recall/raw \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"What is the bedroom door analogy?","mode":"hybrid","top_k":20}' \
  | jq '.context' | head -50

# recall/graph — structured entity data
curl -s http://localhost:9820/memory/recall/graph \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"What is the bedroom door analogy?","top_k":30,"include_chunks":true}' \
  | jq '.entities[].name'

# Compare modes side by side
for MODE in naive local global hybrid mix; do
  echo "=== $MODE ==="
  curl -s http://localhost:9820/memory/recall/raw \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"What analogies has Mercer used?\",\"mode\":\"$MODE\",\"top_k\":20}" \
    | jq '.context | length'
done
```

### Important Constraints

**Per-request parameters** (vary freely across configs):
- `mode` — query mode (naive/local/global/hybrid/mix)
- `top_k` — entity/relation vector retrieval count
- `chunk_top_k` — direct chunk retrieval count (set via `min(top_k, N)` in recall/raw)

**Constructor parameters** (require gateway restart):
- `kg_chunk_pick_method` — set via `KG_CHUNK_PICK_METHOD` env var
- `cosine_threshold` — set via `COSINE_THRESHOLD` env var
- `related_chunk_number` — set via `RELATED_CHUNK_NUMBER` env var
- `chunk_token_size` — set via `CHUNK_TOKEN_SIZE` env var (requires re-ingestion)

The benchmark script generates configs for all combinations but only the
currently-active constructor params will be tested. Re-run with different
env vars to complete the matrix.

---

## 6. Scoring Function Tuning Guide

### Parameter → Pipeline Mapping

| Parameter | Where | Set Via | Effect |
|-----------|-------|---------|--------|
| `mode` | QueryParam | per-request body | Controls which VDBs are queried. `naive` = chunks only, `local` = entities → graph → chunks, `global` = relations → communities → chunks, `hybrid` = local + global, `mix` = hybrid + naive |
| `top_k` | QueryParam | per-request body | Number of entities/relations retrieved from vector search. Higher = more seeds for graph traversal |
| `chunk_top_k` | QueryParam | code (`min(top_k, 5)`) | Number of chunks retrieved via direct vector search (used in naive + mix modes) |
| `kg_chunk_pick_method` | Constructor | env `KG_CHUNK_PICK_METHOD` | How chunks are selected after graph traversal. `VECTOR` = cosine similarity to query, `WEIGHT` = entity degree/importance ranking |
| `cosine_threshold` | Constructor | env `COSINE_THRESHOLD` | Minimum cosine similarity for VDB results to be included. Default 0.2 |
| `related_chunk_number` | Constructor | env `RELATED_CHUNK_NUMBER` | Maximum chunks retrieved per entity during graph-based chunk selection. Default 5 |
| `chunk_token_size` | Constructor | env `CHUNK_TOKEN_SIZE` | Token count per chunk at ingestion time. Smaller = more chunks, finer granularity. Default 300 (current data ingested at 1200) |
| `max_total_tokens` | QueryParam | code (hardcoded 8000) | Token budget for the returned context. Caps total output size |
| `max_entity_tokens` | QueryParam | code (hardcoded 2000) | Token budget for entity descriptions in context |
| `max_relation_tokens` | QueryParam | code (hardcoded 2000) | Token budget for relationship descriptions in context |

### How to Interpret Results

**Scenario 1: naive > hybrid**
→ Embeddings dominate. Graph traversal adds noise, not signal.
- **Action**: Use `mix` mode with high `chunk_top_k` (10-20). Graph still adds
  some relational context but direct chunk search does the heavy lifting.

**Scenario 2: local > naive, and VECTOR > WEIGHT**
→ Graph finds good seed entities, but embedding similarity picks better chunks
  than degree ranking. Best of both worlds.
- **Action**: Use `hybrid` or `mix` with `VECTOR` pick. Increase `top_k` to
  give the graph more seeds. Keep `chunk_top_k` moderate (5-10).

**Scenario 3: WEIGHT > VECTOR**
→ Graph degree is a better signal than embedding similarity for chunk selection.
  Unlikely for conversational data but possible if entities are well-connected.
- **Action**: Use `local` or `hybrid` with `WEIGHT` pick. Focus tuning on
  `related_chunk_number` and `top_k`.

**Scenario 4: Lower threshold improves recall without hurting precision**
→ Default 0.2 threshold is filtering out relevant results.
- **Action**: Lower `cosine_threshold` to 0.1. Monitor context size — lower
  threshold means more results, which may hit token budget limits.

**Scenario 5: Higher threshold improves precision without hurting recall**
→ Default 0.2 is too permissive — irrelevant results are diluting context.
- **Action**: Raise `cosine_threshold` to 0.3. Useful if context is noisy.

**Scenario 6: Relational queries lag behind factual queries**
→ Graph traversal isn't surfacing relationship context well.
- **Action**: Increase `top_k` for more entity seeds. Try `hybrid` mode which
  combines local (entity-centered) and global (relation-centered) search.

**Scenario 7: Exploratory queries score low across all modes**
→ Open-ended queries are too broad for the embedding space.
- **Action**: Consider query decomposition (breaking exploratory queries into
  sub-queries). Lower `cosine_threshold` to cast a wider net.

### Recommended Starting Point

Based on the hypothesis that embeddings should dominate for conversational data:

```
mode=mix
top_k=20
chunk_top_k=10
KG_CHUNK_PICK_METHOD=VECTOR
COSINE_THRESHOLD=0.2
RELATED_CHUNK_NUMBER=5
```

Adjust based on Phase 1/2 results.

---

## 7. Baseline Snapshot

Current state of the prof-mercer workspace before any tuning:

| Metric | Value |
|--------|-------|
| Documents ingested | 11 |
| Entities extracted | 859 |
| Relations extracted | 730 |
| Chunks created | 60 |
| Chunk token size | 1200 (ingested) / 300 (config default) |
| Embedding model | nomic-embed-text |
| Embedding dimensions | 768 |
| Extraction model | qwen2.5:14b |
| Vector backend | NanoVDB (filesystem) |
| kg_chunk_pick_method | VECTOR |
| cosine_threshold | 0.2 |
| related_chunk_number | 5 |
| recall/raw top_k | 20 |
| recall/raw chunk_top_k | min(top_k, 5) = 5 |
| recall/raw max_total_tokens | 8000 |

**Baseline results**: (to be filled in after running Phase 1)

```
# Run this to capture baseline:
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET \
  --phase 1 \
  --verbose \
  --output baseline_results.json
```

---

## 8. Appendix — Re-ingestion for Chunk Size Tests

Phase 4 tests different chunk sizes, which requires re-ingesting all documents.
This is a destructive operation — follow these steps carefully.

### Backup

```bash
# Backup current rag_storage for prof-mercer
cp -r rag_storage/prof-mercer ~/rag_storage_backup_prof-mercer_$(date +%Y%m%d)/
```

### Re-ingest with New Chunk Size

```bash
# 1. Stop the gateway
# 2. Delete the workspace (or move it)
mv rag_storage/prof-mercer rag_storage/prof-mercer-backup-1200

# 3. Set the new chunk size
export CHUNK_TOKEN_SIZE=600

# 4. Start the gateway
memory-gateway &

# 5. Re-ingest all source documents
memory-ingest --workspace prof-mercer shared/memories/mercer/
memory-ingest --workspace prof-mercer shared/memories/prof-mercer/

# 6. Wait for extraction jobs to complete (check with memory-token + curl)
TOKEN=$(memory-token --agent prof-mercer --secret $AUTH_SECRET)
curl -s http://localhost:9820/memory/status \
  -H "Authorization: Bearer $TOKEN" | jq .

# 7. Run the benchmark
python scripts/benchmark.py \
  --gateway http://localhost:9820 \
  --secret $AUTH_SECRET \
  --phase 1 \
  --output benchmark_results_chunk600.json

# 8. Restore the original workspace when done
rm -rf rag_storage/prof-mercer
mv rag_storage/prof-mercer-backup-1200 rag_storage/prof-mercer
```

### Chunk Size Expectations

| Size | Expected Chunks | Tradeoff |
|------|-----------------|----------|
| 300 tokens | ~240 chunks | Fine-grained: better precision, more embedding overhead |
| 600 tokens | ~120 chunks | Balanced: moderate granularity |
| 1200 tokens | ~60 chunks | Current: fewer chunks, each captures more context |

Smaller chunks should improve precision (less irrelevant text per chunk) but may
hurt recall for queries that need broader context. The NDCG metric will reveal
whether smaller chunks surface relevant content earlier in the ranking.
