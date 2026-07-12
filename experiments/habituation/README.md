# experiment: habituation §4b — the cheap decisive pass (runnable)

*The executable half of `docs/reviews/capability-observation-habituation.md`. That doc's §4 is the
pre-registration; **this directory is the thing you actually run.** A "reproducible experiment" written only as
prose is a narrative about an experiment — cf. NVIDIA's **Aspire** (coarse task-level feedback tells you a
rollout failed but not why; you need a closed-loop engine that lets the agent *validate/reproduce*, not just
narrate). Same law in the review domain: models describe defects well but vary at reproducing them, so the
experiment must be code.*

## What it tests (pre-registered)

The one axis where habituation is actually falsifiable: **line-local bugs, familiar-vs-novel.** A random bug
tests *detection*; habituation needs **familiar-looking correctness** (LGTM-shaped idioms) vs alien surface forms
of matched severity.

- **Manipulation:** each seeded line bug is tagged `familiarity ∈ {familiar, novel}` (`manifest.jsonl`).
- **Primary DVs:** recall by familiarity per model; **paired miss-asymmetry** on *familiar* bugs between a small
  and a large same-lineage model.
- **Claim H (habituation):** for the LARGER model, `P(large misses | small catches) > P(small misses | large
  catches)` on **familiar** bugs — the large model *skips the familiar*.
- **Falsifier:** if `large-only >= small-only` on familiar bugs (large is at least as good on familiar lines),
  habituation-as-salience is **not supported on this ladder** — stop before the 6-month program.

## Run it

```bash
# small model — Qwen-30B on the Linux box, via the SSH tunnel (localhost:11435):
python3 run.py --model qwen3-coder:30b      --endpoint http://127.0.0.1:11435 --k 3 --temp 0.4 --label 30b
# large model — Qwen-Coder-Next 80B on the Mac (localhost:11434):
python3 run.py --model qwen3-coder-next:q8_0 --endpoint http://127.0.0.1:11434 --k 3 --temp 0.4 --label 80b
python3 score.py            # pass the small label first, large second (results/*.jsonl)
```

Stdlib only; no install. Raw reviews land in `results/<label>.jsonl`; re-runnable + hashable for the 6-month
drift check.

## Honest limits of THIS v0 (must fix before it's a result)

1. **`score.py`'s `caught()` is a keyword-signal PROXY** so the pipeline runs today. Real scoring = **blind,
   source-stripped, two-rater adjudication** against the manifest (§4). The proxy over/under-counts; do not cite
   its numbers as a finding.
2. **Quant is confounded with size** (30B is 4-bit on the box; 80B is 8-bit on the Mac). The full study must
   match quant/runtime or cross it as a factor. This v0 pass is a *smoke/decision* run, not the controlled ladder.
3. **Same-lineage but only 2 sizes; small seed bank (6); single-defect artifacts.** The full design needs ≥3
   sizes, ~≥30 defects/cell (power), and the crossed within-artifact design (a line-local AND an architectural
   defect in the *same* file). Start here; expand.
4. **A3B for both** → "size" = total experts/knowledge, not compute-per-token (arguably the right control for a
   "rich prior" mechanism — but state it).

The point of v0: the experiment is now **executable**, so the argument is settled by running it, not by prose.
