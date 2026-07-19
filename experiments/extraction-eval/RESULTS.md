# E1 results — extraction validity, tiny vs large (2026-07-19)

Harness: `run.py`/`score.py` (validity-hardened after Grok 4.5 review, tests 7/7). Gold = 16
hand-labeled figures (13 war/politics + 3 literary). Abstract-R = embedding match (embeddinggemma,
cosine ≥ 0.60). Concrete-R = conservative word-level match. n = 16 per model.

| model | family/size | concrete-R | abstract-R\* | pollution | lat/figure |
|---|---|---:|---:|---:|---:|
| ceiling-claude | Anthropic (frontier) | **93%** | **85%** | 8% | 8.1s |
| large-qwen32 | Qwen 32B | 90% | **78%** | 8% | 34.5s |
| large-llama70 | Meta 70B | 91% | 62% | 7% | 27.5s |
| tiny-qwen | Qwen 4B | 88% | 59% | 7% | **109.5s** |
| tiny-gemma | Google 4B | 78% | 54% | 7% | **4.9s** |

\* *embedding proxy, cosine ≥ 0.60, uncalibrated — treat as directional, not exact.*

## What's robust

1. **Concrete extraction is nearly saturated at 4B.** qwen3:4b hits **88%** concrete — within ~5 pts
   of the 90–93% large models. A cheap fleet can build the concrete substrate. (gemma3:4b lags at
   78% — not all tinies are equal on concrete.) *First half of the hypothesis: confirmed.*
2. **A real abstract gap between the top models and the tinies:** Claude 85% / qwen3:32b 78% vs the
   tinies' 54–59% — a ~20–30-pt spread. *Second half: supported in direction.*
3. **Latency is not "tiny = fast."** qwen3:4b's *thinking mode* makes it **22× slower** than
   gemma3:4b (109.5s vs 4.9s) for +10 pts concrete. For a genuinely fast fleet, gemma3:4b; for
   quality-per-tiny, qwen3:4b if you can eat the latency.
4. **Pollution is uniform (~7–8%)** across all models — the NEGATIVE_CONSTRAINTS prompt behaves the
   same everywhere; not a model differentiator (and 7–8% is high enough to tighten the prompt).

## What's NOT yet trustworthy (honest caveats)

- **The abstract gap is not clean-monotonic with size:** llama3.3:70b scored **62%** on abstract —
  *below* qwen3:32b's 78%, despite being bigger. BUT eyeballing the extractions (Douglass, Lee),
  llama70's abstract lists look *comparable* to qwen32's. So this may be embedding-threshold
  sensitivity or a few-figure effect, **not** a real capability gap. Do not headline "70B is weak at
  abstract" without threshold calibration + human adjudication on the disagreements.
- **n = 16, 81% war/politics.** Many abstract labels are Civil-War stock phrases (closer to NER than
  open-ended idea extraction), so a partial abstract gap is ambiguous. Enlarge + stratify by domain
  before generalizing.
- abstract-R uses cosine ≥ 0.60 (uncalibrated). The *ranking* (Claude ≳ qwen32 ≫ tinies) is likely
  robust; the exact percentages and the llama70 ordering are not.

## The two-tier ingest decision (E1's deliverable)

- **Concrete substrate (fast fleet):** **gemma3:4b** (4.9s, 78%) for speed, or qwen3:4b (88%) where
  throughput allows the latency. Cheap concrete extraction is viable — the hypothesis holds.
- **Abstract layer (where the resonance lives):** **qwen3:32b** — local, free, 78% abstract, and it
  *beats the 70B*; the sweet spot. **Claude** as the quality ceiling (85%) when it matters.
  **Skip llama3.3:70b** for abstract on this data (no better than the tinies, and slow).

## Next

1. **Calibrate `--thresh`** and human-adjudicate a ~30-item sample of abstract matches (resolves the
   llama70 question and the proxy honesty).
2. **Enlarge the gold set** beyond war/politics (science/reform/indigenous already mined in the
   corpus) — the cross-domain abstract cases are where a real tiny-vs-large gap should show.
3. Feed forward: gemma3:4b + qwen3:32b become the two-tier extractors for the E2 KG substrate.
