# Portable GraphRAG Integration Playbook (Standalone Backend)

## Design Philosophy

This document captures **portable** architecture and prompt wisdom for running MindMapper-style ingestion/retrieval against a standalone GraphRAG backend (for example, LightRAG-style graph+vector indexing and dual-level retrieval).

The goal is not to mirror one implementation. The goal is to preserve the invariants that survive backend swaps.

Core principles:

1. **Orchestrate, don't own**: the caller coordinates, the backend remains authoritative for graph + retrieval state.
2. **Reference, don't copy**: vector payloads should carry IDs and minimal metadata; canonical text lives in one store.
3. **Per-step data-shape agreement**: if chunking partitions content, extraction must consume those partitions (not full docs).
4. **Model-aware batching**: context window is not attention budget; batch sizes are model dependent.
5. **Semantic edge reasons are first-class**: edge description quality directly controls retrieval quality.

---

## Service Boundaries (Portable)

```text
[Client / Orchestrator]
    | 1) Chunk, extract, dedupe, upsert
    v
[Standalone GraphRAG Backend]
    - Owns graph index
    - Owns vector index
    - Owns retrieval APIs (entity/edge + high-level context)
    |
    | 2) Returns references + ranked context
    v
[Answer Generation LLM]
```

### What the orchestrator should do

- Chunk raw content into semantically coherent units.
- Run extraction prompts with known-node context.
- Enforce schema validation and retries.
- Upsert nodes/edges/chunks through backend APIs.
- Handle failure isolation and observability.

### What the backend should do

- Store canonical graph structures and vector indices.
- Support incremental upsert without full re-index.
- Expose retrieval in two modes:
  - Low-level (entity/edge-centric, precise)
  - High-level (theme/subgraph-centric, broad)

### What this backend should NOT do

- Own business workflow semantics from the caller domain.
- Accept copied canonical text in multiple stores without freshness contract.
- Require callers to coordinate multi-write atomicity across multiple backend endpoints.

---

## Portable Model Recommendations

These recommendations assume three distinct tasks:

1. Embedding text for retrieval
2. Extracting nodes/edges from chunks
3. Writing semantically rich edge reasons

| Task | Recommended Default | Fallback | Why |
|---|---|---|---|
| Embeddings (cost/speed balanced) | `embeddinggemma` (local) | `nomic-embed-text` (local) | Strong speed/quality tradeoff; supports local-first retrieval loops. |
| Embeddings (quality-first cloud) | NVIDIA-hosted retriever-class embedding model | OpenAI/Google embedding endpoints | Higher quality at higher latency/cost; use when recall pressure dominates. |
| Node+edge extraction | Claude 3.7 Sonnet-class model | Qwen3-Next 80B-class model | Best observed coverage + edge density + reason quality under heavy chunk batches. |
| Chat synthesis over retrieved context | Fast model for default, stronger model for deep reasoning | Same extraction model as shared pool | Keep extraction quality high; chat can scale by query difficulty. |

### Operational model strategy

- **Separate extraction and chat models** when possible (different workload shapes).
- Keep embeddings local-first when edge quality + graph topology are doing precision work.
- If retrieval quality plateaus, improve edge reason prompts before paying for heavier embeddings.

---

## Chunking and Batching Defaults

## 1) Semantic chunking (content partition)

- Target: **500-1500 chars** per chunk.
- Allow larger chunks when needed to preserve complete thought.
- Never split mid-paragraph or orphan headers from their body.
- Preserve all source text across chunk set (split, do not summarize).

## 2) Extraction batching (LLM call shaping)

- Start with **batch size 10 chunks/request** for Sonnet-class extraction.
- Reduce to **batch size 5** for weaker/local models that collapse output under larger batches.
- Increase only with evidence that entity and edge yield still scales.

## 3) Embedding safety budget

- Enforce a backend-aware max input length (chars/tokens) discovered from backend constants.
- Do not hardcode limits in multiple services.
- Add a seam test: post-chunk text must always satisfy embedding input limits.

---

## Canonical Data Ownership Rules

For any standalone GraphRAG backend integration:

- Canonical owner of node/edge text must be explicit.
- Vector payloads should include:
  - `node_id` / `edge_id` / `chunk_id`
  - type metadata
  - optional compact routing hints
- Vector payloads should avoid:
  - copied long descriptions
  - copied edge reasons as canonical source
  - denormalized text without invalidation/TTL contract

If you must duplicate text for performance, treat it as cache:

- define TTL/invalidation
- prove correctness with cache cold/miss path
- log staleness metrics

---

## Full Prompt: Semantic Chunking (Portable)

Use this prompt before node/edge extraction.

```text
You are preparing a document for ingestion into a graph-enhanced retrieval system.

## YOUR GOAL
Split this document into richly annotated semantic units. Each chunk will be:
1) embedded for retrieval
2) analyzed for entities, relationships, and graph updates

Good chunks are self-contained: if retrieved alone, they still make sense.

## TARGET CHUNK SIZE
Aim for 500-1500 characters per chunk.
- Smaller improves retrieval precision
- Never cut mid-thought or mid-paragraph
- Keep headers with their content
- A complete idea at 2000 chars is better than half an idea at 500

## BOUNDARY SIGNALS
Use headers as strong hints, plus:
- topic shifts
- speaker changes
- date/time markers
- numbered section transitions
- blank-line semantic breaks

## CRITICAL CONTENT RULE
You are splitting, not summarizing.
Every source word must appear in at least one chunk.
Do not paraphrase. Do not omit details.

## OUTPUT SCHEMA
Return ONLY a JSON array (no markdown fence). Each item:
{
  "text": "chunk text, preserving source language",
  "attributed_to": "full name or null",
  "section_type": "memory|persona_insight|lesson|definition|concept|narrative|metadata",
  "related_features": ["optional feature/issue IDs"],
  "named_entities": ["central entities only"],
  "participants": ["required when memory/persona_insight, else []"],
  "datetime": "ISO-8601/date/null",
  "key_insight": "one sentence for memory/persona_insight or null"
}

## QUALITY RULES
1) Keep attribution with the content it describes.
2) Chunks must be retrievable standalone.
3) named_entities should be graph-worthy entities, not passing mentions.
4) Memory/persona_insight chunks should include participants and a concise key insight.
```

---

## Full Prompt: Node + Edge Extraction (Portable)

Use this prompt per extraction batch (typically ~10 chunks for strong models).

```text
You are expanding an existing knowledge graph from new text chunks.

## EXISTING NODES (reuse IDs if matched)
{known_nodes_json}

## NEW CHUNKS
{tagged_chunks}

Each chunk has:
- chunk_id
- source_doc
- chunk_text
- optional semantic metadata

## YOUR TASK
1) Reuse existing node IDs whenever chunk content matches existing concepts/entities.
2) Create new nodes only when no existing node represents the concept.
3) Create rich edges. Every important new node should connect to at least 2 meaningful neighbors when supported by text.
4) Link each chunk to its main concepts with provenance edges.
5) Keep all outputs grounded in the provided text.

## NODE REQUIREMENTS
Each node:
- id (reuse existing or create new stable ID)
- node_type (PERSON|ORGANIZATION|PROJECT|TECHNOLOGY|PLACE|CONCEPT|FILE|CODE|REPOSITORY|LESSON|WISDOM|MEMORY|ANY)
- text (concise label)
- description (self-contained, retrieval-ready)
- sources (array of source docs)
- importance (1-5)
- attributed_to (required for WISDOM/LESSON/MEMORY when attribution exists; otherwise null)

Description quality:
- PERSON: who they are + why they matter
- CONCEPT/TECHNOLOGY: what it is and role
- WISDOM/LESSON/MEMORY: the learning, context, and practical implication

## EDGE REQUIREMENTS
Each edge:
- from
- to
- reason
- weight (0.1-1.0, optional if your pipeline computes weight later)
- evidence_chunk_ids (array)

CRITICAL EDGE RULE:
Edge reason must explicitly name BOTH endpoints.

Good:
- "Neo4j stores graph entities used by MindMapper retrieval workflows"
- "Kirk Anderson identified copy-not-reference drift in vector payload design"

Bad:
- "related concept"
- "uses this"
- "connected"

## PROVENANCE RULE
For each chunk, include at least one chunk->concept edge:
- from: chunk_id
- to: concept/entity node id
- reason: explicit statement of what the chunk says about that node

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "nodes": [ ... ],
  "edges": [ ... ],
  "stats": {
    "reused_node_count": 0,
    "new_node_count": 0,
    "edge_count": 0
  }
}
```

---

## Retrieval Interaction Pattern (Standalone Backend)

For LightRAG-style backends, use a dual-pass retrieval adapter:

1. **Low-level retrieval pass**
   - query entities, exact relations, local neighborhoods
2. **High-level retrieval pass**
   - query themes, multi-hop conceptual neighborhoods
3. **Merge + rank**
   - dedupe by canonical IDs
   - prioritize exact entity hits + diverse thematic support
4. **Answer generation**
   - pass compact, cited context bundle to answer model

This preserves precision + breadth and maps directly to graph-enhanced RAG patterns.

---

## Failure Modes and Detection

| Failure Mode | Detection | Response |
|---|---|---|
| Extraction output collapses at high batch size | Entity/edge counts flatten as chunks increase | Reduce batch size per model profile |
| Edge semantics too weak | Retrieval returns generic context | Tighten edge reason prompt; enforce endpoint naming |
| Stale copied text in vector payload | Mismatch between graph source and retrieval output | Remove copied text; store IDs only |
| Embedding limit violations | 400/validation errors from embedding backend | Discover limits dynamically and clamp upstream |
| Chunk/extractor shape mismatch | Good chunking but poor extraction coherence | Ensure extraction consumes chunk partitions directly |

---

## Decision Log (Portable Defaults)

| ID | Decision | Alternatives | Rationale |
|---|---|---|---|
| D-P1 | Keep backend as authority for graph/vector state | Split authority across caller/backend | Reduces drift and stale data classes |
| D-P2 | Use per-chunk extraction with known-node accumulation | Whole-doc extraction | Avoids context overrun, improves linkage |
| D-P3 | Prioritize edge reason quality as retrieval lever | Focus only on embedding model upgrades | Better cost/quality slope |
| D-P4 | Model-aware batching defaults (start at 10 for strong extractors) | Global fixed batch | Context window != attention budget |
| D-P5 | Reference-only vector payloads | Copy text into payloads | Canonical ownership + freshness integrity |

---

## Implementation Checklist

- [ ] Backend constants endpoint exposes embedding constraints and model metadata.
- [ ] Chunker preserves complete source coverage and semantic boundaries.
- [ ] Extraction prompt enforces explicit endpoint naming in edge reasons.
- [ ] Known-node reuse is validated before node creation.
- [ ] Vector payloads store references, not canonical text copies.
- [ ] Dual-level retrieval adapter is implemented and observed separately.
- [ ] Seam tests cover chunk -> extraction -> embedding -> retrieval end-to-end.

---

## External Reference

- LightRAG overview and dual-level retrieval framing: [https://lightrag.github.io/](https://lightrag.github.io/)
