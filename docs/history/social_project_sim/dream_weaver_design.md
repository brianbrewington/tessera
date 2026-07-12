# Dream Weaver: Context Visualization & Dynamics

## 1. Overview
The **Dream Weaver** is the dedicated Visualization and Interaction Service for the Context Graph. While the *Resonator* (backend) handles internal dynamics, the *Dream Weaver* (frontend/service) enables the "Driver" (User or AI) to perceive the subconscious graph and guide its evolution.

## 2. Architecture: Visualizer Service (TypeScript Prototype)
Different from the high-performance Rust Resonator (planned for v2), the initial Dream Weaver will be a Node.js Service working alongside the Context Manager.

### 2.1 Components
-   **DreamWeaverService.ts**:
    -   Connects to `ContextGraphManager`.
    -   Exposes HTTP/WebSocket endpoints for the Frontend.
    -   Methods: `getGraphSnapshot()`, `triggerDream(nodeId)`, `injectPrompt(nodeId)`.
-   **Frontend (`public/dream_weaver.html`)**:
    -   **D3.js Force Directed Graph**.
    -   **Control Panel**: "Pulse" Button, Temperature Slider.
    -   **Inspection Panel**: View Node Content, Relations.

### 2.2 Data Flow
1.  **Polling/Push**: Frontend requests graph snapshot (nodes + edges with weights) every 2s (or via WS).
2.  **Rendering**: D3 renders Nodes (Circles) and Edges (Lines).
    -   Size = `strength` (Significance).
    -   Color = `type` (Memory, Person, Project, Concept).
    -   Line Thickness = `weight` (Resonance).
3.  **Dream Driving**:
    -   User clicks a Node -> "Focus".
    -   User clicks "Dream" -> Frontend sends `POST /dream { nodeId }`.
    -   Backend triggers LLM "Dream" cycle (Association).
    -   New Node created -> Graph updates.

## 3. "Dream Driving" Protocol
The core interaction loop for the user:
1.  **Observe**: Watch the graph settle. Identify "Islands" (isolated clusters).
2.  **Drive**: Click an isolated node.
3.  **Pulse**: Send a "Pulse" (Activation Energy) to see what lights up (Visual Feedback).
4.  **Bridge**: Manually or semi-automatically link two disparate nodes ("Connect this Project to that Person").

## 4. Edge Weight Dynamics (Resonance)
The Visualizer must represent the 5 connection axes:
-   **Semantic**: Standard vector similarity (Grey edges).
-   **Hebbian**: Co-occurrence history (Thickening edges).
-   **Temporal**: Time sequence (Arrows).
-   **Causal**: "Because of..." (Red edges).
-   **Affective**: Emotional state (Color tint).

## 5. The "Dream Weaver" Algorithm (REM Mechanism)
Implemented in `DreamWeaverService.ts`:
1.  **Selection**: Pick `SourceNode` (User selection or Random).
2.  **Resonance Search**: Find top 3 nodes connected via `RESONATES_WITH` > 0.5.
3.  **Synthesis**:
    -   Prompt LLM: "Synthesize a new insight connecting '{Source}' with '{Target}'. What is the hidden potential?"
4.  **Crystallization**:
    -   Create `INSIGHT` Node (Type 5).
    -   Link to Source and Target.
    -   Broadcast update to Visualizer.

## 6. Implementation Roadmap
1.  **Backend**: `DreamWeaverService` class (Express Router).
2.  **Frontend**: `dream_weaver.html` with D3.js boilerplate.
3.  **Integration**: Mount on Port `8084` or `/dream`.
4.  **Verification**: Click-to-Dream test.

## 7. Future: Rust Resonator
(See "Context Map Resonator" Legacy Design for high-performance physics simulation).
