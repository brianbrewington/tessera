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

## Entity dedup at CREATION time (two-gate) — the Connector's key finding (Brian)
The hardened Connector's dry-run found its highest-cosine candidate band dominated by un-deduplicated
near-duplicate ENTITIES ("Khoi Families ~ Khoi families", "Stellenbosch Estates ~ Stellenbosch Wine Estates",
"Camera ~ Father's Camera") — an entity-resolution job leaking into edge-proposal, and one even survived. Brian:
dedup should run at ENTITY CREATION time (in the mapper/putNode path), not as a pre-Connector pass — so near-dups
never become separate nodes in the first place. Right direction; but **load-bearing caution:** naive
cosine-at-creation is EXACTLY what we disabled (`nearDupMerge:false`) because it over-merged catastrophically
(0.85 → "ANN" swallowed 92 entities). So creation-time dedup MUST be two-gate, in two layers of very different risk:
- **Layer 1 (cheap, safe, deterministic — do first):** stronger string/type reconciliation. Case/whitespace
  variants should already merge via `norm()`; if "Khoi Families"/"Khoi families" became two nodes, the culprit is
  KI-3 type-jitter (same name, different extracted TYPE → different identity prefix → two nodes). Reconcile the
  type (vote within a doc / at creation). Low over-merge risk; validatable even on the synthetic graph.
- **Layer 2 (bigger, careful):** an embedding near-dup CANDIDATE at `putNode` → **LLM-verify the merge** before
  collapsing (reuse the Connector's verifier in `scripts/connect.ts`). NEVER merge on geometry alone — geometry ≠
  identity is the governing lesson, and the Connector's non-monotonic reject curve just re-proved it. Tune only on
  a real corpus. Then the Connector runs on an already-clean node set (dedup precedes it — that's the ordering).
Composes with the item below + KI-3.

## Connector — before the first REAL-corpus run (cross-review fast-follows, Codex + Fable)
The merge-blocking findings are fixed (de-anchor gate now enforced via `reasonIsAnchored`, cap clamped in the
core, `measureCosineDistribution` stride-sampled, same-family refused in `runConnector`). These three are safe to
defer only because the Connector won't run on a real corpus until creation-time dedup lands (above) — do them
first when it does:
- **kNN slots eaten by provenance vectors.** `propose` fetches `k+1` from `vec_node_quarantine`, but chunks and
  documents live in that same index, and an entity's nearest neighbors prominently include its own chunks — so
  real-entity recall is silently unpredictable (visible only as a large `blockedSelfOrProvenance`). Over-fetch
  (`k×3`-ish) or filter provenance in the query, not after. (Behavior change — re-baseline the propose tests.)
- **No transport-error handling mid-run.** `OllamaChat.complete` throws on network/non-OK; the evaluate loop has no
  try/catch, so one flaky call late in a run loses every paid-for verdict, and in `--commit` can leave edges
  committed with no sidecar. Wrap per-candidate; persist partial progress.
- **Parse-failure folded into `verifierNo`.** A malformed/undelivered reply is counted as "verifier said no,"
  skewing the reject-rate-by-band curve (the geometry≠quality test). Give it its own counter.
- **`buildNodeContext` trusts any `APPEARED_IN` target as a chunk** without a `subtype` check — benign today (motif
  hubs have null description) but a described hub would be fed to the verifier as a source excerpt. One check.
- **Watch (store policy, not the Connector):** `graphStore.putEdge` stores `expert_surprise = f(endpoint-cosine)`
  on every committed assertion — geometry re-enters as a stored per-assertion score. Harmless until something
  downstream ranks by surprise; if it does, geometry is back in the deciding seat through the side door.

## Relational-term over-merge under content-addressed PERSON identity (FOUND on the graphs/big rebuild)
Content-addressed PERSON identity (`person\t<name>`, no source qualifier) is correct for a real recurring
person, but the graphs/big rebuild's PERSON-merge audit surfaced the cost: **bare relational terms merge across
personas** — "Grandmother" (3 source docs, strength 7), "Father" (3), "Mother" (2) collapsed into one node
each, conflating every persona's relatives. Common given names (Thandi/Sipho/Thembi) also merged — some
legitimate (Cissie Gool, a real shared Cape Town figure — a *correct* cross-doc merge), some collisions. The
audit works (it caught this, visibly); the question is the fix. Root cause: subject-aware extraction is
supposed to name relational people "<Subject>'s <Relation>" but emits bare "Grandmother" in many chunks, so the
identity change amplified an extraction gap. Options, in order of preference:
1. **Extraction fix (I1):** make subject-qualification reliable so a bare relational term never reaches the
   mapper — the cleanest, addresses root cause. Measure against this audit.
2. **Disambiguation/dedup layer** (already backlogged): split a wrongly-merged PERSON by clustering its
   descriptions/embeddings — the general answer, needed anyway.
3. Do NOT re-introduce path qualification (Brian's steer stands). A *content*-based subject qualifier for bare
   relational terms only would be a targeted middle path if 1+2 prove insufficient.

**Brian's design direction (2026-07-27, "not a rush — needs careful design"):** *"maybe the question is dedupe
on ingest needing an edge and a node pair. So it's 'Bob', 'related to Bob' (edge), 'Grandmother'?"* — i.e. a
relational person's identity is disambiguated by the (subject, relation) EDGE, not the bare name alone: the
node "Grandmother" is only "the same" when it shares the same subject-edge ("Bob's grandmother"). Dedup keyed
on (node, connecting-edge-to-a-named-anchor), so "Bob → related-to → Grandmother" and "Thabo → related-to →
Grandmother" stay two nodes. Careful design needed — interacts with how the mapper resolves relation endpoints
and with the disambiguation layer above. Decision MADE: merged to main as-is (graph usable; audit makes the
over-merge visible); this is the eventual fix, unhurried.

## Cross-persona dedup + resonance tuning
Do together, done right per `embeddings_experiments`: raise resonance 0.85 → ~0.92 (0.85 catastrophically
over-merged — "ANN" swallowed 92 entities), string-normalize/block first, canonical-by-frequency not length,
two-gate LLM-verify. Reuse `analysis/entity_resolution.py` (fix its greedy-centroid + shortest-canonical bug).

## Identity-scheme convergence (landmine) — RESOLVED 2026-07-27
`persona.ts` (the old `<name> [sourceKey]` scheme) was the divergent identity landmine. The general subject-
aware `tessera ingest` path supersedes it, so `persona.ts`, `scripts/ingest-personas.ts`, and their tests were
**deleted** (Brian: deprecate if unused — it was unused by the main flow). One identity contract remains: the
mapper's content-addressed scheme. (Recoverable from git history if the motif/relationship-expansion ideas in
the old pipeline are ever wanted.)

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

## Distributed "mining" with a fleet of small models  *(vision — see `docs/distributed-mining-ideas.md`)*
Decompose graph construction into narrow, verifiable micro-tasks (entity-spotting, graph-worthiness filtering,
edge evidence-verification, dedup/alias checks, reason-kind clustering) and fan them across a fleet of small local
LLMs (Orin-class proposers/verifiers + the Mac Studio as adjudicator). The win is verification-at-scale + always-on
background re-mining (the resonator's substrate), NOT "small model does the same job." tessera is well-shaped for
it (chunk-shardable, deterministic coordinator-owned identity, idempotent memo, scorecard as fitness). First
experiment: an edge evidence-verification swarm, measured against the scorecard. Full brainstorm in the doc.

## Prompt-version salt in the chunk memo  *(review 3 — closes a real footgun)*
The chunk memo keys on chunk content only, so a graph ingested under an OLD prompt keeps its stale extractions
forever unless someone remembers `--reextract` (e.g. existing persona graphs won't pick up subject-aware
extraction). Fix: a `PROMPT_VERSION` constant salted into the `extracted_chunks` key (or a version column checked
by `isExtracted`); bump it on any prompt change → old memos auto-invalidate. Permanently closes the "silently
stale extraction after a prompt change" class.

## Directed / typed edges  *(review 3)*
`RELATED` is canonicalized undirected, but de-anchored reasons are often directional ("is the father of",
"mentored") — for a symmetric-looking pair the direction is unrecoverable. Ties to the discovered-edge-taxonomy
work: a typed edge could carry direction. Until then, prefer symmetric reason phrasing where possible.

## Within-doc subject alias folding  *(KI-4)*
Fold name variants of the same source-qualified person before identity (`Anele` → `Anele Sotashe`; curly vs ASCII
apostrophe) so subject-aware extraction can't split the hub. A light per-doc pass keyed on the known subject +
fuzzy match; reuse the embeddings_experiments blocking discipline.

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

## `mutation_log` coverage is not universal (FOUND in the durable-map-state review, Codex 5.3)
The store's replay-grade guarantee is narrower than the docs and comments imply. `putNode`/`putEdge`/
`promoteNode` log correctly, but two mutating paths write without appending to `mutation_log`:
`markExtracted()` (`src/store/graphStore.ts:492`, writes `extracted_chunks`) and `recordIngestedSource()`
(`:508`, upserts `ingest_sources`). Consequence: a replay from `mutation_log` reconstructs the graph but NOT
the ingest memo or the file-level manifest — so a replayed db would re-pay the LLM for every chunk and re-ingest
every "unchanged" doc. Harmless today (nothing replays in anger); load-bearing the moment replay/restore is
real, which `docs/specs/graph-store-spec-v2.md:178` (portable export) implies it will be.
**Disposition: ACCEPTED-RISK for now** — not caused by and not blocking the durable-map-state work that found
it. Fix options: log both as first-class ops, or explicitly document them as derived-cache tables excluded from
replay (and make `export` carry them separately). Decide before the export/restore primitive lands.
