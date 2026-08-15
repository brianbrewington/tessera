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

*2026-08-08: superseded in shape by "Identity as a read-time resolution view" (B27, end of this file);
preserved in substance there. Layer 1 becomes B27 slice 1; Layer 2 becomes B27 slice 2, with the verified
outcome landing as a SAME_AS edge feeding a view union rather than a collapse at `putNode`.*

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

### SESSION: what changed, and what the boundary actually is (2026-08-08)

**Brian:** *"there's more here. a DREAM or THINK-ABOUT is a self-directed SESSION. This is a lot. Needs a plan,
which we can then throw in the backlog."* And later, on the review round itself: *"meta: the Claude 1-Claude 2
conversation is a SESSION."*

**No new plan was written, deliberately.** `docs/plan-v3.md` §4 already specifies SESSION with
`mode: dream|conversation|interview|debate|reflection`, a single concrete session-runner
(cast → transcript → residue → commit-gate), mode as a strategy object, and its own warning against doing it
lazily ("five types in a trenchcoat"). Writing a second design would be copy-fork-edit, the anti-pattern
`ideas-ledger.md` §10 names as preceding rot. What follows is the delta against §4. Everything in §4 remains
unbuilt: nothing writes SESSION and no runner exists.

**What changed since §4 was written.** One mode became real and measured, and a second turned out to have been
real all along.
- `mode: conversation` — Claude Code session logs. Measured on this project's own logs (5 JSONL files, 18 MB,
  3551 records): by bytes of conversational payload, `tool_result` 45.7%, `tool_use` 23.3%, `thinking` 14.7%,
  `image` 11.1%, `text` **5.2%**. Stripping system reminders, prose totals **274 KB** (78.9 KB Brian across 81
  blocks, 195.4 KB assistant across 365). **1.5% of raw bytes.** So ingesting a session is a SELECTION problem,
  not a conversion problem: converted literally it is ~12,000 chunks and ~25 hours; selected properly, ~187
  chunks and ~23 minutes. Recorded here because these numbers existed only in a conversation.
- `mode: review` — `docs/reviews/` is already a corpus of agent-to-agent sessions (26 records at the time of
  writing), accumulated since the project started. Nobody planned it as one.

**The finding (DREAM-side review, verbatim at `docs/reviews/session-object-model-round1-dream.md`).** §4 holds,
but the boundary is drawn in the wrong place. The cut is **not** dream-versus-conversation; it is **cast arity
plus alternation**. Of 186 real dream artifacts, **108 are troupe handoffs** with a session id, an explicit
parent link and two named agents taking turns; the other **78 are single-pass**, one generation, no order worth
replaying. So `dream` sits on *both* sides, which is why "does a dream fit SESSION" had no single answer. The
proposed test is structural and checkable: **if `cast.length >= 2` and turns alternate, it is a SESSION.**

**The amendment: name two objects, not five modes.** An **episode record** (identity, cast, order, turns,
origin, timestamps) that both ingested and self-directed paths write, and a **generator** (selection, budget,
breaker, commit policy) that only self-directed modes have. Ingest writes the record and no generator; a dream
writes both. `mode` becomes a label describing which generator ran, not the thing that branches. This also
dissolves the mode-conditional-nulls worry: the dreamer's ten governors live in its config, not in the row.

**Blocker on §4 as written: `mode` cannot be stored.** There is no `mode` column on `nodes`, and
`PutNodeInput` is `.strict()`, so the key is rejected at the boundary today. Cast, budget and transcript order
have no home either. If SESSION is built, `mode` becomes a real column with a Zod enum, or the discriminator
becomes the structural predicate above, which needs no column at all. **Do not put it in `metadata` JSON**: a
strategy object branching on an unvalidated string means the first typo is a silent no-op branch.

**Identity, decided in shape.** A SESSION is a stream, not a document: identity is an external stable id
(`session\t<ns>\t<sessionId>`), never a content hash, because an append-only log re-hashed after every turn is
"new content" forever. Its **turns** are the content-addressed units (`turn\t<ns>\t<sessionId>\t<uuid>`), and
they ride the existing dirty/clean extraction machinery as a `SOURCE` subtype. Correctness comes from per-turn
identity; a high-water mark is speed only, so losing the bookkeeping degrades to a full re-read rather than to
duplication. Cost stated honestly: this introduces a **second identity regime** (documents are content-addressed,
sessions are stream-addressed), which must be documented in `identity.ts` or someone will later "unify" them and
reintroduce the duplication bug.

**Generalisation worth taking seriously.** Chunk identity is `chunk\t<sourceContentHash>\t<sha16(text)>`, so
growing *any* document changes every chunk key. Sessions are only where this surfaced first: a running notes
file, a journal, and the teammate-stack's own append-mostly files have the same shape. The per-turn fix
generalises directly to sections. **Scope the eventual increment as "append-only sources", with SESSION as its
first consumer.** (Hypothesis, from both the author and the reviewer; not yet tested against the chunker.)

**The constraint that binds session-log ingest, which is queued NOW.** Whatever ships must preserve **turns as
parts, with speaker and timestamp**, and attribute extracted MEMORY/INSIGHT to speakers. If the first ingest
flattens a transcript to prose, turn structure, attribution and the self-versus-other distinction are gone, and
the unification is foreclosed. That is the entire design obligation today; the rest can wait.

**The kill test.** Ingest one real session log through the ordinary document path (`SOURCE` plus structured
parts) and ask whether any consumer needs it to be anything else. If a plain `SOURCE` suffices, the unification
reduces to a pipeline-reuse claim provable the day a dream exists, at zero schema cost. If the transcript
demonstrably needs runner semantics, that is the evidence to build SESSION, against a real artifact rather than
two hypotheticals.

**Dispositions.**
- **New SESSION plan: REFUSED.** §4 is the design of record; this entry is the delta. Any future work is a
  delta against §4, not a new document.
- **SESSION and AGENT node types: DEFERRED** until a runner exists or the structural predicate replaces `mode`.
  Adding two more writerless types to a ledger that already has 11 dead node types, 3 dead edge kinds and an
  uncalled promote primitive makes the ledger worse, not better.
- **`mode: walk`: PROPOSED FOR REMOVAL** from the mode list. A walk has no cast, so under the predicate above it
  is not a SESSION. (`plan-v3.md` §10 Move 3 introduced it as a sixth mode after §4 listed five.)
- **`origin` threading: DONE** (2026-08-08). `mapExtraction` and `extractPending` take an origin, and
  `tessera report` counts nodes and assertions by origin. This was the reviewer's CRITICAL: there is no delete
  for nodes or edges anywhere in the repo, so an unmarked self-directed product is permanently
  indistinguishable from extracted fact.
- **Provenance-scoped delete: OPEN, and it gates pointing any generator at a real graph.** Marking now exists;
  removal does not. Until it does, **the first dream ingest goes at a throwaway graph.** Recorded as the
  reviewer's explicit request.
- **`HEBBIAN_ASSOC` has no writer**, and it is the one edge a dream exists to produce (the seed-to-association
  pairing is the claim; extracting the association text alone does not recover it). If the dream path is built,
  that edge getting its first writer is the acceptance test, not turn ingest.
- **Dream/walk runners: stay DEFERRED** under the standing "no resonator, no dream, none of that until ingest is
  solid" rule. This entry describes the object they would run on, not the organs.
- **Attribution parity: OPEN on the dream side.** The dreamer's provenance is `turn <n> (role)`, an ordinal into
  a filtered view that moves when the transcript grows or the filter changes, and it emits no record uuid. The
  DREAM-side author offered to emit uuids so both paths satisfy one attribution contract. Until then, per-turn
  attribution is true for ingested conversations and aspirational for dreams.
- **`AGENT` keying: OPEN.** Per model id makes one node connected to everything that model ever said, which is
  the over-connected-hub signal. The reviewer proposes `model id + prompt sha256`, on the evidence that the same
  model under two prompts behaves like two participants.

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

**RESOLVED 2026-08-08 — the first option was taken.** `markExtracted` and `recordIngestedSource` both append
to `mutation_log` now (they gained a `Meta` argument and run inside the same transaction as their write), and
graphs/testgraph carries 318 `markExtracted` and 23 `recordIngestedSource` ops to prove it. So the replay gap
described above is closed for those two paths. Two things this does NOT settle, both still open: the newer
derived-cache tables (`chunk_extraction_state`, `media_blobs`, and any `node_forms`) are deliberately excluded
from replay and are documented as such at their DDL, which is the second option applied to the tables that
earned it; and `export`/`restore` still does not exist, so nothing has ever replayed in anger. Flagged by the
agent writing B27, which is the argument for re-reading a backlog entry before trusting its tense.

## Slice-3 (`tessera serve`) — open items with explicit dispositions

Recorded because a finding without a disposition is a finding that quietly becomes the default behaviour.
Each of these was raised by a slice-3 reviewer (Codex, Composer, or Fable) and is **not** fixed in the
checkpoint that ships slice 3.

### 1. Multi-file drop discards all but the first file — **SCHEDULED (next)**
`viewer/template.html` takes `e.dataTransfer.files[0]`. Dropping three files ingests one and says nothing
about the other two. Brian: *"multi file drop is common. we should support that."* Deferred only so the
reviewed slice-3 checkpoint lands first; this is the next piece of work on the server, not an accepted
limitation. Until then the UI is silently lossy, which is the part that makes it urgent rather than cosmetic.

### 2. A hung extractor holds single-flight AND the advisory lock until restart — **ACCEPTED-RISK**
`deps.ingest` has no timeout (`src/serve/server.ts`), so an Ollama call that never returns wedges further
drops (409) and blocks CLI ingest (LockHeld) until the server is restarted.

Partial mitigation that predates slice 3 and should be on the record: `src/llm.ts` already aborts an
individual chat call after 600 s, so a single wedged request unblocks itself — the unbounded case is a model
that streams slowly forever rather than one that hangs outright.

Accepted rather than fixed because **no honest timeout exists** for the whole document: a legitimate ingest of `graphs/big` is 199
chunks at ~10 s each — over half an hour — so any timeout generous enough not to kill real work is too
generous to catch a hang promptly. Inventing a number would produce a limit that both fails to protect and
occasionally destroys a long, expensive, half-finished ingest. Mitigations that already hold: the chunk memo
commits per chunk, so a killed ingest resumes rather than restarting; the advisory lock records the holder's
pid and is reclaimed automatically once that process is gone; and restarting the server clears it.
**Revisit if** a per-chunk watchdog lands (bounding one LLM call rather than the whole document is the
tractable version of this).

### 3. `GET`/`PUT /scenes` exist but no client calls them — **ACCEPTED-RISK for the checkpoint**
The served viewer still reads scenes from `localStorage` (`viewer/template.html`), so scenes imported into the
`scenes` table are invisible on the served page. Design §6 says the db is the source of truth in served mode;
slice 3 does not close that loop. Consequence, stated plainly: a user who followed the slice-2 migration will
see **no scenes** when they open the served viewer, and may reasonably conclude the migration failed. The data
is safe — `tessera scenes import` wrote it and `GET /scenes` returns it — but nothing displays it yet.
**Revisit with** the multi-file work; it is the same file and the same slice.

### 4. Two code paths exercised only as mocks — **TEST (pending)**
- The supplemental no-Origin rule (`src/serve/server.ts`: browser-shaped request with `Sec-Fetch-*` but no
  `Origin` on a mutating route) has no test; deleting it stays green.
- `writeScenes`' real version/conflict/`contentKey` logic (`scripts/serve.ts`) is only ever run through an
  injected mock in `test/serve-server.test.ts`.
Both are cheap and neither changes behaviour — they are missing coverage, not missing function. Listed here so
"tested" is not claimed for them.


## The advisory lock needs an OS-level primitive — **DECISION NEEDED** (found round 4, 2026-08-06)

Four review rounds, four defects, one class. Every round fixed the instance:

1. the lock was one-sided — only `serve` took it
2. acquisition was atomic but RECLAIM was check-then-delete → two holders
3. reclaim-by-rename was still check-then-act, because `rename` is not bound to the snapshot that justified
   it → two holders, **demonstrated by execution**
4. the reclaim GUARD's own stale-clearing is check-then-delete → two holders, **demonstrated by execution
   with a 3.86-second concurrent hold**

The reviewer's structural point, which is correct: *exclusivity built from `unlink`/`rename` plus a staleness
heuristic regenerates this race at every layer.* Each guard needs a guard. There is no fixed point.

**What is shipped:** the normal contended path is solid — every reviewer probe against it returned exactly one
winner. What remains broken is the **crash-recovery corner**: the precondition is a lock left behind by a
process that died mid-reclaim, plus adverse sub-millisecond scheduling. Also unaddressed: a live holder past
`LOCK_STALE_MS` (6 h) is legitimately reclaimed with no heartbeat, so a corpus ingest longer than six hours
gets its lock stolen with no race required.

**The terminating fix is a kernel lock bound to process lifetime** — `flock`/`fcntl`. The OS releases it when
the process dies, which deletes the staleness heuristic, the guard, the 6-hour threshold, and the whole class
of bug rather than repairing another instance of it. Node has no built-in binding, so this is a real decision
with a real cost:

- **`proper-lockfile`** (pure JS, widely used, mkdir + mtime heartbeat) — no native build, but it is the same
  *family* of mechanism, better executed. Solves the heartbeat and most of the races; not kernel-backed.
- **`fs-ext`** or similar — genuine `flock`, native compile step, a portability cost on a project whose stack
  values portable-by-default.
- **Linux abstract-namespace sockets** — genuinely kernel-released on death, zero dependencies, but
  Linux-only.
- **Accept the current guarantee** and document it: safe for single-user, no-crash, sub-6-hour operation,
  which is every real use of this tool today.

**DECIDED 2026-08-06 — Brian: "that's an acceptable risk for now."**

Disposition: **ACCEPTED-RISK**, with the boundary stated so it is a decision and not an oversight. The lock is
safe for single-user, no-crash, sub-6-hour operation — which is every real use of this tool today. It is NOT
safe across crashes, ingests longer than `LOCK_STALE_MS` (6 h), or mixed uids.

**Revisit when any of these becomes true**, because each moves the risk from theoretical to routine:
- a corpus ingest is expected to run longer than six hours (the live-holder steal needs no race at all — a
  heartbeat would be the minimum fix, and is cheaper than the full flock migration)
- `tessera serve` is run as a service, or under a different user from the CLI
- more than one person, or more than one machine, writes one graph directory

## Async extraction: split ingest into a fast path and a dirty→clean worker (Brian, 2026-08-06)

**Brian:** *"ingest can take that long. other variants of this project have separated things so the 'ingest'
of chunks would happen asynchronously. so the file read and chunking would be fast, and then chunks would be
flagged as 'dirty' until ingested and then marked 'clean'."*

**Shape.** `ingest` does read → chunk → write SOURCE + CHUNK nodes → return. Milliseconds, no LLM. A separate
pass (worker, CLI command, or serve background task) claims dirty chunks, extracts, maps, and marks them
clean.

### Why this is worth doing, beyond ergonomics

- **It dissolves the accepted lock risk rather than mitigating it.** The advisory lock's live-holder steal
  (see the lock entry above) exists *only* because one lock is held across the entire LLM loop — 199 chunks
  at ~10 s is 33 minutes, and a real corpus exceeds the 6 h staleness threshold. If the lock covers only
  read-chunk-write it is held for milliseconds, and the threshold stops being reachable. That closes a
  DECISION NEEDED without adding a dependency.
- **The drop target stops lying about duration.** A drop returns immediately with "42 chunks queued" instead
  of holding an HTTP request and an SSE stream open for six minutes.
- **Progress becomes a fact rather than a stream.** Dirty count is queryable at any time, by any process,
  after a crash, from a different terminal. Today progress exists only in the SSE connection that is watching.
- **It makes failure visible.** Which is the part that already matters — see below.

### Most of the state already exists

`extracted_chunks` **is** the clean flag. `markExtracted` is written only after a chunk's extraction fully
completes (`src/ingest/ingest.ts`), and `isExtracted` gates re-extraction — so "dirty" is already
`chunk NOT IN extracted_chunks`, and it is already a true completion predicate rather than an attempt marker.

**And it already has non-trivial values:** `graphs/big` has 199 chunks and 197 extracted — **2 dirty**, almost
certainly the parse failures recorded in `ingest_sources`. Nothing surfaces them. A user has no way to learn
that two chunks of their corpus were never extracted. The async design would make that visible as a matter of
course, which is an argument for it independent of latency.

### What is actually missing

1. **Decoupling the loop** — `ingestFile` currently interleaves chunk-write and extraction. Split into
   `ingestChunks()` (fast, locked briefly) and `extractPending()` (slow, lock per chunk or per small batch).
2. **A claim mechanism** so two extractors don't take the same chunk. Note this is a *narrower* problem than
   the graph-wide lock: it can be a per-chunk row-level claim inside one transaction rather than a filesystem
   protocol — which is the class of fix the lock rounds kept failing to hand-roll.
3. **When layout and prominence run.** Both currently run after ingest. With async extraction, entities
   arrive over time, so either they run after `extractPending` drains, or incrementally per batch. The layout
   pass is already additive and idempotent, so per-batch is viable; prominence recomputes wholesale and is
   cheap enough to defer to drain.
4. **Surfacing dirty state** — `tessera report` should show it, and the viewer arguably should too.

### Open questions

- Does a partially-extracted graph render honestly, or does a chunk with no entities read as a bug?
- ~~In-process worker vs. explicit command?~~ **DECIDED (Brian, 2026-08-08): an explicit
  `tessera extract <graph>`.** Resumable, composable, and in keeping with the repo's
  bring-up-is-a-documented-sequence stance — a failed or expensive step stays visible rather than buried in a
  server's lifetime. Consequences to design for: `serve` reports dirty count and tells the user to run it
  rather than silently doing it; the drop response says "42 chunks queued" and means it; and `tessera report`
  surfaces dirty chunks (which would already have shown the 2 unextracted chunks sitting in `graphs/big`).
- Retry policy for a chunk that fails to parse repeatedly — today it silently stays dirty forever, which is
  exactly what those 2 chunks in `graphs/big` are doing.

**Not this round** (Brian). Recorded now because it is the tractable answer to a risk we just accepted, and
because the two dirty chunks are evidence the model is already real and already unobserved.

## Identity as a read-time resolution view (B27, 2026-08-08): supersedes B5 in shape, preserves it in substance

Placed at the end rather than beside "Object model depth" deliberately: backlog items are referenced by
position (B2, B5, B23, B25 appear in `ddl.ts` comments and `queue.md`), and a mid-file insert would silently
renumber them. This is the second object-model thread; the SESSION delta under "Object model depth" is the
first. Companion: `docs/dedup-experiment-protocol.md`, the pre-registered experiments that gate slices 2 and
3 below.

**The recommendation, in one paragraph.** Keep write-time identity exactly as it is (type+name mints a row;
the raw layer never guesses) and build identity as a READ-TIME RESOLUTION VIEW: a deterministic `node_forms`
key table computed from each node's name, a union over nodes sharing a form, minus any pair carrying an
ANTI-EDGE, plus verified SAME_AS edges from an LLM reconciler that reads the originating chunk and is asked
one-to-many. A merge is a view, never a rewrite: nothing deleted (there is no delete), nothing derived
stored (so nothing goes stale), and no edge re-adjudication cascade, because edges keep raw endpoints and
are aggregated at read. Anti-edges and merge verdicts land on existing edge machinery (kind `SAME_AS`,
polarity supports|contradicts, reason in `edge_assertions`, originating chunk in `assertion_sources`). The
reconciler is a stateless processor like the Connector, not a store primitive. The first slice is
deterministic-only: 1714 entities resolve to ~1394 on testgraph without touching a stored row. testgraph is
the tuning corpus and is never deduped in place. Brian: *"the nice thing? We have a giant test corpus to
tune on now! So, don't get in a hurry to de-dupe it."*

### A correction first, because the record should show it

An earlier session told Brian there were **81 name-variance groups**. That was misleading: case-only
variants already normalise to the same identity key (`norm()` lowercases before hashing), so most of the 81
were **type jitter wearing a name-variance costume**. Verified 2026-08-08 against
`graphs/testgraph/graph.db`: **202 type-jitter groups** (same normalized name, more than one extracted
subtype; 469 nodes, 362 cross-type pairs), and **219 stripped-form groups containing more than one node**,
of which **48 have genuine name variance** (58 pairs) and 171 are pure type jitter. The full measurement
record, including two more corrections (the "all descriptions mention tessera" suspicion is false at 98 of
1714, and the stored vectors are nomic-embed-text over `name + ". " + description`, so Brian's remembered
name-only low-90s threshold transfers nothing), lives in `docs/dedup-experiment-protocol.md` §1.

### The frame-break: type is the caption

The problem is not "dedup is missing". It is that **identity is keyed on nondeterministic model output**.
`entityIdentity(type, name)` bakes the extractor's type verdict into the content hash, and a 14-way subtype
rubric at temp 0.4 jitters: `tessera` exists five ways (project s=8, technology s=7, product s=12,
organization s=4, concept s=2), `Connector` six ways, `mutation_log` six ways, `settle` seven. The repo
already states the governing principle against itself, in `mediaIdentity`'s comment: keying on a caption
would make identity depend on nondeterministic output. **Type is the caption.**

Two ways out, argued:

- **(a) Take type out of the identity string.** Dissolves the 202 groups at the source, BUT: it changes
  every content_hash, so every existing graph re-mints every entity on re-ingest with no delete to clean up;
  it contradicts the recorded decision that `place\tjava` and `concept\tjava` are distinct; and it forces
  homograph separation to be perfect at write time, which is the over-merge failure (0.85 cosine, "ANN"
  swallowed 92) already paid for once.
- **(b) Leave the stored key alone; demote it from "identity" to "evidence bucket".** Readers get identity
  from a resolution view. The class is dissolved for every consumer, the recorded decision survives as "the
  raw layer never guesses", migration cost is zero, and the evidence stays preserved for tuning. Honest
  cost: rows keep minting at the jitter rate, strength stays fragmented at the raw layer until the view sums
  it, and every read surface must eventually go through the view.

**Recommendation: (b). Type stops being identity without ever leaving the identity string.**

On the cascade Brian worried about, verbatim: *"all edges to a merged node may need to get re-adjudicated,
somehow? <true, and, .... OOF that could get expensive even if it's right"*. Under (b) the cascade cannot
happen, structurally: merging is never a write, edges never move, and the aggregate is recomputed at read.

**Types as a distribution come free** under (b) and need no schema: a resolved node's type is the
strength-weighted histogram of its members' subtypes, collapsing toward the argmax as evidence accumulates.
Nothing stored, nothing to re-adjudicate.

### What already exists (verified 2026-08-08)

- **The reconciler in miniature.** `putNode`'s reinforce branch already merges name (fill-if-empty), keeps
  the richer description, re-embeds on upgrade, bumps strength and version, and logs before/after. It fires
  only on exact identity match; the view generalises exactly this aggregation to form-sharing groups.
- **The anti-edge shape.** Edges carry kind+polarity (`contradicts` sits unused in the enum; polarity is
  `''` on all 3846 testgraph edges), `edge_assertions` carries a prose reason, `assertion_sources` carries
  set-valued grounding chunk ids, and every edge has status proposed|durable. Brian's anti-edge, verbatim:
  *"the name proposal that's rejected should carry its associated originating chunk... like an anti-edge. 'I
  may not be the same as node <other-ID>, with certainty <confidence>'."* That is representable today as ONE
  new Zod enum value (`SAME_AS`) and zero DDL (`edges.kind` is unconstrained TEXT). The one deviation from
  the verbatim, deliberate and argued below: no stored certainty number.
- **The verifier discipline.** `connector.ts` has the whole pattern: geometry proposes and never decides,
  two gates in diverse model families, `buildNodeContext` walking `APPEARED_IN` for a provenance chunk,
  dry-run sidecar by default, no numeric confidence stored.
- **The sure-enough seam.** Brian: *"there has to be a point when we're sure-enough of something."* The seam
  for that already exists: `status` on every node and edge, `promoteNode` (one caller, a test), and the
  empty shared vector tiers ARE the promotion machinery. Do not invent a parallel confidence system.
- **A deterministic homograph signal nobody uses.** The mapper's `here` map already detects a name splitting
  into two typed nodes WITHIN ONE CHUNK: the extractor asserting in one breath that these are two things.
  Today it only guards relation wiring. It is the correct first anti-edge writer, at zero LLM cost.
- The `typeConflict` guard in `putNode` is reachable only via the opt-in cosine path (`nearDupMerge`, 0.99,
  never passed by any caller) and has fired zero times on testgraph. `SAME_AS` edges never touch it, because
  they do not touch either node.

### What is missing

1. **A `node_forms` table**: `(form TEXT, node_id TEXT REFERENCES nodes(id), PRIMARY KEY(form, node_id))`
   plus an index on form. A form is a deterministic key from the node's name: stripped
   case/whitespace/punctuation/backticks/trailing `()`, snake/camel/space folded. A TABLE, not metadata
   JSON, because forms are a KEY, not a comparison: "which nodes share this form" must be one indexed
   lookup, and `json_each` cannot be indexed for that. Forms are pure functions of `nodes.name`, so this is
   a derived cache in the `extracted_chunks` family: recomputable, excluded from replay, salted by a
   `FORMS_VERSION` constant with the same pinned-test discipline as `PROMPT_VERSION`. Note: "unioned across
   mentions" is automatically true today, because a variant spelling mints a variant identity and each row
   derives its own forms; the union happens in the view. The day the extractor emits proposer forms
   (Brian: *"it is ok to name your canonical form_s_ if you might have more than one. common forms bridge
   the connection."*), those stop being derivable and must graduate to logged writes. Recorded now so the
   graduation is a decision, not a drift.
2. **The `SAME_AS` edge kind** (polarity `supports` = verified same; `contradicts` = anti-edge). One new
   enum value in `schema.ts`; everything else rides `putEdge` unchanged, including grounding.
3. **The resolution view in GraphStore, read-only**: union-find over (form-sharing groups + SAME_AS
   supports) minus (SAME_AS contradicts pairs, which split their group), exposing `resolveIdentity():
   Map<id, canonicalId>` and a lazy per-node aggregate (display name, summed strength, subtype histogram,
   unioned edges and provenance). `reconcile` is NOT a store primitive. The store gains only reads plus form
   maintenance; the reconciler is a processor-layer client, and merging is never a write.
4. **The reconciler pass (slice 2)**: candidates from form intersection first (O(1) per node); embeddings
   only for the residue where forms do not overlap (the Brian / Brian Brewington class); the verifier asked
   ONE-TO-MANY, per Brian's framing; verdicts land as `SAME_AS` proposed edges with the chunk as grounding.
   **No confidence numbers stored.** Three reasons, converging: Brian's NVIDIA experience scoring image
   reconstruction with model-emitted numbers (*"it wasn't reliable."*), the DREAM instance's refusal of the
   same idea, and the recorded `expert_surprise` watch item (geometry re-entering by the side door). What
   would earn a number: a calibration curve of verifier verdicts against hand-labeled pairs on testgraph.
   Until then, verdicts are binary and sureness is structural: independent verdicts from distinct chunks,
   then promotion.
5. **The anti-edge drop rule**: an anti-edge names two node ids; if either side is later absorbed into a
   union, the exclusion is NOT carried to the survivor (Brian's steer: that comparison no longer exists).
   Because merge is a view, "drop" is a read-time rule in the union-find, not a delete.

### Caching (Brian's cost worry, answered)

Brian, on compute-at-display: *"has to be smart about caching. My gut is that computation could be costly."*
The answer: union-find over ~1.7k entities and a few hundred SAME_AS edges is sub-millisecond; the real cost
is per-node aggregation. Cache key: `SELECT max(event_id) FROM mutation_log`, one integer read that
invalidates precisely on any write. The serve process holds the resolution map in memory keyed on that
integer and rebuilds on change; per-node aggregates memoize lazily under the same key. At 100k nodes, form
grouping is one indexed scan and union-find is still linear; the escape hatch is a `resolution`
derived-cache table in the `edge_prominence` family, invalidated by the same integer. And because nothing
derived is stored, the re-adjudication cascade cannot happen: edges never move.

### Smallest first slice, and what it refuses

**Slice 1 (deterministic, zero LLM calls).** The form function + `node_forms` + the resolution view unioning
nodes that share a stripped form, wired into `tessera report` and the viewer's node list; plus the mapper
writing a `SAME_AS` contradicts anti-edge when one chunk splits a name into two types. Acceptance, measured
in preview 2026-08-08: testgraph's entity view goes **1714 -> ~1394** (320 unions; `tessera` becomes one
node with a 5-way subtype histogram, `mutation_log` one from six, `settle` one from seven; exact counts are
fixed when `FORMS_VERSION` freezes the form function), and adding a single anti-edge visibly re-splits a
union. **Refusals, by construction:** no embedding-based union; no LLM call; no union of differently-stripped
names (so Brian / Brian Brewington stays split); no write-time merge; no stored-row change to testgraph.

**Slice 2.** The reconciler pass: form-residue candidates via kNN, one-to-many verifier with the originating
chunk, `SAME_AS` proposed edges, dry-run sidecar first, the Connector's two-gate and family-diversity
discipline reused. Gated on the protocol's VERIFIER EARNED verdict (E3).

**Slice 3, experiment-gated.** Fold form/alias proposal into the extraction call as one extra field. Brian's
caveat governs, verbatim: it *"could sink a tiny LLM into confusion. We can try both ways and compare?"*
Costs a `PROMPT_VERSION` bump plus per-chunk latency that the extract-performance analysis (queue item 4) is
about to care about. Run it as the protocol's measured A/B (E4, with E5 as the separate-pass alternative) or
not at all.

### Interactions

- **KI-3**: the type-jitter half is dissolved at read; the too-many-generic-entities half is untouched and
  remains I1 prompt work. The tighter type rubric stays worth doing but stops being load-bearing.
- **B5**: superseded in shape, preserved in substance. Layer 1 becomes slice 1's forms; Layer 2 becomes
  slice 2's verifier, with one deliberate change: the verified outcome is a `SAME_AS` edge feeding a view
  union, not a collapse at `putNode`, so an over-merge is one edge to contradict rather than 92 entities to
  un-swallow.
- **B7**: partially served, honestly stated. The verifier reading originating chunks prevents NEW
  cross-persona merges of bare relational terms, and anti-edges record the refusals. It does NOT split
  already-merged Grandmother rows: reinforcement collapsed those mentions, so per-mention evidence lives
  only in `APPEARED_IN` and `mutation_log`. B7's preferred fix (extraction-side subject qualification, I1)
  stands.
- **The held-back Connector**: the ordering stands and strengthens. The Connector runs over the RESOLVED
  view, so its candidate band stops being dominated by entity-resolution leakage (its own key finding). Its
  kNN-slots-eaten-by-provenance fix should land as part of pointing it at the view.
- **Unused machinery**: status/promotion adopted as the sure-enough seam, policy deferred.
  `polarity: contradicts` adopted for anti-edges. `vec_*_shared` untouched. `promoteNode` still uncalled;
  edge promotion is what the sure-enough gate needs first.

### Open questions

- Does stripped-name auto-union across types bite on a corpus with genuine homographs (`graphs/big`'s Java
  place vs technology)? Measure there before defaulting cross-type union on; a per-graph flag is the cheap
  hedge, and one anti-edge is the cure. (Hypothesis, not fact: jitter dominates homographs by more than 10:1
  on technical corpora; testgraph measures ~171:48, `graphs/big` may differ.)
- Which candidate-key functions beyond stripping are worth it for the residue (token-subset keys, so `Brian`
  proposes `Brian Brewington` as a candidate without auto-unioning)?
- Strength semantics in the aggregate: sum overcounts overlap-driven duplicate mentions, max undercounts
  corroboration. Pick after looking at real hubs through the view.
- Whether the mapper's `known`-map endpoint resolution should consult the resolution view, and whether that
  is a slice-1 freebie or a behavior change needing its own test.

### Dispositions

- **Option (a), type out of the identity string: REFUSED.** Re-mints every entity with no delete to clean
  up, contradicts a recorded decision, and re-fights the over-merge war at write time.
- **Write-time merge, any layer: REFUSED.** Merging is a view. This is what makes the OOF cascade
  structurally impossible rather than carefully avoided.
- **In-place dedup of testgraph: REFUSED.** It is the tuning corpus (Brian, verbatim above). Slice 1 cannot
  violate this even by accident, because it changes no stored row.
- **Stored confidence numbers on SAME_AS verdicts: REFUSED until a calibration curve exists** (verifier
  verdicts against hand-labeled pairs on testgraph). Until then, binary verdicts; sureness is structural.
- **Anti-edge drop rule: DECIDED** as a read-time rule in the union-find (the exclusion dies with the
  comparison; it is not carried to a merge survivor).
- **B5: SUPERSEDED IN SHAPE, preserved in substance**, per the Interactions bullet; a pointer now sits in
  the B5 entry.
- **Slice 1: PROPOSED**, queued as item 15 (after the E0+E1 experiment session; see `queue.md`).
- **Slice 2: GATED** on `docs/dedup-experiment-protocol.md` E3's VERIFIER EARNED verdict.
- **Slice 3: GATED** on E4's SAME-CALL EARNED verdict; refuted there means E5's separate pass is the design
  of record. A measured A/B or not at all.
- **Promotion policy for SAME_AS** (how many independent grounded verdicts = durable): **DEFERRED**, per
  Brian.
- **`known`-map consulting the view: OPEN** (see Open questions).

---

## Weak nodes should fade faster than strong ones on zoom-out (Brian, 2026-08-08)

**The report, verbatim:** *"weak nodes should fade to transparent faster on zoom out than strong nodes
(they hold unnecessary visual attention when zoomed out)."* Filed against a screenshot of `testgraph`
served at 0.52x: 2055 nodes rendered as an almost uniform grey field, with the hubs indistinguishable
from the singletons except by a size difference the fog has already eaten.

### What the render path does today (verified, not assumed)

- `radius(n)` (`viewer/template.html:303`) is `base + 10*sqrt(n.deg/maxDeg)`. **Size already carries
  strength.** That is the encoding the zoomed-out view is failing to deliver, not one that is missing.
- Node alpha is `ctx.globalAlpha = dim ? 0.18 : 1` (`:435`). **Alpha carries focus state and nothing
  else** — not strength, not altitude. Every node not dimmed by a selection draws at full opacity at
  every zoom level.
- Every node also draws a radial-gradient halo at `rr*2.4` before its core (`:436-438`). At 0.52x with
  2055 nodes those halos overlap into continuous fog. **The halo is probably the larger contributor to
  the mush than the core alpha is**, because it is 2.4x the radius and it is additive across neighbours.
  Whoever takes this should measure both before tuning either.
- Edges already do exactly the thing being requested for nodes: `pa = edgeAlpha * (0.35 + 1.30*p)` where
  `p` is the edge's percentile in the chosen prominence measure (`:420`). So the pattern to copy is in
  the same function, twenty lines up.

### The sub-decision this hides, and it is the real work

**What is "strong"?** `GRAPH.prominence` is **edge-keyed, not node-keyed** — `scripts/export-viewer.ts:31`
builds it from `store.edgeProminence(measure)`, and the viewer indexes it as `tbl[e.id]`. There is no
node-level pagerank or betweenness in the bundle. So today the only per-node strength signal available at
render time is `n.deg`, which is what `radius` and the label-tier budget already use.

Two ways to go, and they are not equivalent:

1. **Use `n.deg`.** Zero new plumbing, ships as a pure viewer change, consistent with radius so size and
   opacity encode the same thing. Weakness: degree in this graph is partly an artifact of extraction
   verbosity, which is exactly the noise KI-3 and the resolution view (B27) exist to fix. Fading by degree
   would make the map look calmer without the map being any better.
2. **Add node-level prominence to the bundle.** Honest, and it makes the edge budget's measure dropdown
   meaningful for nodes too. Costs an export change plus whatever `prominencePass` does not already
   compute per node. Check before scoping: the pass may already have node scores that are only ever
   consumed to derive edge products.

**Recommendation, weakly held:** ship (1) first because it is small and reversible and Brian can look at
it tonight, but write it so the strength lookup is a single function, so (2) is a swap and not a rewrite.

### Do not turn this into a cull

Fading is not filtering. A node at 0.05 alpha is still there, still hit-testable, still findable by
search, and comes back the moment you zoom in. If this lands as "drop nodes below a threshold at
altitude" it becomes the edge budget's node twin, which is a different and larger feature (it changes
what the map *contains* at a zoom level, not how loud it is) and it needs its own entry. The point here
is attention, not truth.

### Interaction with the deferred work

- **Slice 4 (provenance in the layout)** changes geometry, and the 36.6 s `h`-toggle cliff is a
  zoomed-out-with-everything-visible problem. Fading weak nodes does not fix the cliff — that is layout
  cost, not draw cost — but the two will be judged by eye at the same altitudes. Sequence them so a
  regression is attributable.
- **B27 resolution view** collapses ~1714 entity nodes to ~1394 at read time. That removes a fifth of the
  field on its own. If both land, tune the fade *after* the resolution view, or the constants get picked
  against a node population that is about to change.

**Disposition: BUILT 2026-08-15.** `nodeAlpha(n, tier)` in `viewer/template.html`, keyed off `tier.deg` —
the same per-altitude degree threshold the label budget already used, so opacity and labelling now tell one
story instead of two. Option (1) as recommended: `n.deg`, one function, so swapping in a node-level
prominence later is a body change and not a rewrite.

Measured while building it, and it reframes the report from a lighting complaint into a structural fact:
**346 of 1714 entities (20%) have zero semantic links, and 882 more have exactly one.** Median degree is 1;
only 65 nodes reach degree 5. So ~72% of the continent view was degree ≤1 drawing at full opacity with a
full glow halo. Running the shipped page's own `nodeAlpha` over the real graph: at continent 1671 of 1714
nodes now fall below 0.2 alpha and 5 stay above 0.8 (the tier's label budget is 4, so that is the design's
own intent); at building every node is 1.00.

Two decisions worth keeping:
- **The halo fades quadratically, the core linearly.** The halo is 2.4x the radius and ADDS across
  overlapping neighbours, so it, not the core, was what turned 1714 nodes into a uniform wash.
- **The altitude fade applies only when nothing is focused.** Compounding it with the existing focus-dim
  (0.18) drove background context to ~0.009 and blacked out the map around whatever you clicked. One dimming
  system at a time.

Still true, and checked rather than assumed: `nodeAt()` hit-tests on `radius`, never on alpha, so a faint
node is still clickable, hoverable and findable. Fading is not filtering.

**Open, and Brian's call by eye:** the constants. `TIER_FLOOR` and the 1.4 exponent are the knobs; 5 bright
nodes at continent may read as too austere. Tuning is a one-line change.

**Original disposition, kept for the record: QUEUED, viewer-only, no dependencies.** Small enough to do between the larger items, and
it wants a real before/after screenshot at the same zoom rather than a test, because the acceptance
criterion is "do the hubs read at 0.5x" and no assertion captures that. A test can still pin the pure
function (strength → alpha at a given scale) once it exists.

---

## Multiple descriptions per node, and therefore multiple embeddings (Brian, 2026-08-15)

**The idea, verbatim:** *"if nodes carry multiple descriptions (and perhaps they should) then they could also
carry multiple embeddings, which would help with edge proposal. Maybe different models would describe
differently. I wonder if that'd be interesting."*

**What a node embeds today, verified rather than read off a doc:** `name + ". " + description`, truncated at
2000 chars. `src/ingest/mapper.ts:37` builds that exact string and passes the vector to `putNode`, which uses
it rather than re-embedding. Confirmed during E1 by re-embedding a node and getting cosine **1.0000** against
the stored vector. One description, one vector, one row.

### Why this is more than a nice-to-have: it attacks a measured defect

E1 measured that adding the description to the embedding **hurts** identity matching badly — name-only
recovers 0.846 of known duplicates at a zero-false-positive floor, name+description recovers 0.169. The
diagnosis was register homogeneity: one model, one voice, one system, one register, so a large shared
constant rides on every description and swamps what distinguishes them. Separation between true duplicates
and confusable non-duplicates collapses from 0.516 to 0.197.

**CORRECTION (2026-08-15), because this paragraph was wrong and it was mine.** I originally wrote: *"If
several different models describe the same node, their shared component is no longer a single model's voice.
The shared-voice vector partially cancels; the referent does not."* That does not follow, and the variance
decomposition shows why. Write each model's embedding as *signal + shared-register component +
model-specific noise*. Averaging across models cancels the **model-specific** term — that is the entire
mechanism by which ensembles help. But the register component is **not model-specific noise; it is in the
input text**. Every model reads the same description, every model encodes the same stylistic regularity, and
every model's embedding contains it with the same sign. Averaging preserves it exactly, and ensembling more
decorrelated models makes it *relatively more* dominant by removing the only term that was diluting it.

So multi-model description does not attack the register constant. It may still be worth doing for the
agreement-as-evidence reason below, but not for this one.

That also connects to the `analogy_maker` instance's batching hypothesis (`docs/notes/`): our extractor emits
8-20 entities per call, so every description in the corpus is batch-generated, and they measured causally that
batched generation raises shared vocabulary 1.89x. Multi-model description and one-per-call description are
two independent ways of decorrelating the same nuisance signal, and the same instrument tests both — N-hard
mean cosine is the floor among known-unrelated nodes, already measured at 0.420 name-only vs 0.640
name+description. That 0.22 rise IS the shared component, quantified. Either intervention should move it down.

### What it would buy for edge proposal, which is Brian's stated motive

Today the Connector probes with one vector per node. With k descriptions a node has k probes into the
neighbourhood, and the interesting signal is not the union but the **agreement**: a neighbour found by every
description is a different kind of candidate from one found by exactly one. That is a confidence signal
obtained without a verifier call, and it is the same shape as the two-signal complementarity found in E2
(cosine and string agreement failing in different places, so their conjunction is trustworthy and their
disjunction is a candidate set).

### The costs, stated honestly

- **Storage and schema.** `vec_node_*` is keyed one vector per node. Multiple descriptions means either a
  description table with its own vector rows, or k parallel indexes. This is a real schema change, not a
  column.
- **Extraction cost multiplies.** Each additional describing model is another pass over every entity. E4
  measured that roughly half the per-call cost is fixed, so a second describer is not half price.
- **Identity must not fork.** A node is still ONE node. Descriptions are attributes of it, not variants of
  it, and the identity string must keep excluding them or the whole content-addressing scheme splits.
- **Which description does the viewer show?** The panel shows one. Picking arbitrarily is a lie; showing all
  is clutter. Probably: a designated primary, others behind the deep-inspect.

### Open questions

- Does multi-model description actually decorrelate, or do models trained on overlapping corpora share the
  same register anyway? **This is measurable before building anything**, and cheaply: describe ~200 nodes
  with two different local families, embed both, and compare N-hard mean cosine per family and pooled. If
  pooled separation beats each family alone, the idea is real. If not, it dies for the price of ~400 calls.
- Is agreement-across-descriptions actually a better candidate signal than one good description? Same
  experiment answers it.
- Does this interact with the resolution view (B27)? A node with k descriptions has k chances to match a
  candidate, which raises recall and probably also raises false-merge pressure. The anti-edge rule would need
  to know which description produced a rejected match.

### The flip: agreement ACROSS embeddings as edge evidence (Brian, 2026-08-15)

*"seems there's also merit in multiple embeddings. nodes connected by multiple embeddings and multiple
descriptions should have a very strong connection, and the edge description/s could be similarly rich."*

This inverts the idea and is the stronger half. The first version treats k descriptions as k chances to
match. This one treats **the number of independent routes between two nodes as the edge's strength**, which
is a different and better quantity: an edge asserted by the extractor AND found by the qwen-description
embedding AND found by the gemma-description embedding is corroborated by three mechanisms that fail
differently. One asserted by exactly one is not.

Why this is well-founded rather than appealing: it is the same shape as two results already measured here.
E2 found cosine and shared-string-improbability fail in *different places*, so their conjunction admitted
zero known-confusable pairs while either alone admitted some. E3 found the verifier's decoy-pick rate was
0.0% for both families — independent mechanisms agreeing is the signal, not any single mechanism's
confidence. And `hebbian_weight` already encodes exactly this intuition for *repetition*: 1181 of 1239
RELATED edges sit at weight 1, so corroboration is currently rare and therefore meaningful. Multi-embedding
agreement would extend corroboration from "said twice" to "found by different instruments".

**The edge-description half is the part with no precedent here and deserves care.** An edge today carries
`reason` strings as graded assertions. If several embeddings propose the same edge, each proposal has its own
rationale, and those are *not* interchangeable: "these co-occur in the same chunk", "these are near in
qwen-description space", "these share an improbable name fragment" are different kinds of evidence. Storing
them as one flat bag of reasons would destroy exactly the distinction that makes agreement informative.
`assertion_sources` is already SET-valued and provenance-carrying, which is the right substrate — but the
*kind* of evidence needs to be a first-class field, not encoded in prose.

**Cheapest first probe, and it needs no new embeddings at all:** the corpus already has one embedding per
node plus the extractor's own edges. Measure whether cosine-proximity and extractor-assertion agree more than
chance on the existing 1239 RELATED edges, and what the agreement rate predicts about edge quality. If those
two existing instruments turn out to be near-independent (and the tutorial measurement above suggests they
might be — the force layout preserves only 6.8% of embedding neighbourhoods against a 3.9% chance floor),
then agreement is carrying real information and the multi-embedding version is worth its cost. If they are
redundant, adding more embeddings of the same kind buys little and the money goes to *different kinds* of
evidence instead.

**Disposition: QUEUED as an experiment, not as a build.** The cheap decorrelation measurement above is the
gate, and it reuses E0's frozen label sets and the existing N-hard control, so it costs one afternoon and no
new pre-registration beyond its own decision rule. The agreement probe in this section is cheaper still —
zero LLM calls, zero new embeddings — and should run first. Nothing gets built until those numbers exist.

---

## A proper RAG over tessera — the plan (Brian, 2026-08-15: *"it'll be insightful to actually build a proper RAG on this. Not yet. But let's plan it."*)

**Status: PLAN ONLY. Nothing built.** Recorded now so the design exists before the appetite does.

### Why this is the sharpest test the project has

Everything built so far is justified by a claim that has never been measured: *that a graph over the corpus
retrieves better than the corpus alone*. A RAG is the first thing that puts a number on it, because plain
chunk-vector retrieval is a trivially available baseline and the graph either beats it or it does not.

That reframes the deliverable. **The point is not to have a RAG. The point is to have a comparison.** A RAG
that ships without a baseline answers nothing, and is the most likely way to spend a week and learn zero.

### What already exists (verified, not assumed)

- **318 chunk nodes** holding raw text, each embedded on that text, each linked `ORIGINATED_FROM` its
  document. This is a complete conventional vector store already; nothing needs building for the baseline.
- **1714 entities**, merged across documents by `type + normalized(name)`, each linked `APPEARED_IN` its
  chunks. That is the entity-to-evidence index a graph retriever needs.
- **1239 RELATED edges**, each carrying `reason` assertions that are written to *name both endpoints' roles*
  rather than restate the endpoint names. The README calls those reasons "the primary retrieval signal", and
  that claim is also unmeasured.
- `paths` and `common` commands already traverse the graph and are the seed of a graph retriever.
- Edge prominence measures (betweenness, pagerank product) are computed and stored.

### The three arms, and they must be run together

1. **VECTOR (baseline).** Embed the question, retrieve top-k chunks by cosine, answer from them. Deliberately
   unglamorous. Everything else must beat this or it does not exist.
2. **GRAPH-LOCAL.** Resolve question terms to entities, walk 1-2 hops, gather the chunks those entities
   appear in, and include the edge `reason` strings as context alongside the chunk text. This is the arm
   that tests whether relation reasons are worth what they cost to extract.
3. **HYBRID.** Vector retrieval to seed entities, then graph expansion from those seeds, then rank the union.
   The published systems (GraphRAG local search, LightRAG) converge on roughly this shape, which is weak
   evidence it is right and strong evidence it is the expected thing to try.

A fourth arm, **GRAPH-GLOBAL** (community summaries answering "what are the themes here?"), is where GraphRAG
claims its biggest wins. It is deferred: it needs the clustering pass, which is itself gated on the
resolution view, because summarising communities built from 20%-duplicate entities would summarise the
duplication.

### The honest obstacles, named up front

- **Extraction quality is the confound.** 346 of 1714 entities have zero semantic links and the median degree
  is 1. A graph retriever on a graph that thin may lose to the vector baseline *for reasons that have nothing
  to do with whether graphs help*. Either fix quality first, or report the result as "graphs do not help
  **at this extraction quality**", which is a weaker but still honest claim.
- **Identity duplication directly attacks arm 2.** If "Brian" and "Brian Brewington" are two nodes, an
  entity-seeded walk starts from half the evidence. **This is another arrow pointing at dedup**, and it is
  the one with a number attached: the resolution view would take the entity view from 1714 to ~1394 with no
  stored row touched. Run the RAG before that and arm 2 is handicapped by a known, fixable defect.
- **Evaluation is the hard part, not retrieval.** Retrieval is an afternoon. Knowing which arm won is the
  project. See below.

### Evaluation, which is where this stands or falls

Pre-register before running anything, per the discipline that produced E0-E4:

- **A question set, written before any arm runs**, ~40 questions across three registers: single-fact
  (answerable from one chunk), multi-hop (needs two chunks that share an entity), and thematic (needs many).
  The multi-hop band is where a graph should win; if it does not win *there*, it does not win.
- **Retrieval-level metrics before answer-level ones.** Whether the right chunk was retrieved is mechanical
  and cheap; whether the generated answer is good needs a judge, and E3 measured our local judges are not
  verifier-grade as prompted. So: recall@k of the gold chunk, per band, per arm. Answer quality is a
  second phase and explicitly not the primary metric.
- **Gold chunks labelled by hand**, by Brian, once. ~40 questions is roughly the same 15-30 minutes as the
  E0 audit, and the same rule applies that E0 taught the expensive way: **state the sample size needed for
  the decision rule BEFORE collecting, or the rule turns out to be unsatisfiable at the size collected.**
- **The decision rule, frozen in advance:** the graph arm must beat the vector arm on multi-hop recall@5 by a
  margin exceeding the vector arm's own run-to-run variance. Ties go to the baseline, because the baseline is
  radically simpler and simplicity is the incumbent.

### Sequencing

Gated on the resolution view (item 15) for arm 2 to be a fair test, and on nothing else. Arms 1 and 3 could
run today. **Recommended order when the appetite arrives:** write the question set and label gold chunks
first (it is the long pole and it is human time), build arm 1 while that happens, then arms 2 and 3.

**Disposition: PLANNED, NOT SCHEDULED.** Brian: *"Not yet."*

---

## The surprise map: let prediction error move the geometry (Brian, 2026-08-15)

*"like a surprise map. something shows up and if it slots in with what is already known/expected, little
changes. Brains (and Brians!) are drawn to novelty, to the unexpected."*

**This is the strongest idea in this stretch and it should be recorded as such.** It resolves a problem
raised two turns earlier and left open: a layout that adapts to what you are interested in is a filter bubble
made of geometry, because relevance is self-confirming. It brings you closer to what you already lean toward
and quietly loses the ability to surprise you.

Brian's formulation inverts the objective and dissolves that. **Movement is not proportional to relevance,
it is proportional to prediction error.** A new document that slots into the existing structure changes
almost nothing, which is correct — you already knew that. A document that does not fit *forces* geometry to
move, and the movement itself is the notification. The map stops being a picture of the corpus and becomes a
picture of *what the corpus did to your model of it*.

### Why this is well-founded rather than merely poetic

- It has real theory behind it. Predictive-processing accounts of perception (and Itti & Baldi's "Bayesian
  surprise attracts human attention", NIPS 2005 / Vision Research 2009) argue that attention is drawn by
  KL divergence between prior and posterior belief — literally, by how much an observation changed your
  model. That is the same quantity proposed here, applied to a map instead of a retina.
- **It respects the stability constraint instead of fighting it.** Every other adaptive-layout idea trades
  away the "a map you learned stays put" rule. This one *derives* stability: an unsurprising ingest moves
  nothing precisely because it was unsurprising. Stillness becomes meaningful rather than merely preserved.
- It gives movement a semantics. Today a node moving means "the settle ran". Under this rule, movement means
  "this did not fit what was here". That is a channel currently carrying nothing.

### What would have to be built, and the honest hard part

The mechanism is not the hard part. Displacement is already measurable, and the tutorial
(`docs/tutorials/`) established neighbourhood preservation as the way to measure what a layout keeps.

The hard part is **the prior**: surprise is only defined relative to an expectation, so the map needs a model
of what it expected. Candidates, cheapest first:

1. **Positional.** Where would the existing layout have put this node? Seed it by the semantic rule already
   in `layout/pass.ts` §3.3(b), then measure how far the settle drags it. Large drag = poor fit = real
   surprise. **This needs nothing new** and is the obvious first probe.
2. **Predictive.** Hold out a document, ask what the graph predicts its entities and relations would be,
   compare to what extraction actually produced. Expensive but it is the honest version.
3. **Density.** Surprise as the local sparsity of embedding space where the newcomer lands — arriving where
   nothing is, versus arriving in a crowd.

### The trap to avoid, stated now

Novelty and noise are indistinguishable from inside the metric. A garbled chunk, a parse failure, a
badly-extracted generic entity — all of these are maximally "surprising" and all of them are junk. A surprise
map naively built would faithfully devote its most dramatic motion to the worst data in the corpus. Any
version of this needs a quality term, and the honest first experiment should check whether measured surprise
correlates with extraction quality before it is believed.

**Disposition: QUEUED as a probe.** Probe 1 above is nearly free: instrument the existing layout to record
per-node displacement between seed and settled position, ingest a document, and look at what moved most. If
the top-moving nodes are interesting, the idea is real. If they are parse failures, the quality term is the
project.

---

## Attention in transformers, viewed as a graph (Brian, 2026-08-15)

*"I wonder about the intersection between these attention-formed graph views and transformers. Like how
might we illustrate the shifts in attention that comprise progression through a transformer by looking at
the graph."*

**The connection is more literal than it sounds, and that is worth stating precisely, because the word
"attention" is doing double duty and conflating the two senses would be a genuine error.** Perceptual
attention (what a viewer looks at) and transformer attention (a softmax over query-key dot products) are
different things that share a name.

But there is a real, non-analogical claim underneath: **a transformer's attention pattern IS a weighted
directed graph over tokens, and a forward pass IS a sequence of such graphs.** Each head at each layer emits
an n x n weight matrix; that is an adjacency matrix. A 12-layer, 12-head model produces 144 graphs over the
same node set. So "illustrate the shifts in attention that comprise progression through a transformer by
looking at the graph" is not a metaphor to be constructed — it is a description of what the object already
is.

What makes it interesting *here* rather than generically: tessera has spent this session building machinery
for exactly this shape of problem — a fixed node set, edges that change, and the question of how to lay it
out so a human can see the change. The dynamic-graph stability problem is the same problem. The answer we
reached for the map (fix the geometry, vary the emphasis) is the standard answer for attention visualisation
too, and arriving at it from two directions is mild evidence it is right.

**Deferred, and honest about why:** this is a teaching and research thread, not a tessera feature. It does
not make the knowledge graph better. It is recorded because the analogy may repay the map (an attention
matrix is a dynamic weighted graph with ground truth available, which is a rare and useful test case for
layout stability work) and because Brian is building an attention book. See the sequel tutorial.

---

## A human-in-the-loop measurement apparatus for attention (Brian, 2026-08-15)

*"a game idea: see if you can get a human, picking tokens, to _be_ a transformer, completing sentences
(somewhat) at random. then compare to what the actual network does... somewhere in there is a measurement
apparatus for attention with a human in the loop. that is barely half an idea."*

**Levelling, as requested: the game as literally stated does not work, and the reason is instructive.** A
human picking tokens "somewhat at random" is not doing what a transformer does. A transformer does not pick;
it emits a full distribution over the vocabulary, and sampling from that distribution is a separate step done
by the decoder. A human producing one token gives you one sample, and you cannot recover a distribution from
single samples without many trials.

**But the other half of the idea is real, and it is older and better-founded than either of us assumed.**
Shannon did essentially this in 1951 ("Prediction and Entropy of Printed English", Bell System Technical
Journal 30:50-64): he had humans guess successive letters of English text and used the *number of guesses
required* to bound the entropy of English. The number-of-guesses trick is exactly the move that recovers a
distribution from a human who can only produce one answer at a time. That is the apparatus, and it has been
sitting in the literature for seventy-five years.

The modern descendant is the **cloze task** in psycholinguistics: cloze probability (the fraction of humans
completing a context with a given word) versus model surprisal, with reading time as the dependent measure.
That literature is large and the correlation between surprisal and reading time is one of its more robust
findings. So "compare human prediction to what the network does" is a running research programme rather than
a new idea — which is good news, because it means there is a method to borrow instead of invent.

**What would be genuinely new**, and is the part worth pursuing: doing it over a *corpus the human authored
or knows intimately*, which is precisely what tessera holds. Shannon measured the entropy of English. The
interesting question here is the entropy of **your own corpus to you** versus to a model — where you are
surprised and the model is not, and vice versa. That difference is a measurement of what you know that the
model does not, and it is the same quantity the surprise map above wants for its prior.

**Disposition: PARKED as a research thread, with the method identified.** Not a tessera feature. The
playable version lives in the sequel tutorial as a teaching device, and the honest framing there is
Shannon's guessing game rather than "be a transformer".

---

## Cross-agent review of the layout work (Grok + Composer, 2026-08-15) — dispositions

Both reviewers led with the same **structural objection**, and it deserves recording rather than burying:
*the viewer should not be a layout engine.* Their argument: it turns a display surface that must also run as
`file://` into a geometry editor, and that single choice produces the 700KB payload, the O(n²) main-thread
optimiser, the per-request projection, and a PUT that can overwrite the only stored positions. Their proposed
cut: layout stays a CLI/server job writing **named** layouts; the viewer switches between stored ones.

**Disposition: ACCEPTED IN PRINCIPLE, DEFERRED IN PRACTICE, with the reason stated.** They are right that
named layouts is the better end state, and "there is no disk undo" is the sharpest version of the argument.
What the current shape buys is the thing Brian actually asked for — turning a knob and *seeing* the result —
and a CLI round-trip does not deliver that. So the guards below make the destructive path safe, and named
layouts is recorded as the next move rather than pretended away. **Revisit when** a second layout is worth
keeping at the same time as the first; that is the moment overwrite stops being tolerable.

### Fixed, each with a test that failed first

| # | Finding | Fix |
|---|---|---|
| G1 | **Save could tear the map.** Layout ran over visible+embedded nodes; save wrote *every* node. Hide provenance, compute, apply, save, and the graph is permanently half t-SNE and half CLI coordinates. No malice, no divergence — the happy path with `h` pressed. | Layout now runs over **all** nodes with vectors; `layoutCoversAll` compares id **sets** (not counts) and Save is refused and relabelled unless coverage is total. |
| G2 | **Undo after save was a lie.** Undo is in-memory; save is a PUT. Apply → Save → Undo left the screen showing one thing and the database another. | A successful save clears the undo stack and says so. Nothing offers to undo a write it cannot reach. |
| G3/C3 | **Hop distances went stale** when the edge budget or `h` changed `EDGES` under a held selection, while the interaction lock followed the new edges. Bright-but-inert nodes. | `edgeEpoch` bumped in `rebuild()`; hop cache keyed on `(selected, edgeEpoch)`. *Found independently before the reviews came back.* |
| G6/C2 | **NaN could reach the canvas.** `STEP_MAX` bounds a step, not a NaN (`NaN > STEP_MAX` is false), and `writeBack` turns a NaN radius into NaN coordinates. | `layoutIsFinite` gates Apply, and also refuses a collapsed result, which is finite and equally useless. |
| C1 | **`writeLayout` never validated ids** though its comment claimed it did. Unknown ids deferred to `putLayoutBatch`: opaque failure, or a partial write reported as success. | Validation extracted to an exported `validateLayoutPayload`, checked against the graph's real id set, plus an out-of-range check because `Number.isFinite(1e308)` is `true`. |
| G5/C1 | **The tests cloned the validator** instead of calling it — decoration that would keep passing as the handler drifted. | `test/serve-layout.test.ts` drives the shipped function. |
| C4 | **Right-click bypassed the interaction lock.** Left-click was gated, `contextmenu` was not, so deep-inspect could jump outside the focused neighbourhood. | Gated identically. |
| G7 | **Apply did not move the camera**, so a computed layout could land off-screen and read as "Compute failed". | `fitAll()` frames the result. |
| G8 | **Sliders stayed live after Compute**, so they described a run that Apply would not perform. | Params freeze while a computed layout awaits a decision. |
| G9 | `FRAME_MS = 24` exceeded a 16ms frame while claiming responsiveness. | 10ms. |
| G10/C6 | A comment still said there was no layout endpoint and nothing wrote the database, in the same file that added both. | Rewritten. |
| G/C | **Projection recomputed on every page load** (~63M multiply-adds per reload, before anyone touches layout). | Memoised on the node-id set, so an ingest correctly invalidates it. |

### Not fixed, with reasons

- **Worker-based optimiser.** Real, and the right answer at scale. Deferred: `file://` has no server to fall
  back on, and a Blob worker is a second code path for a feature whose value is still unproven. **Revisit if**
  the main-thread hitch is actually felt at 2000 nodes with `FRAME_MS = 10`.
- **Named layouts instead of overwrite.** The structural fix above.
- **Fade floor now exceeds the perception evidence at the top of the slider.** Deliberate, documented at the
  constant: the measured band (0.10-0.20) answers "backgrounded but legible", and past 70% this control is
  answering "remove it". Brian asked for the unlinked mass to go nearly black; at 100% it renders at 0.030.
