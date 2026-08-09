# E0 + E1 results — the representation question, answered

*Ran 2026-08-08 against `graphs/testgraph/graph.db`, opened `readonly: true`. The fixture's md5 is
identical before and after (`a97e6077e571f217122f6b2457e81e0e`). Every decision rule quoted here was frozen
in `docs/dedup-experiment-protocol.md` before anything ran; nothing below was tuned after seeing a number.
Sidecars: `graphs/testgraph/dedup/` (gitignored, regenerable from seed `20260808`).*

---

## The verdict, first

**PROPOSER EARNED — provisionally, and by the simplest representation on the list.**

Name-only clears the pre-registered 0.8 bar. The incumbent, the representation the graph actually stores,
misses it by a factor of five.

| representation | floor @ FP=0 | **P-variant recall @ FP=0** | recall @ FP=1% | P-jitter recall | AUC |
|---|---|---|---|---|---|
| **name** | 0.8818 | **0.846** ✅ | 0.985 | *skipped by design* | 0.999 |
| **norm(name)** | 0.8818 | **0.846** ✅ | 0.985 | *skipped by design* | 0.999 |
| name+type | 0.8890 | 0.362 ❌ | 0.577 | 0.292 | 0.987 |
| **name+description** *(incumbent)* | 0.8988 | 0.169 ❌ | 0.277 | 0.195 | 0.956 |
| description-only | 0.9309 | 0.000 ❌ | 0.046 | 0.007 | 0.630 |

Recall is measured at the cosine floor that admits **zero** of the 300 N-hard pairs. That is the operational
number: how many known duplicates you can still catch while catching none of the known-confusable pairs. AUC
is reported and does not decide, exactly as registered — note that name+description posts a perfectly
respectable 0.956 AUC while recovering 17% of duplicates. That gap is why the metric was chosen in advance.

**Provisional, and the word is load-bearing.** The registered rule is *"proposer-grade = recall ≥ 0.8 …
**with E0 contamination ≤ 10%**."* Contamination is measured by the 40-pair blind human audit, which has not
run — it needs about 15 minutes from Brian (`graphs/testgraph/dedup/audit.html`). Until it does, every recall
number here carries an unquantified error bar, and the verdict cannot be promoted from provisional. It could
move: if the P-variant set turns out to be more than 10% contaminated, its 0.846 is measured against a
polluted positive set and the rule says drop the set.

## The description-drag control fired, and hard

The protocol registered this as the primary control: *"if description-bearing representations put P-jitter
and N-hard in overlapping bands, Brian's suspicion is confirmed and description-only is dead regardless of
AUC."* It did, and it is.

| representation | P-variant mean (positives) | N-hard mean (negatives) | **separation** |
|---|---|---|---|
| name | 0.936 | 0.420 | **0.516** |
| name+type | 0.873 | 0.510 | 0.363 |
| name+description | 0.837 | 0.640 | 0.197 |
| description-only | 0.673 | 0.502 | 0.171 |

Adding descriptions does damage from both ends at once. It pushes true duplicates **down** by about 0.10 and
pulls known-distinct pairs **up** by 0.22. The bands close from 0.52 of daylight to 0.20. Description-only
recovers **zero** duplicates at a zero-false-positive floor.

The mechanism is register homogeneity, and it now has support rather than being the hunch it was in the
protocol (where it was explicitly left as a hypothesis after I got the "everything mentions tessera" version
of it wrong — only 98 of 1714 descriptions contain the string). The descriptions are all written by one
model, in one voice, about one system, in one register. They read as *"a component of the tessera knowledge
graph that does X."* That shared voice is a large constant vector added to every node, and it swamps the
signal that distinguishes them. The name is the part that actually varies.

## The finding underneath, which is bigger than dedup

**The store keeps one vector per node, and it is being asked to do two different jobs that pull in opposite
directions.**

The stored vector is `name + ". " + description` (verified, not assumed — `src/ingest/mapper.ts` builds it
and hands it to `putNode`; the instrument check re-embedded a node and got cosine **1.0000** against the
stored vector). That vector serves:

- **`src/layout/pass.ts`** — semantic neighbours for layout, where "these two are about the same topic" is
  exactly right, and the description genuinely helps.
- **`src/connect/connector.ts`** — semantic proposals, same story.
- **and, if candidate generation were built on it, dedup** — where "these two ARE the same thing" is the
  question, and E1 says the description actively hurts.

Similarity and identity are not the same relation, and one embedding cannot be good at both. This is not a
bug to fix by swapping the stored vector: doing that would improve dedup and degrade layout. It is an
argument for a **second, cheap, name-only index** used only for identity candidates — 1714 short strings,
which is the fastest thing in this entire pipeline.

**Not claimed:** that layout or the Connector are worse off than they should be. E1 measured identity, not
topical neighbourhood, and says nothing about whether name+description is the right choice for those. That
would be its own experiment.

## Consequences for E2, E3 and the extraction work

- **E2 (threshold shape)** runs over E1's sidecar with zero new compute, and now has an obvious subject:
  the name-only representation. Worth noting in advance that the zero-FP floor for name-only is **0.8818**,
  which sits squarely in the "low 90s" region Brian remembered from a previous system. That is a coincidence
  of range, not a transfer — different embedder, different corpus — but it is a nice sanity check that the
  number is not absurd.
- **E1 does not change the E4 question.** E4 asks whether canonical-name output can ride inside
  `EXTRACTION_SYSTEM` without sinking qwen2.5:14b. E1 makes that question *more* interesting, not less: if
  identity is carried by the name, then getting the model to emit a good canonical **name** is precisely the
  high-leverage output, and the description is not where the work is.
- **This is why the experiments come before profiling** (Brian, 2026-08-08): *"they materially impact our
  performance analysis of extraction. we'll re-craft ingest, review+test, then re-extract and then
  measure/profile things as we go."* E1 sharpens that. If the name is what carries identity, and the
  description is dead weight for the identity job, then a cheaper prompt that spends fewer tokens on
  description prose is a candidate lever on the 7.5 s/chunk — and it would be measured on the re-extract,
  not against today's numbers.
- **Layer 1 is untouched by all of this and still ships regardless.** 277 jitter pairs and 130 variant node
  pairs are deterministic string work, zero LLM calls, zero embedding calls.

## Two things that reproduced differently, both benign

**`name` and `norm(name)` are identical to four decimal places on every metric.** Checked rather than
assumed: E0 constructs P-variant to *exclude* pairs whose names differ only by case (those are type jitter,
not name variance), and 0 of the 930 scored pairs differ only by case or whitespace. With no case-only pair
in any scored set, lowercasing cannot change a single score. Structural, not a caching artifact — the raw
score vectors are byte-identical, while `name` vs `name+description` correctly differ.

**P-variant is 130 pairs where the protocol registered 58.** Different units, not a violation: 58 counts
distinct *name* pairs, 130 counts *node* pairs, and E1 embeds nodes. Both numbers are in the sidecar.

## What runs next

1. **The 40-pair blind audit** (`graphs/testgraph/dedup/audit.html`, ~15 min, Brian). This is the gate. It
   promotes or demotes the verdict above, and its sample is reused for E3's kappa so it is never asked twice.
2. **E2**, free, over the existing sidecar.
3. **E3** (~600 chat calls) and **E4** (the expensive one) after that.

---

# Addendum, same day: E0 scored, E2 answered, and Brian's observation made operational

*The 40-pair blind audit came back 2026-08-09T00:21Z. Fixture md5 still `a97e6077e571f217122f6b2457e81e0e`.*

## E0 scored — and a flaw in my own pre-registration

| set | n | contaminated | rate | 95% Wilson CI |
|---|---|---|---|---|
| P-jitter | 15 | 1 | 6.7% | [1.2%, 29.8%] |
| P-variant | 10 | 0 | 0.0% | [0.0%, 27.8%] |
| **N-hard** | 10 | **0** | 0.0% | [0.0%, 27.8%] |
| N-random | 5 | 0 | 0.0% | [0.0%, 43.4%] |

**The judge is validated.** All 15 negatives were called correctly. The N sets were audited alongside the P
sets precisely to catch a judge who answers "same" to everything, and that check passes cleanly. N-hard being
uncontaminated matters more than any other number here, because E1's entire floor is `max(N-hard cosine)` —
a single mislabeled negative at the top of that distribution would silently depress every recall number in
the table.

**But the registered rule cannot be evaluated as written, and that is my error.** The rule says "P-set
contamination **upper bound** ≤ 10%". At n=15 a flawless audit still has a Wilson upper bound of 20%, and at
n=10 it is 28%. The smallest sample where zero errors could clear a 10% upper bound is **n=35 per set**. I
registered 15/10/5/10. So the rule is arithmetically unsatisfiable at the sample size I chose, and swapping
quietly to the point estimate to make it pass would be exactly the tuning the pre-registration exists to
prevent.

Two honest readings, and the choice is Brian's:
- **On point estimates** (6.7% and 0.0%), both P sets are comfortably usable and E1's verdict promotes.
- **On upper bounds** as registered, neither set can be certified at any sample this size, and the fix is
  ~25 more pairs per P set — roughly 10 more minutes.

**Recommendation:** treat the verdict as *supported but not certified*, proceed with E2 and E3 (neither of
which is gated on certification), and spend the extra 10 minutes only if a merge is about to be made durable
on the strength of it. Nothing here writes to a graph yet, so the bound is not load-bearing today.

**The one rejected pair is itself a finding:** `AGENT` (other) vs `AGENT` (concept). Byte-identical names,
and Brian still said not-same — a bare generic word carries no evidence of shared referent. That is the
lowest-information name in the whole sample, and it previews the next section exactly.

## E2 — the registered question, answered: PER-TYPE floors, decisively

Registered rule: *spread ≤ 0.03 means one global floor is defensible; over 0.03 means per-type floors.*

| subtype pairing | n | zero-FP floor |
|---|---|---|
| concept + concept | 47 | 0.8066 |
| technology + technology | 28 | 0.7549 |
| concept + other | 23 | 0.5757 |
| concept + technology | 30 | 0.5401 |

**Spread = 0.2665**, nearly nine times the threshold. One global floor is refuted.

**And the global floor is set by a single pair, from the subtype I nearly deleted.**

> `docs/reviews/durable-map-state-r5.md` vs `docs/durable-map-state-design.md` — cosine **0.8818**

Two genuinely different documents sharing most of a path. They are `file`-subtype entities: the same 110
nodes that `type != 'SOURCE'` would have silently dropped. Removing `file` entities from the negatives moves
the floor from 0.8818 to 0.8066 and **P-variant recall from 0.846 to 0.928**.

So those 110 nodes are simultaneously essential to include and the thing corrupting the global floor. That is
not a contradiction, it is the per-type result stated concretely: **file paths need their own floor**, because
near-identical paths are the norm for distinct files and would be strong evidence of identity anywhere else.

## Brian's observation, and the first version of it that was wrong

His note, verbatim:

> "the more unusual the name, the faster I click 'same' with confidence. you could probably even time it.
> Like how much do I actually read before making the call. Easy: getIndexedIdFromGraphStore() vs
> get_indexed_id_from_graph_store. Hard: Software vs Code. I don't know how to use this observation...just
> noticed some notion of name-surprise impacts my matching confidence."

**First attempt: inverted, and instructively so.** I scored a name by the rarity of its tokens *across this
graph's entity names*. In a corpus about a codebase, `get`/`id`/`graph`/`store` appear in dozens of names
while `software` appears in one, so the metric called `getIndexedIdFromGraphStore` common (7.55 bits) and
`Software` rare (10.74) — backwards from what he described. Caught/missed separation was 0.26 bits, i.e.
nothing. Corpus-internal document frequency is not general-language improbability.

**Second attempt, and the better reading of his claim:** the confidence does not come from either name. It
comes from **the improbability of what the two names share**. Agreeing on 26 characters of
`getindexedidfromgraphstore` cannot be coincidence; agreeing on `code` says almost nothing. So: longest
common substring of the stripped names, scored in bits against a character-trigram model built from the
corpus's own chunk prose.

It now reproduces his intuition on every example he gave:

| pair | shared substring | bits |
|---|---|---|
| getIndexedIdFromGraphStore / get_indexed_id_from_graph_store | `getindexedidfromgraphstore` | **313.8** |
| Software / software | `software` | 102.5 |
| AGENT / AGENT | `agent` | 49.3 |
| Software / Code | `o` | **13.8** |

And it separates far more cleanly than cosine does: **P-variant mean 128.3 bits, N-hard mean 21.9 bits.**
Note where `AGENT` lands — 49.3 bits, low, the one pair he rejected.

## The two signals are complementary, which is the operational result

The 20 P-variant pairs cosine misses average **116.5 bits** — they are mostly high-improbability pairs, so
shared-bits catches what cosine drops. Combining them (cosine floor 0.8818, name-only):

| rule | P-variant recall | N-hard admitted |
|---|---|---|
| cosine alone | 0.846 | 0 of 300 |
| shared-bits alone (≥100) | 0.769 | 3 of 300 |
| **cosine OR bits ≥ 100** | **0.985** | 3 of 300 |
| **cosine AND bits ≥ 60** | **0.754** | **0 of 300** |

That is exactly the two-tier policy the protocol wanted, and it arrives without a single LLM call:

- **AND** is the auto-merge tier: 75% of true duplicates, zero known-confusable admissions, no verifier.
- **OR** is the candidate tier for E3's verifier: 98.5% recall, and only 3 negatives for the verifier to
  reject.

**Where shared-bits fails, stated plainly** — the three negatives it admits at ≥100 bits:

1. `docs/reviews/durable-map-state-r5.md` vs `docs/durable-map-state-design.md` (196 bits) — file paths again
2. `Node Ontology` vs `Edge Ontology` (121 bits) — one word differs inside a long shared string
3. `have a model name the group` vs `gate the grouping with an LLM verifier` (113 bits) — long prose-like names

All three are the same shape: **long structured names whose difference is small in characters but total in
meaning.** A character metric cannot see that, which is precisely the job E3's verifier exists to do. The
signals fail in different places, which is why combining them works.

**Not claimed:** that this replaces the verifier, or that these constants transfer to another corpus. The
bits threshold is calibrated on 130 positives and 300 negatives from one graph, and the pre-committed rule
that no number merges unattended still stands. What changed is that there is now a measured, zero-cost way
to say which candidates deserve a verifier call and which are already beyond reasonable doubt — and that
directly cuts E3's call volume, which is the expensive part.

---

# Correction, 2026-08-09: the string features were validated against their own definition

**Retracting part of the addendum above.** Brian proposed that cosine and bits form a joint operating curve
rather than two thresholds. Testing that produced a feature (agreement ratio) that scored **recall 1.000 at
zero false admits**, cross-validated. That number is not a result. It is circular, and the circularity
invalidates the string half of the previous section.

## What happened

E0 constructs P-variant as *"distinct normalized names, identical after `[^a-z0-9]` strip"* and P-jitter as
*"same normalized name, different subtype."* Measured directly:

- **130 of 130** P-variant pairs are byte-identical after stripping.
- **277 of 277** P-jitter pairs are byte-identical after stripping.

So for every positive in every set, the longest common substring **is** the whole name and the residue is
empty. `residual = 0` and `ratio = 1.000` are not properties the feature discovered; they are restatements
of the predicate that built the label. Any string-agreement feature will separate these sets perfectly, and
learning that tells us nothing about the world.

This is the same shape as the degeneracy flagged in the protocol's reframe 3 (jitter positives score cosine
1.0 on name-only *by construction*). I named that trap, registered a handling for it, and then walked into a
fresh instance of it on a different feature.

## What survives, and what does not

| feature | status |
|---|---|
| **cosine (name-only)** | **stands.** The embedder has no knowledge of the construction rule, so P-variant is a fair test of it. E1's 0.846, the description-drag finding, and E2's per-type floors are unaffected. |
| shared bits | **not clean evidence.** Partly circular. It is not *trivially* perfect (recall 0.115 at FP=0, because bits scales with name length and short names like `AGENT` score low), but it is measured on a set defined by the same predicate. |
| residual bits / agreement ratio | **void.** Exactly the label rule, restated. |
| the joint cosine+bits curve | **unvalidated.** The earlier table (cosine OR bits ≥ 100 → 0.985 recall) inherits the contamination and should not be used to set a policy. |

## The deeper problem, which is worth more than the retraction

**Every positive we have is a string match, and string matches do not need any of this machinery.**

Layer 1 already resolves string-identical pairs deterministically and exactly: no threshold, no embedding, no
verifier, no risk. The 277 jitter pairs and 130 variant pairs are, in the end, a `GROUP BY strip(name)`.

The pairs the dedup project actually exists for are the ones with **no string identity**: `Brian` vs
`Brian Brewington`, a concept named two genuinely different ways in two documents. **We have zero labeled
examples of those.** So the current label sets cannot test the question that matters most, and a good score
on them can be achieved by a rule that adds nothing over Layer 1.

Brian's operating-curve intuition is not refuted by this. It is aimed at a region we have no data for:

> "A very specific name that near-matches another very-specific name is a no brainer. There's probably a
> whole operating curve of such things."

That is a claim about *near*-matches. Our positives are *exact* matches. The curve he is describing lives in
the gap between them, and building it requires labels from that gap.

## What this changes about what to do next

1. **Layer 1 ships regardless and needs no further evidence.** It is exact string work over 407 pairs. None
   of this correction touches it. If anything the correction strengthens the case: the deterministic layer is
   demonstrably sufficient for the entire labeled population.
2. **E3 becomes the load-bearing experiment, not a follow-up.** A verifier-grade model is the cheapest way to
   *generate* labels in the unlabeled region: propose non-string-identical candidates from cosine space, have
   the model judge them, and have Brian audit a sample of the judgments. That produces the positive set this
   protocol lacks.
3. **A new label set is needed before any string feature is trusted:** pairs that are semantically the same
   and lexically different. Registered here so it is not quietly skipped, and it must be built *without* a
   string rule or it reproduces this exact error.
4. **The `AGENT` datapoint gains weight.** It is the one audited pair with identical names that Brian called
   not-same, and it is the only evidence in the entire run that string identity is not sufficient for
   identity. One datapoint, so a hypothesis, not a finding.

**The methodological rule this earns, stated for the next person:** a label set built by a rule cannot
evaluate a feature that reimplements the rule. Before trusting a feature, ask what predicate created the
positives and whether the feature can see it. Cosine passed that test; the string features did not, and a
cross-validated 1.000 is a symptom rather than a triumph.

---

# E3 — the verifier question: not earned, but failing in the safe direction

*Ran 2026-08-09. 240 trials (100 HIT, 100 NULL, 40 JUDGMENT) against two model families, 480 calls, temp 0.
No confidence field in the schema, no cosines shown to the model. Fixture md5 unchanged.*

| model | decoy-pick (≤2%) | null abstention (≥95%) | hit recall (≥90%) | kappa vs Brian (≥0.6) | verdict |
|---|---|---|---|---|---|
| qwen2.5:14b | **0.0%** ✅ | 94.0% ❌ | 57.0% ❌ | 0.42 ❌ | not verifier-grade |
| gemma3:12b | **0.0%** ✅ | 87.0% ❌ | 78.0% ❌ | **0.65** ✅ | not verifier-grade |

**VERIFIER: NOT EARNED**, by the registered rule, which requires all four bars from at least one family.

**But read the failure direction before concluding anything.** The registered kill condition was *"decoy-pick
over 5% for both families: creation-time LLM merge is REFUSED."* Decoy-pick came in at **0.0% for both**, over
480 trials with a planted impostor in every single list. That is the one metric needing no labels and no
human, and it is spotless: neither model ever reached for a same-subtype, different-document, no-shared-token
candidate. They are not pattern-matching on shape. They fail by refusing to merge things they should merge,
which is the direction a graph can survive.

**A caveat I have to own, because it is my fault and it moves two of the four numbers.** The system prompt I
wrote contains *"Most of the time the correct answer is NONE. Prefer NONE whenever you are not sure."* That is
a conservatism knob, set by me, arbitrarily, and hit-recall and null-abstention trade off directly along it.
The registered verdict stands as recorded — the rules were frozen and the run is the run — but "these models
cannot verify merges" is **not** established by this. What is established is that these models with *this
prompt* sit too far toward refusal. A neutral-prompt re-run is the honest next step and it is cheap.

**Position bias, checked.** The registered control voids a run if the model favours position 1. Neither does;
both skew *away* from it (qwen 9/17/30/23, gemma 15/25/39/33 across A/B/C/D). So the control does not fire,
but the bias is real and pointed the other way, and a shuffled-seed replication should confirm it is the
shuffle rather than the models.

**Parse failures: zero, both families.** The forced JSON schema held across 480 calls.

**gemma3:12b clears the kappa bar (0.65)** and is the only family to agree with Brian at better than chance-
corrected 0.6. Given it also has the higher hit recall, it is the candidate for the re-run.

## Where this leaves the whole line of work

The retraction above showed that every labeled positive we have is a string match, and string matches need no
model. E3 now shows that our two local candidates will not, as prompted, supply judgments trustworthy enough
to *generate* labels in the unlabeled region either. So the sequence that remains is:

1. **Ship Layer 1.** Deterministic, exact, 407 pairs, no threshold and no model. Unaffected by everything above.
2. **Re-run E3 with a neutral prompt**, gemma3:12b first. Cheap, and it is the only thing standing between us
   and a label-generating loop.
3. **Only then** build the non-string-identical positive set, and only then revisit the operating curve.
