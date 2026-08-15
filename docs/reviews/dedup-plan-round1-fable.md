# Review: dedup-plan.md, round 1 (Fable)

*Reviewed 2026-08-15 against `docs/dedup-plan.md`, `docs/dedup-e0-e1-results.md`,
`docs/dedup-experiment-protocol.md`, `docs/backlog.md` (B27, multiple-descriptions entry),
`src/extract/identity.ts`, `src/ingest/mapper.ts`, `src/store/graphStore.ts`, and
`graphs/testgraph/graph.db` opened `{readonly: true}` plus the sidecars in
`graphs/testgraph/dedup/`. Every DB number below was recomputed, not quoted. What I could not
recompute (anything requiring the embedder) I took from the sidecar JSONs and say so.*

---

## Verdict

**Build Layer 1, amended; do not build Layers 2 through 4 as designed.** Two of the plan's
load-bearing claims fail verification:

1. **Layer 3's evidence is the retracted result.** The two-tier numbers the plan quotes
   (conjunction 0.754 / 0 admissions, disjunction 0.985 / 3 admissions) are the exact table the
   2026-08-09 correction voids, with the words "should not be used to set a policy." The worry
   named in the review brief is confirmed: the poisoned result was carried forward into the plan
   as settled evidence. Worse, even taken at face value those numbers show conjunction strictly
   dominated by the single cosine channel, which is the plan's own falsification criterion #2.

2. **The residue is real but roughly a tenth the size the machinery assumes, and the plan's
   miner cannot see it.** I mined the corpus directly. Structural co-occurrence yields 39
   candidates, essentially all related-but-distinct. The residue that actually exists (about two
   dozen visible pairs, mostly token reorderings plus `Brian`/`Brian Brewington`) lives in pairs
   that do NOT co-occur; the exemplar pair shares zero chunks. At this scale, resolving the
   residue by hand and keeping the judgments as labels is cheaper than building the pipeline
   that would decide whether to build the pipeline.

What survives: Layer 1 as a read-time view (with the amendments in finding 2), the
per-field-channels insight from E1/E5 (name-only index for identity, description kept for
topical work), the no-unattended-merge pre-commitment, and the anti-edge design. What does not:
the agreement architecture as currently evidenced, the structural-mining label strategy as the
sole miner, and step 7's 1714-call second describer without its cheap kill-test.

---

## The frame-breaking question: is this the right plan?

**Mostly wrong scale, not wrong problem.** The plan's shape (channels, agreement, verifier,
labels first) is the right shape for a corpus where "same thing, different name" is a
population. On testgraph it is a countable list. Measured:

- Layer 1's territory: 362 jitter pairs + ~136 variant pairs, 320 nodes removed, 1714 to 1394.
  Verified exactly.
- The post-Layer-1 residue I could surface with three cheap miners (containment, token-Jaccard,
  sorted-token forms): on my read, roughly 15 to 30 genuinely plausible same-referent pairs,
  about 1 to 2 percent of nodes. (Hypothesis, not fact: this is my eyeball over candidate
  lists, not a blind audit. Brian's audit could double it. It will not find 10x it, because the
  candidate lists themselves are short.)

**The dissolving architecture, concretely:**

1. **Extend Layer 1 with a second deterministic form: the sorted-token key** (lowercase,
   split camel/snake/punctuation, sort tokens, join). Verified against the DB: it adds exactly
   5 pairs beyond strip-equality, all genuine (`analytic Connector` = `Connector (analytic)`,
   `Identity (v1)` = `v1 identity`, `hidden provenance` = `provenance hidden`,
   `non-.md/.txt formats` = `Non-txt/md Formats`), and zero false unions on this corpus (the
   dangerous near-misses like `round-1 review` vs `round-2 review` differ in a token, so the
   key separates them). This is B27's form-function slot, one more form, no new machinery.
2. **One pooled candidate sweep + one blind audit, and the audit IS the resolution.** Pool
   candidates from all cheap miners (structural co-occurrence, containment, token-Jaccard,
   name-only kNN once the index exists), shuffle, audit blind, write the verdicts as SAME_AS /
   anti-edges. Roughly 150 pairs, about an hour of Brian. This resolves testgraph's visible
   residue AND produces the label set, because at this scale labeling and resolving are the
   same act. The plan treats labels as a prerequisite for a resolver; here the labels are the
   resolver.
3. **Layers 2 through 4 become corpus-gated, not sequence-gated.** Build them when some corpus
   measures a residue too large to audit by hand (graphs/big may be that corpus; testgraph is
   not). The labels from step 2 are then already waiting.

**Cost of this frame, stated honestly:** the channel/agreement architecture is shelved, not
refuted; the design thinking is retained on paper. Manual resolution does not transfer to a
10x corpus, so if graphs/big or the session-ingest future has a large residue, the plan's
stack gets built after all, and this detour will have cost one audit hour and bought the
labels that stack needs anyway. Per-corpus human involvement is retained, but the plan already
had that: its thresholds are corpus-calibrated and its results doc says so ("the bits
threshold is calibrated on ... one graph"), so every new corpus needed Brian regardless. The
one thing genuinely given up is momentum on the multi-channel machinery, and the findings
below argue that momentum was pointed at a retracted number.

---

## Findings, most severe first

### F1. Layer 3 is founded on the retracted E2 table, and misquotes it besides

**Facts, all checkable in `docs/dedup-e0-e1-results.md`:**

- Plan, Layer 3: "conjunction → auto-resolve (E2: 0.754 recall, 0 known-confusable
  admissions); disjunction minus conjunction → verifier band (E2: 0.985 recall, 3
  admissions)." These are the "cosine AND bits ≥ 60" / "cosine OR bits ≥ 100" rows of the
  addendum table.
- The 2026-08-09 correction, verbatim: "the joint cosine+bits curve: **unvalidated**. The
  earlier table (cosine OR bits ≥ 100 → 0.985 recall) **inherits the contamination and should
  not be used to set a policy**." Shared bits itself: "**not clean evidence**."
- The plan also says "their conjunction admitted zero known-confusable pairs while either
  alone admitted some." False even against the retracted table: cosine alone admitted 0 of
  300. Only bits-alone admitted 3.
- Even at face value, conjunction (0.754 recall, 0 admissions) is strictly dominated by cosine
  alone (0.846 recall, 0 admissions): lower recall at identical measured FP. The plan's own
  falsification criterion #2 ("agreement performs no better than the best single channel →
  Layer 3 is ornamentation") is met by the only numbers cited in its support.

**The mechanism, which is worse than contamination.** `e2-surprisal.json` lists the 20
P-variant pairs cosine misses: `contentHash`/`content_hash`, `GraphStore`/`Graph Store`,
`querySimilar`/`query_similar`, `exportViewer`/`export-viewer`. Every one is strip-identical,
because every P-variant positive is strip-identical by construction. So the entire measured
gain of the disjunction (0.846 → 0.985) consists of pairs Layer 1 already resolves
deterministically. On the post-Layer-1 residue, the only region Layers 2+ exist for, the
complementarity has never been measured at all.

**And the channels do not fail in different places on the class that matters.** Verified in
the DB: `docs/reviews/durable-map-state-r5.md` vs `docs/durable-map-state-design.md`, a
genuine non-duplicate, is simultaneously the maximum cosine negative (0.8818, sets the global
floor), the maximum bits negative (196), **and** shares 100 percent of its chunks (1 of 1).
All three "independently failing" channels agree, wrongly, on the same pair. The plan's own
Layer 2 table half-admits this: path-shaped failures appear in both the name row and the
string row. Correlated failure on structured names is the expected joint failure mode, and
agreement-as-confidence will auto-resolve exactly those pairs with maximum confidence.

**Failure scenario:** the conjunction tier ships calibrated on the retracted table; the next
review round adds `docs/reviews/dedup-plan-round2-*.md`; name channel, string channel and
structure channel all fire on it against `docs/dedup-plan.md`; the pair auto-resolves with no
verifier call; every read surface welds two distinct documents.

**Disposition:** strike the E2 bullet from Layer 3's evidence. Layer 3 is currently a
hypothesis with zero clean measurements behind it; the plan must say so. Re-derive any tier
policy only from the new label set, and require the policy to beat the best single channel
(the plan's own falsifier) before it earns the conjunction tier. Treat structured names (file
paths, command strings, numbered documents) as a class where agreement is anti-evidence until
measured otherwise, and route them to the verifier or leave them unresolved regardless of how
many channels agree.

### F2. Layer 1 as specced silently merges the 85 pairs the protocol refused to label

**Facts, verified in the DB:** `GROUP BY strip(norm(name))` resolves 362 jitter pairs and
~136 variant pairs, not the 277+130 the plan quotes. The 277 is the post-exclusion count: E0
excluded person/place/event groups precisely because "a genuine sense-split is plausible
(mother, de doorns, klipgat farm, codex, grok)." The mechanism cannot see that exclusion. On
testgraph today it will union: `Codex` PERSON with `Codex` organization/product/technology
(the reviewer persona with the OpenAI product), `Grok` PERSON with `Grok` technology, `Mother`
PERSON with `Mother` concept, plus De Doorns and Klipgat Farm place/other splits. The one
audited byte-identical pair (`AGENT`/`AGENT`) came back not-same, and P-jitter's audited
contamination point estimate is 6.7 percent, which extrapolates to roughly 18 wrong unions in
the included class alone (hypothesis: n=15 sample, wide Wilson interval).

The plan's words "resolves ... exactly, with no threshold, no embedding, no model, and no
risk" are wrong in both directions: it resolves more than it claims, and the excess is the
riskiest part.

**Failure scenario:** the viewer shows one `Codex` node whose aggregate blends a person's
review verdicts with a product's capabilities; on a personal-notes corpus, `Mother` the person
absorbs `Mother` the concept, and the Grandmother-class cross-persona bug (B7) that already
bit once is reintroduced by the resolution layer that was supposed to be the safe part.

**Disposition:** ship Layer 1 with (a) the same person/place/event guard the label protocol
used: no cross-type union when either member carries a person/place/event subtype, absent
corroboration; and (b) the anti-edge writer and one-click re-split in the SAME slice, not
deferred to Layer 5's timeline, because the correction path is what makes a known-imperfect
union shippable. Amend the plan's Layer 1 claim from "no risk" to "reversible, with a measured
~7 percent wrong-union rate in the jitter class." B27 already contains most of this (the
mapper's homograph anti-edge writer is in slice 1 there); the plan dropped it in compression.

### F3. The structural miner cannot find the residue, so step 3 cannot feed steps 4 and 5

**Facts, measured against the DB:**

- Entities co-occurring in ≥3 chunks with non-matching stripped names: **39 pairs**, and the
  list is dominated by related-but-distinct pairs (`Graph Store`/`Web Viewer`,
  `Resonator`/`Connector`, `GOAL`/`CLAIM`, `putEdge`/`putNode`). Plausible positives in the
  list: approximately zero to two.
- The plan's own exemplar of the target class, `Brian` vs `Brian Brewington`: **zero shared
  chunks, one shared neighbour** (of 35 and 5). The proposed miner does not find it at any
  threshold that excludes noise.
- The visible residue (token reorderings, containments, paraphrase names) surfaces only under
  string-shaped miners, because on this corpus "same thing, different name" almost always
  means "same tokens, different arrangement," and those pairs live in different documents
  written months apart, which is exactly where co-occurrence is silent. The plan's Layer 2
  table itself notes structure "says nothing about ... the cross-document case," then step 2
  proposes structure as the sole source of cross-document labels.

**Consequence for the falsifier:** falsification #1 ("structural mining yields no candidates
with non-matching names") is miscalibrated. It tests candidate existence, not positive yield.
39 candidates exist, so the falsifier never fires; meanwhile the audit returns ~1 positive and
step 5 measures recall on n=1. The plan would conclude neither "residue absent" nor anything
about the channels: the worst of both.

**Failure scenario:** Brian spends his 30 minutes on 40 structural candidates, labels 38
not-same, 2 same. Step 4 reports name-channel recall of 1/2 or 2/2. A policy is set on a
sample whose confidence interval spans nearly the whole unit interval, which is the E0
sample-size lesson (n=35 minimum) repeated one layer up.

**Disposition:** pool the miners: structural co-occurrence + stripped-containment +
token-Jaccard + name-only kNN (once the cheap index exists) + sorted-token forms. Shuffle,
audit blind, once. Restate falsification #1 as a positive-yield threshold ("fewer than N
audited positives across ALL miners"), and state the sample size the recall measurement needs
before collecting, which the plan itself demands and then does not do (30 minutes cannot
certify anything at the Wilson bounds the plan's own E0 lesson establishes).

### F4. The residue exists, and it is small (the dimension-4 answer)

**Facts:** enumerated above and in F3. Sorted-token adds 5 pairs; containment (999 raw pairs,
173 involving file paths) and token-Jaccard (121 pairs at ≥0.5) are mostly non-duplicates on
inspection, with a plausible-positive core of roughly 15 to 30 pairs
(`Brian`/`Brian Brewington`, `Cross-persona entity dedup`/`Cross-Persona Dedup`,
`Effective-liveness at query time`/`query-time liveness`, `centroid of anchored
neighbours`/`Centroid of its already-anchored neighbours`, the `tessera scenes import
<graph>`/`<name>` placeholder variants, and kin). **Hypothesis:** true count after audit is
under 50 pairs, i.e. under 3 percent of nodes, versus Layer 1's 320.

**What this means:** the plan is not unnecessary, but it is an order of magnitude heavier than
its quarry on the only corpus it has measured. This is the plan's own falsification #1
outcome, arriving through a different door: not "no candidates," but "few enough to resolve
by hand." The honest disposition of Layers 2 through 4 is DEFERRED pending a corpus that
measures a material residue, not "next after Layer 1."

**Open question I could not settle:** whether `graphs/big` (different corpus, different era)
has a materially larger residue. That measurement, the same three cheap miners run read-only
over that DB, is a prerequisite to un-deferring the stack, and it costs an afternoon.

### F5. The label strategy has a subtler circularity, and one channel is unevaluable on any current or proposed set

**The specific answer to dimension 3:** the mining mechanism is NOT independent of the
features it would evaluate, in two places.

- **Structure channel vs structure-mined labels: fully circular.** Layer 2's third channel is
  "do the two nodes share chunks, documents, or neighbours"; step 2's miner is that same
  predicate. Every structure-mined positive scores maximally on the structure channel by
  construction. This is the cross-validated-1.000 shape again, one feature over.
- **N-hard negatives are RELATED-edge pairs**, structurally adjacent by construction, so the
  structure channel cannot be scored against the existing negatives either. There is currently
  NO set, existing or proposed, on which the structure channel is evaluable. It would enter
  Layer 3 unmeasured, in an architecture whose whole premise is measured channels.
- **The miner's "names do not match" clause is itself a string predicate.** It truncates the
  string-feature distribution among labeled positives. Acceptable if "match" is defined as
  strip-equality only and the target region is declared, but define it; a looser matcher would
  eat exactly the near-match operating-curve region Brian's verbatim intuition is about.

**Disposition:** cross-mining. Each channel may only be evaluated on pairs surfaced by OTHER
miners (structure-mined labels test name and string channels; name-kNN-mined labels test
structure and string; and so on). The human audit keeps every label honest regardless of
miner. And add one sentence to the plan so a good number is not over-read: **all recall
figures are relative recall, recall within the union of the miners; absolute recall is
unmeasurable without exhaustive labeling.** Pairs no miner can see (pure synonyms with
disjoint tokens, disjoint documents, no shared neighbours) are invisible to the entire
program, which is worth stating as the standing blind spot rather than discovering later.

### F6. The multiple-embeddings "independent route" is the register mistake one level up, and its cheap kill-test was dropped

**The dimension-5 answer:** Layer 3 is a defensible home, but the argument given is not yet
evidence. Two describing models read the same chunk text about the same node in the same
batched-generation regime. Their agreement is largely a re-measurement of the shared input,
which is precisely the structure of the already-retracted claim that ensembling would cancel
register: the correlated component lives in the input, and a second reader of the same input
is not an independent instrument. "Two models that agree have told you something" is true;
how MUCH they have told you is the error correlation, and it is unmeasured.

The backlog entry this plan absorbs already contains the right gate, and the plan dropped it:
describe ~200 nodes with two local families, embed both, compare N-hard mean cosine per family
and pooled (~400 calls, one afternoon). "If pooled separation beats each family alone, the
idea is real. If not, it dies for the price of ~400 calls." The plan's step 7 goes straight to
the full 1714-call build "measured as an added agreement channel."

**Failure scenario:** step 7 runs, the second describer's channel correlates ~0.9 with the
first on exactly the confusable pairs, the agreement tier's measured FP barely moves, and
1714 calls have bought a channel whose marginal information could have been priced at 400.

**Disposition:** reinstate the 200-node decorrelation pilot as step 7's gate. Downgrade
"independent route" to hypothesis in the plan text. And note the honest alternative role: if a
description channel earns a place, it is likelier as a MINER for the one class nothing
string-shaped can reach (lexically disjoint synonyms), while E1's description-only geometry
(AUC 0.630, recall@FP=0 of 0.000) predicts even that will be weak. Luckily F4 says that class
is rare here.

### F7. The zero-FP floor is a sample maximum feeding a union-find, which is how you get the next ANN incident

**Facts:** every floor in E1/E2 is `max(N-hard cosine)` over a 300-pair sample. A sample
maximum is the most fragile estimator there is: removing one pair moved recall from 0.846 to
0.928 in E2's own analysis, so adding one moves it the other way. Zero admissions on n=300
bounds the true FP rate only to about 1.2 percent at 95 percent confidence, and the
auto-resolve tier feeds a union-find, where pairwise errors are not additive: one false pair
bridges two clusters, and cluster-level over-merge is unbounded by any pairwise FP number.
That is structurally the ANN-swallowed-92 incident, which the protocol names as founding
memory and the plan's tier policy does not re-guard against.

**Failure scenario:** a new ingest adds one confusable pair above yesterday's floor;
conjunction auto-resolves it; the union bridges the `Connector` cluster and the `Resonator`
cluster; the view (correctly, reversibly, but visibly) presents them as one node until someone
notices.

**Disposition:** floors as per-type quantiles with intervals, never maxima presented as
operating points; a cluster-size cap and a per-run union cap carried from B27 into the plan
text (they are in B27 and absent here); and any auto-resolve tier evaluated at CLUSTER level
(size distribution of resulting unions against expected) rather than pairwise only. The
view's reversibility is real mitigation and should be argued as such, explicitly, instead of
"no risk."

### F8. Smaller defects, listed with dispositions

1. **Internal inconsistency:** the plan's settled section refutes the global floor (spread
   0.2665), then Layer 3 quotes tier numbers measured AT the global 0.8818 floor. Fix by F1's
   strike; if a tier policy returns, it is per-type by the plan's own settled finding.
2. **"277 type-jitter pairs" in the situation table** is the post-exclusion count without
   saying so; the mechanism's population is 362 (verified). Label the row or the mechanism.
3. **"480 trials" (Layer 4)** conflates trials with calls: E3 was 240 trials run against two
   families, 480 calls. Same substance, but the plan's evidence-discipline standard is exact
   numbers.
4. **Step 4's gating is looser than written:** the name-only index build does not depend on
   labels; only its scoring does. Build it alongside step 2 and it becomes a fourth miner for
   F3's pooled sweep, which is the cheaper validated path the review brief asked about.
5. **Step 3's "~30 min of Brian"** ignores the plan's own n=35-per-set lesson stated eleven
   lines earlier. State the arithmetic before collecting; with the pooled sweep it is closer
   to an hour, and worth it because the audit doubles as the resolution (frame section).

---

## Facts, hypotheses, open questions

**Facts I verified directly against the DB (readonly), reproducible:**
- 1714 entity nodes; 346 (20.2%) with zero RELATED edges; median RELATED degree 1.
- Jitter pairs 362 pre-exclusion (277 post person/place/event exclusion); variant node pairs
  136 by my strip (labels.json froze 130 with exclusions); strip-group union removes 320 nodes,
  1714 → 1394; RELATED hebbian weights 1181/53/5 at 1/2/3 (1239 total).
- `Codex` exists as person+organization+product+technology; `Grok` person+technology; `Mother`
  person+concept; `AGENT` three subtypes: all strip-identical, all auto-unioned by Layer 1 as
  specced.
- `Brian`/`Brian Brewington`: 0 shared chunks, 1 shared neighbour.
- Co-occurrence(≥3)-with-name-mismatch mining: 39 pairs, near-zero plausible positives.
- Sorted-token form key adds exactly 5 pairs beyond strip, all plausible positives.
- The r5.md/design.md pair: max cosine negative (0.8818) AND max bits negative (196) AND
  shares its single chunk: all three channels fail together on it.
- Sidecar quotes are as the results doc reports them (E1 0.846/0.169, E2 spread 0.2665, E2b
  agreement-ratio CV of 1.000, the strip-identical composition of cosine's 20 misses).
- No resolution-view code exists in `src/` yet (no `node_forms`, no `SAME_AS`, no
  `resolveIdentity`).

**What I could not check:** the embedding computations themselves (no embedder run; sidecars
trusted as records), E3/E4 raw runs, Brian's audit answers (ground truth by definition), and
`graphs/big`'s residue (not examined; see open question).

**Hypotheses, labeled:** residue count ~15–50 pairs (my eyeball, not a blind audit); ~18 wrong
unions extrapolated from 1/15 jitter contamination (wide interval); two local describers'
errors correlate heavily on confusables (the F6 pilot measures it); pure-synonym duplicates
rare on technical corpora (untested on personal-notes corpora).

**Open questions:** does `graphs/big` have a residue large enough to un-defer Layers 2–4 (an
afternoon, read-only, same miners)? What is the wrong-union rate of the sorted-token form on a
corpus with prose-like entity names (testgraph says zero; that will not transfer for free)?
Where do person/place/event guards come from on corpora whose extractor types are noisier than
testgraph's?

---

## What I would do next, in order

1. Ship Layer 1 as B27 slice 1 actually specifies it: strip form + sorted-token form,
   person/place/event cross-type guard, anti-edge writer and re-split in the same slice.
2. Build the name-only index (ungated, 1714 short strings) and run the pooled candidate sweep
   (structure + containment + token-Jaccard + name-kNN), pre-registering the positive-yield
   falsifier and the sample arithmetic.
3. One blind audit, ~150 pairs, ~an hour. Its verdicts land as SAME_AS/anti-edges (testgraph
   stays unwritten; sidecar first, per standing order). testgraph's residue is now resolved
   AND labeled.
4. Run the same miners read-only over `graphs/big`. If its residue is hand-scale too, Layers
   2–4 stay shelved and that is the good news the plan's falsifier anticipated. If it is not,
   the label set from step 3 plus a `graphs/big` audit sample is the clean foundation the
   channel stack needed, and the neutral-prompt E3 re-run (kept, cheap, ungated) decides
   whether a verifier exists.
