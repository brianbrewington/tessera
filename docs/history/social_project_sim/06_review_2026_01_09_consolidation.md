# Code Review: Context Service & Graph Quality Consolidation

**Date**: 2026-01-09
**Reviewer**: Antigravity (Principal Software Architect)
**Focus**: Stale Tests, Architecture Drift, Graph Quality
**Version**: Phase 3.8

---

## 1. Executive Summary

The **Context Service** has matured into a robust, microservices-ready component. The transition to `UnifiedGraphManager` as the single source of truth for graph mutation is successful, providing a clean "Check-Before-Create" pipeline that solves the duplicate node issues. The new `DreamWeaverService` is integrated correctly, though its return types needed a hotfix.

**Biggest Risk**: **Test Hygiene**. While the backend core (`UnifiedGraphManager`, `ResonanceEngine`) is well-tested, the UI layer (`GraphVisualizer`) has skipped tests, and some integration tests (`embedding_verification`) are prone to timeouts. This creates a "blind spot" for frontend regressions.

## 2. Critical Issues (Blockers)

*None identified.* The system boots, ingests data, and serves the dashboard correctly.

## 3. Detailed Findings

### A. Architecture & Patterns
*   **[Facade Pattern]** `ContextGraphManager.ts` correctly acts as a facade, delegating complex logic to `UnifiedGraphManager` and `IngestionPipeline`. This preserves API compatibility while allowing the core engine to evolve. **Keep as is.**
*   **[Type Safety]** The mismatch in `DreamWeaverService.synthesizeDream` (returning `{ dream, impact }` instead of `ContextNode`) was a critical regression but is now **FIXED**.
*   **[Separation of Concerns]** The frontend correctly treats the backend as an API. `GraphVisualizer` handles its own rendering state (`val` mapping) without polluting the backend types.

### B. Test Inventory (The "Stale" List)
The following tests are explicitly skipped or failing and represent technical debt:

| Test File | Status | Issue | Recommendation |
| :--- | :--- | :--- | :--- |
| `frontend_dashboard/tests/GraphVisualizer.test.tsx` | **SKIPPED** | Tests (`renders without crashing`) are skipped. | **Un-skip and Fix**. Vital for UI stability. |
| `context_service/test/embedding_verification.test.ts` | **FLAKY** | Often times out on local LLM. | Increase timeout or mock LLM response. |
| `context_service/test/persistence_integration.test.ts` | **FLAKY** | Race conditions in DB setup. | Ensure `db:reset` runs before this suite. |

### C. Graph Quality (Pruning Strategy)
To address the "context explosion" from simple inputs, we will implement the **Pruning Strategy** directly in the `EXTRACTION_PROMPTS` (See Section 4).

## 4. Refactoring Plan

### Immediate (Phase 3.8 - Pruning)
Update `context_service/src/prompts/extraction.ts` with the following rules:
1.  **Hard Limit**: `Extract a maximum of 3-5 high-value Concepts`.
2.  **Filter**: `Ignore generic nouns (e.g. 'Work', 'Future'). Only extract specific methodologies or unique entities.`
3.  **Conflict Prevention**: `CRITICAL: Do not create Concept nodes if a Person or Project node already exists with that name.`

### Short-term (Test Polish)
1.  Remove `.skip` from `GraphVisualizer.test.tsx` and fix the `ResizeObserver` mock if necessary.
2.  Standardize `start_services.sh` to ensure it always waits for the DB to be ready before starting dependent services.

### Long-term
1.  **Deprecation Check**: Monitor `ContextGraphManager`. If no direct calls remain (all going through `UnifiedGraphManager` or `IngestionPipeline`), consider removing the facade in Phase 4.

## 5. Verdict

**Proceed to Phase 3.8 (Pruning)**. The codebase is stable enough to apply the prompt constraints. Test repair should follow immediately after.
