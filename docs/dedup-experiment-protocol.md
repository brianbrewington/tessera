# tessera: entity-dedup experiment protocol (pre-registered)

*A pre-registered protocol in the style of `docs/clustering-mining-sketch.md`: every label set, decision
rule, control and verdict is committed here BEFORE anything runs, so a result cannot be tuned into passing.
Status: protocol only; nothing has run. Every script is read-only over `graphs/testgraph/graph.db`; sidecars
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
