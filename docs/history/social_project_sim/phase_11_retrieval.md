# Design: Phase 11 Retrieval Enhancements

**Author**: Principal Engineer (Antigravity)
**Date**: 2026-01-10
**Status**: DRAFT

## 1. Objective
Enhance the accuracy and efficiency of the `!ask` command by:
1.  **Context Limiting**: Replace simple "Top K Nodes" limit with a Byte-Size Limit `MAX_CONTEXT_BYTES` (e.g., 5000 chars) to prevent context window overflow while maximizing relevant information.
2.  **Query Rewriting**: Use LLM to generate 2-3 variations of the user's query ("Multi-Query RAG") to improve retrieval recall.

## 2. Architecture Changes

### 2.1 Component: `QueryRewriter` (New Service)
- **Location**: `src/core/retrieval/QueryRewriter.ts`
- **Method**: `rewrite(query: string, count: number = 3): Promise<string[]>`
- **Logic**:
    - Call LLM with strict prompt.
    - **Refinement**: Use `JsonRepair` to ensure robust parsing of LLM response.
    - Fallback: Return original query if LLM fails.

### 2.2 Component: `ContextGraphManager` (Update `askContext`)
- **Current Flow**:
    - `vectorSearch`
- **New Flow**:
    - **Step 1: Rewrite**: `variations = await rewriter.rewrite(query)`
    - **Step 2: Parallel Search**: `Promise.all`
    - **Step 3: Deduplicate**: Merge results. If node found in multiple searches, keep **MAX** score.
    - **Step 4: Prune by Bytes**:
        - Sort unique nodes by score.
        - Accumulate until `SUM(text.length) > MAX_CONTEXT_BYTES`.
    - **Step 5**: Chat.

## 3. Configuration
- `CONTEXT_BYTE_LIMIT`: 5000 (approx 1250 tokens).
- `QUERY_REWRITE_COUNT`: 3.

## 4. Requirements for Test (Test Strategy)

The **Test Team** must verify:

1.  **Scenario: Byte Truncation**
    - Mock Search returns 3 nodes of 2000 chars each.
    - `MAX_CONTEXT_BYTES` = 3000.
    - **Expect**: Only Top 1 and partial Top 2? OR truncate list to Top 1 only. (Decision: Truncate list strictly. Don't slice node text for now to maintain coherence).
    - Result: Only 1 node used.

2.  **Scenario: Query Rewriting**
    - `rewrite` mocked to return ["A", "B", "C"].
    - `vectorSearch` called 3 times.
    - Results merged and deduplicated.

3.  **Scenario: Latency Check**
    - Rewriting adds time. Verify total overhead is acceptable (or skipped if < 5 words?).
    - *Optimization*: Run parallel searches.

