# Memory Agent — REST API Reference

> **Audience**: Another agent or developer building a web viewer / admin dashboard against this API.
> **Base URL**: `http://localhost:9820` (local) or configurable via `GATEWAY_HOST`/`GATEWAY_PORT`.

---

## Authentication

All endpoints require a JWT bearer token in the `Authorization` header.

```
Authorization: Bearer <jwt>
```

### Token Structure (JWT / RFC 7519)

```json
{
  "sub": "agent_id",
  "iss": "memory-gateway",
  "iat": 1708531200,
  "exp": 1708617600,
  "scope": "memory:read memory:write",
  "workspace": "prof-mercer"
}
```

### Scopes

| Scope | Access |
|-------|--------|
| `memory:read` | Read-only access to the agent's own workspace |
| `memory:write` | Read + write access to the agent's own workspace |
| `memory:admin` | Full access to all workspaces, admin endpoints, Qdrant inspection |

### Workspace Isolation

- Non-admin tokens: `workspace` is derived from `sub` — the agent can only access its own graph.
- Admin tokens: Can target any workspace via the `X-Workspace: <agent_id>` header.

### Obtain a Token

```
POST /auth/token
Content-Type: application/json

{
  "agent_id": "prof-mercer",
  "secret": "<shared-secret>"
}
```

**Response** `200 OK`:
```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 86400
}
```

**Errors**:
- `401` — Invalid secret
- `400` — Missing `agent_id`

---

## Agent Memory Endpoints

These are the core endpoints agents use for read/write. Require `memory:read` or `memory:write` scope.

---

### POST /memory/stash

Insert text into the agent's knowledge graph. **Async** — returns immediately, extraction runs in background.

**Request**:
```json
{
  "content": "The authentication system uses a flat ownership model where each user owns their own resources directly.",
  "metadata": "architecture"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | The text to remember |
| `metadata` | string | no | Tag or category (e.g., "architecture", "debugging") |

**Response** `202 Accepted`:
```json
{
  "status": "queued",
  "job_id": "job_a1b2c3d4",
  "message": "Memory stashed, extraction in progress"
}
```

---

### POST /memory/stash/file

Insert file contents into the agent's knowledge graph. **Async**.

**Request**: `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes | The file to ingest (text-based: .md, .txt, .py, etc.) |
| `metadata` | string | no | Tag or category |

**Response** `202 Accepted`:
```json
{
  "status": "queued",
  "job_id": "job_e5f6g7h8",
  "message": "File stashed, extraction in progress"
}
```

---

### POST /memory/stash/batch

Bulk insert multiple items. **Async** — single job for all items.

**Request**:
```json
{
  "items": [
    { "content": "Lesson 1: Always validate at system boundaries.", "metadata": "patterns" },
    { "content": "Lesson 2: Prefer composition over inheritance for auth middleware.", "metadata": "patterns" }
  ]
}
```

**Response** `202 Accepted`:
```json
{
  "status": "queued",
  "job_id": "job_batch_x9y0",
  "item_count": 2
}
```

---

### POST /memory/recall

Semantic query **with LLM synthesis**. Returns a natural-language answer grounded in the agent's memory graph.

**Request**:
```json
{
  "query": "What analogies has Mercer used to teach authentication concepts?",
  "mode": "hybrid"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language query |
| `mode` | string | no | `"hybrid"` | Query mode: `naive`, `local`, `global`, `hybrid`, `mix` |

**Response** `200 OK`:
```json
{
  "answer": "Professor Mercer has used several analogies for teaching authentication...",
  "sources": ["doc_abc123", "doc_def456"]
}
```

---

### POST /memory/recall/raw

Semantic query **without LLM synthesis**. Returns raw context chunks, matched entities, and relationships.

**Request**:
```json
{
  "query": "Socratic scaffolding teaching method",
  "mode": "hybrid",
  "top_k": 20
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language query |
| `mode` | string | no | `"hybrid"` | Query mode |
| `top_k` | integer | no | `20` | Max results to return |

**Response** `200 OK`:
```json
{
  "context": "Raw concatenated context from matching chunks...",
  "entities": [
    { "name": "Socratic Scaffolding", "type": "Concept", "description": "A five-step teaching method..." }
  ],
  "relationships": [
    { "source": "Prof Mercer", "target": "Socratic Scaffolding", "description": "teaches using" }
  ]
}
```

---

### POST /memory/recall/graph

**Deep query** — returns structured graph data (nodes + edges) without LLM synthesis. This is the primary endpoint for building graph visualizations.

**Request**:
```json
{
  "query": "HTTP vs gRPC protocol decision",
  "mode": "hybrid",
  "top_k": 30,
  "include_chunks": true,
  "include_embeddings": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language query |
| `mode` | string | no | `"hybrid"` | Query mode |
| `top_k` | integer | no | `30` | Max entities to return |
| `include_chunks` | boolean | no | `false` | Include source text chunks |
| `include_embeddings` | boolean | no | `false` | Include raw embedding vectors (for similarity viz) |

**Response** `200 OK`:
```json
{
  "entities": [
    {
      "name": "Auth Ownership Model",
      "type": "Concept",
      "description": "A flat ownership model where each user owns their own resources directly.",
      "importance": 4,
      "embedding": [0.012, -0.034, ...]
    }
  ],
  "relationships": [
    {
      "source": "Auth Ownership Model",
      "target": "Defense In Depth",
      "keywords": "security, layered-defense",
      "description": "Auth ownership model complements defense-in-depth by...",
      "weight": 0.85,
      "embedding": [0.008, -0.021, ...]
    }
  ],
  "chunks": [
    {
      "id": "chunk_abc123",
      "text": "The authentication system uses a flat ownership model...",
      "source_doc": "architecture-decisions.md",
      "embedding": [0.015, -0.028, ...]
    }
  ],
  "query_keywords": ["authentication", "ownership", "defense-in-depth"]
}
```

> **Note**: `embedding` fields are only present when `include_embeddings: true`. Vectors are float arrays whose dimension depends on the configured embedding model (default 768).

**Implementation detail**: This endpoint does NOT call the LLM. It:
1. Extracts keywords from the query using LightRAG's keyword extractor
2. Performs vector search across entity/relation/chunk indices
3. Extracts the subgraph around matched entities
4. Returns structured JSON

---

### POST /memory/similarity

**Similarity search** — find entities, relationships, or chunks similar to a given node/edge/text. This is the key endpoint for "use this node as a query" in the viewer.

**Request**:
```json
{
  "anchor": {
    "type": "entity",
    "name": "Auth Ownership Model"
  },
  "target_types": ["entity", "relationship", "chunk"],
  "top_k": 20,
  "threshold": 0.5,
  "include_embeddings": true,
  "cross_workspace": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `anchor` | object | yes | — | The item to search from (see Anchor Types below) |
| `target_types` | string[] | no | `["entity"]` | What to search for: `entity`, `relationship`, `chunk` |
| `top_k` | integer | no | `20` | Max results per target type |
| `threshold` | float | no | `0.0` | Min cosine similarity (0.0–1.0) |
| `include_embeddings` | boolean | no | `false` | Return embedding vectors in results |
| `cross_workspace` | boolean | no | `false` | Admin only — search across all workspaces |

**Anchor Types**:

```json
// By entity name (looks up its embedding)
{ "type": "entity", "name": "Auth Ownership Model" }

// By relationship (source + target, looks up edge embedding)
{ "type": "relationship", "source": "Prof Mercer", "target": "Socratic Scaffolding" }

// By chunk ID
{ "type": "chunk", "id": "chunk_abc123" }

// By raw text (computes embedding on the fly)
{ "type": "text", "content": "How does role-based access control relate to ownership?" }

// By raw embedding vector (for external tools that already have a vector)
{ "type": "vector", "embedding": [0.012, -0.034, ...] }
```

**Response** `200 OK`:
```json
{
  "anchor": { "type": "entity", "name": "Auth Ownership Model" },
  "results": {
    "entity": [
      {
        "name": "RBAC",
        "type": "Concept",
        "description": "Role-Based Access Control...",
        "similarity": 0.89,
        "embedding": [0.011, -0.033, ...],
        "workspace": "prof-mercer"
      }
    ],
    "relationship": [
      {
        "source": "RBAC",
        "target": "Auth Ownership Model",
        "description": "RBAC extends ownership with roles...",
        "similarity": 0.82,
        "weight": 0.75,
        "embedding": [0.009, -0.025, ...],
        "workspace": "prof-mercer"
      }
    ],
    "chunk": [
      {
        "id": "chunk_xyz789",
        "text": "Role-based access control builds upon...",
        "source_doc": "auth-patterns.md",
        "similarity": 0.78,
        "embedding": [0.014, -0.030, ...],
        "workspace": "prof-mercer"
      }
    ]
  }
}
```

---

### DELETE /memory/forget

Remove specific knowledge from the graph.

**Request**:
```json
{
  "entity_name": "Deprecated Auth Pattern",
  "doc_id": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `entity_name` | string | no | Name of entity to remove (and its edges) |
| `doc_id` | string | no | Document ID to remove |

At least one of `entity_name` or `doc_id` must be provided.

**Response** `200 OK`:
```json
{
  "status": "removed",
  "entities_removed": 2,
  "relations_removed": 5
}
```

---

### GET /memory/status

Graph statistics for the authenticated agent's workspace.

**Response** `200 OK`:
```json
{
  "workspace": "prof-mercer",
  "entity_count": 142,
  "relation_count": 287,
  "document_count": 12,
  "chunk_count": 384,
  "storage_bytes": 524288,
  "last_updated": "2026-02-20T18:30:00Z",
  "embedding_model": "nomic-embed-text",
  "embedding_dim": 768,
  "ingest_model": "llama3.2:3b"
}
```

---

### GET /memory/jobs/{job_id}

Check the status of an async stash operation.

**Response** `200 OK`:
```json
{
  "job_id": "job_a1b2c3d4",
  "status": "completed",
  "entities_extracted": 12,
  "relations_extracted": 23,
  "chunks_created": 8,
  "duration_ms": 4500,
  "error": null
}
```

| Status | Description |
|--------|-------------|
| `queued` | Waiting to be processed |
| `processing` | Extraction in progress |
| `completed` | Finished successfully |
| `failed` | Error occurred (see `error` field) |

---

## Admin Endpoints

Require `memory:admin` scope. These power the admin dashboard and graph viewer.

---

### GET /admin/graphs

List all workspaces (agent memory graphs) with summary stats.

**Response** `200 OK`:
```json
{
  "graphs": [
    {
      "workspace": "prof-mercer",
      "entity_count": 142,
      "relation_count": 287,
      "document_count": 12,
      "storage_bytes": 524288,
      "last_updated": "2026-02-20T18:30:00Z",
      "embedding_model": "nomic-embed-text",
      "ingest_model": "llama3.2:3b"
    },
    {
      "workspace": "kirk",
      "entity_count": 89,
      "relation_count": 156,
      "document_count": 8,
      "storage_bytes": 312400,
      "last_updated": "2026-02-19T12:00:00Z",
      "embedding_model": "nomic-embed-text",
      "ingest_model": "llama3.2:3b"
    }
  ]
}
```

---

### GET /admin/graphs/{agent_id}

Detailed stats for a specific agent's graph, including model configuration and type breakdowns.

**Response** `200 OK`:
```json
{
  "workspace": "prof-mercer",
  "entity_count": 142,
  "relation_count": 287,
  "document_count": 12,
  "chunk_count": 384,
  "storage_bytes": 524288,
  "last_updated": "2026-02-20T18:30:00Z",
  "embedding_model": "nomic-embed-text",
  "embedding_dim": 768,
  "ingest_model": "llama3.2:3b",
  "entity_types": {
    "Concept": 58,
    "Person": 12,
    "Technology": 34,
    "Pattern": 22,
    "Decision": 16
  },
  "top_entities": [
    { "name": "Prof Mercer", "type": "Person", "degree": 45, "description": "..." },
    { "name": "Defense In Depth", "type": "Concept", "degree": 23, "description": "..." }
  ],
  "vector_store": {
    "backend": "qdrant",
    "collection": "prof-mercer",
    "point_count": 526,
    "index_status": "indexed"
  }
}
```

---

### GET /admin/graphs/{agent_id}/subgraph

Query-scoped subgraph in a format ready for force-directed graph rendering. This is the primary endpoint the graph viewer calls.

**Query Parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | no | — | Seed query to scope the subgraph (omit for full graph) |
| `depth` | integer | no | `2` | How many hops from matched entities |
| `max_nodes` | integer | no | `200` | Cap on returned nodes |
| `max_edges` | integer | no | `500` | Cap on returned edges |
| `include_embeddings` | boolean | no | `false` | Include embedding vectors per node/edge |
| `include_chunks` | boolean | no | `false` | Include source chunks linked to nodes |
| `entity_types` | string | no | — | Comma-separated type filter (e.g., `Concept,Person`) |

**Response** `200 OK`:
```json
{
  "nodes": [
    {
      "id": "Socratic Scaffolding",
      "type": "Concept",
      "description": "A five-step teaching method: anchor, question, explore, connect, check.",
      "degree": 12,
      "importance": 5,
      "summary": "Five-step teaching method used by Prof Mercer",
      "embedding": [0.012, -0.034, ...],
      "chunks": [
        { "id": "chunk_abc", "text": "...", "source_doc": "teaching-methods.md" }
      ]
    },
    {
      "id": "Prof Mercer",
      "type": "Person",
      "description": "Computer science professor specializing in systems and security.",
      "degree": 45,
      "importance": 8,
      "summary": "CS professor, systems & security",
      "embedding": [0.009, -0.041, ...]
    }
  ],
  "edges": [
    {
      "source": "Prof Mercer",
      "target": "Socratic Scaffolding",
      "label": "teaches using",
      "description": "Prof Mercer employs Socratic scaffolding as his primary pedagogical method.",
      "weight": 0.9,
      "keywords": "teaching, pedagogy, scaffolding",
      "embedding": [0.008, -0.021, ...]
    }
  ],
  "meta": {
    "workspace": "prof-mercer",
    "query": "teaching methods",
    "depth": 2,
    "total_nodes": 47,
    "total_edges": 83,
    "truncated": false,
    "embedding_model": "nomic-embed-text",
    "embedding_dim": 768
  }
}
```

> **Viewer note**: The `importance` field (1–10) can drive node size. The `degree` field (edge count) can drive an alternative sizing. `weight` on edges can drive edge thickness/opacity. `embedding` vectors can be used to compute layout positions via UMAP/t-SNE or for custom similarity coloring. `summary` is a short label suitable for display on the node glow sprite.

---

### POST /admin/graphs/{agent_id}/query

Query any agent's graph with admin privileges. Same request/response shape as `/memory/recall`.

**Request**:
```json
{
  "query": "What does this agent know about authentication?",
  "mode": "hybrid",
  "raw": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Query text |
| `mode` | string | no | `"hybrid"` | Query mode |
| `raw` | boolean | no | `false` | If true, returns raw context (no LLM synthesis) |

**Response**: Same as `/memory/recall` or `/memory/recall/raw` depending on `raw` flag.

---

### POST /admin/graphs/{agent_id}/similarity

Admin version of similarity search, scoped to a specific workspace. Same request/response as `/memory/similarity` but with explicit workspace targeting.

**Request**: Same as `/memory/similarity`.

**Response**: Same as `/memory/similarity`.

---

### POST /admin/similarity/cross

Cross-workspace similarity search. Find similar entities/concepts across all agent graphs.

**Request**:
```json
{
  "anchor": {
    "type": "entity",
    "name": "Defense In Depth",
    "workspace": "prof-mercer"
  },
  "target_types": ["entity"],
  "top_k": 20,
  "threshold": 0.6,
  "include_embeddings": true,
  "workspaces": ["kirk", "sophia"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `anchor` | object | yes | — | Same anchor types as `/memory/similarity`, plus required `workspace` |
| `workspaces` | string[] | no | all | Which workspaces to search (omit for all) |
| `target_types` | string[] | no | `["entity"]` | What to search for |
| `top_k` | integer | no | `20` | Max results per workspace per type |
| `threshold` | float | no | `0.0` | Min cosine similarity |
| `include_embeddings` | boolean | no | `false` | Return vectors |

**Response** `200 OK`:
```json
{
  "anchor": { "type": "entity", "name": "Defense In Depth", "workspace": "prof-mercer" },
  "results_by_workspace": {
    "kirk": {
      "entity": [
        { "name": "Security Layers", "type": "Concept", "similarity": 0.84, "workspace": "kirk" }
      ]
    },
    "sophia": {
      "entity": [
        { "name": "Multi-Layer Protection", "type": "Concept", "similarity": 0.79, "workspace": "sophia" }
      ]
    }
  }
}
```

---

### DELETE /admin/graphs/{agent_id}

Delete an agent's entire graph. **Destructive** — requires confirmation header.

**Request Headers**:
```
X-Confirm-Delete: true
```

**Response** `200 OK`:
```json
{
  "status": "deleted",
  "workspace": "kirk",
  "entities_removed": 89,
  "relations_removed": 156,
  "documents_removed": 8
}
```

**Errors**:
- `400` — Missing `X-Confirm-Delete` header
- `404` — Workspace not found

---

### GET /admin/health

System health check.

**Response** `200 OK`:
```json
{
  "status": "healthy",
  "workspaces_loaded": 3,
  "uptime_seconds": 86400,
  "storage_backend": "filesystem",
  "vector_backend": "qdrant",
  "qdrant_status": "connected",
  "ollama_status": "connected",
  "ollama_models": {
    "embedding": "nomic-embed-text",
    "ingest": "llama3.2:3b"
  }
}
```

---

## Model Configuration Endpoints

Admin endpoints for inspecting and configuring the Ollama models used for embedding and ingestion.

---

### GET /admin/models

List configured and available models.

**Response** `200 OK`:
```json
{
  "active": {
    "embedding": {
      "provider": "ollama",
      "model": "nomic-embed-text",
      "dim": 768,
      "max_tokens": 8192
    },
    "ingest": {
      "provider": "ollama",
      "model": "llama3.2:3b",
      "context_length": 8192
    }
  },
  "available": {
    "ollama_models": [
      { "name": "nomic-embed-text", "type": "embedding", "size": "274MB", "dim": 768 },
      { "name": "mxbai-embed-large", "type": "embedding", "size": "670MB", "dim": 1024 },
      { "name": "llama3.2:3b", "type": "llm", "size": "2.0GB", "context_length": 8192 },
      { "name": "llama3.2:1b", "type": "llm", "size": "1.3GB", "context_length": 8192 },
      { "name": "qwen2.5:7b", "type": "llm", "size": "4.7GB", "context_length": 32768 }
    ]
  }
}
```

---

### PUT /admin/models/embedding

Change the active embedding model. Only affects new ingestions — existing embeddings remain in their original model's space.

**Request**:
```json
{
  "provider": "ollama",
  "model": "mxbai-embed-large",
  "dim": 1024
}
```

**Response** `200 OK`:
```json
{
  "status": "updated",
  "previous": { "model": "nomic-embed-text", "dim": 768 },
  "current": { "model": "mxbai-embed-large", "dim": 1024 },
  "warning": "Existing embeddings were computed with nomic-embed-text (dim=768). New embeddings will use mxbai-embed-large (dim=1024). Consider re-indexing affected workspaces."
}
```

---

### PUT /admin/models/ingest

Change the active ingest (extraction) LLM model.

**Request**:
```json
{
  "provider": "ollama",
  "model": "qwen2.5:7b"
}
```

**Response** `200 OK`:
```json
{
  "status": "updated",
  "previous": { "model": "llama3.2:3b" },
  "current": { "model": "qwen2.5:7b" }
}
```

---

### POST /admin/graphs/{agent_id}/reindex

Re-compute embeddings for an entire workspace using the current embedding model. Useful after changing embedding models.

**Request**:
```json
{
  "confirm": true
}
```

**Response** `202 Accepted`:
```json
{
  "status": "queued",
  "job_id": "reindex_prof-mercer_abc123",
  "workspace": "prof-mercer",
  "estimated_items": 526,
  "embedding_model": "mxbai-embed-large"
}
```

---

## Qdrant Vector Store Endpoints

When Qdrant is configured as the vector backend (`VECTOR_BACKEND=qdrant`), these additional admin endpoints expose direct vector inspection capabilities.

---

### GET /admin/qdrant/collections

List all Qdrant collections (one per workspace, plus system collections).

**Response** `200 OK`:
```json
{
  "collections": [
    {
      "name": "prof-mercer",
      "point_count": 526,
      "vector_dim": 768,
      "index_status": "indexed",
      "on_disk": true,
      "size_bytes": 2097152
    }
  ]
}
```

---

### POST /admin/qdrant/collections/{collection}/search

Raw vector similarity search against a Qdrant collection. Useful for debugging or custom viewer queries.

**Request**:
```json
{
  "vector": [0.012, -0.034, ...],
  "top_k": 10,
  "threshold": 0.5,
  "filter": {
    "must": [
      { "key": "type", "match": { "value": "entity" } }
    ]
  },
  "with_payload": true,
  "with_vectors": true
}
```

**Response** `200 OK`:
```json
{
  "results": [
    {
      "id": "entity_auth_ownership_model",
      "score": 0.92,
      "payload": {
        "type": "entity",
        "name": "Auth Ownership Model",
        "description": "A flat ownership model...",
        "entity_type": "Concept",
        "workspace": "prof-mercer"
      },
      "vector": [0.011, -0.033, ...]
    }
  ]
}
```

---

### GET /admin/qdrant/collections/{collection}/points/{point_id}

Inspect a single point (entity, relationship, or chunk) in Qdrant.

**Response** `200 OK`:
```json
{
  "id": "entity_auth_ownership_model",
  "payload": {
    "type": "entity",
    "name": "Auth Ownership Model",
    "description": "A flat ownership model where each user owns their own resources directly.",
    "entity_type": "Concept",
    "workspace": "prof-mercer",
    "source_docs": ["architecture-decisions.md"],
    "created_at": "2026-02-18T10:00:00Z"
  },
  "vector": [0.012, -0.034, ...]
}
```

---

## Common Response Shapes

### Error Response

All error responses follow this shape:

```json
{
  "detail": "Human-readable error message",
  "code": "ERROR_CODE",
  "status": 401
}
```

| Status | Code | Meaning |
|--------|------|---------|
| `400` | `VALIDATION_ERROR` | Bad request body |
| `401` | `UNAUTHORIZED` | Missing or invalid token |
| `403` | `FORBIDDEN` | Valid token but insufficient scope |
| `404` | `NOT_FOUND` | Workspace or resource not found |
| `409` | `CONFLICT` | Resource conflict (e.g., workspace already exists) |
| `422` | `UNPROCESSABLE_ENTITY` | Valid JSON but semantically invalid |
| `500` | `INTERNAL_ERROR` | Server error |
| `503` | `SERVICE_UNAVAILABLE` | Qdrant or Ollama not reachable |

### Entity Object

```json
{
  "name": "string",
  "type": "string (Concept | Person | Technology | Pattern | Decision | ...)",
  "description": "string",
  "importance": "integer (1-10, optional)",
  "degree": "integer (edge count, optional)",
  "summary": "string (short label, optional)",
  "embedding": "float[] (optional, only when include_embeddings=true)",
  "workspace": "string (only in cross-workspace results)"
}
```

### Relationship Object

```json
{
  "source": "string (entity name)",
  "target": "string (entity name)",
  "label": "string (short verb phrase, optional)",
  "description": "string (full description)",
  "keywords": "string (comma-separated)",
  "weight": "float (0.0-1.0)",
  "embedding": "float[] (optional)",
  "workspace": "string (only in cross-workspace results)"
}
```

### Chunk Object

```json
{
  "id": "string",
  "text": "string",
  "source_doc": "string (filename)",
  "embedding": "float[] (optional)",
  "workspace": "string (only in cross-workspace results)"
}
```

---

## Configuration Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_SECRET` | *required* | HMAC secret for JWT signing |
| `TOKEN_EXPIRE_HOURS` | `24` | JWT expiration time |
| `GATEWAY_HOST` | `127.0.0.1` | Gateway bind address |
| `GATEWAY_PORT` | `9820` | Gateway bind port |
| `RAG_STORAGE_ROOT` | `./rag_storage` | Parent directory for workspace storage |
| `VECTOR_BACKEND` | `nano` | Vector backend: `nano` (NanoVDB) or `qdrant` |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `QDRANT_API_KEY` | — | Qdrant API key (optional, for Qdrant Cloud) |
| `LLM_PROVIDER` | `ollama` | LLM provider for ingest |
| `LLM_MODEL` | *required* | Ingest/extraction model (e.g., `llama3.2:3b`) |
| `LLM_BASE_URL` | `http://localhost:11434` | Ollama API URL |
| `EMBEDDING_PROVIDER` | `ollama` | Embedding provider |
| `EMBEDDING_MODEL` | *required* | Embedding model (e.g., `nomic-embed-text`) |
| `EMBEDDING_DIM` | `768` | Embedding vector dimension |
| `EMBEDDING_MAX_TOKENS` | `8192` | Max tokens per embedding call |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## CORS

The gateway enables CORS for the admin dashboard/viewer:

- **Allowed origins**: Configurable via `CORS_ORIGINS` env var (default: `http://localhost:3000,http://localhost:5173`)
- **Allowed methods**: `GET, POST, PUT, DELETE, OPTIONS`
- **Allowed headers**: `Authorization, Content-Type, X-Workspace, X-Confirm-Delete`

---

## WebSocket (Future)

A WebSocket endpoint is planned for real-time graph updates in the viewer:

```
WS /ws/graph/{agent_id}
```

Events:
- `node_added` — new entity extracted
- `edge_added` — new relationship extracted
- `job_progress` — stash job progress updates
- `job_completed` — stash job finished

This is not yet implemented but the viewer should be designed to accommodate it.
