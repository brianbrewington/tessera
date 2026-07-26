# tessera — backlog

Feature-request stash. Nothing here is built until **basic ingest** (the tracer + its flesh-out iterations) is
solid. Ordered loosely by when it'd land.

## Ingestors (each ADDS its own acceptance test corpus when it lands)
- **PDF** (pymupdf-style text + layout), **docx** (pandoc/textutil), **`.odp`** (open slides) / **`.pptx`**,
  **image** (OCR/caption), **html / .eml** (email). All behind the existing `readDoc` adapter seam
  (`src/ingest/adapters.ts`); tracer ships `.txt`/`.md` only.

## Chunker tuning (sub-plan — flagged by Brian)
The simple chunker (`src/ingest/chunker.ts`) is a placeholder. **Chunk size × overlap are a JOINT function of
the extraction model** — a bigger extraction model takes bigger chunks (more cross-entity relations captured
within a single call, fewer chunks, less overlap-driven duplicate-node load), which is why a bigger model
**paid off on the Mac** despite the cost. Sub-plan:
- Parameters to sweep together: `chunk_size`, `overlap`, `extraction_model`.
- Metrics (reuse `~/code/embeddings_experiments` harnesses — chunk-size baseline, overlap sweep, embedding
  drift): (a) relation **recall** across chunk boundaries (do cross-boundary edges survive?); (b) **duplicate-node
  rate** (embeddings_experiments: 50% overlap → 49–62% dup nodes); (c) cost/latency per doc.
- Priors from the experiments: chunk-size plateau ~75–250 tokens; overlap sweet spot 50–70% (90% wasteful).
- Decision variable: **which extraction model.** qwen2.5:14b works well in the tracer; a bigger model
  (qwen3:32b / llama3.3:70b) or the fleet 3-stage extractor may pay off (fleet gave +33% nodes, 7.5× cross-doc,
  100% citation vs 0%). Tie the chosen chunk_size/overlap to the chosen model.

## Extraction hardening (I1+)
- NEGATIVE_CONSTRAINTS strictness tuning; per-chunk **node-reuse via known-node injection** (feed existing node
  ids into the prompt, MindMapper-style) rather than only post-hoc name-match; **provenance per chunk** (chunk
  nodes) not just per-document; **attribution** enforcement for WISDOM/LESSON/MEMORY; **citation grounding**
  (mandatory quote per edge → mechanical+semantic+grounding verification); **temp-consensus** (≥3 → 0% BS
  backbone); the **fleet 3-stage** extractor as a quality/scale option.

## Engine (deferred until ingest is solid — Brian: "no resonator, no dream, none of that")
- **Connector hardening**: dirty-set candidates + open-triangle closure + tautology-debloat + LLM-verify (the
  two-gate 0%-BS pattern, `embeddings_experiments/src/extraction/deep_edge_discovery.py`).
- **Resonator**: lazy τ-decay + degree + rank-normalization-per-tile + seeded clustering → sticky PATTERN nodes.
- **Dream**: walker + weave + lucid-extract + fast-decay + σ-circuit-breaker + TTL.
- **Store hardening**: promote-breaker (no-brick), `promoteAssertion`, prune-cascade, reinforce/decay commutative.
- **Prominence pyramid / `getTile`**: semantic-zoom tiling for the viewer.

## Cross-persona dedup + resonance tuning
Do together, done right per `embeddings_experiments`: raise resonance 0.85 → ~0.92 (0.85 catastrophically
over-merged — "ANN" swallowed 92 entities), string-normalize/block first, canonical-by-frequency not length,
two-gate LLM-verify. Reuse `analysis/entity_resolution.py` (fix its greedy-centroid + shortest-canonical bug).

## Identity-scheme convergence (landmine)
`persona.ts` builds node identity as `name [sourceKey]` — a DIFFERENT scheme from the mapper's tab-delimited
`<type>\t<name>[\t<sourceKey>]`. If a persona-path graph and a mapper-ingest graph ever share a store, the "same"
entity gets two nodes and never dedups. Pick one identity contract (the mapper's is the reviewed one) and route
`persona.ts` through it, or explicitly namespace the two so the divergence is intentional, not accidental.

## Viewer chrome — the larger frame (deferred surfaces + seams to hold)
From the Claude Design handoff (`docs/viewer-answers.md` has the full Q&A). Tracer bullet = the detail panel +
idle (`1b`–`1e`). Deferred surfaces: **scenes/tours** (tracer+1), **semantic zoom** (the Church-in-Kansas
pyramid — start at the country tier on degree; continent tier needs a clustering pass), **annotations**
(net-new sidecar store), **readings** (cluster the de-anchored assertion reasons — same as the discovered
taxonomy below). **Seams to hold now so we're not cornered:** (1) stable GUIDs are the reference for citations /
scenes / annotations — never name-slugs; (2) de-anchored assertion embeddings (shipped) make readings free
later; (3) filters serialize as an extensible *object*, not named booleans; (4) annotations = sidecar keyed by
GUID, append-only, with `author{kind,id}` + `visibility` from day one (decided now to avoid a migration), and
they never enter the graph `mutation_log`; (5) degree/strength drive zoom tiers today, communities are a later
clustering pass.

## Discovered (not imposed) edge taxonomy — hierarchical, from the explanations themselves (Brian)
Today every extracted semantic link is one kind — `RELATED` — distinguished only by its prose reason. The idea:
**don't hand-author an edge-type enum — discover the taxonomy bottom-up** by clustering the (now de-anchored)
reason embeddings across the whole graph. De-anchoring is the enabler: a reason carries the KIND of relationship,
not the two nodes, so "attended the same college", "shares a hobby", "is kin to" cluster regardless of who's
involved. The taxonomy is **hierarchical** — shallow/generic (`RELATED`) at the top, deepening to specific typed
relations (`ATTENDED_SAME_COLLEGE`, `CO_AUTHORED_WITH`) as clusters sharpen; an assertion gets typed by which
cluster its reason lands in, and stays `RELATED` if it clusters with nothing. Composes with **multi-facet edges**
(one edge owns many typed assertions) and reuses the `embeddings_experiments` clustering + two-gate-verify
discipline (naive thresholds over-merge). Do this AFTER de-anchored reasons accumulate at real corpus scale —
clusters need volume to form. Let the corpus vote on the type list, don't impose it.

## Idempotent + cheap re-ingest (chunk-hash extraction memo)
Live re-ingest of one doc is idempotent for everything the system *controls* (SOURCE/CHUNK/PERSON identity all
reinforce, zero duplication), but the entities/edges still churn because extraction runs at temp 0.4 and returns
different output each call. Since CHUNK identity is deterministic (`chunk\t<sourceKey>\t<sha16(rawtext)>`), a
chunk that already exists with `APPEARED_IN` entities could **skip re-extraction** entirely — making re-ingest
truly idempotent AND saving the (dominant) LLM cost. Design: memo on chunk content_hash; invalidate if the
extraction model/prompt version changes. Interacts with the chunker-tuning sub-plan.

## known-map on memo-skip (latent, from review 2)
The chunk memo skips already-extracted chunks on re-ingest, but a skipped chunk doesn't repopulate the mapper's
cross-chunk `known` name→id map. Dead-code-safe today (the LlmExtractor drops relations whose endpoints aren't in
the same chunk, so `known`'s cross-chunk fallback is never exercised), but a smarter/custom extractor that emits
cross-chunk relations would silently drop them on a partial re-ingest — diverging from a fresh ingest. Fix when
that extractor lands: on skip, seed `known` from the chunk's existing APPEARED_IN entities. Alternatively make the
same-chunk-relations assumption an explicit contract on the `Extractor` interface.

## Identity-string normalization edges (latent)
`contentHash` runs identity strings through `normalizeText` (lowercase + `\s+`→space). Two consequences, both
low-frequency, both safe to fix now (no persisted data): (1) `\t` field delimiters collapse to spaces before
hashing, so identity safety rests on the type prefix being an enum, not on the delimiter; (2) case-distinct file
paths on a case-sensitive FS (`/a/Notes.md` vs `/a/notes.md`) collapse to one SOURCE identity while their chunks
(raw-path `sourceKey`) stay separate → provenance split. Fix: hash identity strings verbatim (bypass the lossy
normalize) OR normalize paths consistently across `sourceIdentity` and `sourceKey`.

## Extraction type-consistency (I1)
Live run flagged the same word typed two ways in one corpus (e.g. `Imifino` as both CONCEPT and PRODUCT,
`Spinach` as PRODUCT). By design that's two identity nodes (type is part of identity), so extractor type-jitter
fragments hubs. Mitigations to test: a tighter type rubric in the prompt, a post-pass that reconciles same-name
different-type within a doc, or folding near-synonym subtypes. Measure hub fragmentation before/after.

## Embedder head-to-head
nomic-embed-text vs mxbai-embed-large vs current SOTA (the field has moved since Jan/Feb). "Go slowly — it
powers a good de-dupe." embeddinggemma's ~0.92-compressed space is a warning; measure near-dup separation, not
just retrieval.

## Object model depth
- **Session-as-strategy** (mode = dream/interview/debate/reflection/walk — the design's mandated polymorphism).
- **Processor-layer split**: Embedder / Connector / Resonator / Dream as stateless `GraphStore` clients (the sps
  Manager/Engine/Service layering), preserving single-writer authority.
- Reason **graduation**: an edge assertion graduates to a CLAIM/INSIGHT node when detachable + reusable + contestable.

## Named-graph management
switch / rename / merge / delete; per-graph config (extraction model, embedder); an in-db `meta` row instead of the
`meta.json` sidecar.
