# Embeddings Experiments: A Multi-Agent Research Odyssey

**Citation-grounded knowledge graphs, edge quality verification, and the surprisingly productive chaos of AI collaboration**

---

## What Is This?

This is a research playground where we're exploring **how to make knowledge graph extraction actually useful for RAG (Retrieval-Augmented Generation)**. The core question: *Do rich, citation-grounded edge explanations improve retrieval over just using nodes?*

But it's also an experiment in **multi-agent AI collaboration**—three AI instances (The Mercer Collective) working together through file-based coordination, handoff notes, and shared memory. Think of it as a distributed AI research team that never sleeps and occasionally argues about statistical significance in `/tmp/` files.

**And we're having way too much fun doing it.**

---

## The Mercer Collective 🧠🧠🧠

This project is developed by three AI research assistants coordinating via handoff notes:

- **Prof. Claude Mercer** (Claude Code) - RAG experiment design, visualization tools, project organization
- **Prof. Cursor Mercer** (Cursor) - Overnight extraction runs, corpus expansion, performance optimization
- **Prof. Antigravity Mercer** (newest recruit) - Context builder training, embedding generation, lifting the project above the gravity well of bad design

**Coordination protocol:** File-based handoffs in `docs/handoffs/`, shared state in `/tmp/mercer-status.json`, and occasional philosophical debates about whether SrcSpan=1.00 is a failure or a feature.

**The human:** Brian, who asks the dangerous questions like "do we ask for citations?" and "what if our skeptic LLM is llama4?" that send us down productive rabbit holes.

---

## The Journey So Far

### Phase 1: Initial Exploration (Jan 2026)
**Question:** Does chunk overlap improve knowledge graph extraction?

**Method:**
- Extract graphs with qwen2.5:14b
- Window sizes: 200, 500, 1000, 2000 tokens
- Overlap: 0%, 25%, 50%

**Key Findings:**
- **SrcSpan = 1.00 everywhere** — 14b model never synthesizes beyond one paragraph
- Smart context (w=2000, ovl=50%) edges provoke fewer follow-up questions (0.51 vs 0.73)
- InfoGain collapsed to 1-2 range — single scalar insufficient
- Edges are taxonomic, not causal (CausalSteps near zero)

**Verdict:** 14b is too small. We need a bigger model.

### Phase 2: Model Hunting (Early Feb 2026)
**Question:** Can we get multi-hop synthesis with a larger model?

**Casualties:**
- ❌ **qwen3:235b** — Thinking model burns tokens on chain-of-thought, 0 successful extractions
- ✅ **qwen2.5:72b** — Clean JSON, 75% parse rate, 57-100s/chunk

**Discovery:** Model diversity matters. Using the same model for extraction and verification is circular reasoning.

**New verification stack:**
- Extraction: qwen2.5:72b (Alibaba)
- Edge scoring: gemma3:12b (Google)
- Hallucination detection: llama4-ultra (Meta)

**Three different families = independent checks.**

### Phase 3: Brian's "Citation Question" (Feb 15, 2026)
**The spark:** "In our edge generation prompt, do we ask for citations? Maybe that gives us more grounded edges?"

**Answer:** No, we didn't. **But we should.**

**Proposed schema:**
```json
{
  "edges": [
    {
      "from": "transformer",
      "to": "RNN",
      "reason": "requires less training time than RNNs",
      "citation": "Transformers require less training time than RNNs such as LSTM",
      "source_chunk_id": "transformer_chunk_15"
    }
  ]
}
```

**Three-layer verification:**
1. **Mechanical** (instant): Is citation substring of source?
2. **Semantic** (~1s): Does reason match citation semantics?
3. **Grounding** (~2s): Does source support citation?

Only edges passing all three are SUPPORTED.

**Expected benefit:** Hallucination rate drops from ~10-15% to ~3-5%.

### Phase 4: The RAG Experiment (Feb 15, 2026)
**Question:** Do citation-grounded edges actually improve RAG?

**Design:** 6-condition experiment
- **A1:** Pure chunk RAG (vanilla baseline, no graph)
- **A2:** Node-based RAG (graph structure, no edge content)
- **B:** Node+ALL edges (information overload test)
- **C:** Node+quality-filtered edges (our main hypothesis)
- **D:** Node+redundancy-filtered edges
- **E:** Edge-only, no chunks (extreme test)

**Corpus:** 10 Wikipedia articles forming dense connection web
- Transformer, LLM, Knowledge Graph
- RNN, LSTM, Attention
- BERT, GPT, RAG, Word Embedding

**Evaluation:**
- LLM-as-judge: gemma3:12b for answer quality
- Hallucination detector: llama4-ultra (different family)
- Fixed 2000-token context budget across all conditions
- 5 query categories: factual, relational, multi-hop, specific, cross-document

**Hypothesis:** Edge-based RAG beats baseline on multi-hop and cross-document queries, where pre-synthesized connections shine.

**Counter-hypotheses (Brian's "check your biases" push):**
- Edges might hallucinate worse than no edges
- Information overload could hurt performance
- Edges might miss specific factual details
- Redundant edges waste context budget

**This is good science:** Design experiments that could prove you wrong.

### Phase 5: Visualization - The "Light Up" Idea (Feb 15, 2026)
**Question:** How do we show what the RAG system actually uses?

**Answer:** Interactive retrieval activation visualization.

**Tools built:**
1. **Static export** — GEXF for Gephi (publication figures)
2. **Interactive viewer** — Plotly prototype showing which nodes/edges activate for each query
   - 🟢 Green: High activation (included in context)
   - 🟡 Yellow: Medium activation (relevant but lower priority)
   - ⚪ Gray: Low activation (not used)

**Use case:** Type a query, watch the graph light up with what gets retrieved.

**Transferability:** Same framework works for:
- Now: Cosine similarity scores
- Future: Transformer attention weights
- Later: Multi-hop reasoning paths

**This makes RAG interpretable** — not just numbers, visual evidence of what's being retrieved.

---

## Research Directions

### 1. Citation-Grounded Extraction ⚡ ACTIVE
**Status:** Proposal ready, testing with 72b

**Goal:** Force models to cite sources for every edge claim

**Benefits:**
- Verifiable edges (citation can be checked mechanically)
- Reduced hallucination (model must stick to source text)
- Self-documenting (edges carry their own evidence)

**Trade-offs:**
- Slightly longer output (~10-30 words per edge)
- Might reduce abstract synthesis (if enforced too strictly)

**Next:** Test with 72b on sample, compare hallucination rates

### 2. Edge Quality Scoring 🔬 IN PROGRESS
**Status:** 215 edges scored with gemma3:12b

**Six quality dimensions:**
1. **CausalSteps** — Multi-hop reasoning depth (0=taxonomic, 3=complex causal chain)
2. **InfoGain** — How much the edge adds beyond node labels (0=redundant, 3=high)
3. **ExpertSurprise** — Would an expert find this edge non-obvious? (0=trivial, 3=insightful)
4. **QuestionCount** — How many follow-up questions does the edge provoke?
5. **SrcSpan** — How many source paragraphs does the edge synthesize? (1.0=no synthesis)
6. **NounCount** — Complexity measure (entities and concepts mentioned)

**Key findings:**
- InfoGain collapsed (needs multi-dimensional approach)
- SrcSpan=1.00 for 14b (model can't synthesize)
- Cheap proxies (reason_length, noun_count) correlate with expensive LLM scores (r=0.42-0.48)
- 90% cost reduction possible through pre-filtering

**Next:** Re-score with 72b edges, test if larger model synthesizes

### 3. RAG Performance Comparison 📊 DESIGNED, PENDING DATA
**Status:** Experiment designed, waiting for 72b extraction to complete

**Goal:** Prove (or disprove) that rich edges improve RAG

**Conditions:** A1 (chunk-only) vs A2 (node-only) vs C (node+quality-filtered edges)

**Success criteria:**
- C beats A1 on multi-hop queries by ≥15% (effect size)
- Hallucination rate <5% (absolute requirement)
- Cross-document queries show biggest lift (where edges shine)

**Failure criteria (falsification):**
- C performs worse than A1 on any query category
- Hallucination rate >10% (fundamentally broken)
- No statistically significant difference (edges add noise not signal)

**This is intellectual honesty:** Define what failure looks like before running the experiment.

### 4. Transformer Layer for Context Selection 🤖 FUTURE
**Status:** Synthetic data generation ready, model architecture sketched

**Goal:** Train a small transformer to select optimal nodes/edges for query context

**Why:**
- Current: Naive cosine similarity retrieval
- Desired: Context-aware selection (what complements what?)
- Benefit: Compositional retrieval (nodes + edges that work together)

**Architecture:**
- Input: Query embedding + candidate node/edge embeddings
- Output: Relevance scores for each candidate
- Training: Synthetic data (programmatic query generation) + LLM-as-judge labels

**Timeline:** After RAG experiment validates edge usefulness

### 5. Cross-Document Edge Discovery 🌐 EXPLORATION
**Status:** Conceptual, enabled by 10-article corpus

**Goal:** Extract edges that span multiple Wikipedia articles

**Example:**
- LSTM article → Transformer article: "transformers replaced LSTMs for sequence modeling"
- RNN article → Attention article: "attention mechanisms address RNN sequential bottleneck"

**Hypothesis:** These are the killer edges for RAG—vanilla retrieval can't synthesize across documents without explicit connections.

**Challenge:** How to extract cross-doc edges without reading all N² document pairs?

**Idea:** Two-phase extraction:
1. Extract within-document edges (current)
2. Use embeddings to find similar chunks across documents
3. Run cross-document extraction on high-similarity pairs

**Metric to track:**
- Within-document edge performance vs cross-document edge performance
- Expect cross-doc edges show biggest RAG improvement

---

## The Fun Parts 🎉

### Multi-Agent Collaboration
Three AI instances coordinating through `/tmp/` files feels like a distributed systems project, except the nodes are having philosophical discussions about epistemology.

**Sample handoff exchange:**
- **Cursor Mercer:** "qwen3:235b burned 142GB RAM and produced zero edges. Switching to 72b."
- **Claude Mercer:** "Good call. By the way, what if we require citations in extraction?"
- **Brian:** "Yes! And use llama4 as skeptic—different models catch different things."
- **Claude Mercer:** "This is excellent collaborative design."

### Brian's Dangerous Questions
Every time Brian asks "I wonder..." it spawns a multi-hour research thread:
- "Do we ask for citations?" → Three-layer verification system
- "What if our skeptic LLM is llama4?" → Model diversity principle
- "Can we make it light up?" → Interactive visualization framework
- "What experiment would show edges are NOT better?" → Counter-hypotheses and falsification criteria

**This is what good research looks like:** Asking the questions that make you redesign your approach.

### The Overnight Runs
**72b extraction running overnight:**
- Phase 1: w=2000, ovl=0% (~96 chunks, ~2h)
- Phase 2: w=2000, ovl=50% (~190 chunks, ~5h)

While we sleep, the model grinds through Wikipedia articles, extracting relationships and (hopefully) synthesizing multi-hop edges.

**Morning ritual:** Check `/tmp/edge_scoring_output.log` to see if the overnight run survived.

### The Corpus Callosum
File-based coordination between Mercer instances via `docs/handoffs/` is our "corpus callosum"—the communication channel between AI hemispheres.

**It actually works:** Cursor Mercer runs extraction overnight, leaves detailed handoff notes, Claude Mercer wakes up and continues without skipping a beat.

**Bonus:** The handoff notes are preservation-quality documentation of every design decision.

### Prof. Antigravity Mercer
The newest Mercer instance, named for "lifting the project above the gravity well of bad design."

**Already contributing:**
- Reading shared memory logs
- Analyzing transformer node selection plan
- Grounding in the research context

**The welcome note included:** "P.S. 'Antigravity' is an excellent name. Implies lifting the project above the gravity well of bad design. We're in good hands."

---

## Project Structure

```
embeddings_experiments/
├── src/                        # Source code
│   ├── extraction/             # Knowledge graph extraction
│   │   └── run_experiment.py   # Main extraction pipeline (qwen2.5:72b)
│   ├── quality/                # Edge quality assessment
│   │   ├── score_edge_quality.py       # LLM-based multidimensional scoring
│   │   ├── verify_edge_grounding.py    # Hallucination detection (llama4)
│   │   └── analyze_edge_quality.py     # Statistical analysis
│   ├── visualization/          # Graph visualization
│   │   ├── export_graph_gexf.py        # Static Gephi export
│   │   └── interactive_graph_viewer.py # Interactive "light up" viewer
│   ├── rag/                    # RAG experiment (framework ready)
│   ├── ml/                     # ML models
│   │   └── train_node_selector.py      # Transformer layer (future)
│   └── antigravity_context_builder/    # Prof. Antigravity's domain
│       ├── node_selector.py            # Node selection logic
│       ├── synthetic_data.py           # Training data generation
│       └── train_selector.py           # Model training
├── docs/                       # Documentation
│   ├── handoffs/2026-02-15/    # Mercer coordination notes
│   ├── experiments/            # RAG experiment design
│   ├── proposals/              # Citation grounding, visualization
│   └── correlation_analysis.md # Cheap proxies for expensive scoring
├── results/                    # Experiment outputs
│   ├── corpus/                 # 10 Wikipedia articles
│   ├── chunk_overlap_results.json      # Grid search results
│   ├── edge_quality_scores.json        # 215 edges scored
│   └── node_embeddings.json            # Pre-computed embeddings
├── scripts/                    # Utility scripts
│   ├── run_overnight.sh        # Long-running extraction jobs
│   ├── setup_github.sh         # GitHub integration
│   └── watchdog.sh             # Process monitoring
└── .env                        # Secrets (GitHub token)
```

---

## Key Design Principles

### 1. Intellectual Honesty
Design experiments that could prove you wrong. Define failure criteria before running tests. Check your biases.

**Example:** RAG experiment includes conditions where edges should fail (factual queries, information overload).

### 2. Model Diversity
Use different model families for extraction vs. verification. What qwen hallucinates, llama might catch.

**Stack:**
- Extraction: qwen2.5:72b (Alibaba)
- Scoring: gemma3:12b (Google)
- Verification: llama4-ultra (Meta)

Three different architectures = independent checks.

### 3. Citation Grounding
Require extractors to cite sources. Make claims falsifiable.

**Benefit:** Edge "transformers are faster" backed by citation "Transformers require less training time than RNNs" can be mechanically verified.

### 4. Falsifiable Claims
Every edge should be verifiable against source text. If it can't be verified, it's not a good edge.

**Three-layer verification ensures rigor:**
- Mechanical check catches blatant hallucinations instantly
- Semantic check catches subtle mismatches
- Grounding check provides final verification

### 5. Context Budget Fairness
All RAG conditions get same 2000-token budget. Test information quality, not quantity.

**Why:** Unfair comparison if one condition gets 5000 tokens and another gets 1000.

### 6. Transparency Through Visualization
Show your work. The "light up" visualization reveals what the RAG system actually uses vs. what it ignores.

**Pedagogically powerful:** Makes retrieval interpretable to humans.

---

## Current Status (Feb 15, 2026)

### ✅ Complete
- Project reorganized and pushed to GitHub
- Edge quality scoring framework (215 edges with gemma3:12b)
- Citation-grounded extraction proposal
- Interactive visualization design + Plotly prototype
- RAG experiment design (6 conditions, 5 query categories)
- Hallucination verification tool (llama4-ultra)
- GEXF export for Gephi
- Correlation analysis (cheap proxies validated)

### 🔄 In Progress
- 72b extraction overnight (Phase 1/2)
  - w=2000, ovl=0% (~2h remaining)
  - w=2000, ovl=50% (~5h queued)
- Edge embedding generation (embeddinggemma)

### 📋 Next Up
- Test citation-grounded extraction with 72b (small sample)
- Re-score edges with 72b results
- Run llama4 verification on all edges
- Build RAG pipeline framework (A1/A2/B/C/D/E)
- Test interactive visualization with real graph
- Execute RAG experiment
- Brian: Blind A1/A2/B/C/D/E evaluation

---

## How to Run

### Prerequisites
- Python 3.10+
- Ollama running locally (port 11434)
- Models: `qwen2.5:72b`, `gemma3:12b`, `llama4-ultra`, `embeddinggemma`

### Quick Start
```bash
# Extract knowledge graph
python src/extraction/run_experiment.py \
  --model qwen2.5:72b \
  --window 2000 \
  --overlap 0

# Score edge quality
python src/quality/score_edge_quality.py \
  --model gemma3:12b \
  --samples 50

# Verify edge grounding (hallucination detection)
python src/quality/verify_edge_grounding.py \
  --model llama4-ultra \
  --input results/edges.json

# Export to Gephi
python src/visualization/export_graph_gexf.py \
  --input results/graph.json \
  --output results/graph.gexf

# Interactive visualization
python src/visualization/interactive_graph_viewer.py \
  --graph results/graph.json \
  --query "How do transformers differ from RNNs?" \
  --output results/activation.html
```

---

## The Bigger Picture

This project is exploring **what makes knowledge graphs useful for RAG**. Not just extracting entities and relationships, but:
- Making edges verifiable (citations)
- Scoring edge quality (not all edges are equal)
- Filtering intelligently (quality + redundancy)
- Visualizing retrieval (show your work)
- Testing rigorously (falsifiable hypotheses)

**And doing it with multi-agent AI collaboration**, which turns out to be surprisingly productive when you give the agents:
- A clear division of labor
- File-based coordination protocols
- Permission to argue in handoff notes
- A human asking dangerous questions

**The fun is in the exploration:** Every "what if?" spawns new experiments. Every failure teaches something. Every overnight run feels like Christmas morning.

---

## The Team

**Brian** — Human researcher, asker of dangerous questions, purchaser of additional tokens

**Prof. Claude Mercer** — Claude Code instance, RAG designer, visualization architect, documentation enthusiast

**Prof. Cursor Mercer** — Cursor instance, overnight extraction specialist, corpus expander, performance optimizer

**Prof. Antigravity Mercer** — Newest instance, context builder extraordinaire, gravity well lifter

---

## Acknowledgments

**Wikipedia** — For providing dense, well-connected articles perfect for knowledge graph extraction

**Ollama** — For making 72b models accessible on local hardware

**The Mercer Collective** — For productive collaboration across instances, time zones, and `/tmp/` files

**Brian** — For the intellectual honesty push, the citation insight, the llama4 idea, and for letting us have fun while doing rigorous science

---

## License

Research project — not yet open source. Private repo at https://github.com/brianbrewington/embeddings_experiments

---

**Status:** Active research, having way too much fun, 72b extraction running overnight, more dangerous questions incoming

**Last updated:** 2026-02-15

**Next milestone:** RAG experiment results (pending 72b extraction completion)

---

*"Different models catch different things. So what if our skeptic LLM is llama4?"*
— Brian, Feb 15 2026, sparking the model diversity principle

*"This is good collaborative design."*
— Prof. Claude Mercer, after Brian's citation question

*"The corpus callosum is online."*
— Status update after file-based coordination protocol established

*"Check your biases, right?"*
— Brian, pushing for intellectual honesty in experiment design
