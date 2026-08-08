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
