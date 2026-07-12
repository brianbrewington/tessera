# Audit of `context_audit_test` Codebase

This document maps the functionality of each source file in `context_audit_test` to its corresponding unit test, identifying any gaps.

## Source Code Functionality & Test Coverage

| Source File | Functionality Description | Test File | Coverage Status |
| :--- | :--- | :--- | :--- |
| **`core/AuditCursor.ts`** | Manages audit checkpointing (save/load) to JSON files to allow resumability. | `test/unit/Resumability.test.ts` | ✅ **Covered**. Tests save, load, and atomic overwrite logic. |
| **`core/AuditOrchestrator.ts`** | Main controller. Orchestrates fetching data, batching it, running pipelines (Void, Consistency, Rationale), and updating TUI. | `test/integration/AuditOrchestrator.test.ts` | ✅ **Covered**. Integration test verifies start-up and completion cycle. |
| **`core/BatchProcessor.ts`** | Utility to process arrays of items in chunks with rate limiting/pausing. | `test/unit/Batching.test.ts` | ✅ **Covered**. Tests batch slicing and processing logic. |
| **`core/ConsistencyEngine.ts`** | Uses LLM to check nodes for semantic validity and nonsense. | `test/unit/Consistency.test.ts` | ✅ **Covered**. Tests prompt generation and JSON parsing (hardened with `jsonrepair`). |
| **`core/CostEstimator.ts`** | Calculates token usage and estimated cost for audits. | `test/unit/Safety.test.ts` | ✅ **Covered**. Tests cost accumulation and budget limits. |
| **`core/RationaleEngine.ts`** | Generates text narratives for edges using LLM and stores embeddings in SQLite. | `test/unit/Rationale.test.ts` | ✅ **Covered**. Tests narrative generation and SQLite interactions (stubbed/mocked). |
| **`core/VoidDetector.ts`** | Finds duplicates and missing links using Vector Search + LLM verification. | `test/unit/Void.test.ts` | ✅ **Covered**. Tests duplicate and missing link detection logic. |
| **`core/config.ts`** | Defines default configuration values (batch size, concurrency, paths). | N/A | ⚪ **Config only**. No dynamic logic to test. |
| **`run_audit.tsx`** | CLI Entry point. Sets up TUI and launches Orchestrator. | `test/unit/TUI.test.tsx` | ⚠️ **Partial**. TUI components tested separately. Full E2E is manual. |
| **`imports.ts`** | ESM/CJS Bridge for importing legacy modules. | N/A | ⚪ **Glue code**. Validated by generic runtime success. |

## Identified Gaps & Actions

1.  **`AuditOrchestrator` Integration**: The test `should run full audit cycle` is failing because of a mock mismatch (`loadFromDB` missing or `storage` property access failing).
    - **Action**: Fix `MockGraphStorage` linkage or `ContextGraphManager` mock setup in `AuditOrchestrator.test.ts`.

2.  **`run_audit.tsx`**: We rely on manual "dry run" verification.
    - **Action**: Keep as manual/dry-run verification due to TUI complexity, but ensure `AuditOrchestrator` is rock solid.

## Conclusion

The core logic engines (`Void`, `Consistency`, `Rationale`) and utilities (`Batch`, `Cursor`) are well-tested. The primary instability is in the high-level integration test for the Orchestrator, which is expected during this refactoring phase.
