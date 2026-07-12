# Memory Service — System Design Document

*Last updated: 2026-02-20*

This document describes the architecture, components, data flows, and configuration of the memory service in sufficient detail for another engineer (or agent) to stand up a functionally equivalent system from scratch.

---

## 1. Purpose

The memory service is a **graph-enhanced Retrieval-Augmented Generation (GraphRAG) system** that lets users and AI agents ingest text, build a knowledge graph of entities and relationships, and query it using multiple retrieval strategies. It is designed for:

- **Persistent memory** — an agent can write observations, lessons, and context into the graph and retrieve them later across sessions.
- **Rich retrieval** — queries fan out across entity-centric (local), theme-centric (global), and hybrid strategies, producing better answers than naive vector search alone.
- **Model flexibility** — extraction (graph building) and chat (answer synthesis) can use different LLMs, and the extraction prompt is fully customizable.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Interfaces                            │
│                                                             │
│   ┌──────────────┐          ┌──────────────────────────┐    │
│   │  REPL (CLI)  │          │  MCP Server (stdio/sse)  │    │
│   │  repl.py     │          │  mcp_server.py           │    │
│   └──────┬───────┘          └────────────┬─────────────┘    │
│          │                               │                  │
│          └───────────┬───────────────────┘                  │
│                      ▼                                      │
│         ┌────────────────────────┐                          │
│         │    Core Orchestration   │                          │
│         │    (shared functions    │                          │
│         │     in repl.py)        │                          │
│         └────────────┬───────────┘                          │
│                      │                                      │
│    ┌─────────────────┼──────────────────┐                   │
│    ▼                 ▼                  ▼                    │
│ ┌──────┐     ┌────────────┐     ┌───────────────┐          │
│ │Config│     │  Prompts   │     │   LightRAG    │          │
│ │.py   │     │  prompts.py│     │  (library)    │          │
│ └──────┘     └────────────┘     └───────┬───────┘          │
│                                         │                   │
│                    ┌────────────────────┬┴────────┐         │
│                    ▼                    ▼         ▼         │
│             ┌───────────┐    ┌──────────┐  ┌──────────┐    │
│             │ LLM Client│    │ Embedding│  │  Storage  │    │
│             │ (Ollama / │    │ (Ollama /│  │ (Graph +  │    │
│             │  OpenAI)  │    │  OpenAI) │  │  Vector + │    │
│             └───────────┘    └──────────┘  │  KV)      │    │
│                                            └──────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Components

### 3.1 Configuration (`config.py`)

Reads `.env` via `python-dotenv` and produces frozen dataclasses:

| Class | Fields | Purpose |
|---|---|---|
| `LLMConfig` | `provider`, `model`, `base_url`, `api_key`, `num_ctx` | Single LLM endpoint config |
| `EmbeddingConfig` | `provider`, `model`, `dim`, `max_tokens`, `base_url`, `api_key` | Embedding endpoint config |
| `Config` | `working_dir`, `extraction`, `chat`, `embedding`, `prompts_dir`, `entity_types`, `language`, `log_level` | Top-level config |

**Key design decisions:**

- **Extraction/Chat split:** `Config.extraction` and `Config.chat` are separate `LLMConfig` instances. `CHAT_*` env vars fall back to `LLM_*` if unset, via `LLMConfig.from_env_with_fallback()`. This allows a strong model for graph building and a fast model for interactive queries.
- **Entity types:** Configurable via `ENTITY_TYPES` env var (comma-separated). Default set: `Person, Organization, Project, Technology, Place, Concept, File, Code, Repository, Lesson, Wisdom, Memory`. These are domain-tuned for a memory/knowledge system.
- **Language:** `SUMMARY_LANGUAGE` env var controls extraction output language (default: `English`).

### 3.2 Prompt System (`prompts.py`)

Custom prompts live in files within a configurable directory (default: `prompts/`).

| File | LightRAG hook | Effect |
|---|---|---|
| `extraction_system.txt` | `PROMPTS["entity_extraction_system_prompt"]` | Replaces the system prompt used during entity/edge extraction. Must contain `{entity_types}`, `{tuple_delimiter}`, `{completion_delimiter}`, `{language}`, `{examples}` placeholders. |
| `query_system.txt` | `aquery(system_prompt=...)` | Passed to the LLM during answer synthesis. Freeform text. |

**Mechanism:** `apply_extraction_prompt()` monkey-patches LightRAG's global `PROMPTS` dict before the `LightRAG` instance is created. This is necessary because LightRAG reads its prompts at construction time from a module-level dict.

### 3.3 REPL (`repl.py`)

Interactive command-line interface. Start with `memory-repl`.

#### User-Facing Commands

| Command | Syntax | Description |
|---|---|---|
| `insert` | `insert <text>` | Insert inline text into the knowledge graph |
| `insert -f` | `insert -f <filepath>` | Insert contents of a file |
| `query` | `query [-m MODE] <text>` | Query the graph; returns LLM-synthesized answer |
| `context` | `context [-m MODE] <text>` | Like `query`, but returns raw retrieved context without LLM synthesis |
| `stats` | `stats` | Show graph node/edge counts, KV store sizes, chunking config, disk usage breakdown |
| `reset` | `reset` | Delete ALL indexed data and reinitialize (interactive confirmation required) |
| `modes` | `modes` | List available query modes |
| `status` | `status` | Show current config: models, entity types, language, custom prompts loaded |
| `help` | `help` | Show all commands |
| `exit` | `exit` / `quit` / `q` | Exit the REPL |

**Query modes:** `naive` (chunk vector search only), `local` (entity/relation-centric), `global` (theme/community-centric), `hybrid` (local + global, default), `mix` (graph + vector + reranker).

The `-m MODE` flag is optional; default is `hybrid`.

#### Internal Architecture

- **LLM wiring functions:**
  - `_build_extraction_llm_func(cfg)` — for Ollama, returns `ollama_model_complete` directly (LightRAG injects `model_name` and `hashing_kv` internally). For OpenAI, wraps `openai_complete_if_cache`.
  - `_build_chat_llm_func(llm_cfg)` — standalone wrapper that calls the LLM client directly, stripping LightRAG-specific kwargs like `hashing_kv`. Used as `QueryParam.model_func` override.
  - `_build_embedding_func(cfg)` — wraps the embedding provider with LightRAG's `wrap_embedding_func_with_attrs`.

- **Core functions (reused by MCP server):**
  - `_init_rag(cfg)` → `(rag, custom_prompts)` — creates and initializes the LightRAG instance, applies custom prompts, sets `addon_params` for entity types and language.
  - `_cmd_insert(rag, arg)` — ingest text or file.
  - `_cmd_query(rag, cfg, arg, ...)` — query with mode, optional chat model override, optional query system prompt.
  - `_cmd_stats(rag, cfg)` — graph node/edge counts, KV store counts, chunking config, disk usage.
  - `_cmd_reset(rag, cfg)` → `(new_rag, custom_prompts, message)` — drops all storage singletons, deletes working directory, reinitializes.

- **REPL loop:** `_repl(cfg)` — input loop dispatching to the above functions.

### 3.4 MCP Server (`mcp_server.py`)

Exposes the memory service as agent-callable tools via [FastMCP](https://github.com/jlowin/fastmcp). Supports `stdio` (default, for Cursor/Claude Desktop) and `sse` transports.

| Tool | Args | Description |
|---|---|---|
| `memory_insert` | `text: str` | Ingest text into the knowledge graph |
| `memory_insert_file` | `filepath: str` | Ingest a file's contents |
| `memory_query` | `query: str, mode: str` | Query with LLM-synthesized answer |
| `memory_context` | `query: str, mode: str` | Retrieve raw context without LLM synthesis |
| `memory_stats` | — | Graph metrics, storage info |
| `memory_reset` | `confirm: str` | Destructive: delete all data (requires `confirm="yes"`) |

**Singleton pattern:** `_get_rag()` lazily initializes a single `LightRAG` instance + config on first tool call. Shared across all tool invocations within the process.

---

## 4. Data Flow

### 4.1 Insert (Ingestion)

```
Text/File
  │
  ▼
rag.ainsert(text)
  │
  ├──► Chunking (token-level splitting, default 1200 tokens, 100 overlap)
  │
  ├──► Entity/Relationship Extraction (extraction LLM)
  │       Uses: entity_extraction_system_prompt (custom or default)
  │       Uses: entity_types, language from addon_params
  │       Output: entity/relation tuples delimited by <|#|>
  │
  ├──► Graph Storage (NetworkX)
  │       Nodes: entity_name, entity_type, description, source_id
  │       Edges: source→target, keywords, description, source_id
  │
  ├──► Vector Storage (NanoVectorDB)
  │       Three indices: entities, relationships, chunks
  │       Embeddings from embedding model
  │
  └──► KV Storage (JSON files)
        full_docs, text_chunks, full_entities, full_relations,
        entity_chunks, relation_chunks, llm_response_cache, doc_status
```

### 4.2 Query (Retrieval + Synthesis)

```
Query text
  │
  ▼
Keyword extraction (LLM)
  │
  ├──► [local mode] Entity/relation vector search → subgraph traversal
  ├──► [global mode] Community detection → theme-level summaries
  ├──► [hybrid mode] Both local + global
  ├──► [naive mode] Chunk vector search only
  ├──► [mix mode] Graph + vector + reranker
  │
  ▼
Context assembly (text chunks + graph context)
  │
  ▼
Answer synthesis (chat LLM, optional system_prompt from query_system.txt)
  │
  ▼
Result string
```

### 4.3 Reset

```
1. drop() on all KV stores (full_docs, text_chunks, full_entities,
   full_relations, entity_chunks, relation_chunks, llm_response_cache)
2. drop() on graph storage
3. drop() on all vector DBs (entities, relationships, chunks)
4. drop() on doc_status
5. finalize_storages()
6. rm -rf working_dir && mkdir working_dir
7. Re-init LightRAG from scratch
```

This sequence is critical — LightRAG uses **module-level storage singletons**. Deleting files without calling `drop()` leaves stale in-memory state (particularly `doc_status`, which blocks re-ingestion of previously seen document IDs).

---

## 5. Storage Layout

All persistent state lives under `RAG_WORKING_DIR` (default: `./rag_storage/`).

| File | Format | Contents |
|---|---|---|
| `graph_chunk_entity_relation.graphml` | GraphML | NetworkX graph: nodes (entities) + edges (relations) |
| `vdb_entities.json` | JSON | NanoVectorDB: entity embeddings |
| `vdb_relationships.json` | JSON | NanoVectorDB: relationship embeddings |
| `vdb_chunks.json` | JSON | NanoVectorDB: chunk embeddings |
| `kv_store_full_docs.json` | JSON | Full document content keyed by doc hash |
| `kv_store_text_chunks.json` | JSON | Chunked text keyed by chunk hash |
| `kv_store_full_entities.json` | JSON | Entity metadata |
| `kv_store_full_relations.json` | JSON | Relation metadata |
| `kv_store_entity_chunks.json` | JSON | Entity→chunk mappings |
| `kv_store_relation_chunks.json` | JSON | Relation→chunk mappings |
| `kv_store_llm_response_cache.json` | JSON | Cached LLM responses |
| `kv_store_doc_status.json` | JSON | Document ingestion status (prevents duplicate ingestion) |

---

## 6. Dependencies

| Package | Version | Purpose |
|---|---|---|
| `lightrag-hku` | latest | Core GraphRAG engine (extraction, indexing, retrieval, storage) |
| `ollama` | latest | Python client for local Ollama LLM/embedding server |
| `python-dotenv` | latest | Load `.env` files into `os.environ` |
| `fastmcp` | latest | MCP (Model Context Protocol) server SDK |
| `numpy` | (transitive) | Array operations for embeddings |
| `networkx` | (transitive) | Default graph storage backend in LightRAG |

Dev dependencies: `pytest`, `pytest-asyncio`.

---

## 7. Configuration Reference

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | Extraction LLM provider: `ollama` or `openai` |
| `LLM_MODEL` | *required* | Extraction model name (e.g. `qwen3:32b`, `gpt-4o`) |
| `LLM_NUM_CTX` | `32768` | Context window size for extraction |
| `LLM_BASE_URL` | — | API base URL (for OpenAI-compatible endpoints) |
| `LLM_API_KEY` | — | API key (for OpenAI-compatible endpoints) |
| `CHAT_PROVIDER` | falls back to `LLM_PROVIDER` | Chat LLM provider |
| `CHAT_MODEL` | falls back to `LLM_MODEL` | Chat model name (e.g. `llama3`, `gpt-4o-mini`) |
| `CHAT_NUM_CTX` | falls back to `LLM_NUM_CTX` | Context window for chat |
| `CHAT_BASE_URL` | falls back to `LLM_BASE_URL` | Chat API URL |
| `CHAT_API_KEY` | falls back to `LLM_API_KEY` | Chat API key |
| `EMBEDDING_PROVIDER` | `openai` | Embedding provider: `ollama` or `openai` |
| `EMBEDDING_MODEL` | *required* | Embedding model name (e.g. `nomic-embed-text`) |
| `EMBEDDING_DIM` | `768` | Embedding vector dimension |
| `EMBEDDING_MAX_TOKENS` | `8192` | Max tokens per embedding call |
| `EMBEDDING_BASE_URL` | — | Embedding API URL |
| `EMBEDDING_API_KEY` | — | Embedding API key |
| `ENTITY_TYPES` | see defaults | Comma-separated entity types for extraction |
| `SUMMARY_LANGUAGE` | `English` | Output language for extraction |
| `PROMPTS_DIR` | `./prompts` | Directory containing custom prompt files |
| `RAG_WORKING_DIR` | `./rag_storage` | Persistent storage directory |
| `LOG_LEVEL` | `INFO` | Logging level |

### Default Entity Types

```
Person, Organization, Project, Technology, Place, Concept,
File, Code, Repository, Lesson, Wisdom, Memory
```

These are optimized for a memory/knowledge service. Override with `ENTITY_TYPES` env var.

---

## 8. Entry Points

| Command | Module | Description |
|---|---|---|
| `memory-repl` | `memory_service.repl:main` | Interactive REPL |
| `memory-mcp` | `memory_service.mcp_server:main` | MCP server (stdio) |
| `memory-mcp --sse` | `memory_service.mcp_server:main` | MCP server (SSE transport) |

---

## 9. Testing Strategy

| Tier | File | What it tests | External deps |
|---|---|---|---|
| Unit | `test_config.py` | Config loading, env var parsing, LLM fallback logic, prompt loading, entity type defaults | None |
| Integration | `test_integration.py` | Embedding shape/similarity, LLM connectivity, full RAG lifecycle (insert→query→stats→reset) | Ollama + `llama3` + `nomic-embed-text` |

**Key constraint:** LightRAG uses module-level storage singletons that bind to the active event loop. All RAG-dependent integration tests must run within a single async test function (single event loop) to avoid `RuntimeError: Lock is bound to a different event loop`.

Integration tests auto-skip when Ollama is not reachable (TCP probe on `127.0.0.1:11434`).

---

## 10. Prompt Customization

### Extraction Prompt

The extraction prompt controls how the LLM identifies entities and relationships from text. The default (from LightRAG) produces generic entity types. The custom prompt in `prompts/extraction_system.txt` adds domain-specific quality rules:

- **Description quality standards** per entity type (e.g., PERSON: who + why they matter; LESSON/WISDOM: the learning + context + practical implication).
- **Critical edge quality rule**: relationship descriptions must explicitly name both endpoints (prevents vague edges like "related concept" or "uses this").
- **Edge density rule**: every important entity should connect to at least 2 meaningful neighbors.
- **Attribution rule**: WISDOM, LESSON, and MEMORY entities must include source attribution.

**Format requirement:** The extraction prompt must use LightRAG's delimiter-based output format (not JSON), with placeholders `{entity_types}`, `{tuple_delimiter}`, `{completion_delimiter}`, `{language}`, `{examples}`.

#### Full Extraction Prompt (`prompts/extraction_system.txt`)

```text
---Role---
You are a Knowledge Graph Specialist building a memory-oriented knowledge graph. You extract entities and relationships from text with emphasis on:
- Rich, self-contained descriptions that support standalone retrieval
- High-quality edge reasons that explicitly name both endpoints
- Attribution of wisdom, lessons, and memories to their sources

---Instructions---
1.  **Entity Extraction & Output:**
    *   **Identification:** Identify clearly defined and meaningful entities in the input text.
    *   **Entity Details:** For each identified entity, extract:
        *   `entity_name`: Title-cased name. Ensure **consistent naming** across the extraction.
        *   `entity_type`: One of: `{entity_types}`. If none fit, use `Other`.
        *   `entity_description`: A self-contained, retrieval-ready description.
    *   **Output Format:** 4 fields per entity, delimited by `{tuple_delimiter}`:
        *   `entity{tuple_delimiter}entity_name{tuple_delimiter}entity_type{tuple_delimiter}entity_description`

    **Description Quality Standards (by type):**
    - PERSON: who they are + why they matter in this context
    - ORGANIZATION: what it does + its role in the narrative
    - PROJECT/REPOSITORY: what it builds + its purpose
    - TECHNOLOGY/CODE: what it is + how it's used
    - CONCEPT: what it means + why it matters
    - LESSON/WISDOM: the learning itself + the context that produced it + the practical implication
    - MEMORY: what happened + who was involved + what was significant about it

    **Attribution Rule:** For WISDOM, LESSON, and MEMORY entities, include who the insight is attributed to in the description when attribution exists in the source text.

2.  **Relationship Extraction & Output:**
    *   **Identification:** Identify direct, clearly stated, meaningful relationships between extracted entities.
    *   **Decompose N-ary relationships** into binary pairs.
    *   **Relationship Details:**
        *   `source_entity`: Title-cased, consistent with entity extraction.
        *   `target_entity`: Title-cased, consistent with entity extraction.
        *   `relationship_keywords`: Comma-separated high-level keywords. **DO NOT use `{tuple_delimiter}` within keywords.**
        *   `relationship_description`: A concise explanation of the relationship.
    *   **Output Format:** 5 fields per relationship, delimited by `{tuple_delimiter}`:
        *   `relation{tuple_delimiter}source_entity{tuple_delimiter}target_entity{tuple_delimiter}relationship_keywords{tuple_delimiter}relationship_description`

    **CRITICAL EDGE QUALITY RULE:**
    The relationship_description must explicitly name BOTH endpoints. This is the single most important quality rule — edge descriptions are the primary retrieval signal in graph-enhanced search.

    Good descriptions:
    - "Neo4j stores graph entities used by MindMapper retrieval workflows"
    - "Kirk Anderson identified copy-not-reference drift in vector payload design"
    - "LightRAG implements dual-level retrieval combining local entity search with global theme search"

    Bad descriptions (DO NOT produce these):
    - "related concept"
    - "uses this"
    - "connected"
    - "is part of"

    **Edge Density Rule:** Every important new entity should connect to at least 2 meaningful neighbors when the text supports it. Prefer creating more edges with specific reasons over fewer edges with vague reasons.

3.  **Delimiter Usage:** `{tuple_delimiter}` is an atomic field separator. Never embed content in it.

4.  **Relationships are undirected** unless explicitly stated otherwise. Avoid duplicates.

5.  **Output Order:** All entities first, then all relationships (most significant first).

6.  **Context & Objectivity:** Third person. Name subjects explicitly — no pronouns like "this article" or "our system."

7.  **Language:** Output in `{language}`. Keep proper nouns in original language.

8.  **Completion:** Output `{completion_delimiter}` after all entities and relationships.

---Examples---
{examples}
```

### Query System Prompt

Optional. Placed in `prompts/query_system.txt`. Passed to `aquery(system_prompt=...)` to control how the chat LLM synthesizes answers from retrieved context. If absent, LightRAG uses its built-in synthesis prompt.

---

## 11. Known Constraints and Gotchas

1. **Module-level singletons:** LightRAG's storage backends (KV stores, graph, vector DBs) are module-level singletons. This means:
   - Only one LightRAG instance per working directory per process.
   - `drop()` must be called on every storage object before reinitializing (file deletion alone is insufficient).
   - Tests cannot create fresh instances across different event loops.

2. **Ollama `hashing_kv` injection:** LightRAG's Ollama integration injects `hashing_kv` (a KV store for response caching) into the LLM function call chain. The extraction LLM function must accept and use this. The chat LLM function (used as `QueryParam.model_func`) must strip it — LightRAG passes it but the standalone client doesn't expect it.

3. **Embedding function decoration:** LightRAG requires embedding functions to carry `embedding_dim`, `max_token_size`, and `model_name` attributes. Use `wrap_embedding_func_with_attrs()`.

4. **Default storage backends:** Out of the box, LightRAG uses NetworkX (graph) and NanoVectorDB (vectors), both stored as JSON files in the working directory. These work for moderate-scale use but are not suitable for production-scale deployments. LightRAG also supports Neo4j, Milvus, and other backends via configuration.

5. **Document deduplication:** LightRAG tracks ingested document IDs in `doc_status`. Re-inserting the same text produces a "document already exists" warning and skips processing. This is by design, but can be surprising after a partial reset.

---

## 12. File Inventory

```
memory_service/
├── .env                              # Local config (git-ignored)
├── .env.example                      # Config template
├── .gitignore
├── README.md
├── pyproject.toml                    # Dependencies, entry points, build config
├── docs/
│   ├── graphrag-integration-playbook.md  # Prompt design and architecture philosophy
│   └── system-design.md             # This document
├── prompts/
│   └── extraction_system.txt         # Custom extraction prompt (LightRAG format)
├── samples/
│   └── graphrag-overview.txt         # Sample document for testing ingestion
├── src/memory_service/
│   ├── __init__.py
│   ├── config.py                     # Env-driven config loading
│   ├── prompts.py                    # Prompt file loading + LightRAG patching
│   ├── repl.py                       # REPL + core LightRAG wiring
│   └── mcp_server.py                # MCP tool server
├── tests/
│   ├── conftest.py                   # Shared fixtures, Ollama skip detection
│   ├── test_config.py               # Unit tests (config + prompts)
│   └── test_integration.py          # Integration tests (requires Ollama)
└── rag_storage/                      # Persistent data (git-ignored)
```

---

## 13. Standing Up From Scratch

If you need to rebuild this system:

1. **Create the project structure** as shown in Section 12.
2. **Install dependencies:** `lightrag-hku`, `ollama`, `python-dotenv`, `fastmcp`. Build with `setuptools`.
3. **Configure `.env`** with at minimum `LLM_PROVIDER`, `LLM_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`.
4. **Implement `config.py`:** Load env vars into frozen dataclasses. Support extraction/chat model split with fallback. Support `ENTITY_TYPES`, `SUMMARY_LANGUAGE`, `PROMPTS_DIR`.
5. **Implement `prompts.py`:** Load text files from prompts dir, monkey-patch `lightrag.prompt.PROMPTS` before LightRAG construction.
6. **Implement `repl.py`:**
   - Build LLM functions: extraction returns provider function directly (for Ollama) or a thin wrapper (for OpenAI). Chat builds a standalone wrapper that strips `hashing_kv`.
   - Build embedding function: wrap with `wrap_embedding_func_with_attrs`.
   - Init LightRAG with `llm_model_func`, `llm_model_name`, `embedding_func`, `addon_params` (language, entity_types), and optionally `llm_model_kwargs` for Ollama `num_ctx`.
   - Implement insert, query, stats, reset commands.
   - For reset: call `drop()` on every storage component, then delete and recreate the working directory, then re-init.
7. **Implement `mcp_server.py`:** Wrap the core functions as FastMCP tools. Use a lazy singleton for the RAG instance.
8. **Write tests:** Unit tests for config/prompt loading. Integration tests for the full RAG lifecycle (run as a single test function to avoid event loop issues).
9. **Customize prompts:** Place `extraction_system.txt` in the prompts directory with domain-specific quality rules. Optionally add `query_system.txt`.

---

## 14. Design Principles

- **Configuration over code:** All model settings, entity types, language, and prompt paths are env-var-driven. No code changes needed to switch models or tune extraction.
- **Prompt files over env vars:** Prompts are too long and structured for env vars. File-based prompts support version control, diffing, and multi-line editing.
- **Separation of extraction and synthesis:** Different LLMs can serve different roles. A strong model (e.g. `qwen3:32b`) builds the graph once; a fast model (e.g. `llama3`) serves interactive queries.
- **Two interfaces, shared core:** The REPL and MCP server share the same initialization and command functions. Adding a third interface (REST API, Discord bot, etc.) requires only a thin adapter.
- **Explicit reset over implicit:** The reset sequence is deliberately verbose (drop every storage, delete files, reinitialize) because LightRAG's singleton pattern makes partial cleanup dangerous.
