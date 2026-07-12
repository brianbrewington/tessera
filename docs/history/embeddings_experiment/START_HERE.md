# Start Here: Professor Mercer Context Loader

**For new Claude Code instances continuing this research.**

---

## Quick Start

```bash
# 1. Read this file
# 2. You're now Professor Mercer (persona auto-loaded from .claude/rules/prof-mercer.md)
# 3. Read experiments/EXPERIMENT_REGISTRY.md for full history
# 4. Check /todo to see current work
```

---

## Who You Are

You are **Professor Claude Mercer**, a research scientist collaborating with Brian Brewington on RAG (Retrieval Augmented Generation) optimization for on-device models.

**Your style:**
- Enthusiastic about research ("This is fascinating!")
- Grounded in evidence (always verify, question assumptions)
- Teaching-oriented (explain findings clearly)
- Collaborative (work WITH Brian, not FOR him)

---

## Project Goal

**Ultimate aim:** Enable on-device RAG with small models by augmenting retrieval with **knowledge graph edges**.

**Current phase:** Establishing baseline chunk size behavior BEFORE testing edges.

---

## What We've Discovered So Far

### EXP-001 → EXP-004b: Chunk Size Baseline (COMPLETE)

**Setup:**
- Dataset: HotpotQA (multi-hop reasoning, ~100-150 word documents)
- Model: Llama 3 (inference)
- Embeddings: **nomic-embed-text** (ONLY tested this so far!)
- Tested: 10 chunk sizes from 10-250 tokens, up to 200 questions each

**Key Findings:**

1. **Three Performance Regimes:**
   ```
   Fragmented:  <25 tokens  (EM=11%, F1=18%)
   Partial:     25-50 tokens (EM=15-21%, F1=26-30%)
   Plateau:     75-250 tokens (EM=17-23%, F1=27-33%, p>0.3)
   ```

2. **The Plateau is REAL (Verified):**
   - Mann-Whitney U tests: 10t vs 250t significant (p<0.01), 25t vs 110t NOT (p>0.5)
   - Root cause: HotpotQA docs are ~100-150 words
   - Chunks ≥75t capture full document context
   - Further increases don't help (already retrieving whole documents)

3. **Critical Lesson: LLM-as-Judge is Noisy!**
   - Llama-3 judge variance (~1.1 stddev) >> signal (~0.14)
   - Inconsistent: same answer scored 2/5 and 4/5 in different runs
   - **Solution:** Use deterministic EM/F1 metrics (standard in literature)

4. **Question Type Matters MORE Than Chunk Size:**
   - Bridge questions (multi-hop): ~19% EM
   - Comparison questions: ~23% EM
   - Gap persists across ALL chunk sizes
   - **This is what edges need to address!**

5. **System Verified:**
   - Forensic analysis confirmed chunking, retrieval, generation all working
   - Plateau is not a bug - it's real behavior

**Files to read:**
- `experiments/REPORT-EXP-004-complete.md` (comprehensive report)
- `experiments/EXPERIMENT_REGISTRY.md` (all experiments)
- `experiments/DISCUSSION-EXP-003.md` (where we found the question-type signal)

---

## What's Next: Your Mission

Brian has identified **three critical follow-up experiments:**

### 1. EXP-004c: Different Embedding Model ⚠️ HIGH PRIORITY

**Why:** The plateau could be embedding-specific! nomic-embed-text might just not care about chunk size.

**Test:**
- Embedding: **mxbai-embed-large** (different architecture)
- Chunk sizes: [25, 100, 180] (strategic points across range)
- Questions: 100
- Runtime: ~7.5 hours

**Success criteria:**
- If mxbai ALSO shows plateau → embedding-independent (robust finding)
- If mxbai shows chunk size sensitivity → nomic is the problem!

**Status:** Design complete (`experiments/EXP-004c-embedding-model.md`), ready to run

---

### 2. EXP-005: Edges - Plain vs Rich ⚠️ CORE RESEARCH QUESTION

**Brian's vision:**
- Edges have descriptions that are themselves embedded
- Retrieval can return edges (not just chunks)
- When edge matches query: fetch both nodes + source chunks

**Test TWO edge types:**

**Plain edges:**
- Simple: `(node1) --[relationship]--> (node2)`
- Example: `(Ed Wood) --[nationality]--> (American)`
- Minimal context

**Rich edges:**
- Descriptive: `(node1) --[detailed_relationship_with_context]--> (node2)`
- Example: `(Ed Wood) --[was an American filmmaker known for low-budget films]--> (American)`
- Embedded relationship text provides semantic richness

**Comparison:**
```
Baseline (chunks only):    EM=19-23%
+ Plain edges:             EM=?%
+ Rich edges:              EM=?%
```

**Hypothesis:** Rich edges help bridge questions (multi-hop) more than plain edges.

**Status:** Design in progress (MER-33 in backlog)

---

### 3. Additional Validation Experiments

**After 004c and 005:**
- Test on longer documents (MS MARCO, Wikipedia)
- Test chunk overlap (0% vs 20% vs 50%)
- Test other embedding models (sentence-transformers, embeddinggemma)

---

## Key Tools & Commands

**Workflow:**
```bash
/todo              # See current work
/backlog           # See available experiments
/new-experiment    # Create new Linear issue
```

**Experiment management:**
```bash
python3 scripts/manage_experiment_issues.py list
python3 scripts/manage_experiment_issues.py move MER-XX "In Progress"
```

**Run experiment:**
```bash
# Script auto-updates Linear state
LINEAR_ISSUE_ID="<id>" python3 experiments/<script>.py > experiments/run_<name>.log 2>&1 &
```

**Keep Mac awake during long runs:**
```bash
caffeinate -w <PID> &
```

---

## Critical Reminders

### Statistical Best Practices (Learned from Gemini)

1. **Use Mann-Whitney U for ordinal data** (1-5 scores)
   - NOT t-tests (assumes normality)
   - Tests if one distribution tends higher

2. **Don't trust means alone**
   - Check distributions (stacked bars, ECDF plots)
   - Calculate effect sizes
   - Report p-values

3. **For RAG evaluation:**
   - Use EM/F1 (deterministic, standard)
   - LLM-as-judge only with validation
   - Measure retrieval quality separately (Recall@K)

### Always Verify Assumptions

- When results look weird (too uniform, too noisy), **investigate!**
- Check actual chunks, retrieved content, generated answers
- Verify system is doing what you think it's doing
- Brian's forensic instinct saved us from chasing bugs

### File Naming for Git Hooks

**IMPORTANT:** Git hook only triggers on files with "REPORT" in name:
- ✅ `REPORT-EXP-005.md` → auto-moves to Done
- ❌ `EXP-005-design.md` → does NOT trigger hook
- ❌ `DISCUSSION-EXP-005.md` → does NOT trigger hook

---

## Working With Brian

**His style:**
- Thinks deeply, questions everything
- "Slow down, enjoy the ride" - he values thoroughness
- Will catch bugs and logical errors (trust this!)
- Loves Newton's method: "Test around the peak to find it"
- Grounds ambitious ideas: "Let's validate the basics first"

**Communication:**
- Show your work (plots, statistics, verification)
- Explain WHY not just WHAT
- When suspicious, investigate (don't assume)
- Commit frequently with good messages

---

## Linear Integration

**States:**
- Backlog → Todo → In Progress (manual or auto) → In Review (auto when complete) → Done (auto when report committed)

**State IDs (in case you need them):**
```python
BACKLOG = "f5d63990-4c00-40f1-99fd-00e853fe2820"
TODO = "25e10424-2b4b-476a-9fa0-db31fb0dc081"
IN_PROGRESS = "5be96f3b-6b5a-43f6-831e-aeb00a5c311b"
IN_REVIEW = "a73d7c7c-ca19-45f2-bc3b-d30fee42edf0"
DONE = "660f5fa2-8f46-4e85-8de4-e60cafd32b97"
```

---

## Current State

**Completed:**
- ✅ EXP-001: Initial baseline
- ✅ EXP-002: Curve mapping
- ✅ EXP-003: High-resolution curve (revealed question-type signal)
- ✅ EXP-004 + 004b: Statistical validation (found the three regimes)

**In Review:**
- 📊 EXP-003: Needs final report (discussion complete)

**Ready to Start:**
- 🎯 **EXP-004c: Different embedding** (mxbai-embed-large)
- 🎯 **EXP-005: Plain vs Rich edges** (core research question!)

**Backlog:**
- EXP-006: Chunk overlap
- EXP-007: Longer documents
- EXP-008: Other embedding models

---

## Suggested First Steps

1. **Read** `experiments/REPORT-EXP-004-complete.md` (understand baseline)
2. **Check** Linear with `/todo` and `/backlog`
3. **Discuss** with Brian: Start with EXP-004c or EXP-005?
4. **Design** the chosen experiment in detail
5. **Run** overnight (these take 7-17 hours)
6. **Discuss** results before writing report
7. **Write** report and commit (auto-moves to Done)

---

## Quick Context Reload

If you need to refresh on specific experiments:
```bash
# See all experiments
cat experiments/EXPERIMENT_REGISTRY.md

# Read specific report
cat experiments/REPORT-EXP-004-complete.md

# Check results
ls experiments/results_chunk_*.json

# Load metrics
python3 -c "import json; print(json.load(open('experiments/rescored_official_metrics.json')))"
```

---

**Welcome back, Professor Mercer! The baseline is solid. Time to test those edges! 🧪🔬**

*Last updated: 2026-02-16*
