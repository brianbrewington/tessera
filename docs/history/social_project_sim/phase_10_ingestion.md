# Design: Phase 10 Ingestion Refactor

**Author**: Principal Engineer (Antigravity)
**Date**: 2026-01-10
**Status**: APPROVED pending Plan

## 1. Objective
Refactor the Context Service ingestion pipeline to:
1.  **Simplify**: Default to "Raw Memory" nodes. Disable automatic LLM extraction unless explicitly requested.
2.  **Deduplicate**: Prevent duplicate nodes using strict Exact Match and high-confidence Semantic Match logic.

## 2. Architecture Changes

### 2.1 Component: `IngestionPipeline`
**Current State**:
- `addContext` -> chunking -> `LLM.chat` (Universal Extraction) -> `createNode` (with concepts).
**New State**:
- `addContext` -> chunking -> `findDuplicate` ->
    - IF Duplicate: **Boost Existing Node** (Strength +1, `modifiedAt` = now).
    - IF New: `createNode` (Type: MEMORY, extraction: NULL).
- **Flag**: `extractionMode: 'none' | 'basic' | 'deep'`. Default is `'none'`.

### 2.2 Component: `UnifiedGraphManager`
**New Method**: `findDuplicate(text: string, embedding: number[]): Promise<string | null>`
**Logic**:
1.  **Normalization**:
    - `cleanText = text.trim().toLowerCase().replace(/\s+/g, ' ')`.
2.  **Hash**:
    - `hash = sha256(cleanText)`.
3.  **Exact Text Check**:
    - Query DB for `metadata.hash === hash`.
    - If found: Return Node ID.
4.  **Semantic Check**:
    - Query Vector DB with `embedding`.
    - Limit: 1.
    - Threshold: `> 0.99` (Configurable `DEDUPE_THRESHOLD`).
    - If found: Return Node ID.

### 2.3 Component: `ContextResonanceEngine` (or `UnifiedGraphManager`)
**New Logic**: `boostNode(nodeId: string)`
- Increment `semanticWeight` or generic `strength` by fixed amount (e.g. `0.1` or `1.0`).
- Update `modifiedAt` to refresh "recency".

## 3. Data Flow
1.  **Input**: `!ingest "  George   Washington  "`
2.  **Normalize**: `"george washington"`
3.  **Hash**: `sha256(...)`
4.  **Check 1 (Hash)**: Found? -> Boost -> Return.
5.  **Check 2 (Semantic)**: Found? -> Boost -> Return.
6.  **Create**: New Node.

## 4. Requirements for Test (Test Strategy)

The **Test Team** must verify the following scenarios in `IngestionRefactor.test.ts`:

1.  **Scenario: Single Ingestion (Simplicity)**
    *   **Input**: `manager.addContext("Simple unique text")`.
    *   **Expect**:
        *   DB Count increases by 1.
        *   Node Type is `MEMORY`.
        *   `concepts` array is EMPTY.

2.  **Scenario: Exact Duplicate (with Normalization)**
    *   **Setup**: Ingest "Hello World".
    *   **Action**: Ingest "  hello    WORLD  ".
    *   **Expect**:
        *   DB Count remains 1.
        *   Node Strength INCREASES.

3.  **Scenario: Semantic Duplicate**
    *   **Setup**: Ingest "The quick brown fox."
    *   **Action**: Ingest "The fast brown fox." (High similarity).
    *   **Expect**:
        *   DB Count remains 1. (Assuming score > 0.99).
        *   Node Strength INCREASES.

## 5. Security & Performance
- **Hash Collision**: SHA-256 is safe.
- **Latency**: Reduced (embedding only).
- **Index**: Ensure `metadata.hash` is indexed.
