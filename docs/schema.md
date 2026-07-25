# tessera — schema rundown (for review)

One **named graph = one SQLite file** (`graphs/<name>/graph.db`), `better-sqlite3` + `sqlite-vec`, WAL,
single-writer (`BEGIN IMMEDIATE`). Everything is a **record**; all writes go through `GraphStore` verbs and
append to `mutation_log`. IDs are **v4 GUIDs** (`randomUUID()`); edges reference nodes by GUID (FKs). The full
v2.1 table set ships from day 1 (later slices add *logic*, not migrations); several tables are **schema-only
seams** today — marked ⏳ below.

## `nodes` — one row per entity/concept/source
| column | type | meaning | status |
|---|---|---|---|
| `id` | TEXT PK | v4 GUID | ✅ live |
| `type` | TEXT | NodeType enum (17 values, below) | ✅ |
| `subtype` | TEXT? | finer type (place/org/product/lesson…) — carries the extractor's detail (anti-sprawl) | ✅ |
| `origin` | TEXT | Origin enum (user/connector/dream/ingest) | ✅ |
| `text` | TEXT | **the identity/dedup basis** — `content_hash(normalizeText(text))`. For ingested entities this is the entity NAME. | ✅ (⚠️ see Identity) |
| `content_hash` | TEXT (indexed) | sha256 of normalized `text`; the dedup key | ✅ |
| `strength` | REAL=1 | reinforce count (++ on dedup hit) | ✅ |
| `timestamp` | INT | created-at | ✅ |
| `provenance` | TEXT(json)? | e.g. `{path}` for SOURCE | ✅ |
| `metadata` | TEXT(json)? | freeform — today holds `{name, description}` for entities, `{bio,…}` for personas | ✅ (⚠️ name/description live here, not as columns) |
| `last_observed` | INT? | SOURCE observation time (distinct from strength) | ⏳ column only |
| `observation_budget` | REAL? | SOURCE budget | ⏳ column only |
| `status` | TEXT | `proposed`\|`durable` — durable set only by a promote txn | ✅ column; promote logic ⏳ |
| `pinned` | INT=0 | never-decay flag | ⏳ |
| `frame_debt` | INT=0 | v3.1 PATTERN audit counter | ⏳ |
| `version` | INT=1 | ++ every mutation | ✅ |

## `edges` — structural spine (one row per unique from/to/kind/polarity)
| column | type | meaning | status |
|---|---|---|---|
| `id` | TEXT PK | v4 GUID | ✅ |
| `from_id` / `to_id` | TEXT → `nodes(id)` | endpoint GUIDs (FK) | ✅ |
| `kind` | TEXT | EdgeKind enum (6) | ✅ |
| `polarity` | TEXT='' | Polarity enum or '' (NULL would break the UNIQUE) | ✅ (used by CLAIM/INSIGHT later) |
| `semantic_weight` | REAL=0 | set at create | ✅ |
| `hebbian_weight` | REAL=0 | ++ on each re-`putEdge` (co-activation) | ✅ |
| `status` | TEXT | proposed\|durable | ✅ col; promote ⏳ |
| `version` | INT=1 | | ✅ |
| **UNIQUE** | | `(from_id, to_id, kind, polarity)` — **directed** (⚠️ see review finding #1) | ✅ |

## `edge_assertions` — many per edge (the reasons; an edge *owns* these)
| column | type | meaning |
|---|---|---|
| `id` | TEXT PK GUID | |
| `edge_id` | → `edges(id)` | owner edge |
| `reason` | TEXT | the human explanation (must name both endpoints) |
| `origin` | TEXT | who asserted it |
| `grounding` | TEXT? | citation/quote (⏳ unused) |
| `expert_surprise` | INT? | store-computed from endpoint embedding distance |
| `status`/`version` | | |
*Note (review): a new assertion is inserted on **every** `putEdge`, including reinforce → grows unboundedly on re-ingest.*

## Vector tables (4) — `vec0`, dim baked at graph creation (768)
`vec_node_quarantine`, `vec_node_shared`, `vec_assert_quarantine`, `vec_assert_shared`. Every embedding lands
in **quarantine**; a promote txn copies to **shared**. Node dedup's secondary check is KNN cosine `>0.99` over
`vec_node_quarantine`. ✅ quarantine live; ⏳ shared empty until promote is built.

## Deferred / seam tables (schema only today)
- `layout` (x,y,tile,zoom_min — the pyramid/get_tile viewer) ⏳
- `pyramid` (zoom,tile,node,rank — semantic-zoom LOD) ⏳
- `breaker_state` (per-origin circuit breaker for the connector/dream) ⏳
- `mutation_log` (event_id, effective_at, actor, cause, op, target_id, before, after) — **live**, append-only replay log ✅

## Enums
- **NodeType (17):** PERSON, AGENT, PROJECT, GOAL, CONCEPT, INSIGHT, QUESTION, CLAIM, MEMORY, SOURCE, QUOTE,
  SESSION, PATTERN, CONFLICT, SYSTEM_FEEDBACK, ACTION, TASK. *(Deliberately few; finer detail → `subtype`.)*
- **EdgeKind (6):** RELATED, ORIGINATED_FROM, APPEARED_IN, HEBBIAN_ASSOC, RESONATES_WITH, REFERENCES.
- **Polarity (4):** elaborates, supports, contradicts, depends_on (else '').
- **Origin (4):** user, connector, dream, ingest.
- **Status (2):** proposed, durable.

## Write contracts (Zod, `.strict()` — reject unknown fields)
- `PutNodeInput`: `{ type, subtype?, origin, text, provenance?, metadata?, pinned? }` (+ `Meta`, + optional vector).
- `PutEdgeInput`: `{ from, to, kind, polarity?, reason, origin, semanticWeight? }` (+ `Meta`, + optional reasonVector).
- `Meta` (on every mutation): `{ actor, cause, effectiveAt? }` — feeds the mutation_log.

## Ingest-layer types (above the store)
- **Extractor output** (`extractor.ts`): `Entity { name, type: EntityType(14), description }`,
  `Relation { source, target, reason }`. EntityType = PERSON/ORGANIZATION/PLACE/PROJECT/TECHNOLOGY/CODE/FILE/
  CONCEPT/EVENT/PRODUCT/LESSON/WISDOM/MEMORY/OTHER.
- **typemap** (`extract/typemap.ts`): EntityType → `{ NodeType, subtype }` (e.g. PLACE → CONCEPT/place,
  LESSON → INSIGHT/lesson) — the anti-sprawl mapping.

## Identity mechanics (the crux)
- **GUIDs are real and used** — nodes/edges/assertions each have a v4 GUID; edges wire by GUID.
- **BUT which GUID a new entity gets is decided by `content_hash(text=name)`**: same name → same GUID (dedup/
  reinforce). Great for shared hubs ("De Doorns" = one node across all docs); wrong for identity-bearing types
  (two distinct "Anele Sotashe" collapse). → the identity-fix cluster.
- **name/description are NOT first-class fields.** `name` = the node `text` (which doubles as the identity key)
  + `metadata.name`; `description` = `metadata.description` only, and it's **dropped on reinforce** (reinforce
  bumps strength only). → to be promoted to first-class, name decoupled from the identity key.

## Proposed changes (the identity-fix cluster — to review alongside this)
1. **First-class `name` + `description`** node fields (columns or a documented contract), name **decoupled from
   the dedup key** so identity = GUID + a resolution policy, not the name string.
2. **Identity policy by type:** hub types (PLACE/ORG/CONCEPT/PRODUCT/EVENT/TECH) dedup by name (shared hubs);
   identity types (PERSON, SOURCE) source-qualified (distinct instances stay distinct).
3. **SOURCE keyed by path**, not title.
4. **Type in the dedup key** (or a reinforce merge policy that keeps the richest description / flags type conflict).
5. **Undirected `RELATED` canonicalized** (`min(id),max(id)`), matching the connector/persona passes.
6. **Assertion idempotency** on re-ingest (skip duplicate reasons) — bound the unbounded growth.
