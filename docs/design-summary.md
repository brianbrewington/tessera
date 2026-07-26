# tessera — Architecture & Design Summary (for cross-model review)

*Written for an architecture soundness review by Codex / Grok / Composer. Goal: catch an unsound foundation
before a large body of code is built on it. Be adversarial — where would this break, mislead, or fail to scale?*

> **Post-review status (revised model):** The review verdict was "architecture sound for the narrow scope,"
> with a converged cluster of **identity** findings (name-as-identity-key, un-canonicalized edges,
> title-keyed SOURCE, type-blind dedup, non-idempotent assertions). Those, plus **chunk nodes for RAG** and
> **name/description as first-class fields**, are now consolidated into the implementation contract in
> **`ingest-model.md`** — the current source of truth for identity + provenance. Sections 3.1 (provenance) and
> the identity notes below are **superseded by `ingest-model.md`**.

---

## 1. What tessera is
A **named, persistent knowledge graph** built from **heterogeneous documents** (personas, chat transcripts,
code, wiki pages, email, book chapters) via **LLM entity+relation extraction**, rendered as a browsable map.
It is domain-agnostic: you keep *one named graph* for personas, *another* for book-ideas + research papers,
etc. Long-term it grows a "resonator" (decay/prominence/clustering) and a "dream" (generative connection)
engine — but those are **explicitly deferred**; today's target is that **basic ingest is rock-solid**.

Prior art: this is the distillation of several earlier systems the author built (a memory-agent on LightRAG,
MindMapper on Neo4j+Qdrant, a social-sim graph, an embeddings-experiments corpus). Their durable lessons are
tagged `[KEEP]`/`[ADAPT]` in `docs/ideas-ledger.md`; the full plan of record is `docs/plan-v3.md`.

## 2. Use cases
- **Persona populations** (the immediate driver): ingest ~150 synthetic personas → a graph whose hubs are the
  shared places/concepts/entities → later, spot tropes and near-duplicates (the "population editor").
- **A personal research graph**: book chapters + research papers + notes in one named graph, cross-linked.
- **Conversational memory**: ingest chat transcripts → people/projects/decisions/lessons with attribution.
- **A codebase map**: files/modules/functions/technologies and how they relate.
Each is a *named* graph; the same pipeline serves all (a doc is a doc).

## 3. Architecture

### 3.1 The ingest pipeline (the tracer's spine)
`named graph → adapter (txt/md) → chunker → extractor (LLM) → graph-mapper → GraphStore → export → viewer`.
Each stage is a small module behind a seam:
- **Adapter** (`src/ingest/adapters.ts`): a file → `{source, title, text}`. Only `.txt`/`.md` today; other
  formats are new impls behind the same `readDoc` seam.
- **Chunker** (`src/ingest/chunker.ts`): text → self-contained chunks (~1500 chars, paragraph boundaries).
  **Deliberately naive**; size/overlap tuning is coupled to the extraction model and deferred (backlog).
- **Extractor** (`src/extract/extractor.ts`): a `Chat`-backed `Extractor` returning Zod-validated
  `{entities:[{name,type,description}], relations:[{source,target,reason}]}`. The prompt (ported from
  `docs/history`) enforces: typed entities incl. single-mention proper names, multi-word names kept whole,
  **NEGATIVE_CONSTRAINTS** (drop buzzwords/abstractions/empty-shells), and the **CRITICAL EDGE RULE** —
  every relation reason must *name both endpoints*. Output is JSON (not LightRAG's delimiter format) for
  robust TS parsing; a brace-balanced extractor tolerates chatty models; dangling relations are dropped.
- **Graph-mapper** (`src/ingest/mapper.ts`): entity → a typed node whose **`text` is the entity name** (so
  same-named entities dedup into ONE shared hub via the store's content_hash — the trope signal); the
  description goes in metadata. Relation → a `RELATED` edge whose reason becomes the `edge_assertion`. New
  entities get an `ORIGINATED_FROM` provenance edge to a per-document `SOURCE` node. Node-reuse within a doc
  is a name→id map accumulated across its chunks.

### 3.2 The store (`src/store/graphStore.ts`) — the sole writable authority
- `better-sqlite3` + `sqlite-vec`, WAL, single-writer (`BEGIN IMMEDIATE`), every mutation appended to a
  replay-grade `mutation_log`. Records in / hydrated records out; all writes go through GraphStore verbs.
- **Dedup**: primary `content_hash(normalizeText(text))`; an **opt-in** (`nearDupMerge:true`) secondary KNN
  cosine `> 0.99` over a *quarantine* vector table (ingest never opts in — identity is content_hash only). A hit
  **reinforces** (`strength += 1`, no new row, richer description wins, embedding refreshed on upgrade) →
  idempotent re-ingest. Nodes embed on a supplied vector or (default) their text.
- **Two-tier vectors** (quarantine → shared): everything lands in quarantine on write; `promoteNode` is the
  only path to the durable "shared" tier (promote-hardening is **not yet built** — a known gap).
- **Edges**: a structural spine (`edges`, unique on from/to/kind/polarity) separate from **`edge_assertions`**
  (many per edge — reason + embedding + origin + a store-computed `expert_surprise`).
- `strength` (reinforce count) exists; **decay/prominence are NOT implemented** (deferred).

### 3.3 The object model (minimal slice) (`src/model.ts`)
Record-oriented core + a thin **read-only** value-object layer: `Node`/`Person`, and **`Edge` owns
`Assertion`s** (the one real object relationship — an edge accumulates graded reasons). Persistence still
delegates to GraphStore (preserves single-writer + append-log). Node **types are few** (the store's ~17-value
`NodeType` enum); the extractor's finer types map onto `type + subtype` (anti-sprawl — the memory-agent
"235 types → ~20" lesson). Session-as-strategy and a processor-layer split are backlog.

### 3.4 Named, persistent graphs (`src/graph.ts`)
A name → `graphs/<name>/graph.db` (+ a `meta.json` sidecar). `Graph.open/list`; reads return value objects.
Minimal — rename/merge/delete and an in-db meta row are backlog.

## 4. Design decisions & rationale
- **Extraction-first, deviating from plan-v3** (which sequences Store-hardening → Resonator → Dream next):
  browsing exposed that the graph is only as good as what goes in, and extraction was a keyword stub. The
  author explicitly chose to build real extraction now. *Risk to probe: are we skipping store-hardening the
  ingest actually depends on?*
- **Tracer-bullet delivery**: wire every layer thin, end-to-end, then flesh out — de-risks integration.
- **All-TypeScript**, Ollama-backed (chat + embeddings) — one runtime; native shared types.
- **Entity node text = the name** (dedup into hubs) rather than per-mention nodes — makes over-connected hubs
  the trope signal. *Risk: cross-domain homographs merge (two unrelated "Java"); mitigated by the named-graph
  boundary, but is that enough?*
- **JSON extraction + drop-dangling-relations + Zod** over LightRAG's delimiter format — parse robustness.
- **Wire-on-use, not wire-on-ingest** (past lesson: eager auto-linking made a hairball) — the analytic
  connector/resonance is a *separate, deferred* pass, not part of ingest.

## 5. Rollout
- **Slice 0 — tracer (DONE):** named graph + txt/md + real extraction → viewer. Verified on the De Doorns
  persona (De Doorns/Klipgat Farm/2012 Strike as typed entities; both-endpoints edges).
- **I1 — extraction quality:** the corpus rubric + `ingest-report.ts` scorecard; tighten NEGATIVE_CONSTRAINTS;
  cross-chunk entity consolidation (known-node injection); per-chunk provenance; attribution enforcement.
- **I2 — chunker tuning:** size × overlap × model (bigger model → bigger chunks; joint optimization).
- **I3 — formats:** PDF/docx/`.odp`/image, each adding its own test corpus.
- **I4 — object-model depth; I5+ — engine (connector/resonator/dream), cross-persona dedup, embedder eval** —
  all backlog, only after ingest is solid.

## 6. Current state — proven vs unbuilt
- **Proven:** the tracer runs end-to-end; extraction produces real typed entities + quality edge reasons;
  27 store/persona tests green; typecheck clean.
- **Untuned (known):** ~39 entities from one persona (target ~5–15); 13 chunks per persona fragmented person
  references ("Mother" vs "Charnel's mother"); an occasional generic entity ("Grapes") slips NEGATIVE_CONSTRAINTS.
  These are I1/I2, not architecture — but the reviewer should judge whether the *architecture* makes them
  fixable by tuning, or whether they reveal a structural flaw (e.g. per-chunk extraction without a resolution
  pass).
- **Unbuilt (deferred):** promote-hardening, resonator/decay/prominence, connector hardening, dream,
  cross-persona dedup, non-txt/md formats, embedder head-to-head.

## 7. Open questions for the review (pressure-test these)
1. **Extraction-first vs plan-v3's store-hardening-first** — is deferring promote/prune/breaker while piling on
   ingested nodes going to bite (quarantine tier filling, no promotion, no decay)?
2. **Consolidation:** is per-chunk LLM extraction + name-match node-reuse sound, or is a dedicated entity-
   resolution pass (or known-node injection into the prompt) *required*, not optional? The fragmentation above
   is the symptom.
3. **Name-as-node-text dedup:** right call for hubs, or a homograph landmine? Is the named-graph boundary the
   right isolation unit?
4. **Chunk×model coupling:** is treating this as tuning (deferred) safe, or does it change the architecture
   (e.g. forcing whole-doc extraction for big models)?
5. **Object-model minimalism:** is Edge-owns-Assertions + thin value objects the right first cut, or premature?
6. **Is the analytic map useful standalone** (no resonator/dream/decay), or is the value gated on the engine?
7. **Store invariants under ingest load:** single-writer + all-to-quarantine + no-promotion — does anything
   accumulate unboundedly or violate an invariant across many docs?
8. **Where is the biggest architectural risk we're not seeing?**
