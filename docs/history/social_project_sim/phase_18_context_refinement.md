# Phase 18: Context Partitioning & Generative Analyzers

**Status**: DRAFT (Awaiting Review)
**Feature**: Protocol-Based Context Refinement

## 1. Overview
The user requires a major architectural shift in how the **Context Service** manages memory and how the **Simulation** loop processes interactions.
The goals are:
1.  **Reduce Noise**: Deduplicate context entries (no paragraph splits) and choke duplication.
2.  **Partitioned Recall**: Distinctly manage "Short-Term Recall" (immediate conversation) vs "Long-Term Recall" (graph retrieval) with strict token/byte guards.
3.  **Active Analysis**: An "Analyzer" loop that runs *after* every interaction (conversation or dream) to extract entities using a multi-pass approach (People first, then Projects/Ideas).
4.  **Generative Collaboration**: Update prompting to force agents to collaborate, invent, and introduce peers.

## 2. Architecture Changes

### 2.1 Context Service
-   **Refactor `addContext`**:
    -   **DROP** the paragraph splitting logic. Ingest full blocks.
    -   **Add Deduplication**: Verify if content already exists (string match or high similarity) before adding.
-   **Refactor `queryContext` / `askContext`**:
    -   Implement **Partitioned Context Construction**:
        -   **Guard A (Short-Term)**: X bytes for the immediate previous interactions.
        -   **Guard B (Long-Term)**: Y bytes for RAG retrieval.
        -   Ensure total size < Context Limit.

### 2.2 Simulation / Loop
-   **New "Analyzer" Pipeline**:
    -   Triggered post-simulation.
    -   **Pass 1 (People)**: Prompt LLM to identify *only* new people mentioned.
    -   **Pass 2 (Projects/Ideas)**: Prompt LLM to identify *only* projects or abstract ideas.
    -   Ingest these as distinct Node Types (`PERSON`, `PROJECT`).

### 2.3 Prompt Engineering
-   **Collaborative Directive**:
    -   Inject a "Prime Directive" into the System Prompt:
        > "You MUST collaborate. You MUST invent new concepts. If you know two people who should meet, you MUST introduce them."

## 3. Data Flow
1.  **Simulate** -> (Conversation Log)
2.  **Analyzer Service**:
    -   Input: Conversation Log
    -   Execution:
        -   Start Pass 1 (People) -> Extract JSON -> Context Service (`addContext`)
        -   Start Pass 2 (Ideas) -> Extract JSON -> Context Service (`addContext`)
3.  **Context Service**:
    -   Ingest new nodes (Check Dupes).

## 4. Test Strategy
-   **Unit**: Test `addContext` ensures no duplicates. Test Partitioning allocates correct byte ratios.
-   **Integration**: Run a simulation, ensure Analyzer triggers and writes to DB.
-   **Functional**: Verify prompt injection leads to "Collaboration" behavior (subjective, but verifiable via log inspection).
