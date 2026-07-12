## Verdict

§3’s humility is better than §1’s prose. The honest claim is: **exploratory pattern + mechanism sketch**, not “size reallocates attention.” The decisive fix is a **same-lineage, same-artifact, size × locality interaction** with a **direct miss probe** and a **familiarity manipulation** — not a soft “crossover” story that can always be narrated as support.

---

## I LIKE

**§3 is the scientific core.** Tiny n, artifact×model confound, post-hoc coding, and “habituation inferred not measured” are the right caveats. The crux line (large never misses a line-seed a small model caught) is correctly identified.

**Falsification intent in §4 is real.** Naming monotone line-local recall as killing the reallocation claim, and “large never misses what small caught” as killing the habitutation mechanism, is stronger than most capability anecdotes.

**Same-lineage ladder (Qwen 30B↔80B) is the right control** — better than comparing Claude to Qwen and calling it “size.” Matches `review-of-reviews.md` axis-2.

**IOS / seeded holdout / blind adjudication / negative controls / FDR** inherit the good methodology upgrades. Secondary FDR + near-clean negatives are necessary given R3’s ~2/3 FDR.

**Drift re-run (frozen artifacts, 6 months)** is a real longitudinal design, not theater.

**§5’s citation ban** (“do not cite §1 as established”) matches the allergy to over-claiming.

---

## I WISH

### (a) §1 is over-generalized from tiny n — stronger rewrite

**What §1 asserts vs what the table supports:**

| §1 claim | Actual support |
|---|---|
| Split “tracks model size” | Size **confounded with family** (Qwen vs Claude) and artifact |
| Small “not prey to habituation” | **Never measured** (§3 admits this) |
| Small “zero architectural reframes” | Only on Graph Store; no architectural seeds; absence ≠ inability |
| Large “prey to habituation” | Brian’s work prior, **unquantified here**; R2 shows arch skill, not line-miss |
| “Complementary by construction” | Architectural conclusion from n≈few exploratory cells |

**Stronger §1 (honest):**

> Across 3 exploratory cells (Qwen-30B on 1 seeded code snippet + 1 spec; Claude on 1 plan), *issue class* of catches *looks* local/completeness vs architectural — but size, family, and artifact type are entangled. We treat this as a **hypothesis**: within a family, as capacity grows, **architectural recall rises while line-local recall plateaus or falls**, with habituation as a candidate mechanism. Until §4, do not claim complementarity-by-construction.

Drop “not prey to habituation” and “complementary by construction” from §1 entirely; demote them to §2 mechanism / §5 architecture corollary **conditional on §4**.

Also: R3 “recall 1/1” on one canary is not a profile. R4 “completeness” findings may simply be what a completeness-shaped reading of a CRUD spec produces — not evidence small models *cannot* reframe.

---

### (b) §3 caveats — necessary but incomplete; stronger confound list

§3 already has: tiny n, artifact×model, orchestrator-coded classes, post-hoc selection, habitutation unmeasured. **Add:**

1. **Family ≠ size.** R2 vs R3/R4 is Claude-vs-Qwen, not a size ladder. §1’s “tracks model size” is unsupported by the table.

2. **Quantization / host confound (already flagged in companion, missing here).** Roster: 30B **4-bit** on Linux vs 80B **8-bit** on Mac. §4 must lock **same quant, same runtime, same decode** or treat quant as a crossed factor — otherwise “size” is garbage.

3. **Class-of-catch is outcome coding under a soft taxonomy.** Several Claude “architectural” items (`promote` missing from API, tile API) are *also* completeness/local under another rubric. Without a **pre-registered locality rubric with examples**, the DV can be shaped to the hypothesis.

4. **Noise / volume asymmetry as fake complementarity.** Small models with high FDR emit more flags; union recall looks “complementary” even if precision collapses. You need **adjudicated true positives** and **per-size FDR**, not raw catch counts. R3 already shows the hazard.

5. **Task difficulty confounded with locality label.** Line seeds in short code are easier than invariant contradictions in plans. If “local” artifacts are shorter/easier, size×locality is confounded with difficulty×length.

6. **No same-artifact cross-model cell.** The decisive contrast (same artifact, small vs large) does not exist in §3 evidence.

7. **Compute / output budget.** Different max tokens, thinking, or verbosity change apparent locality of attention. Hold **output token budget** constant (or measure allocation under fixed budget).

8. **Prompt role contamination.** If prompts already say “find bugs” vs “critique architecture,” locality is prompt-induced. Phase 2 correctly parks shaping; §4 must say **one flat prompt for all sizes**.

**Stronger §3 one-liner to add:** *Until same artifact × same family × same quant × blinded locality labels, §1 is pattern-matching, not a size effect.*

---

### (c) §4 — reproducible intent yes; decisive/falsifiable not yet

**Where “crossover” fails as a falsifier**

- “Flattens **or** decreases” is a **disjunction that absorbs noise**. Within CI, almost any non-monotone-up curve can be called “flatten.”
- Crossover is a **visual story**. Many non-crossover shapes still leave a soft narrative (“arch rises faster”).
- Prediction can “succeed” if large models simply get better at hard/global items while local stays at ceiling — that’s **difficulty × capacity**, not habituation.

**Stronger falsifiable form — pre-register an interaction, not a cartoon**

Primary estimand (match companion mixed-effects suggestion):

```text
caught ~ size * locality + (1|artifact) + (1|seed)
```

**H1 (reallocation):** interaction `size × locality` significant in the predicted direction  
- contrast A: `P(catch|arch, large) − P(catch|arch, small) > 0`  
- contrast B: `P(catch|line, large) − P(catch|line, small) ≤ 0`  (strict: `< 0` for habitutation-strength)

**Hard falsifiers (any one kills the strong claim):**
1. Contrast B **strictly positive** (line-local recall rises with size) → reallocation claim wrong.
2. Contrast A ≤ 0 (no arch gain) → “large brings reframes” unsupported on this ladder.
3. **Direct miss probe fails:** among line seeds caught by small, large catch rate ≥ small (no systematic large-miss) → habitutation mechanism unsupported *even if* curves differ via difficulty.

**Optional graded claims** so you don’t all-or-nothing the whole essay:
- Claim L (locality specialization): interaction only.
- Claim H (habituation): Claim L **plus** familiarity manipulation (below) **plus** direct miss probe.

**Blinding / contamination (lock these)**
- Seed authors ≠ adjudicators ≠ runners.
- Reviewers never see seed list, IOS, or other models’ outputs.
- Adjudicators see **atomic claims stripped of model id**; ≥2 independent raters + IRR; human or cross-family tie-break (no Claude-grades-Claude).
- Locality labels on seeds fixed **before** any model run (not coded from outputs).
- Artifact order randomized; log seed RNG; **k≥3 independent samples** per (model, artifact) at fixed temperature/top-p (or temp=0 if you accept mode collapse — then say so).

**Seeding that can actually probe habitutation**
Random `lo=mid` bugs test **local detection**, not habitutation. Habituation needs **familiar-looking correctness**:
- **Familiar/idiomatic defects:** bugs that match common correct idioms / LGTM patterns (half-open intervals, standard API shapes, “obviously fine” loops).
- **Alien/weird defects:** same severity, odd surface form.
- Prediction under Claim H: size hurts **familiar** line recall more than **alien** (familiarity × size interaction). If large misses alien and familiar equally, prefer **capacity/budget** over habitutation.

**Scoring**
- Catch = claim maps to seed under rubric: **actionable + correct + specific** (line/span or invariant pair cited).
- Report recall, precision, FDR; **do not** use peer consensus as GT.
- Negative controls: near-clean twins of each artifact family.

**Statistics / power (concrete floor)**
- Specify N, M before running. Cheap but serious floor: **N≥24 line artifacts** (12 familiar / 12 alien), **M≥12 arch docs**, **≥3 sizes** (tiny floor + 30B + 80B; optional frontier as *separate family cell*, not on the size slope).
- Primary test: interaction coefficient / planned contrasts with **bootstrap CIs** over artifacts.
- Power: assume baseline line recall ~0.6 small, want to detect **absolute drop ≥0.15** at large (or rise ≥0.15 on arch). With paired artifacts and k=3, rough ballpark is tens of seeds per cell — **n≈few as in §3 is not confirmatory**.
- Pre-register exclusions (refusals, truncated outputs, contaminated context).

**Reproducibility gaps to close in §4 text**
- Exact model IDs, quant, ctx length, prompt hash, decode settings, packing policy.
- Artifact hashes + seed manifest (held out).
- Harness script interface + scoring code version.
- Do **not** leave frontier as optional on the same slope as Qwen — that reintroduces family confound. Frontier = parallel cell for generalization, not the size axis.

**Is the prediction unfalsifiable today?** Softly yes: “flattens or decreases” + exploratory coding + no direct miss probe + no familiarity factor can always be narrated as support. The interaction + hard falsifiers above make it failable.

---

### (d) Habituation — measured vs inferred; measure it directly

§3 is right: currently **inferred**. Stronger operationalization:

**Direct miss probe (minimum for Claim H):**  
On the **same** line-seeded artifacts, compute  
`P(large miss | small catch)` and `P(small miss | large catch)`.  
Habituation-style reallocation needs the first elevated for **familiar** line seeds, not just overall recall difference.

**Familiarity manipulation (stronger than miss alone):**  
Misses can be capacity, instruction-following, or verbosity. Familiar vs alien isolates “skip the familiar.”

**Attention reallocation (cleaner than metaphor):**  
Under **fixed output budget**, score **share of verified claims** (or claim tokens) tagged local vs global. Prediction: as size ↑, global share ↑ and local share ↓ — even when total true positives rise. That is reallocation of a saturating channel; raw recall alone is not.

**Process measure (optional, expensive):** force a two-pass protocol (“list suspicious lines, then architecture”) and compare which pass recovers seeds by size — only if you can keep it from becoming a prompt confound.

---

## I WONDER

**Cheaper decisive experiment (run this before the full package):**

1. Freeze **20 short code files** (10 familiar-seeded, 10 alien-seeded) + **8 short design docs** with one planted global contradiction each.  
2. Reviewers: **Qwen 30B vs 80B only**, **same quant/runtime**, flat prompt, fixed output cap, k=3.  
3. Blind adjudication to IOS.  
4. Pre-register: `size × locality` interaction + direct miss probe on familiar line seeds.  

If contrast B is clearly positive (large better on familiar lines too), stop — Claim H is dead on this ladder, no need for 6-month mythology. If interaction flips as predicted **and** large systematically misses familiar line seeds small catches, then fund the full N/M drift harness.

**Missed confound worth a sentence in §3:** several “architectural reframes” in R2 are framework-aligned readings (prominence = attention law). That may be **thesis-fit / shared prior with the orchestrator’s family**, not pure “global capacity.” Cross-family adjudication of Claude’s unique catches matters for Claim L as much as for FDR.

**Cleaner name than “habituation” until measured:** call the DV **size × locality recall interaction**; call the mechanism **candidate habitutation** only after the familiarity × size contrast lands. “Attention reallocation” = **fixed-budget share of verified local vs global claims**. That keeps mechanism language from laundering exploratory coding.

---

## Stronger one-paragraph claim (drop-in for post-cross-check)

> Exploratory reviews suggest different *classes* of catches across our current small-local vs frontier-native cells, but size, family, artifact type, and coding are confounded (n tiny; habitutation unmeasured). We pre-register a confirmatory test: within Qwen, under flat prompt and matched quant, **size × defect-locality interaction** on seeded recall, plus a **familiarity-seeded miss probe**. Support requires arch recall rising with size **and** familiar line-local recall flat/down with elevated `P(large miss | small catch)`. Monotone gains on line-local, or no systematic large miss of small’s line catches, falsify the strong reallocation/habituation claim; architecture complementarity remains an engineering bet until then.

That’s the allergic version: §1 shrinks, §3 grows by two confounds (family, quant/budget), §4 becomes an interaction + miss + familiarity test that can actually fail.
