# tessera — ingest data model (target spec, post-review)

The data model "basic ingest" builds, after the cross-model architecture review + the RAG requirement. It is
the implementation contract for the identity/chunk fix. Everything is a Node or Edge in the existing
`GraphStore`; the store stays domain-agnostic (generic `content_hash(text)` dedup) — **the mapper owns the
identity policy** by constructing each node's `text` (the dedup basis) and its first-class `name`/`description`.

## Node types produced by ingest
| node | `text` (identity/dedup key) | `name` (display) | `description` / retrieval | notes |
|---|---|---|---|---|
| **SOURCE** (1 per doc) | `source\t<path>` | doc title | — (path in provenance) | keyed by PATH, not title |
| **CHUNK** (1 per chunk) | `chunk\t<sourceKey>\t<sha256(rawtext)[:16]>` | short label (first ~60 chars) | **raw chunk text** (embedded) | **NEW — the RAG retrieval unit** |
| **Hub entity** (PLACE/ORG/CONCEPT/PRODUCT/EVENT/TECHNOLOGY/CODE/FILE) | `<type>\t<normalized name>` | name | description | shared across docs → trope hubs |
| **Identity entity** (PERSON) | `<type>\t<normalized name>\t<sourceKey>` | name | description | distinct instances never merge |

- `sourceKey = sha256(source path).slice(0,8)` (matches `persona.ts`). `normalized = trim().toLowerCase()`.
- The **source path is canonicalized** (`path.resolve`) in the adapter, so `doc.md`, `./doc.md`, and an
  absolute path yield ONE source identity — a re-ingest under a different spelling reinforces, never duplicates.
- Same identity string → same GUID (dedup/reinforce). Different → new GUID. **Dedup is identity-only by
  default**: the store's secondary cosine near-dup merge is OPT-IN (`nearDupMerge:true`), so similar CONTENT
  never collapses distinct identities. Ingest never opts in — the content embedding is for RAG, not identity.
- **CHUNK identity = source + hash of its raw text** → re-ingesting the same doc reinforces the same chunks
  (idempotent); the same text in a *different* doc is a distinct chunk (source-qualified).

## Edges (provenance + relations)
| edge | kind | reason (names both endpoints) |
|---|---|---|
| CHUNK → SOURCE | `ORIGINATED_FROM` | "chunk N of <title>" |
| entity → CHUNK | `APPEARED_IN` | "<entity> appears in chunk N of <title>" |
| entity → entity | `RELATED` | the extracted relation reason |

- **`RELATED` is canonicalized**: undirected, stored `from = min(GUID), to = max(GUID)` (kills the A→B / B→A
  double-edge). ORIGINATED_FROM / APPEARED_IN stay directed (they are directional).
- **Ambiguous endpoints are dropped, not guessed**: relations carry entity *names*, not types. If a name split
  into two typed nodes in a chunk (PLACE Java / CONCEPT Java), a relation naming it is unresolvable → the edge
  is skipped rather than bound to an arbitrary (last-written) node. Only real new edges count toward the report.
- **Assertion idempotency**: `putEdge` skips inserting a new `edge_assertion` if an identical `reason` already
  exists on that edge (bounds unbounded growth on re-ingest).

## Provenance chain (why chunks are nodes)
`SOURCE (doc) ← CHUNK (raw text, embedded) ← entity`. Trace any entity to the exact passage; the CHUNK is the
retrievable evidence unit. **RAG flow:** `query → embed → KNN over CHUNK embeddings → top chunks (raw text) +
their linked entities/neighborhood → context` — never the whole doc.

## Identity policy summary
- **Hubs merge by name** (the trope signal we want): "De Doorns" is one node across every doc.
- **Identity-bearing nodes don't merge across sources**: PERSON is source-qualified; SOURCE is path-keyed;
  CHUNK is raw-text-keyed. Cross-doc "is this the same person?" is entity-resolution → deferred.
- **Type is part of identity** (baked into the `text` prefix): PLACE "Java" ≠ CONCEPT "Java".

## Store changes (small; pre-data, so "ship the schema", not a migration)
1. `nodes`: add `name TEXT` and `description TEXT` columns (first-class; `text` becomes pure identity, not
   display). `PutNodeInput` + `NodeRecord` gain `name?`/`description?`.
2. `putNode` reinforce: keep the **richer description** (longer non-empty), and set `name` if it was empty
   (never clobber a good value). When the description upgrades, **refresh the stored embedding** too, so
   retrieval never runs on a stale first-mention vector. A **type conflict** (only reachable via opt-in cosine
   merge) is not evidence: leave the node untouched, don't bump strength, log it.
3. `putEdge`: **assertion idempotency** — skip the assertion insert (and its vector) when an identical reason
   already exists for the edge; still bump `hebbian_weight`.
4. Everything the mapper does (identity strings, canonicalization, chunk nodes, provenance) is **ingest-layer**,
   not store logic.

## Fail-loud extraction (cheap correctness win)
`parseExtraction` never throws and returns a `parsed: boolean`; ingest counts bad chunks and the `IngestResult`
reports them, so a run that silently extracted nothing is visible (not a false success). **`parsed:false` means
NO parseable JSON object** (distinct from a valid-but-empty chunk). Salvage is **per-element**: one malformed
entity/relation drops only that row, never the whole chunk; a chatty model's decoy object is skipped in favour of
the first entities/relations-shaped payload. Relation endpoints match extracted names **case-insensitively**.

## Not changing
GraphStore single-writer/`BEGIN IMMEDIATE`, two-tier vec, mutation_log, the deferred engine
(resonator/dream/promote/prune), non-txt/md formats, the embedder eval.

## Tests (Tier-1, mocked extractor — the reviewers' gap)
A `StubChat`/canned-extraction test over `ingestFile` → assert: chunk nodes created + linked SOURCE←CHUNK←entity;
hub entities dedup across chunks, PERSON source-qualified; RELATED canonicalized (no A→B + B→A); re-ingest is
idempotent (no new nodes/assertions); SOURCE keyed by path; name/description first-class + reinforce keeps richer.
