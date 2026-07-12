# Code Review: Phase 2.1 - Frontend Observability & Interaction Recovery

**Date**: 2026-01-09
**Reviewer**: Principal Software Architect (AI Persona)
**Focus**: Frontend Architecture, React Patterns, Maintainability
**Version**: v0.2.0 (Phase 2 WIP)
**Repository**: `social_sim/frontend_dashboard`

---

## 1. Executive Summary
The codebase has made significant strides in **Phase 2.1**, particularly in recovering the "Mindmap" visualization and establishing a pattern for specific, human-in-the-loop observability. The shift to **Canvas Rendering** for the graph was the correct decision for performance and legibility.

However, the architecture still exhibits "Prototype Fragility." The decision to lift state to `App.tsx` (the "God Component" anti-pattern) to solve the Console logging requirement is a temporary fix that will not scale. While acceptable for this WIP phase, **Phase 2.2** must prioritize moving this shared state into a proper Context or generic Store (e.g., Zustand/Redux) before we add more complexity like Qdrant vectors.

**Risk Assessment**: **Medium**. stable for now, but technical debt is accumulating in `App.tsx`.

## 2. Critical Issues (Blockers)
*None found at this stage. The application builds and runs, and critical interaction paths (Click -> Highlight -> Console Log) are functional.*

## 3. Detailed Findings

### A. Architecture & Patterns
*   **Location**: `src/App.tsx`
*   **Issue**: **Prop Drilling** of `onLog` and `logs`. You are passing `onLog` to every component. As you add more dashboards, `App.tsx` will become cluttered with callback management.
*   **Recommendation**: Introduce a `LoggerContext`.
    ```typescript
    // Future Refactor
    const { addLog } = useLogger();
    ```

### B. Code Quality & Readability
*   **Location**: `src/components/GraphVisualizer.tsx:249` (`nodeCanvasObject`)
*   **Issue**: The custom renderer is growing large (~40 lines) and mixes logic (sizing, highlighting) with drawing commands.
*   **Fix**: Extract `drawNode` and `drawLabel` into pure helper functions outside the component or in a `renderUtils.ts` file. This will make the main component logic much easier to scan.

### C. Type Safety
*   **Location**: `src/types.ts`
*   **Issue**: `LogEntry['data']` is `any`.
*   **Fix**: Define a Union Type for known data payloads (e.g., `TranscriptPayload | SearchResultPayload`) to prevent runtime errors when rendering generic JSON dumps in the console.

### D. UX & Interaction
*   **Location**: `src/components/InteractionFeed.tsx`
*   **Observation**: The "Tabs" UI is a great addition for density.
*   **Idea**: The "Live Logs" scroll very fast in a real system. Consider adding a "Pause on Hover" feature or a "Stick to Bottom" toggle so users can actually read log entries during high-activity bursts.

## 4. Refactoring Plan

1.  **Immediate (Phase 2.2 Prep)**:
    *   Extract `drawNode`/`drawLabel` from `GraphVisualizer`.
    *   Define schemas for `LogEntry` payloads.

2.  **Short-term (Phase 2.3)**:
    *   Migrate `logs` and `onLog` to a React Context (`LogContext`).
    *   Refactor `App.tsx` to be a layout container, not a state manager.

## 5. Verdict
**Proceed with Caution**.

The current implementation is sufficient to support the **Qdrant Integration (Phase 2.2)**. Do not refactor `App.tsx` now; wait until the Qdrant service patterns are established, as they may dictate the shape of our global state.

**Next Step**: Implement Phase 2.2 (Qdrant & Vector Search).
