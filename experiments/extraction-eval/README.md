# E1 — entity/idea extraction: tiny vs large (validity eval)

Hypothesis (Brian): tiny models nail **concrete** entities (person/place/thing) cheaply; **abstract**
cross-cutting ideas need larger models. A paired asymmetry: `tiny ≈ large` on concrete, `tiny ≪ large`
on abstract. Testbed = the Civil War known-answer corpus (`corpus/civil_war.jsonl`); gold =
hand-labeled salient entities (`gold/manifest.jsonl`, 16 figures).

    python3 test_score.py                       # the metric's own tests (no models)
    python3 run.py --roster reviewers.jsonl     # extract with every enabled model -> results/
    python3 score.py                            # concrete-R / abstract-R / pollution / latency

**Honesty:** `score.py` matches by token-overlap PROXY. Robust for concrete; **under-counts abstract**
recall (paraphrase). Abstract numbers are a LOWER BOUND — real result needs embedding-match (v2) or
blind two-rater adjudication. `test_score.py` pins that limitation.

Roster (`reviewers.jsonl`): tiny = gemma3:4b (google), qwen3:4b (qwen); large = qwen3:32b (qwen,
x299 via ssh tunnel), llama3.3:70b (meta, pulling); ceiling = claude (anthropic). Enable llama70 +
claude for the full run. x299 needs `ssh -L 11435:127.0.0.1:11434 x299` up first.
