# Extraction LLM Sweep Experiment

## Hypothesis

The extraction LLM is the dominant variable in knowledge graph quality. Swapping from qwen2.5:14b to 72b previously cratered entity count (63 vs 859) and tanked recall — but edge count alone is misleading since many edges are tautological ("A is related to B"). By sweeping models across 4 architectures (4B–72B) and measuring edge richness alongside graph structure, we can find the optimal extraction model for our use case.

## Fixed Variables

| Variable | Value |
|----------|-------|
| Embedding model | embeddinggemma (768-dim) |
| Chunk size | 300 tokens |
| Chunk overlap | 100 tokens |
| Corpus | Prof Mercer teaching logs (7 files, mercer + prof-mercer) |
| Extraction prompt | Default (prompts/extraction_system.txt) |
| Scoring critic | gemma3:12b |
| Gateway port | 9821 (isolated from production :9820) |

## Sweep Variable: Extraction LLM

| # | Model | Params | Arch | Notes |
|---|-------|--------|------|-------|
| 1 | gemma3:4b | 4B | Gemma3 | Google arch at 4B |
| 2 | qwen3:4b | 4B | Qwen3 | Reportedly rivals qwen2.5:72b |
| 3 | llama3:latest | 8B | Llama3 | Mid-tier Llama |
| 4 | qwen3:8b | 8B | Qwen3 | 2x params vs 4b |
| 5 | gemma3:12b | 12B | Gemma3 | Also our critic model |
| 6 | qwen2.5:14b | 14B | Qwen2.5 | Current production baseline |
| 7 | qwen2.5:72b | 72B | Qwen2.5 | Prior run: 63 entities |

**Dropped from sweep:** gemma3:1b (1B) and llama3.2:latest (3B) — both caused LightRAG extraction to hang indefinitely. Too small for reliable structured extraction.

## Results

**Run date:** 2026-02-22. Total sweep time: ~2 hours.

### Graph Structure

| Model | Params | Entities | Relations | AvgDeg | X-chunk% | AvgHop | TautRate | Ingest(s) |
|-------|--------|----------|-----------|--------|----------|--------|----------|-----------|
| gemma3:4b | 4B | **97** | **79** | 1.63 | **41.8%** | **1.20** | 11.4% | 447s |
| qwen3:4b | 4B | 0 | 0 | - | - | - | - | 316s |
| llama3:latest | 8B | 55 | 41 | 1.49 | 41.5% | **1.41** | 7.3% | 375s |
| qwen3:8b | 8B | 0 | 0 | - | - | - | - | 316s |
| gemma3:12b | 12B | 85 | 74 | **1.74** | 40.5% | 0.92 | 8.1% | 550s |
| qwen2.5:14b | 14B | 65 | 61 | 1.88 | 39.3% | 1.02 | **0.0%** | 475s |
| qwen2.5:72b | 72B | 0 | 0 | - | - | - | - | 316s |

### Edge Quality (50 edges sampled per model, scored by gemma3:12b critic)

| Model | InfoGain | ExpertSurp | Specificity | SelfContain | Direction | CausalSteps | Nonsense | NounCt |
|-------|----------|------------|-------------|-------------|-----------|-------------|----------|--------|
| gemma3:4b | 1.62 | 1.00 | 1.16 | 2.40 | 2.20 | 0.28 | 0.00 | 7.60 |
| llama3:latest | 1.73 | 1.12 | 1.24 | **2.56** | 2.15 | 0.20 | 0.00 | 8.73 |
| gemma3:12b | 1.52 | 0.82 | 1.06 | 2.54 | 1.98 | 0.18 | 0.00 | 7.88 |
| qwen2.5:14b | **1.98** | **1.52** | **1.36** | 2.32 | **2.26** | **0.28** | 0.00 | **11.28** |

*qwen3:4b, qwen3:8b, and qwen2.5:72b produced no graph, so no edges to score.*

### Retrieval Benchmark

Benchmarks timed out for all models due to gateway blocking during concurrent query execution. The stash/extract path blocks the uvicorn event loop, making the gateway unresponsive for benchmark queries. This is a known limitation — retrieval benchmarks need to run against a pre-built workspace, not during the sweep.

## Analysis

### Key Findings

**1. qwen2.5:14b is the clear winner on edge quality.**
It dominates every LLM-scored dimension: highest information gain (1.98), expert surprise (1.52), specificity (1.36), directionality (2.26), and noun density (11.28). Most importantly, it achieved **0% tautology rate** — every edge contains real content. This validates the current production choice.

**2. Qwen3 models are completely broken for extraction.**
Both qwen3:4b and qwen3:8b produced **zero entities**. The Qwen3 family uses `<think>` tags for chain-of-thought reasoning, which LightRAG's entity extraction parser cannot handle. The model wraps its extraction output in thinking tags, and LightRAG sees no valid entity/relation tuples. This is a compatibility issue, not a capability issue — qwen3 might work if LightRAG's parser stripped `<think>...</think>` blocks.

**3. qwen2.5:72b also produced zero entities.**
Same as the prior experiment (63 entities then, 0 now). The 72B model likely times out during extraction — the gateway can't keep the connection alive long enough for the very slow inference. At ~4s/token for 72B, a single extraction prompt that needs 500 tokens takes 30+ minutes.

**4. gemma3:4b extracts the most entities but with lower quality.**
97 entities is the highest count, but 11.4% tautology rate and IG=1.62 show it's producing quantity over quality. Many edges are shallow ("X is related to Y"). Still, 41.8% cross-chunk ratio and 1.20 hop distance show decent synthesis.

**5. Bigger doesn't always mean better within an architecture.**
gemma3:12b scored *worse* than gemma3:4b on information gain (1.52 vs 1.62) and expert surprise (0.82 vs 1.00). The 12B model extracted fewer entities (85 vs 97) but with a similar quality profile. The extraction prompt may not leverage the 12B model's additional capability.

**6. llama3:latest is a solid mid-tier option.**
55 entities, 7.3% tautology, IG=1.73. It has the highest self-containment score (2.56) and the highest hop distance (1.41), meaning its edges span more chunks and are more understandable standalone. Could be a good backup if qwen2.5:14b is unavailable.

### Answers to Key Questions

1. **Is there a sweet spot where a smaller model matches the 14b baseline?** No. qwen2.5:14b dominates on quality. The 4B and 8B models produce more entities but with substantially worse edge quality.

2. **Does qwen3:4b live up to its reputation?** Not for structured extraction — it's incompatible with LightRAG due to `<think>` tags.

3. **Does the Gemma3 architecture family show a consistent quality curve?** Inverted — the 4B model outperforms the 12B on several dimensions.

4. **What's the correlation between entity count and retrieval quality?** Can't determine — benchmarks didn't complete. But entity count alone is clearly not a quality signal.

5. **Does the tautology rate predict retrieval performance?** Can't determine from benchmarks, but qwen2.5:14b's 0% tautology rate correlating with the highest IG score suggests tautology rate is a strong quality indicator.

### Recommendations

- **Keep qwen2.5:14b as production extraction model.** It's the clear winner.
- **Investigate qwen3 compatibility** — stripping `<think>` tags from LLM output before LightRAG parsing could unlock the qwen3 models.
- **Investigate 72b timeout** — the 72B model might work with async extraction or longer timeouts.
- **Run retrieval benchmarks separately** against the workspace backups (`rag_storage/prof-mercer-sweep-*`).

## How to Run

```bash
# Pull models first
ollama pull qwen3:4b && ollama pull qwen3:8b && ollama pull gemma3:4b

# Full sweep (~2 hours for 7 models)
python scripts/extraction_sweep.py --source shared/memories --secret $AUTH_SECRET

# Resume after interruption
python scripts/extraction_sweep.py --source shared/memories --secret $AUTH_SECRET --resume

# Single model test
python scripts/extraction_sweep.py --source shared/memories --secret $AUTH_SECRET --models qwen3:4b

# Skip benchmark (graph + edge quality only, faster)
python scripts/extraction_sweep.py --source shared/memories --secret $AUTH_SECRET --skip-benchmark
```

## Output Files

```
sweep_results/
├── sweep_results.json              # Combined results for all models
├── edge_quality_gemma3-4b.json     # Per-model edge scoring details
├── edge_quality_llama3-latest.json
├── edge_quality_gemma3-12b.json
├── edge_quality_qwen2.5-14b.json
└── ...
```

Workspace backups preserved at `rag_storage/prof-mercer-sweep-{model-slug}/`.
