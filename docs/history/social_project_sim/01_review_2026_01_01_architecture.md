# Code Review: Architecture Refactoring

**Date**: 2026-01-01
**Reviewer**: Antigravity (AI Architect)
**Focus**: Refactoring `App.tsx` and architectural separation of concerns.
**Version**: 1.0.0

---

## 1. Executive Summary

The application is currently functional but suffers from a significant "God Component" anti-pattern in `App.tsx`. This file currently handles:
1.  **Global State Management** (via a massive `useState` object).
2.  **Business Logic / Simulation Engine** (the `runConversationStep` loop).
3.  **Data Processing** (`enrichProfiles` and file parsing orchestration).
4.  **UI Layout & Rendering** (Header, Sidebar, Main Graph, Modals).

This tight coupling makes the application difficult to test, hard to extend (e.g., adding new interaction types), and prone to performance issues (unnecessary re-renders).

## 2. Critical Issues

### A. Violation of Single Responsibility Principle (SRP)
`App.tsx` is responsible for *everything*.
*   **The Problem:** The simulation logic (finding partners, checking synergy, executing interactions) is intertwined with React render cycles.
*   **The Evidence:** Functions like `enrichProfiles`, `executeInteraction`, and `runConversationStep` occupy nearly 200 lines of mixed logic (API calls, state updates, business rules) directly inside the component body.

### B. Inefficient State Management
*   **The Problem:** The `SimulationState` is a single, deeply nested object managed by `useState`.
*   **The Evidence:**
    ```typescript
    // App.tsx
    setSimulation(prev => ({ ...prev, currentActivity: '...' }));
    ```
    Every time a minor property changes (e.g., `conversationCount` increments), the **entire** `App` component and all its children re-render. While React is fast, this prevents optimization (like `React.memo` on the Graph) because the props passed down are often new object references created during the render of `App`.

### C. Logic Leaks in `executeInteraction`
*   **The Problem:** The logic to resolve target IDs (finding if a text string refers to a Person, Project, or Topic) is hardcoded inside a callback within the UI component.
*   **The Evidence:** The `resolveTargetId` function and the complex mapping of `CoachDecision` back into the state graph should be domain logic, encapsulated in a model or service, not a UI event handler.

### D. UI Component Bloat
*   **The Problem:** The JSX return statement is massive and contains complex conditional rendering logic.
*   **The Evidence:** The Sidebar is manually constructed with `div`s and `CollapsibleSection`s inline. The control panel (buttons for phases) contains logic about *when* buttons should appear, mixing presentation with state logic.

## 3. Performance Implications

1.  **Re-render Storms:** Since the `NetworkGraph` receives the raw `participants` array from the `simulation` state, and that state reference changes on every "tick" of the simulation, the heavy D3 force simulation may be receiving signals to update too frequently, or at least triggering React diffing unnecessarily.
2.  **Main Thread Blocking:** The `enrichProfiles` function performs a loop over files and awaits AI calls. While `await` yields, the heavy processing of the results happens on the main thread inside the component, potentially causing UI stutter during imports.

## 4. Prioritized Action Plan

To correct these issues without rewriting the entire logic from scratch, I recommend the following refactoring phases:

### Phase 1: Extract the Simulation Engine (Highest Priority)
Move the "brain" of the app out of the View.

1.  **Create `hooks/useSimulation.ts`:**
    *   Move `SimulationState` and the `useState` (or preferably `useReducer`) logic here.
    *   Expose methods: `loadData`, `startSimulation`, `pauseSimulation`, `runStep`.
    *   This hook should return `{ state, actions }`.

2.  **Move Business Logic:**
    *   Move `enrichProfiles` to a dedicated `services/enrichmentService.ts`.
    *   Move `runConversationStep` logic into a `services/simulationEngine.ts` or keep it within the hook, but separated from UI concerns.
    *   Move `resolveTargetId` and graph update logic into `services/graphUpdater.ts` or a method on the `Entity` models.

### Phase 2: Componentization (Medium Priority)
Break the UI into semantic blocks.

1.  **Create `components/Sidebar/ControlPanel.tsx`:** Encapsulate the file upload, progress bar, and phase control buttons.
2.  **Create `components/Sidebar/EntityList.tsx`:** Encapsulate the collapsible lists for People, Projects, and Topics.
3.  **Create `components/Layout/Header.tsx`:** Move the top bar logic there.

### Phase 3: State Optimization (Low Priority / Polish)
Switch to a reducer pattern to handle complex state transitions more predictably.

1.  **Define Action Types:** `START_INIT`, `INTERACTION_COMPLETE`, `SYNERGY_CHECK_COMPLETE`.
2.  **Implement Reducer:** This makes the state transitions testable without running the React app.

## 5. Conclusion

The codebase contains high-quality constituent parts (the `Entity` classes and `geminiService` are well-written). However, the glue code in `App.tsx` has become a bottleneck. Refactoring to a **Hook-based architecture** for logic and **Atomic Components** for UI will solve the "God Component" problem.
