# Design Review: Context Audit Utility
**Reviewer**: Senior Backend Engineer
**Date**: 2026-01-10
**Target**: `01_context_audit_design.md`
**Status**: REQUESTING CHANGES

## Summary
The design captures the user's intent well ("MRI Scan" of the graph), but has critical scalability and feasibility risks that need addressing before implementation. 

## Critical Findings

### 1. Scalability Risk: "Snapshot into Memory"
**Issue**: Section 3.2, Step 1 proposes loading *all* nodes and edges into `InMemGraphStorage`.
**Impact**: Node.js default heap is ~2GB. A graph with 10k nodes and 50k edges, plus rich metadata strings, plus the 1GB log buffer, ensures an OOM (Out Of Memory) crash.
**Recommendation**: The `ContextAuditor` must use a **Streaming/Cursor** approach. It should fetch `batch_size=100` nodes, audit them, flush results to disk/DB, and garbage collect before moving to the next batch. The "In-Memory" requirement from the prompt likely referred to the *Log*, not the *Graph*.

### 2. Cost & Latency: O(N + E) LLM Calls
**Issue**: Running a separate LLM prompt for every single node (Consistency) and every single edge (Rationale) is prohibitively slow and expensive.
-   Example: 1,000 nodes = 1,000 calls. 5,000 edges = 5,000 calls. Total 6,000 calls.
-   At 1 sec/call = 1.6 hours.
**Recommendation**: Implement **Micro-Batching**.
-   Group 10-20 nodes into a single prompt: *"Review this list of 20 nodes. Return a JSON list of IDs that are inconsistent."*
-   This reduces calls by factor of 20x.

### 3. Edge Rationale Storage
**Issue**: Section 3.1 proposes `audit_rationale_embedding`.
**Question**: Where does this live? The current `VectorDBAdapter` is keyed on `NodeID`. Does it support "Edge Embeddings"?
**Recommendation**: If the Vector DB (LanceDB) doesn't support Edge-as-Document natively, we need a separate Collection (`edge_narratives`) or store it as a "Meta-Node" (reified edge) in the main graph.

### 4. Golden Set Evaluation
**Issue**: Section 4.3 mentions an "LLM-Judge".
**Risk**: Infinite recursion / Hallucination. If the Judge has the same bias as the Generator, it will approve false positives.
**Recommendation**: The "Golden Set" should have *explicit* keywords or facts that MUST be present. The Judge should be instructed to verify factual recall, experienced through `RAGAS` or similar evaluation frameworks (Context Precision, Faithfulness).

## Nitpicks
-   **Log Rotation**: The 1GB log cap is a safeguard, but standard `winston` or `pino` loggers handle rotation better than custom in-memory buffers.
-   **Resume Capability**: If the audit takes 2 hours (see point 2) and crashes, we lose progress. We need a detailed `checkpoint.json` to resume from the last batch.

## Verdict
**Update Required**. Please re-spin the design to address Batching, Streaming, and Resume capability.
