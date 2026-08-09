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
