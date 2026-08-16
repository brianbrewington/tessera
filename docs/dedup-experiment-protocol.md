# tessera: entity-dedup experiment protocol (pre-registered)

*A pre-registered protocol in the style of `docs/clustering-mining-sketch.md`: every label set, decision
rule, control and verdict is committed here BEFORE anything runs, so a result cannot be tuned into passing.
Status: **E0 and E1 have run (2026-08-08); results in `docs/dedup-e0-e1-results.md`. E2-E5 have not.** The
registered rules below are NOT edited after the fact — results live in the companion document. Every script is read-only over `graphs/testgraph/graph.db`; sidecars
land in `graphs/testgraph/dedup/` (the `graphs/big/mine/` precedent), each recording embedder, model tags,
seeds, and the frozen decision rules. The fixture is opened read-only in every script: testgraph is never
deduplicated, never re-extracted, never written. E4's arms write JSON sidecars, not graphs. Facts marked
**[measured 2026-08-08]** were re-verified against the fixture before this document was written; everything
else is labeled hypothesis or decision. Companion: the backlog entry "Identity as a read-time resolution
view (B27)", which holds the design these experiments gate.*

Brian, on the fixture, and this is the protocol's standing order:

> "the nice thing? We have a giant test corpus to tune on now! So, don't get in a hurry to de-dupe it."

---

## 0. Three reframes that reshape the plan

These came out of measurement, not argument, and they are the most important part of the document.

**Reframe 1: most measured duplication needs NO embedding.** 202 groups of entities share a normalized name
and differ only in extracted type (469 nodes, 362 cross-type pairs), and 48 groups (58 pairs at the norm
level) have names identical after stripping space/case/punctuation **[measured 2026-08-08]**. All of that is
deterministic Layer-1 territory: zero LLM calls, near-zero over-merge risk. The embedding question governs
only the RESIDUE (Brian vs Brian Brewington; a chunk's memo vs an extraction's memo). So the FIRST number
this protocol produces is how big the residue is after deterministic Layer 1, and no experiment tunes a
threshold before that number exists.

**Reframe 2: the threshold question is answered in kind, if not yet in number.** House doctrine (geometry
proposes, never decides), the ANN-at-0.85 incident (92 entities swallowed), and the Connector's measured
NON-MONOTONIC reject curve (`graphs/big/mine/connector-proposals.json` **[re-verified 2026-08-08]**: reject
0.95 in [0.75,0.80) on 40 candidates, 0.778 in [0.80,0.85) on 9, 1.0 at [0.90,0.95) on n=1) jointly
pre-commit the answer: **no cosine number will ever merge unattended.** E2 does not search for "the
threshold"; it measures whether any candidate FLOOR exists with acceptable recall at zero tolerated
hard-negative admissions, per type. A floor is a candidate-budget knob, and saying so up front is honest.

**Reframe 3: the free-labels idea has a DEGENERACY, stated plainly because it was my proposal and it was
flawed.** I proposed type-jitter pairs as free ground truth. But type-jitter positives have byte-identical
names, so any name-based representation scores cosine 1.0 on them **by construction**. Jitter positives
cannot rank name-only against anything; the only thing they can test is whether adding description or type
signal DESTROYS identity. Unstratified, E1's head-to-head would be circular for exactly the representation
Brian suspects won last time. The positive set is therefore stratified (see E1's registered degeneracy
handling), and the flaw is on the record.

## 1. Confirmed facts (verified read-only against `graphs/testgraph/graph.db`)

All **[measured 2026-08-08]** unless noted. Three of these are corrections of things I previously told
Brian, marked as such, because the record should show it.

- 1714 entity nodes (2055 total minus 318 chunks and 23 documents). All 1714 have non-empty descriptions.
- 202 type-jitter groups under `norm()` (same normalized name, more than one subtype): 469 nodes, 362
  cross-type pairs. Grouping on byte-exact names instead gives 175 groups.
- **CORRECTION (the "81" figure).** An earlier session reported **81 name-variance groups**. That was
  misleading: case-only variants already normalise to the same identity key (`norm()` lowercases before
  hashing), so most of the 81 were type jitter wearing a name-variance costume. The honest split: **48
  genuine name-variance groups** (distinct normalized names sharing a stripped form; 58 pairs), inside **219
  stripped-form groups containing more than one node** (the other 171 are pure type jitter). Counting raw
  case variants inflates the variance-group count to ~80, which is where the misleading 81 came from.
  (Adjacent measurement passes have produced 47 and 220 for these two counts; the differences are single
  borderline groups, and E0's frozen `labels.json` settles the exact numbers.)
- **CORRECTION (register homogeneity).** I suspected all descriptions mention "tessera". False: **98 of
  1714** descriptions contain the string. Register homogeneity remains a hypothesis, and it is measured by
  E1's hard-negative control, not assumed either way.
- **CORRECTION (what the stored vectors actually are, and what transfers).** The stored node vectors are
  **nomic-embed-text (768d) over `name + ". " + description` (first 2000 chars)** , verified by the planning
  session by re-embedding a node and getting cosine 1.0000 against the stored vector. Not the identity
  string, not embeddinggemma. So name+description is the INCUMBENT representation, and Brian's remembered
  name-only low-90s threshold came from a DIFFERENT system in a DIFFERENT embedding space. **Nothing
  transfers.**
- Contamination profile of the jitter groups: 15 of 202 touch a person or place subtype; adding event brings
  it to 27 groups (where a genuine sense-split is plausible: mother, de doorns, klipgat farm, codex, grok).
  The excluded groups carry 85 of the 362 cross-type pairs, leaving 277. (An earlier draft said "15 excluded
  groups, 347 remaining pairs"; that counted person/place only and mistook groups for pairs. The registered
  exclusion below is person/place/event, and the sidecar lists every excluded group.) The insight survives:
  the overwhelming majority of jitter pairs sit inside the concept/technology/product/project/code/other
  blob, so the exclusion is bounded and auditable.
- 318 chunks, all extracted under `PROMPT_VERSION="1"`, zero recorded errors, ~7.5 s/chunk.
- Models on this box **[re-verified 2026-08-08 via `ollama list`]**: qwen2.5:14b, gemma3:12b, phi4,
  mistral-small, llama3.3:70b, qwen3:32b, qwen3-coder:30b, nomic-embed-text. Two-family verifier pairs exist
  without pulling anything.

## E0: freeze the label sets and bound contamination

**Question.** Are type-jitter and strip-variant pairs usable as free ground truth, and what fraction is
contaminated?

**Procedure.** One read-only script, sidecar JSON. Emit `labels.json` with four frozen sets:

- **P-jitter**: cross-type pairs from norm-identical-name groups, EXCLUDING any group containing subtype
  person, place, or event (registered exclusion; 27 groups, 277 pairs remain **[measured 2026-08-08]**; the
  excluded groups are listed in the sidecar, not silently dropped).
- **P-variant** (58 pairs): distinct norm-names, identical after `[^a-z0-9]` strip.
- **N-random** (500): uniform random entity pairs, no shared name token, different source documents, fixed
  seed recorded.
- **N-hard** (~300): pairs joined by a RELATED edge whose names share no strip-normalized containment.
  Guaranteed confusable, almost guaranteed distinct. This is the control standing in for "ANN swallowing 92
  entities".

Then the human audit, the ONLY labelling in the protocol: 40 pairs, blind, stratified 15/10/5/10 across the
four sets, shuffled. Brian answers same/not-same. About 15 minutes.

**Metric.** Contamination rate per set, with a Wilson interval.

**Control.** The N sets are audited alongside the P sets: a judge who calls everything "same" is caught here.

**Decision rule (frozen).** P-set contamination upper bound <= 10%: free labels usable, and every downstream
metric carries the bound as an error bar. Over 10%: that set is refuted, drop it. N-hard contamination over
10%: replace N-hard with human-picked hard negatives before E1 runs. Do not proceed with a poisoned control.

**Cost.** Zero LLM calls, ~5 min compute, 15 min of Brian.

**Fallback** if Brian is unavailable: a different-family LLM audit, explicitly flagged as weaker.

## E1: representation head-to-head, embedding only

**Question.** Which embedding input (name / normalized name / name+type / name+description /
description-only) best separates known duplicates from known-related-but-distinct pairs in nomic-embed-text
space?

**Procedure.** Embed all 1714 entity rows under the five representations, locally. Compute cosine for every
pair in E0's four sets, plus a background distribution via the exact stride-sampling of
`measureCosineDistribution` in `connector.ts`.

**Registered degeneracy handling (reframe 3, operationalized).** P-jitter pairs are scored ONLY for
representations whose input differs between the two nodes (name+type, name+description, description-only).
They are EXCLUDED for name and strip(name), where cosine is 1.0 by construction. P-variant and the audited
judgment pairs are the positives for the name arms.

Sidecar: per-representation, per-set cosine distributions; AUC of P vs N-hard; and the operational number,
recall on P at the cosine that admits ZERO N-hard pairs, and at 1% of N-hard.

**Metric (primary).** recall@FP=0-on-N-hard, per representation. AUC is reported, never decides.

**Control (primary signal).** N-hard admission count. Plus the description-drag test: if description-bearing
representations put P-jitter and N-hard in overlapping bands, Brian's suspicion is confirmed and
description-only is dead regardless of AUC.

**Decision rule (frozen).** Proposer-grade = recall@FP=0-on-N-hard >= 0.8 on P-variant (and >= 0.8 on
P-jitter where scored). If no representation reaches 0.8, geometry cannot even propose here; candidate
generation falls back to string blocking + type vote, and E3 runs on that. Ties within the contamination
error bar: prefer the simpler representation.

**Cost.** ~8,600 embed calls (1714 x 5), local, 10-20 min. Zero chat calls.

**Invalidated by:** E0 contamination over bound; any embedder change (the sidecar records the embedder
precisely because `meta.json` does not); mixing vectors from `graphs/big` (different embedder era, never
comparable).

## E2: threshold shape, one number or per-type or none

**Question.** Does any single cosine floor work across types, or does the crossover move?

**Procedure.** Zero new compute; analysis over E1's sidecar, and the analysis is FROZEN BEFORE E1 RUNS. For
the winning representation, recompute recall@FP=0 and the P/N-hard crossover within each subtype pairing
with >= 20 labeled pairs; report the spread, and the monotonicity of N-hard admission by cosine band.

**Metric.** Max minus min of per-type zero-FP floors.

**Control.** Band monotonicity. If admissions do not fall monotonically as cosine rises, no floor is
trustworthy (the Connector's non-monotonic reject curve is the precedent that this happens in practice).

**Decision rule (frozen).** Spread <= 0.03: one global candidate floor is defensible. Over 0.03: per-type
floors. Non-monotone: no floor certifies anything, and the floor is set purely by verify budget. **In all
three outcomes the floor gates CANDIDACY, never merging.** What stops an ANN recurrence is not the number:
(a) E3's verifier as a mandatory gate, (b) a per-run merge cap, (c) sidecar-first with an audit file per
proposed merge, (d) the strength-weighted canonical rule with the mutation logged. That is the
pre-commitment.

**Cost.** Zero.

## E3: can a model answer the one-to-many merge question? Decoy-calibrated

**Question.** Given a node and a candidate list, does a small local model pick the true duplicate, refuse
when there is none, and how often does it grab a planted known-unrelated decoy?

**Procedure.** ~300 trials built from E0's labels. Each trial: a probe node plus 4 candidates (names and
descriptions, NO COSINES SHOWN, order shuffled with a recorded seed). Three trial types, ~100 each:

- **HIT**: the list contains the true duplicate, 2 distractors from N-hard neighbours, plus ONE PLANTED
  DECOY (same subtype, different source doc, no shared strip-tokens, cosine below the E1 background median).
- **NULL**: no true duplicate; 3 plausible distractors plus a decoy; the correct answer is "none".
- **JUDGMENT**: the audited hard cases.

The prompt asks a forced structured choice `{"same_as": "<candidate id or NONE>"}` with a one-sentence
reason. **NO CONFIDENCE FIELD EXISTS IN THE SCHEMA, deliberately**: every metric is a choice rate, never a
self-reported score. Brian, from scoring image reconstruction with model-emitted numbers at NVIDIA: *"it
wasn't reliable."* Run twice: qwen2.5:14b and gemma3:12b (two families; same-family pairs refused by house
rule). Temperature 0. Parse failures get their own counter, never folded into "no".

**Metric.** Decoy-pick rate (this IS the continuously-measured false-positive rate, no labels needed); null
abstention rate; hit recall; Cohen's kappa against Brian on the 40 audited pairs (reuse E0's sample so Brian
is not asked twice).

**Control.** The decoy, present in every list. Secondary: a position-bias check (if the model favours
position 1, the run is voided and reshuffled); cross-family agreement.

**Decision rule (frozen).** Verifier-grade = decoy-pick <= 2% AND null abstention >= 95% AND hit recall
>= 90% AND kappa >= 0.6, for at least one family. Decoy-pick over 5% for both families: creation-time LLM
merge is REFUSED for now; only deterministic Layer 1 ships, and the answer is "no, not with these models",
recorded as a result, not a failure.

**Cost.** ~600 chat calls, 30-80 min. Zero new minutes from Brian.

**Invalidated by:** decoy leakage; showing cosines to the model (geometry in the prompt is geometry
deciding); candidate lists built by a proposer that E1 refuted.

## E4: does asking for canonical forms in the same extraction call degrade extraction?

Brian's question, verbatim: adding this output *"could sink a tiny LLM into confusion. We can try both ways
and compare?"* This experiment is the comparison.

**Question.** Does adding canonical-name output to `EXTRACTION_SYSTEM` sink qwen2.5:14b, measured against
the run-to-run churn floor?

**Procedure** (no graph writes anywhere; the fixture is never re-extracted). A standalone harness reads all
318 chunk texts read-only. Three arms, each a full pass, writing JSON sidecars only:

- **Arm A**: current `EXTRACTION_SYSTEM`, temp 0.4 (reproduces the fixture's regime).
- **Arm A'**: identical to A, fresh run. THE VARIANCE CONTROL. A-vs-A' churn is the floor every A-vs-B delta
  is read against. Non-negotiable at temp 0.4.
- **Arm B**: prompt extended with a `canonical` field per entity plus a two-sentence instruction, honouring
  Brian's framing: *"it is ok to name your canonical form_s_ if you might have more than one. common forms
  bridge the connection."* The Arm-B prompt text is frozen in the sidecar before any runs.

Compare: parse-failure rate (the harness reuses `parseExtraction`, so failure is mechanical), entities per
chunk, relation count, banned-phrase rate (reuse the ingest-report scorecard mechanics), and simulated
post-map dedup stats: how many norm-name type-jitter groups and strip-variant groups each arm's output would
mint (pure string computation over the sidecar, mirroring `mapper.ts` identity construction).

**Metric.** delta(B, A) on parse-failure and entities/chunk, IN UNITS OF delta(A', A). Jitter and variant
counts per arm.

**Control.** Arm A'. Also: the `PROMPT_VERSION` machinery is deliberately NOT used here; bumping it would
re-dirty and rewrite the fixture, which is forbidden. The memo-salt route is how a WINNING Arm B later
ships, not how it is tested.

**Decision rule (frozen).** B is safe if its parse-failure and entity-count deltas are within 1.5x the
A-vs-A' churn on both, AND B's minted jitter+variant groups are <= half of A's. Parse failures beyond 1.5x
churn: same-call canonicalization is refused for this model, and the answer becomes E5's separate pass.
Mixed (safe but jitter not halved): same-call is harmless but insufficient.

**Cost, honest.** 3 arms x 318 chunks x ~7.5 s = ~2 hours wall-clock, ~954 LLM calls. A registered 150-chunk
stratified subsample cuts it to ~56 min at the price of noisier jitter counts; decide which BEFORE running.

**Invalidated by:** comparing Arm B against the fixture's stored extractions instead of a fresh Arm A (that
confounds the prompt change with run variance); arms run on different days or model versions; temperature
changed between arms.

## E4 ADDENDUM (pre-registered 2026-08-09, BEFORE any E4 run): Arm C and wall-clock

*Brian chose to extend E4 rather than run it as first written. This section is frozen before the harness
executes, and the Arm-C prompt text is written into the sidecar before the first call, exactly as Arm B's is.*

**Why extend it.** E1 found that identity rides on the NAME and that descriptions actively hurt identity
matching (recall 0.846 name-only vs 0.169 name+description). Descriptions are also the bulk of the GENERATED
tokens, and generation is where the ~7.5 s/chunk goes. So "are descriptions dead weight?" is simultaneously a
quality question and the prompt-side performance lever, and it costs one more arm on a harness that is
already running three.

**Arm C — lean descriptions.** Identical to Arm A except the description instruction is replaced by a short
one capping the description at roughly a dozen words, and the "self-contained, retrieval-ready sentence"
requirement is dropped. Nothing else changes: same entity rules, same DO-NOT-EXTRACT list, same relation
rules, same temperature.

**New measurement, applied to every arm: WALL-CLOCK PER CHUNK.** The original E4 measured quality only,
which was an omission given Brian tied this experiment to the extraction performance analysis (queue item 4).
Median and p90 seconds per chunk are recorded per arm, and A-vs-A' supplies the timing noise floor exactly as
it supplies the quality noise floor.

**Decision rule for Arm C (frozen).** Arm C is SAFE if its parse-failure and entities-per-chunk deltas are
within 1.5x the A-vs-A' churn, the same bar Arm B must clear. Arm C is WORTH IT only if it is also safe AND
its median per-chunk time is faster than Arm A by more than 2x the A-vs-A' timing spread. Faster but unsafe
is refused. Safe but not faster means descriptions are free and the lever is elsewhere, which is a result.

**The limitation, stated up front so a good result is not over-read.** This harness writes no graph, so it
CANNOT measure what descriptions are actually for: semantic neighbourhood in `layout/pass.ts` and the
Connector. A SAFE + WORTH-IT verdict on Arm C therefore licenses only a follow-up, never a ship. The gate
before shipping Arm C is registered here now: embed Arm A and Arm C descriptions for the same entities and
show the semantic neighbourhood is preserved. Until that runs, Arm C stays a measurement.

**Corpus decision, made before running as the protocol requires:** the registered 150-chunk stratified
subsample, not the full 318. Four arms x 150 chunks x ~7.5 s is about 75 minutes; the full corpus would be
~2.6 hours. The price is noisier jitter/variant counts, which are exactly Arm B's headline metric, so: if
Arm B lands within 20% of its "jitter halved" threshold in either direction, the result is declared
INCONCLUSIVE and re-run on the full corpus rather than called.

## E5: does the originating chunk improve proposed canonical forms?

**Question.** When a separate pass proposes a canonical name, does showing it the originating chunk collapse
more known variant groups WITHOUT collapsing known-distinct pairs?

**Procedure.** ~250 nodes in E0's variant groups plus a 100-node random control. Two prompts to qwen2.5:14b
at temp 0: **Arm X** = name+type+description; **Arm Y** = the same plus the node's originating chunk text
(first `APPEARED_IN` chunk, the Connector's `chunkText` mechanics). Scoring is FULLY MECHANICAL, zero
model-scored numbers: a canonicalizer succeeds on a variant group iff all members map to one identical
string; it fails on an N-hard pair iff both members map to one string.

**Metric.** Variant-group collapse rate per arm.

**Control (primary).** False-collapse rate on N-hard pairs and the random control. A canonicalizer that maps
everything to fewer strings wins the collapse metric trivially; false-collapse decides.

**Decision rule (frozen).** Chunk context earns its cost iff collapse(Y) - collapse(X) >= 10 points AND
false-collapse(Y) <= false-collapse(X) + 1 point. If Y only wins by collapsing more N-hard pairs, the chunk
is making the model braver, not better, and the answer is no.

**Cost.** ~700 calls, 40-60 min.

**Invalidated by:** E0 contamination; a chunk-selection rule that differs between arms; Arm Y seeing
multiple chunks while X sees none (arms must differ by exactly one ingredient).

## Order and prerequisites (what to run first)

E0 -> E1 -> E2 (free analysis over E1's sidecar). E0 -> E3. E0 -> E5. E4 is independent, costliest, run last
or overnight. E0 is prerequisite to everything and contains the only human labelling (15 minutes, reused by
E3's kappa).

**If only one session runs: E0+E1 together.** Zero chat calls, under an hour, and it settles the
representation question, most of the threshold-shape question, the description-drag suspicion, and whether
the free labels hold. Nothing else has that ratio.

## Pre-committed verdicts

- **PROPOSER EARNED**: some representation reaches recall >= 0.8 at zero N-hard admissions (E1) with E0
  contamination <= 10%. Geometry may then generate candidates, floored per E2's shape. Not earned:
  candidates come from string blocking + type vote only, and that is a finding, not a setback. Layer 1
  already covers the 362 jitter pairs and 58 variant pairs measured above.
- **VERIFIER EARNED**: decoy-pick <= 2%, null abstention >= 95%, hit recall >= 90%, kappa >= 0.6 for at
  least one family (E3). This, not any cosine, is the licence to build the LLM-verified merge layer (still
  sidecar-first, capped, audited). Not earned with both families: creation-time LLM merge is refused; ship
  Layer 1 alone and re-test when the models change.
- **SAME-CALL EARNED / REFUTED**: E4's Arm B within 1.5x churn on parse and entity counts AND jitter halved:
  canonical-in-extraction ships behind a `PROMPT_VERSION` bump. Outside the floor: refuted for this model
  size, and E5's separate pass is the design of record. Either outcome closes Brian's "could sink a tiny
  LLM" question with a measurement instead of an opinion.
- **Reading a null honestly (pre-committed).** Free labels contaminated + no proposer + no verifier is still
  a success state, because Layer 1's deterministic fix is validated by the same E0 counts and ships
  regardless. The one outcome forbidden in every branch: **an unattended cosine merge at any threshold.**

## Critical files

`src/extract/identity.ts` · `src/connect/connector.ts` · `src/ingest/mapper.ts` · `src/extract/extractor.ts`
· `docs/clustering-mining-sketch.md` (the form this protocol follows) · the backlog entry "Identity as a
read-time resolution view (B27)" (the design these experiments gate).

---

# E6–E9, pre-registered 2026-08-16: the ingest overhaul probes

*Registered after E0–E5 and after `docs/dedup-plan.md`. **The goal has widened, in Brian's words:** what this
teaches "will become the core of the ingest algorithm: a chunk read in should result in (1) entity extraction,
(2) matching those against the existing corpus with >1 embedding (different blind spots!), (3) edge proposals
-or- node merge proposals." So these are no longer dedup experiments that happen to touch ingest. They are
ingest experiments, and dedup is one of their outputs. Same discipline as above: every decision rule below is
frozen before the scored run, and everything already measured is labelled as such.*

## Two standing decisions this section inherits, and does not re-argue

- **No cosine number merges unattended.** Unchanged.
- **A positive set built by a string rule can never evaluate a string feature.** This is what the 2026-08-09
  correction cost, and it is why E6 exists.

## E6 — structural candidate mining. **RUN 2026-08-16.**

**Question.** Do candidate pairs exist that are structurally connected but lexically unrelated — the pairs no
string rule can reach and no label set currently covers?

**Procedure.** Two channels over `graphs/testgraph/graph.db`, kept separate: chunk co-occurrence
(`APPEARED_IN`) and shared `RELATED` neighbours. Every pair carries its lexical stratum — `identical`
(dropped, Layer 1 owns it), `containment`, `token`, `disjoint` — and the strata are never averaged together.
Zero LLM calls. `scripts/dedup/e6-structural-candidates.ts` → `graphs/testgraph/dedup/e6-candidates.json`.

**Result [measured 2026-08-16].** 11,082 pairs carry a signal, 47 identical pairs dropped to Layer 1.
By stratum: 116 containment, 450 token, 10,516 disjoint. **The plan's falsifier #1 did not fire.**

| stratum | ≥1 shared chunk | ≥2 | ≥1 shared neighbour | ≥2 |
|---|---|---|---|---|
| containment | 74 | 3 | 58 | 1 |
| token | 431 | 26 | 130 | 3 |
| disjoint | 8125 | 445 | 3755 | 124 |

**The finding that reshapes the plan, and it was not predicted.** Eyeballing the top of each stratum, the
`disjoint` population is overwhelmingly **related-but-distinct, not duplicate**: `HYPOTHESIS`/`EVIDENCE`,
`SUPPORTS`/`REFUTES`, `sqlite-vec`/`WAL`, `Resonator`/`Graph Store`. The duplicate residue lives in
`containment`: `LlmExtractor`/`Extractor`, `tessera serve`/`serve`, `annotations`/`annotations sidecar` — mixed
with genuine near-miss negatives (`x`/`vx`, `to_id`/`id`, `Grandmother`/`Mother`), which is what makes it a
hard set rather than a soft one. **Consequence:** the edge question has more to grade at corpus scale than the
merge question does, and the plan's ordering (merge first, edges as a by-product) is inverted by the data.

**Also a correction, and it is mine.** A single structural bar of ≥2 across all strata left **four** usable
containment pairs on this fixture — it would have silently gutted the one stratum where duplicates live. The
bar is therefore per-stratum and registered here before the scored run: `disjoint` keeps ≥2 (structure is the
only thing separating it from the floor control), `containment` and `token` use ≥1 (they already carry a
lexical signal; structure there is corroboration, not the whole case).

## E7 — the merge/edge proposal ladder. **Pilot run; scored run NOT yet run.**

**Question, Brian's.** Given name, inferred type and source context for both ends, (1) "are these nodes the
same thing?" and (2) if not, "are they related, and if so, how?" — across models of different strength,
grounded by running Claude Haiku on the same items.

**What is new against E3.** E3 asked same/NONE only and discarded every "no". Question 2 turns a rejection
into an edge proposal *and* supplies a falsifier E3 lacked: a model that answers "not same" to everything must
still say what each pair **is**, and a model that is merely refusing cannot.

**What E3 got wrong that this must not repeat.** E3's system prompt said *"Most of the time the correct answer
is NONE. Prefer NONE whenever you are not sure."* That is a conservatism knob, set arbitrarily by me, along
which hit-recall and null-abstention trade off directly — which is why E3's verdict says nothing about model
capability. **The E7 prompt is frozen in the sidecar, states the same/not-same rule in both directions in one
breath, and expresses no preference for either answer.** A test asserts the banned phrasings are absent
(`test/dedup-e7-harness.test.ts`).

**Trial set (frozen).** 210 trials, seed recorded, A/B order randomised per trial so position bias is
measurable:

| stratum | n | what it is |
|---|---|---|
| ceiling | 30 | strip-identical pairs whose **raw names differ** (`contentHash`/`content_hash`). Layer 1 resolves these for free. Pure type jitter is excluded: `AGENT`/`AGENT` is the recorded case where Brian judged byte-identical names **not** the same thing, so it is not a ceiling. |
| containment | 50 | the duplicate residue, with its near-miss negatives |
| token | 50 | shared token, neither name contains the other |
| disjoint | 50 | structurally linked, lexically unrelated — the never-measured population |
| floor | 30 | random pairs, **zero** structural signal, no shared token. E3's decoy discipline: a "same" here is a grab, and this is the one false-positive rate needing no labels and no human. |

**Arms.** gemma3:12b · qwen2.5:14b · phi4 · mistral-small:24b · qwen3-coder:30b · qwen3:32b · llama3.3:70b ·
claude-haiku-4-5. Local arms via Ollama at temperature 0; the Haiku arm via the `claude` CLI with its system
prompt replaced and settings, CLAUDE.md and all tools stripped, so the model answers rather than a Claude Code
session. There is no `ANTHROPIC_API_KEY` on this box and none is introduced: secrets by indirection.

**Standing rules carried in.** No cosines shown to any model (geometry in the prompt is geometry deciding).
**No confidence field exists in the schema** — every metric is a choice rate. **Parse failures get their own
counter and are never folded into "no".** JSON is not forced at the decoder on either side, because Ollama can
force it and the CLI cannot, and forcing it on one arm would confound model strength with decoding mode.

**Metrics.** Per stratum: same-rate, parse failures, relation-rate over *not-same* answers only, distinct
relation types. Plus the swapped/unswapped same-rate split.

**Decision rules (frozen).**
- **Merge-proposer grade** = floor same-rate ≤ 2% **and** ceiling same-rate ≥ 90%. Below either bar the model
  does not propose merges unattended, at any strength.
- **Edge-proposer grade** = floor relation-rate ≤ 20%. A model that invents a relation for random pairs is a
  relation generator, not a relation detector, and its edges cannot be trusted anywhere else.
- **Position bias** ≥ 15 points between swapped and unswapped voids the run and it is reshuffled.
- **Strength monotonicity is a question, not an assumption.** If the ladder does not order by size, that is
  the result, and it is the one that most changes the ingest design.

**Ground truth, stated honestly.** Haiku is the **top rung, not the gold standard**. The protocol permits
verifier-generated labels only after the Layer 4 gate and "only ever audited rather than trusted", so
agreement-with-Haiku measures ladder position, not correctness. The headline is **Cohen's kappa against Brian
on a blind subsample, n = 35, fixed in advance** — E0's registered rule was stated on a Wilson upper bound and
was arithmetically unsatisfiable at n = 15/10, which is the cheapest lesson in this document to reuse.

### E7 pilot [run 2026-08-16, NOT SCORED, and it changed two things]

20 trials (4 per stratum) on gemma3:12b and Haiku, run to validate mechanics before freezing. Declared
non-scoring in the sidecar so it cannot tune the result.

| arm | parse failures | ceiling same | floor same | floor relation-rate | median |
|---|---|---|---|---|---|
| gemma3:12b | 0/20 | 0.75 | **0.00** | **1.00** | 4.2 s |
| claude-haiku-4-5 | 0/20 | 0.75 | **0.00** | **0.75** | 13.0 s |

**Three things it surfaced, all worth more than the numbers.**

1. **The floor control fires on question 2, hard, and it fires on both arms.** Neither model grabbed a single
   false merge, exactly reproducing E3's spotless decoy rate — but gemma invented a relation for **4 of 4**
   random unrelated pairs and Haiku for 3 of 4. gemma's inventions hedge audibly (*"might necessitate"*,
   *"might reference"*, *"likely provided"*); Haiku's read as grounded and are therefore more dangerous. **An
   LLM asked "are these related?" will almost always say yes.** The edge-proposer bar above exists because of
   this, and it is registered before the scored run rather than after seeing it.
2. **Source context can push a model AWAY from a correct merge.** Haiku's ceiling miss was
   `recordIngestedSource()` vs `RecordIngestedSource`, and its stated reason was that the two *chunk contexts*
   discuss different things. The name evidence was overridden by the context evidence. This is E5's question
   asked from the other side and it is now a registered arm — see E7b.
3. **One ceiling miss is a genuine sense-split, not a model failure.** gemma refused `harness` (code) vs
   `HARNESS` (concept) on the grounds that one is a tool and one is an evaluation framework — the same shape
   as `AGENT`/`AGENT`. So the ceiling is honestly **"agreement with Layer 1"**, not "correctness", and a model
   disagreeing with Layer 1 there is itself a measurement. Reported under that name.

### E7b — does source context help or hurt? (registered, not run)

Two arms differing by **exactly one ingredient**, per E5's rule: **Arm N** = name + type + description;
**Arm C** = the same plus the originating chunk text. Same trials, same seed, same models.
**Decision rule (frozen):** context earns its place iff it raises ceiling same-rate by ≥ 5 points **without**
raising floor same-rate above 2% or floor relation-rate by more than 5 points. Haiku's pilot miss is the
hypothesis that motivates it; one datapoint is not a result.

## E8 — can small models extract? (registered, not run)

**Brian's question, verbatim:** *"I am genuinely curious if small models can do a decent job of node
extraction and if it's worth it."*

**The gap this exposes.** E4 varied the *prompt* on one model (qwen2.5:14b). Nothing has varied the *model*.
And the installed ladder's smallest rung is 12B, so **as it stands this question cannot be asked** — there is
no small end. Registered prerequisite: pull genuinely small models (a 1B–7B set) before running, and record
exactly which.

**Procedure.** E4's harness, unchanged, across the model ladder on the registered 150-chunk stratified
subsample. Arm A on qwen2.5:14b is the incumbent; A-vs-A' remains the churn floor that every delta is read
against. Measure: parse-failure rate, entities/chunk, banned-phrase rate, median and p90 seconds per chunk,
and minted jitter/variant groups.

**Decision rule (frozen).** A small model is **viable** if its parse-failure and entities-per-chunk deltas
against Arm A sit within 1.5× the A-vs-A' churn. It is **worth it** only if viable **and** its median
per-chunk time beats Arm A by more than 2× the A-vs-A' timing spread. Faster but not viable is refused —
that is E4's Arm C verdict reused, and it exists so a speed win cannot be read as a quality win.

## E9 — a second embedder, and it is gated (registered, not run)

Brian wants matching against the corpus with **more than one embedding, "different blind spots!"**. This is
the one place his stated goal fights a recorded decision, and the fight is worth naming rather than papering
over.

**What the plan already retracted.** Layer 3 was retracted on 2026-08-15 with multiple embeddings riding
along, because *"the 'independent route' argument has the same shape as the register claim already retracted,
and it has not earned a seat on evidence."* E5 measured the related claim directly: All-but-the-Top recovered
0.185 against name-only's 0.846, so the description defect is a mixing ratio, not a nuisance direction, and no
subtraction — or second model reading the same text — recovers a signal diluted by volume.

**Why the goal survives anyway.** The retraction is conditional, and its condition is exactly what E6 and E7
are building: revival is permitted *"only on numbers measured against a label set that does not exist yet, and
only if agreement beats the best single channel on pairs Layer 1 cannot reach."* E6 produced those pairs; E7
plus the n=35 audit produces the labels. **So the order is labels first, embeddings second** — and running
E9 before the labels exist would manufacture another cross-validated 1.000 that means nothing.

**Prerequisite, unglamorous but blocking.** Only `nomic-embed-text` is installed. A second embedder must be
pulled, and the sidecar must record which — `meta.json` does not, which is why E1's sidecar recorded it
explicitly and why mixing vectors across embedder eras is registered as invalidating.

**Decision rule (frozen).** A second embedding channel earns a seat iff, on the E7 label set, **agreement
between the two embedders beats the better single embedder** at zero floor-control admissions. Equal or worse
means the second model is cost with no signal, and the honest answer is one embedder plus a verifier.

## What would falsify this whole section

- **Every arm fails the floor bar on question 2.** Then edge proposals cannot be generated by asking a model
  "are these related", at any strength, and the mechanism has to change rather than the prompt.
- **The ladder does not order by strength.** Then model size is the wrong axis for ingest and something else
  (prompt, context, channel) is carrying the variance. That would be the most useful negative result here.
- **The containment stratum turns out to be the whole product.** If merges only ever land where one name
  contains the other, that is a string rule with a model rubber-stamping it, and the honest move is to say so
  and ship the string rule.

---

## Review round, 2026-08-16: what the panel changed before anything was scored

*Panel per Brian's standing rule: **Grok 4.6 and Composer 2.5 in parallel, with a Fable-class subagent
adjudicating disagreements.** Codex was first choice and was unavailable (Cursor Pro usage limit, resets
2026-09-01). All of the below landed **before** any scored run, which is the only time this is cheap.*

### The finding that cost the most: I repeated E3's mistake in question 2

E7's question 1 was balanced. Question 2 was not. It read *"are they related? If they are, name the relation
as a short UPPER_SNAKE_CASE type"* — the affirmative branch got a prose instruction and the negative branch
got only a token in the JSON format template. **That is E3's conservatism knob pointed the other way**, and it
sits on exactly the axis the two registered edge metrics are defined along.

**Consequence, stated plainly: the E7 pilot's headline is retracted.** "Both arms invented a relation for
nearly every random floor pair" is not clean evidence of model yes-bias, because it is confounded with my own
wording. It cannot be decomposed after the fact.

Grok flagged it; **Composer explicitly cleared the prompt**, listing "E3 'prefer NONE' conservatism: removed;
tests check banned phrases" under *what is not a real problem*. Fable ruled for Grok and diagnosed the miss:
Composer verified that E3's *literal artifact* was gone rather than reasoning about the *class*. It checked
the fingerprint, not the shape — and a structural asymmetry contains no banned phrase. **The banned-phrase
test could never have caught this**, which is why `test/dedup-e7-harness.test.ts` now asserts the both-branches
*shape* of each question and the comparable weight of each branch, verified against both prior wordings.

The repair itself took two passes. My first rewrite gave the negative branch the vivid clause ("some are
simply two unconnected things that happen to appear in the same corpus") and the positive branch three words —
a mild tilt back toward NONE, failing safe (models get failed, not passed) but still not balanced. Q2 now
mirrors Q1 exactly: one definitional sentence per branch, one instruction sentence per branch.

### E7-W: the wording becomes a measurement rather than an apology

A retraction with nothing in its place is a waste of the mistake. `scripts/dedup/e7b-wording-ab.ts` builds
**one frozen trial set** and runs each arm twice over the identical pairs, varying nothing but the Q2 string.
Both wordings are kept in the source for exactly this reason.

*(Note against the temptation to shortcut it: the re-pilot under v2 changed the wording, the structural bar
and the RNG streams at once, so its delta is uninterpretable. Three variables, one number. The A/B is the
version that can settle it.)*

**Registered read, frozen before it runs.** Floor relation-rate falls materially v1 → v2: the headline was my
artifact and stays retracted. It does not move: models really do over-relate, and the finding survives on
better evidence than it was first published on. Either outcome is worth the GPU minutes.

### Defects fixed, with who found them

| defect | found by | why it was fail-toward-green |
|---|---|---|
| A universal refuser passed the edge grade | Grok, Composer | `{"same": false, "relation": "NONE"}` on every trial scores 0% floor relation-rate and reads as "does not hallucinate relations". The edge grade is now a **separation** (disjoint − floor); separating nothing fails. Bars now live in `BARS`/`grade()` in code, not only in this document. |
| The seed did not identify the trial set | Grok | Floor rejection-sampling consumed a data-dependent number of draws from one shared RNG, so every later stratum shifted with the data. Per-stratum streams; `ORDER BY` on every query. Composer called this "not a correctness bug if the seed is recorded" — Fable ruled for Grok, on the grounds that a recorded seed is *for* rebuilding the set, and this project exists to change the fixture. |
| `sample()` underfilled silently | Grok, Composer | The ≥2 bar really did leave four containment pairs. A short draw produced a completed-looking run with a gutted headline stratum. It now throws. |
| The FLOOR filter diverged from `stratumOf` | Grok, Composer | It rejected strip-identical names and shared tokens but not **containment**, so `x`/`vx` and `id`/`to_id` could land in the control that must contain no related pairs. |
| The FLOOR pool was not deduped | Grok, Composer | One pair could occupy two trial slots in the only label-free control. |
| `RELATED`-only pairs could miss the candidate file | Grok, Composer | On this fixture all 1239 are covered by co-occurrence, but nothing guaranteed it: a pair joined only by an edge would read as *zero structural signal* and be eligible for the FLOOR, so `SUPPORTS`/`REFUTES` could be scored as random and any model naming their relation charged with inventing edges. |
| E7's bar then dropped those same pairs | Composer | Minted by E6 with `chunks = neighbours = 0`, and excluded by a bar written per-channel. The bar now admits `related` outright and sums the channels (amended before any scored run: one shared chunk **and** one shared neighbour is two pieces of evidence, and the old form excluded it while admitting two chunks and nothing else). |
| `score()` missed absent responses | Grok, Composer | A crashed arm looked cleaner than a merely sloppy one, and `n === parsed + parse_failures` did not hold. |
| A comment promised a control the code never applied | Grok, Composer | "different source documents" was never implemented. |
| **`PROMPT_VERSION` was not bumped after the rewrite** | **Fable only** | Two materially different prompts under one version string. A future reader comparing the pilot to a scored run *by version* would conclude they used the same prompt. **This corrupts the audit trail itself, which makes it worse than any wrong number in it.** Sidecar filenames now carry the version too. |
| The header claimed a test that did not exist | **Fable only** | It said the tests "assert the symmetry for both questions". They asserted Q1 only. This file's own standard: a comment promising a control the code does not apply is worse than no comment. |
| Stream-label reuse *inside* the determinism fix | **Fable only** | `streamFor("floor")` built the floor pool and then shuffled it, restarting the identical sequence — stream reuse inside the fix meant to eliminate stream reuse. Now `"floor:mine"` vs `"floor"`. |

### The hub cutoff: measured, and it is a no-op

Both reviewers flagged E6's `ns.length > 200` skip; Composer called it "a systematic blind spot at exactly the
high-degree nodes." **Measured on the fixture: RELATED degree is min 1, median 1, p90 3, p99 9, max 35. Zero
stars skipped, zero pairs dropped.** Composer's severity claim was empirically vacuous and Grok's "fixture
frequency unverified" was the correct posture. The cutoff stays as future-proofing, but it no longer fails
silent: `hub_max_related_degree` and `hub_stars_skipped` are in the report, so a future corpus that grows a
real hub announces itself instead of quietly losing a channel.

**The transferable lesson, and it is about reviews rather than code:** a reviewer reading only a diff will
assert severity it cannot check. Give the adjudicator the fixture and permission to measure.

### Tests

`test/dedup-lexical.test.ts`, `test/dedup-e7-harness.test.ts` and `test/dedup-e7-trials.test.ts` (433 passing
overall). Both reviewers ranked "no coverage of the code that decides who gets asked what" as the largest
hole; `buildTrials` now has integration coverage for determinism, stream independence, underfill, floor
purity, floor dedup and ceiling composition.

**Every guard here was mutation-proven, and that caught two of my own tests being vacuous** — the parse-failure
denominator case and the relation-credit case both passed under the mutation they claimed to pin, because I
had chosen fixtures where the correct and the broken formula give the same answer. Fixed and re-verified. A
passing test proves nothing until it has been seen to fail.

### E7-W RESULT [ran 2026-08-16]: the wording was not the cause, and the finding survives

50 frozen trials, two arms, both Q2 wordings, 200 calls, zero parse failures. Nothing varied but the string.

| arm | floor relation-rate v1 | v2 | delta |
|---|---|---|---|
| gemma3:12b | 1.00 | 1.00 | **0.000** |
| claude-haiku-4-5 | 0.50 | 0.50 | **0.000** |

Zero delta on every stratum, both arms.

**The instrument was verified before the verdict was believed**, because a wording flag that silently did
nothing would produce exactly this table. The sidecar records two different Q2 strings; replies are almost
entirely non-identical (4/50 and 0/50 byte-identical); and the *relation label chosen* changed on 26 and 27 of
50 trials. So the models unambiguously saw different prompts, and the wording moved **which** relation they
named while leaving **whether** they named one untouched (same-verdict agreement 50/50 and 49/50).

**Verdict, against the rule registered before the run: the pilot's headline survives.** Models really do
over-relate; it was not my leading question. The retraction was still the right call at the time — the
confound was real and could not be decomposed after the fact — but the claim now rests on 200 controlled calls
instead of 20 confounded ones. **This is why the wording was measured instead of merely apologised for.**

### Two results that fall out of the same run, and both are consequential

**1. The edge question fails its bar on both arms, at every strength tested.**

| arm | disjoint relation-rate | floor relation-rate | separation | edge grade |
|---|---|---|---|---|
| gemma3:12b | 1.00 | 1.00 | **0.000** | FAIL |
| claude-haiku-4-5 | 0.89–1.00 | 0.50 | 0.39–0.50 | FAIL (floor 0.50 > 0.20) |

gemma names a relation for **every** not-same pair it is shown, including pairs drawn at random with no
structural signal and no lexical overlap: it separates nothing. Haiku is meaningfully better and still
inventing a relation for half the random pairs. **This fires the section's own falsifier:** asking a model
"are these related?" does not, on this evidence, generate trustworthy edges at any strength tested — the
mechanism has to change rather than the prompt. What that means for ingest is that edge proposals need a
gate the model does not supply, and the floor control is the instrument that measures it.

**2. Strength does not order the merge answers, and the direction is the surprise.**

| arm | ceiling (agreement with Layer 1) | floor same-rate | merge grade |
|---|---|---|---|
| gemma3:12b | **0.90** | 0.00 | **PASS** |
| claude-haiku-4-5 | 0.70 / 0.60 | 0.00 | FAIL (ceiling) |

The 12B local model agrees with Layer 1 more often than Haiku does, and Haiku's misses are *refusals to merge*,
not grabs — floor same-rate is 0.00 for both, reproducing E3's spotless decoy result on a third and fourth
model. On the pilot evidence Haiku's refusals were reasoned from **source context** ("Entity B's source context
discusses migration fidelity with no mention of ingest_sources"), which is E7b's registered question and now
has a second datapoint behind it.

**Read this cautiously: n = 10 per stratum.** It is four times the first pilot and consistent across it, but it
is not the registered 210-trial run and no bar is being called on it. What it does establish is that
**"bigger model, better answer" is not safe to assume here**, which was registered as the outcome that would
most change the ingest design.

---

## E10 — span-grounded extraction, and the small-model ladder that rides on it. Pre-registered 2026-08-16, before any run.

*This is Phase A1 of the converged plan agreed with the `embeddings_experiments` session
(`~/agent_to_agent_comms/messages/0009` and `0011`, approved by Brian in `0012`). It replaces multi-run
consensus as the DEFAULT cheap gate, on the strength of two measurements: E7/E7-W (an LLM asked to relate a
pair invents a relation nearly always, so ungated generation cannot be trusted) and the Mercer forensics
(consensus's published 0.0% rests on n=13/0 events, upper bound ~23%, with a shared-prior confound). Span
grounding attacks the same confabulation class for near-zero compute: a relation must carry its evidence.*

**Question 1 (E10 proper).** Does requiring a VERBATIM supporting quote per relation — verified mechanically
against the chunk at parse time — kill confabulated relations without degrading extraction quality?

**Question 2 (the E8 ladder, folded in).** Brian, verbatim: *"I am genuinely curious if small models can do a
decent job of node extraction and if it's worth it."* The same harness answers it: arms are MODEL × PROMPT,
so quote-fidelity per model size falls out of the same runs. Registered small ladder: qwen2.5:3b, qwen2.5:7b,
llama3.2:3b, gemma3:4b (pulled 2026-08-16), against the qwen2.5:14b incumbent.

**Arms.** Per model: **A** = incumbent `EXTRACTION_SYSTEM`; **A′** = identical, fresh run (churn floor, E4's
spine — every A-vs-S delta is read in units of A-vs-A′); **S** = A plus a required `quote` field per
relation: a verbatim snippet copied from the chunk that asserts the relationship. Temperature 0.4 (the
fixture's regime), identical across arms. No graph is written; PROMPT_VERSION is not bumped; sidecars only.

**Quote verification (frozen).** Normalize whitespace and case ONLY (no punctuation stripping — that
over-matches); require the normalized quote as a substring of the normalized chunk. Near-misses (edit
distance ≤ 5 after normalization) are counted separately as diagnostics, not survivals. An empty or missing
quote is a kill, counted as its own category.

**Metrics, per arm.** Parse-failure rate; entities/chunk; relations emitted; relations surviving the quote
check; **quote-fidelity rate** (relations whose quote verifies ÷ relations emitted — the "can this model
quote at all" number, and the ladder's headline); template-reason rate (the banned-phrase list); median and
p90 s/chunk.

**Decision rules (frozen).**
- **SAFE**: Arm S's parse-failure and entities/chunk deltas within 1.5× the A-vs-A′ churn (E4's bar, reused).
- **ACTIVE**: quote check kills ≥ 5% of emitted relations. A gate that kills nothing is decoration.
- **GROUNDED**: on an audited sample of ≥ 20 killed relations, ≥ 70% are judged actually-ungrounded rather
  than paraphrase failures of true relations. (Kill-rate alone cannot distinguish "killed a confabulation"
  from "killed a truth the model paraphrased"; this is the check that keeps us honest about which.)
- **Ship** = SAFE ∧ ACTIVE ∧ GROUNDED, behind a PROMPT_VERSION bump.
- **Small model VIABLE** = SAFE (vs its own A′) ∧ quote-fidelity within 10 points of the incumbent's.
  **WORTH IT** = VIABLE ∧ faster than the incumbent by more than 2× the incumbent's timing spread.
- **Pilot first** (20 chunks, incumbent only, arms A and S, declared non-scoring) to validate mechanics —
  the E7 pilot caught a leading prompt and a stratum collapse before the scored run; same discipline here.

**What would falsify the approach.** Quote-fidelity so low even at 14B that most TRUE relations die
(paraphrase-heavy corpora would show this); or a kill-rate near zero (the extractor was already grounded and
the gate is dead weight); or small models producing verbatim quotes for relations the quote does not actually
assert — quoting is not grounding, and the audit sample is what catches the difference.

---

## E11 — write-time known-node injection vs read-side resolution. Pre-registered 2026-08-16, before any run.

*Design converged on the agent channel (0050 fork → 0051 claude-code → 0052 analogy-maker), all conditions
accepted. The moderator's observation that seeded it: post-ingest, tessera attempts NO merge softer than
exact norm(name)+type — strip-merge is read-side only, and nothing at all handles containment/semantic
fragmentation. The comms graph is the measured bill: 459 entities, Layer 1 reaches 27 groups, 342
containment pairs, "consensus"×8.*

**Question.** Does write-time injection of known entity names buy anything ON TOP of read-side resolution —
and at what conditioning cost? Read-side E7 machinery runs regardless; the experiment prices only the
increment. A null result is a result.

**Arms, on one frozen chunk set** (the comms messages as of registration; per-chunk is the independent unit;
frozen surfaces hash-pinned per the 0035 rider):
- **A** — no injection (control; current production behaviour).
- **B** — deterministic reuse-only: inject ONLY names whose chunk-surface-form → canonical mapping is
  deterministic strip normalization (Layer-1 rules). Parse-time normalization, same class as a relation
  inventory. The 0051 boundary: anything requiring judgment (containment, embedding) stays read-side,
  because a canonical choice the chunk does not literally contain is a synthesized judgment and the graph
  would be agreeing with its own earlier decisions.
- **C** — full known-node injection (all extant entity names offered for reuse).

**Metrics, all frozen now:**
1. **Fragmentation**: entity count, Layer-1 group count, containment-pair count, fragment-family sizes.
2. **Unsupported-mention rate**: injected names appearing in relations whose E10 quote check fails —
   agreement manufactured, caught mechanically. (The E10 gate makes conditioning a measurable kill-rate.)
3. **Novel-entity suppression**: on chunks known to contain new material, do B/C discover fewer entities
   absent from the injected list than A? The quiet killer — a graph that stops seeing what it doesn't
   already contain; no fragmentation metric would show it.
4. **False-merge rate on a labeled hard-negative set built from THIS corpus's own collisions** (0052's
   load-bearing addition): E3-the-tessera-experiment vs E3-the-register-experiment, claude-code-the-handle
   vs Claude-Code-the-product, span-the-metric vs span-the-word. E10 audits PRESENCE, not IDENTITY — this
   class evades metrics 2 and 3 entirely while destroying evidence of distinctness. Labeled set built and
   frozen before arms run; scored per arm.

**Storage rule (0052, accepted):** every arm stores the raw observed surface form BESIDE the canonical
assertion. Fragmentation preserves evidence; assimilation destroys it; an experiment whose injection arms
write only canonical names cannot even compute metric 4 post hoc. Raw-beside-derived is one column and the
difference between a reversible experiment and a self-erasing one.

**Scope language (0052, accepted, C8's lesson):** the E10 gate bounds RECRUITMENT (relation-level
contamination), not ASSIMILATION (identity-level false merges). No result from this experiment may be cited
as "injection proven safe" beyond the population it measures.

**Decision rule (frozen).** Injection (B or C) earns write-time status only if it beats A on fragmentation
by a margin that survives per-chunk analysis AND metrics 2-4 come back clean (2: ≤ A's rate; 3: no
significant suppression; 4: zero false merges on the labeled set). **The default is and remains
no-injection until metric 4 comes back clean.** Anything less ships read-side resolution alone.
