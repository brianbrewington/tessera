# Memory-Agent Status Report

**Date**: 2026-02-21
**Repository**: https://github.com/brianbrewington/memory-agent

---

## What Was Built

A full-stack memory system for AI agents, built from design docs to working code in a single session. The system gives Claude Code personas persistent, searchable memory via a knowledge graph.

### Architecture

```
Claude Code (Prof Mercer)
    │
    ▼
MCP Server (stdio)          ◄── 8 tools: stash, recall, recall_raw, recall_graph, forget, status, batch_stash, job_status
    │
    ▼ httpx
FastAPI Gateway (:9820)     ◄── JWT auth, workspace isolation, async job management
    │
    ▼
LightRAG                    ◄── Graph-enhanced RAG: entity/relation extraction, hybrid search
    │
    ├── Ollama (qwen2.5:14b)       ◄── LLM extraction + chat synthesis
    └── Ollama (nomic-embed-text)   ◄── 768-dim embeddings
```

### Components

| Component | Entry Point | Description |
|-----------|-------------|-------------|
| **Gateway** | `memory-gateway` | FastAPI server on port 9820. Agent endpoints (`/memory/*`) + admin endpoints (`/admin/*`) |
| **MCP Server** | `memory-mcp` | FastMCP stdio server. 8 tools that proxy to the gateway. Plugs into Claude Code via `.mcp.json` |
| **Ingest CLI** | `memory-ingest` | Bulk-loads `.md` files into workspaces. Shows progress, waits for extraction per file |
| **Token CLI** | `memory-token` | Generates JWT tokens for agents and admins |

### Source Code

- **14 Python modules**, 2,246 lines total
- Key files:
  - `workspace.py` — LightRAG instance pooling, Ollama wiring, custom embedding function
  - `deep_query.py` — Structured graph traversal (entities/relations/chunks) without LLM
  - `routes/memory.py` — 8 agent-facing endpoints (stash, recall, forget, status, jobs)
  - `routes/admin.py` — 6 admin endpoints matching the viewer app's TypeScript types
  - `gateway.py` — FastAPI app with lifespan, CORS, auth token issuance
  - `mcp_server.py` — FastMCP server with 8 tools proxying to gateway

---

## Ingestion: Prof Mercer

### Source Files

7 memory files from `shared/memories/mercer/` + `prof-mercer/` (~200 KB total), containing:
- Teaching session logs with multiple students
- Pedagogical notes (what worked, what confused, felt signals)
- Cursor IDE session transcripts
- Authentication and security teaching analogies

### Extraction Results

| Metric | Value |
|--------|-------|
| Documents ingested | 11 |
| Entities extracted | 859 |
| Relations extracted | 730 |
| Chunks created | 60 |
| Storage size | ~16 MB |
| Extraction model | qwen2.5:14b |
| Embedding model | nomic-embed-text (768-dim) |

### Extraction Notes

- **llama3.2:latest** was tried first but produced garbage entity types (e.g., `developmentreferencereferencereference...`)
- **qwen2.5:72b** was tried but too slow locally (~3-5 tok/s)
- **qwen2.5:14b** was the sweet spot — clean entity types (Person, Technology, Concept, etc.), reasonable speed
- The largest file (120 KB Cursor sessions log) took ~52 minutes to extract
- Custom extraction prompt with 12 entity types: Person, Organization, Project, Technology, Place, Concept, File, Code, Repository, Lesson, Wisdom, Memory

### Sample Query

**Q**: "What teaching analogies has Mercer used for authentication and security?"

**A** (abbreviated): Retrieved the "Bedroom Door Analogy" (defense in depth), "Entangled Identity Problem" (userId vs graphId confusion), and "Painted Door Experiment" (Lean Startup applied to memory tools) — all grounded in actual teaching session content.

---

## Configuration: Prof Mercer MCP Integration

### Files Modified

| File | Change |
|------|--------|
| `~/Code/claude_mercer/.mcp.json` | Created — points to `memory-mcp` with Mercer's JWT |
| `~/Code/claude_mercer/.claude/settings.local.json` | Added MCP tool permissions (no prompts for memory tools) |
| `~/Code/claude_mercer/.claude/rules/prof-mercer.md` | Updated "Teaching Log" section: now uses `memory_recall_raw` instead of reading files. Updated "Recording Memories" section: now uses `memory_stash` |

### MCP Tools Available to Mercer

- `memory_recall` / `memory_recall_raw` — Search past teaching sessions
- `memory_stash` / `memory_batch_stash` — Record new teaching memories
- `memory_recall_graph` — Structured entity/relation retrieval
- `memory_forget` — Remove entities
- `memory_status` — Check workspace stats
- `memory_job_status` — Poll extraction jobs

---

## Companion: Memory Viewer

A separate viewer app at `~/Code/memory-viewer/` is being built against this gateway's admin API. Its TypeScript types and API client are locked in — our admin endpoint response shapes match exactly:

- `GET /admin/health` → `HealthResponse`
- `GET /admin/graphs` → `GraphListResponse`
- `GET /admin/graphs/{id}` → `GraphDetail`
- `GET /admin/graphs/{id}/subgraph` → `SubgraphResponse`
- `POST /admin/graphs/{id}/query` → `QueryResponse`
- `POST /admin/graphs/{id}/similarity` → `SimilarityResponse`

---

## LightRAG Integration Gotchas

Issues hit and resolved during implementation:

1. **`initialize_storages()` required** — LightRAG >= 1.4.9 requires `await rag.initialize_storages()` after construction. Without it, `JsonDocStatusStorage` throws.
2. **Default embedding model** — `ollama_embed` defaults to `bge-m3:latest`. Had to write a custom embedding function that explicitly uses the configured model via `ollama.AsyncClient.embed()`.
3. **`num_ctx` nesting** — Must be inside `options` dict: `{"options": {"num_ctx": 32768}}`, not top-level.
4. **Model tag mismatch** — Ollama uses `llama3.2:latest` not `llama3.2:3b`.
5. **Doc deduplication** — LightRAG skips re-ingestion of already-seen document hashes. Re-running ingest safely skips completed files (~2s each).

---

## What's Next

- [ ] End-to-end test: open Claude Code in `~/Code/claude_mercer/`, verify MCP tools load, have a teaching conversation
- [ ] Ingest memories for other agents (sophia, kirk, emily, etc. — 12 workspaces in `shared/memories/`)
- [ ] Connect the memory-viewer app and verify graph visualization
- [ ] Consider Qdrant for production vector storage (currently using NanoVDB/filesystem)
- [ ] Add tests

---

## Backup

Graph data backed up to `~/rag_storage_backup_prof-mercer_20260221/` (16 MB).
