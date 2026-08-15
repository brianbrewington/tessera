# Entity resolution in tessera — the plan

*Written 2026-08-15, after E0–E5. Supersedes the scattered dedup entries in `backlog.md` as the working
design; those remain as the reasoning trail. Shape chosen by Brian: **per-field channels first, agreement on
top.** Everything below is either a measurement already taken or a decision rule pre-registered before the
measurement that settles it.*

---

## The situation, in numbers rather than adjectives

| fact | value | where from |
|---|---|---|
| entity nodes | 1714 | E0 |
| with **zero** semantic links | 346 (20%) | measured |
| median degree | 1 | measured |
| name-only recall @ zero-FP floor | **0.846** | E1 |
| name+description recall @ zero-FP floor | **0.169** | E1 |
| type-jitter pairs (same normalized name, different type) | 277 | E0 |
| strip-variant node pairs (differ only in punctuation) | 130 | E0 |
| **labeled pairs that are semantically same, lexically different** | **0** | E0 |

That last row is the plan's spine. Every labeled positive we have is a string match, and string matches need
no model at all. **We have never measured the thing the project exists to do.**

## What is already settled, and should not be re-argued

- **All-but-the-Top does not fix the description problem** (E5: 0.185 against name-only's 0.846, and worse as
  more directions come out). The defect is not a low-rank nuisance direction. It is a mixing ratio: a
  description is roughly an order of magnitude more text than a name, so the fused vector is mostly *about*
  the description. No subtraction recovers a signal diluted by volume.
- **Ensembling will not strip the shared register component either.** Register lives in the input text, not
  in model-specific noise, so every model encodes it with the same sign and averaging preserves it exactly.
  This corrects an earlier claim of mine in `backlog.md`.
- **Randomly sampling among embeddings per comparison is dominated by averaging** — same expectation,
  strictly higher variance, and variance is what a zero-false-positive threshold pays for. Dropped.
- **One global cosine floor is refuted** (E2: per-type spread 0.2665 against a registered 0.03 threshold).
- **No cosine number merges unattended.** Standing pre-commitment from the protocol, unchanged.

---

## The architecture

### Layer 1 — deterministic string resolution. Ships now, needs no further evidence.

`GROUP BY strip(norm(name))` over the entity view. Resolves the 277 jitter pairs and 130 variant pairs
exactly, with no threshold, no embedding, no model, and no risk. testgraph's entity view goes 1714 → ~1394
with **no stored row touched**, because the mechanism is the read-time resolution view (B27), not a
destructive merge.

The E0–E5 run *strengthens* this rather than weakening it: Layer 1 turned out to be sufficient for the entire
labeled population, which is exactly why nothing above it can currently be validated.

**One known exception, already found:** `AGENT` (other) vs `AGENT` (concept) — byte-identical names that
Brian judged **not** the same thing. String identity is not sufficient for identity. One datapoint, so a
hypothesis, and the reason Layer 1 produces a *view* rather than a merge.

### Layer 2 — per-field channels. Never one fused vector.

The measured reason: 0.846 versus 0.169. This is also what entity-resolution practice does (Ditto, PVLDB
2020; DeepMatcher, SIGMOD 2018) — per-attribute similarity into a combiner, never a concatenated embedding.

Three channels, each cheap and each failing differently:

| channel | signal | cost | known failure mode |
|---|---|---|---|
| **name** | cosine over a name-only embedding | 1714 short strings; the cheapest thing in the pipeline | structured identifiers: paths, `getLayout`/`putLayout`, version strings |
| **string** | shared-substring improbability against a corpus character model | zero calls, pure computation | long names whose difference is small in characters and total in meaning |
| **structure** | do the two nodes share chunks, documents, or neighbours? | pure SQL | says nothing about two nodes from disjoint documents, which is the cross-document case |

**Do not fuse these into one score by hand-tuned weights.** Keep them separate through Layer 3.

### Layer 3 — agreement across channels is the confidence signal.

This is Brian's flip, and it earns its seat on evidence rather than appeal:

- **E2 measured it directly.** Cosine and string-improbability fail in *different places*, so their
  conjunction admitted **zero** known-confusable pairs while either alone admitted some, and their
  disjunction reached 0.985 recall against 0.846 for cosine alone.
- **E3's real headline was the same shape.** The trustworthy metric was independent mechanisms agreeing, not
  any single mechanism's self-reported confidence — which is why the schema has no confidence field at all.
- **`hebbian_weight` already encodes this intuition for repetition.** 1181 of 1239 RELATED edges sit at
  weight 1, so corroboration is rare and therefore meaningful. Agreement extends corroboration from "said
  twice" to "found by instruments that fail differently".

**Where multiple embeddings enter, and it is here rather than at Layer 2.** A second describing model gives a
second *independent route* to the same pair. Not because it cancels register — it does not — but because two
models that read the same text and still disagree about a pair have told you something, and two that agree
have told you something else. The evidence-kind must be a **first-class field**, not prose folded into
`assertion_sources`: "co-occur in a chunk", "near in name space", "share an improbable substring" and "near in
gemma-description space" are different kinds of evidence, and flattening them destroys exactly the
distinction that makes agreement informative.

Output is a **two-tier** policy, which E2 already measured on the existing channels:

- **conjunction** → auto-resolve, no model call (E2: 0.754 recall, 0 known-confusable admissions)
- **disjunction minus conjunction** → the band that needs a verifier (E2: 0.985 recall, 3 admissions)

### Layer 4 — the verifier, for the uncertain band only.

E3 says neither local family is verifier-grade **as prompted** — and that qualifier is load-bearing, because
decoy-pick was **0.0% for both across 480 trials**. They fail by refusing to merge, not by grabbing. The
conservatism was at least partly mine: my prompt said "prefer NONE whenever you are not sure."

**Gate: a neutral-prompt re-run of E3, gemma3:12b first** (the only family to clear kappa at 0.65, and the
higher hit recall). Cheap. Until it passes, Layer 4 does not exist and the uncertain band is simply left
unresolved, which is the honest default.

### Layer 5 — resolution as a read-time view, never a destructive merge.

Already the design of record (B27). Two properties that matter more after this run than before:

- **`AGENT`/`AGENT` proves reversibility is required.** Any rule will be wrong sometimes, and a view can be
  corrected while a merge cannot.
- **Anti-edges carry the rejections**, with the evidence kind that produced them, so a rejected pair is not
  silently re-proposed by the same mechanism next run.

---

## The blocking problem, and it is first

**Nothing above Layer 1 can be validated, because there are no labels for it.** The gap is specific: pairs
that are *semantically the same and lexically different*. Every positive we hold is a string match.

Three ways to get them, cheapest first:

1. **Mine the structure.** Pairs that co-occur in many chunks, or share many neighbours, but whose names do
   *not* match. Zero calls, and it produces exactly the candidates a string rule cannot reach. This is the
   first thing to build.
2. **Human audit of that candidate set**, reusing the blind audit page. And this time **state the sample size
   the decision rule needs before collecting** — E0's registered rule was stated on the Wilson upper bound
   and was arithmetically unsatisfiable at n=15/10, which needed n=35 per set. That was my error and it is
   the cheapest lesson here to reuse.
3. **Verifier-generated labels**, only after the Layer 4 gate passes, and only ever audited rather than
   trusted.

**Pre-registered before any of it runs:** a positive set built by a *string* rule can never evaluate a
*string* feature. That is the retraction this project already paid for once. The new label set must be built
by a mechanism the features under test cannot see — structural co-occurrence, or a human — or it will produce
another cross-validated 1.000 that means nothing.

---

## Order of work

| # | step | cost | gates |
|---|---|---|---|
| 1 | **Ship Layer 1** as a read-time view | deterministic, ~a day | nothing |
| 2 | **Mine structural candidates** with non-matching names | zero LLM calls | nothing |
| 3 | **Label them** (blind audit, sample size fixed in advance) | ~30 min of Brian | step 2 |
| 4 | **Build the name channel** (name-only index) and score it against the new labels | 1714 short embeddings | step 3 |
| 5 | **Agreement across the three cheap channels**; measure the two-tier policy on the new labels | zero calls | step 4 |
| 6 | **Neutral-prompt E3 re-run** | ~25 min GPU | — |
| 7 | **Second describing model**, measured as an added agreement channel | ~1714 calls | steps 5 and 6 |

Steps 1 and 2 are unblocked today. Step 7 is where multiple embeddings actually get built, and it is last on
purpose: it is the most expensive, and steps 4–5 will already have shown whether agreement across *free*
channels carries the signal. If it does not, a paid channel will not rescue it.

## What would falsify this plan

- **Structural mining yields no candidates with non-matching names.** Then the residue this whole layer
  targets may not exist at corpus scale, and Layer 1 is the entire product. That is a real possible outcome
  and it would be good news.
- **Agreement across the free channels performs no better than the best single channel.** Then Layer 3 is
  ornamentation, and the honest move is a single-channel threshold with a verifier.
- **The new labels show name-only degrades badly on non-string-identical pairs.** E1's 0.846 was measured on
  positives that were string-identical, so it may not transfer. This is the number most likely to disappoint,
  and it should be measured before anything is built on top of it.
