# Comprehensive Simulation Roadmap & Review

## 1. Social Evolution Sim: Context & Planning

### 1.1 Context Bootstrapping
- [x] **Current State**: Agents initialize with static profiles.
- [x] **Goal**: Leverage `ContextService` to "hydrate" agents.
- **Implementation Plan**:
    1.  **On Sim Start**: `POST /api/context/:id/ingest` with the agent's full profile text.
    2.  **Result**: Instant graph of ~50-100 nodes defining their identity.
    3.  **Integration**: `useSimulation` hook calls `ContextService` (gRPC/HTTP) during agent spawn.

### 1.2 The "Global Namespace" (Collective Unconscious)
- **Problem**: "AI (Field of Study)" created by Agent A is ID `123`, but for Agent B is ID `456`. No shared reality.
- **Design Proposal**:
    - **Shared Concept Graph**: A persistent, singleton graph `GLOBAL_CONCEPTS`.
    - **Ingest Logic**: Extract Entity -> Check Global -> Link Shadow Node.

```mermaid
graph TD
    subgraph Agent A Context
        NodeA[Local: "AI"] -.->|Reference| GlobalNode
    end
    
    subgraph Global Namespace
        GlobalNode[Global ID: 999<br/>"AI (Field of Study)"]
    end
    
    subgraph Agent B Context
        NodeB[Local: "AI"] -.->|Reference| GlobalNode
    end
    
    style GlobalNode fill:#f9f,stroke:#333,stroke-width:2px
```

- **Benefit**: Resonance can track "Trends" (e.g., 50 agents thinking about `GlobalID:999`).

### 1.3 Plan Batch Implementation
- [ ] **Status**: Stubbed.
- **Design**:
    - **UI**: Allow "Drafting" of multiple plans (Movement, Conversation, Interaction) in a queue.
    - **Execution**: `ProcessBatch` button.
    - **Backend**: `InteractionQueueService` runs sequential/parallel scheduler.
    - **UX**: "Planning Phase" vs "Action Phase" (Turn-based strategy feel).

## 2. Conversation Quality

### 2.1 Intentions & Closure
- **Issue**: Conversations drift and fade without clear output.
- **Fix**: Updated System Prompt to end with strict XML Intentions.
    - `<INTENTION type="memory">Remember X</INTENTION>`
    - `<INTENTION type="action">Go to Y</INTENTION>`
    - `<INTENTION type="social">Talk to Z</INTENTION>`

### 2.2 System Feedback Loop
- **Feature**: Agents providing feedback to Developers.
- **Implementation**:
    - New `MessageRole`: `SYSTEM_FEEDBACK`.
    - Agents can output: `[FEEDBACK]: "I feel constrained by..."`
    - These specific logs are aggregated into a daily "Developer Report".

## 3. Bug Hunting

| Symptom | Root Cause | Fix Strategy |
| :--- | :--- | :--- |
| **Stream Duplication** | Backend sending overlapping windows or naive frontend deduplication. | **Backend**: Send STRICT `delta`. **Frontend**: Use `token_id` or `sequence_index`. |
| **WebSocket Failures** | Vite HMR disconnection due to CPU overload from tests. | Restart dev server (Low Priority). |

## 4. Context Resonator 2.0 (Design Refinement)

### 4.1 Algorithms
- **Community Detection**: Use **Louvain Method** to identify clusters (topics).
- **Centrality**: Use **PageRank** to determine "Significance" (Node Size).
- **Spreading Activation**: Standard "Gas" model (Energy injection & decay).

### 4.2 Architecture: The "Rust" Service
- **Service Name**: `context-resonator-svc`
- **Language**: Rust 🦀
- **Interface**:
    - Consumes: `ContextGraph` (gRPC).
    - Output: `ResonanceEvents` (New Links, Strength Updates).
- **Justification**: O(N^2) comparisons are expensive. A dedicated compiled service enables constant background annealing.

## 5. Review Summary
- **Working**:
    - ✅ **Context Service V1**: Solid foundation. Visuals, basic resonance, and persistence are great.
    - ✅ **UI**: Graph interaction is intuitive.
- **Needs Work**:
    - 🚧 **Integration**: The "Brain" is isolated. It isn't driving behavior yet.
    - 🚧 **Scale**: In-memory graphs (Node.js) limited at >5k nodes.

## 6. Distributed Context & Dreaming (V3 Preview)

*Ref: [Gemini Transcript: Distributed Context & Dreaming](file:///Users/brew/social_project_sim/design/Gemini%20transcript%20about%20context%20resonance%20dreaming%20and%20more.md)*

### 6.1 The "Dream" Topology
Moving to a heterogeneous Slurm cluster to support "Dreaming" (Offline Processing).

- **The Hub (Mac Studio)**: Runs `Context Service` + `Llama 4 (Wisdom Head)`.
- **The Edge (Jetson Nanos)**: Runs `Dream Weaver` (Llama 3.2 1B).
- **The Scribes (Raspberry Pis)**: Log monitors.

### 6.2 The Dreaming Cycle
1.  **Request**: Nano requests a "Dream Seed" (Agent ID) from Hub.
2.  **REM State**: Nano uses local LLM to find associations between disparate nodes.
3.  **Consolidation**: Nano commits new edges ("Insights") back to the Global Graph.
