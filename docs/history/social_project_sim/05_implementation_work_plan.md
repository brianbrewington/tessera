# Work Plan: Context Audit Utility Implementation
**Author**: Antigravity (Program Manager / Principal Engineer)
**Date**: 2026-01-10
**Goal**: Deliver a verified `audit_context` CLI tool with real-time observability.
**Reference**: `03_context_audit_design_v2.md`

## Phase 0: Preparation
**Objective**: Ensure environment is ready.
- [ ] **0.1 Dependencies**: Install `ink`, `react`, `winston`, `better-sqlite3`. Verify build on Mac.
- [ ] **0.2 Env Check**: Verify `OPENAI_API_KEY` visibility to CLI context.

## Phase 1: Foundation (Basic Flow with Stubs)
**Objective**: Establish the skeleton application that runs end-to-end (doing nothing) with a working TUI and Logger.
- [ ] **1.1 Project Setup**: Initialize `context_audit_test/src/*` structure.
- [ ] **1.2 TUI Shell**: Implement `AuditDashboard.tsx` (using `ink`) with dummy progress bars and KPI counters.
- [ ] **1.3 Orchestrator Stub**: create `ContextAuditor.ts` that initializes the dashboard, logs "Starting", waits 2 seconds, logs "Finished", and exits.
- [ ] **1.4 Verification**: Run `ts-node src/run_audit.ts` and verify the UI appears and exits cleanly.

## Phase 2: Test Construction ("The Guardrails")
**Objective**: Write the tests that will fail now but pass later (TDD). 
- [ ] **2.1 Mock Setup**: Create `MockLLMAdapter` and `MockGraphStorage` in `src/test/mocks/`.
- [ ] **2.2 Unit Tests**:
    -   `Batching.test.ts`: Define expected behavior for chunking.
    -   `Resumability.test.ts`: Define expected behavior for `checkpoint.json` loading.
    -   `TUI.test.ts`: Verify `MetricStore` updates can be read by a renderer.
- [ ] **2.3 Safety Tests**: Create `CostCap.test.ts` to verify execution stops if budget > $5.
- [ ] **2.4 Golden Set Definition**: Create `tests/fixtures/golden_profile_brian.txt` and `GoldenQuestions.json`.

## Phase 3: Code Construction (Sequential Implementation)
**Objective**: Implement core logic one component at a time.
- [ ] **3.1 Batch Processor**: Implement `BatchProcessor.ts`.
    -   *Logic*: Generic array chunking with `process(items, callback)`.
    -   *Verify*: Pass `Batching.test.ts`.
- [ ] **3.2 Audit Cursor**: Implement `AuditCursor.ts`.
    -   *Logic*: Read/Write `checkpoint.json` (Atomic writes to prevent corruption).
    -   *Verify*: Pass `Resumability.test.ts`.
- [ ] **3.3 Consistency Engine**: Implement `ConsistencyEngine.ts`.
    -   *Logic*: Construct the "Analysis List" prompt for the LLM.
    -   *Verify*: Use `MockLLMAdapter` to verify prompt structure.
- [ ] **3.4 Edge Rationale & Vector Store**: Implement `RationaleEngine.ts` & SQLite connection.
    -   *Logic*: Batch prompt for narratives -> Embedding -> Save to SQLite.
    -   *Verify*: Inspect generated SQLite file.
- [ ] **3.5 Void & Duplicate Detector**: Implement `VoidDetector.ts` (Phase 2 Design).
    -   *Logic*: Vector Search + Duplicate Check (Threshold 0.85).
    -   *Verify*: Mock graph with known "missing link" and "duplicate node".
- [ ] **3.6 Safety Rails**: Implement `CostEstimator.ts`.
    -   *Logic*: (NodeCount * PromptCost) + (EdgeCount * PromptCost).
    -   *Verify*: Pass `CostCap.test.ts`.

## Phase 4: Integration
**Objective**: Wire components into `ContextAuditor` and replace stubs.
- [ ] **4.1 Wiring**: Connect `ContextAuditor` to `BatchProcessor`, `ConsistencyEngine`, `RationaleEngine`, etc.
- [ ] **4.2 Streaming Logic**: Implement the main loop (Fetch Batch -> Audit -> Save Checkpoint).
- [ ] **4.3 TUI Integration**: Connect real events (Batch Complete, Anomaly Found) to `AuditDashboard` updates.

## Phase 5: Verification & Delivery
**Objective**: Prove it works on real data.
- [ ] **5.1 Integration Test**: Run `FullAudit.test.ts` on a small consistent graph.
- [ ] **5.2 Golden Validator Tool**: Build `scripts/validate_golden.ts` to ingest `golden_profile_brian.txt` and run the `GoldenQuestions.json` against the audited graph.
- [ ] **5.3 Final Report Generation**: Implement the Markdown Report generator (Phase 5 of Design).
- [ ] **5.4 User Demo**: Record a run of the tool for the user.
