# Context Graph System Design

## 1. Overview
We will implement a **Context Graph System** where each simulation participant maintains a personal "Mind Map" of ideas, memories, and experiences. Unlike flat vector stores, this graph preserves structural relationships between concepts while enabling semantic retrieval.

The core principle is **Graph-RAG (Retrieval-Augmented Generation)**:
1.  **Ingest**: New ideas are embedded and linked to semantically similar existing nodes.
2.  **Retrieve**: Conversation flow triggers semantic search (finding entry nodes) followed by graph traversal (gathering connected context).

This system will reuse the `MindMapper` visualization frontend to allow humans to explore an agent's mind.

---

## 2. Data Structure

We will adapt the existing `MindMapModel` to support semantic features.

### 2.1 Node Schema (Protocol Buffer)
Extensions to the visual bubble:
- `embedding` (repeated float): The vector representation of the text.
- `timestamp` (int64): When the memory was formed.
- `strength` (float): Reinforcement level (0.0 - 1.0). Decays over time, boosted by recall.
- `type`: "CONCEPT", "MEMORY", "GOAL", "PERSON".

### 2.2 Edge Schema
- `weight`: Similarity score or explicit logical connection strength.
- `type`: "ASSOCIATED", "CAUSED_BY", "DISLIKES", etc.

---

## 3. Architecture Options

We present three designs ranging from monolithic to distributed.

### Option 1: In-Memory "Brain" (Recommended MVP)
Each `Participant` instance in the `ConversationService` loads its own graph into memory from a JSON/GEXF file at startup.
- **Pros**: Zero latency, simplest implementation, strictly local (easy to debug).
- **Cons**: High memory usage if graphs grow large. Persistence requires writing full JSON dumps.
- **Components**:
    - `ContextManager` class inside `conversation_service`.
    - Local `ollama` for on-the-fly embedding.

### Option 2: Centralized Context Service (Refined)
A dedicated `ContextService` backed by **PostgreSQL + pgvector**.
- **Why**: Single source of truth, ACID compliance, easy to query by Agent ID, robust vector search.
- **Schema**:
    - `nodes`: `id` (UUID), `agent_id`, `content`, `type`, `embedding` (vector(768)), `strength` (float), `created_at`.
    - `edges`: `source_id`, `target_id`, `type`, `weight`.

### Option 3: Agent-Centric "Sidecar" (MCP)
Each Participant is treated as a distinct process with its own "Context Sidecar" (Model Context Protocol).

### Option 3: Agent-Centric "Sidecar" (MCP)
Each Participant is treated as a distinct process with its own "Context Sidecar" (Model Context Protocol).
- **Pros**: True agent autonomy. "Minds" can run on different machines.
- **Cons**: Highest infrastructural complexity.
- **Components**:
    - `mcp-server-context` for each agent.

**Recommendation**: We will implement **Option 2 (Centralized Context Service)** but designed with an API that *looks* like Option 3 (RPC calls), allowing future migration. This fits the "Specialized MCP" requirement while keeping the system manageable.

---

## 4. Graph-RAG Strategy

### 4.1 Ingestion (Formation & Maintenance)
When a conversation turn is completed and `ParticipantOutcome` is generated:
1.  **Embed**: Generate embedding for the new text using `embeddinggemma:latest`.
2.  **Deduplicate**: Search for existing nodes with Cosine Similarity > **0.90**.
    - **If Match Found**: Do NOT create new node. "Reinforce" the existing node (set `strength = 1.0`, update `timestamp`, potentially merge content).
    - **If No Match**: Create new node.
3.  **Link**: Find top-k (k=3-5) conceptual neighbors (Similarity > 0.5). Create weighted edges.
3.  **Link**: Find top-k (k=3-5) conceptual neighbors (Similarity > 0.5). Create weighted edges.
4.  **Decay**: Run a rigid decay process: `NewStrength = OldStrength * 0.99`. Prune nodes where `strength < 0.1` (Forgetting).

### 4.2 Hebbian Dynamics (Reinforcement & Wiring)
To mimic biological memory, we implement Hebbian learning ("Cells that fire together, wire together").

When a set of nodes is "Activated" (e.g., returned by `AskContext` or part of a Dream):
1.  **Reinforcement**: Activated nodes receive an additive strength boost (`Strength += 0.1`).
2.  **Wiring**: Edges are created between *all* pairs of currently activated nodes if they don't exist. Existing edges between them are strengthened.
3.  **Global Decay**: All *inactive* nodes suffer a multiplicative decay (`Strength *= 0.99`) to simulate forgetting. This ensures that unused memories fade while active/related ones persist.

### 4.3 Retrieval (Active Reasoning & Tool Use)
Instead of just passive injection, we treat Memory as a **Tool**.

1.  **Passive Context**: Always inject the top-3 most relevant short-term memories into the System Prompt.
2.  **Active Tool Use**: The LLM is provided with a tool definition: `search_memory(query: string)`.
    - If the Agent feels it needs more info ("I vaguely recall..."), it emits this tool call.
    - The Orchestrator halts, queries `ContextService`, inserts the results ("Search Results: ..."), and prompts the Agent to continue.

### 4.3 Portability & Visualization
- **LOD Optimization**: `GetFullGraph` accepts `min_strength` and `limit` to prevent browser crashes.
- **Export**: `ExportContext` RPC returns a full JSON payload compatible with `MindMapper`'s file format, allowing "Brain Dumps" to be shared or viewed offline.


---

## 5. Visualization Service

We will create a lightweight HTTP service `ContextVisualizer` (or integrate into `ContextService`'s HTTP port).

### Endpoints
- `GET /visualizer`: Serves the `MindMapper` React App.
- `GET /api/context/:participantId/graph`: Returns the JSON graph (Nodes/Edges) compatible with `MindMapModel`.

### Frontend Adaptation
The `MindMapper` app will be modified to accept a `sourceUrl` query param or have a "Load from Agent" dropdown, fetching the JSON from the API instead of a local file.

---

## 6. Interface Definitions

### `context.v1.proto`

```protobuf
syntax = "proto3";
package context.v1;

service ContextManager {
  // Save a new memory/idea
  rpc AddContext (AddContextRequest) returns (AddContextResponse);
  
  // Retrieve relevant graph for a query
  rpc QueryContext (QueryContextRequest) returns (QueryContextResponse);
  
  // Get the full graph (with filters)
  rpc GetFullGraph (GetGraphRequest) returns (GraphData);
  
  // Export for portability
  rpc ExportContext (ExportRequest) returns (ExportResponse);
}

message ExportRequest {
  string participant_id = 1;
  string format = 2; // "JSON", "GEXF"
  string auth_token = 3; // Stub for future authentication
}

message AddContextRequest {
  string participant_id = 1;
  string text = 2;
  string type = 3; // "MEMORY", "GOAL", etc.
  string auth_token = 4; // Stub for future authentication
}

message QueryContextRequest {
  string participant_id = 1;
  string query_text = 2; // The current conversation topic
  int32 max_nodes = 3;
  string auth_token = 4; // Stub for future authentication
}

message QueryContextResponse {
  repeated ContextNode nodes = 1;
  string summary = 2; // Synthesized natural language summary
}

message GraphData {
  repeated ContextNode nodes = 1;
  repeated ContextEdge edges = 2;
}

message ContextNode {
  string id = 1;
  string text = 2;
  NodeType type = 3;
  repeated float embedding = 4;
  float strength = 5;
  int64 timestamp = 6;
  map<string, string> metadata = 7; // Flexible props (image_url, source_id)
}

enum NodeType {
  CONCEPT = 0;
  MEMORY = 1; // Episodic
  GOAL = 2;
  PERSON = 3;
  PROJECT = 4;
}

message ContextEdge {
  string from_id = 1;
  string to_id = 2;
  float weight = 3;
  string type = 4; // "RELATED_TO"
}
```

---

## 7. Test Plan

| Test Case | Type | Description |
| :--- | :--- | :--- |
| **Ingestion** | Unit | Add a node. Verify it links to semantically similar existing nodes (Mock Embedding). |
| **Retrieval** | Unit | Query "Pizza" in a graph about food. Verify "Pepperoni" and "Cheese" nodes are returned. |
| **Monologue** | Integration | Run a monologue. Verify the agent "remembers" previous thoughts by querying its own graph. |
| **Visualization** | E2E | Load the standalone visualizer. Verify it renders the Participant's graph structure correctly. |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
| :--- | :--- |
| **Embedding Latency** | `embeddinggemma` is small but non-zero cost. Cache embeddings of static text. Run embedding async for "writes" (memory formation). |
| **Context Explosion** | Graphs can get noisy. Implement "Forgetting" (pruning weak nodes) and limits on retrieval size (Token Budget). |
| **Hallucination** | Retrieving irrelevant nodes. Use strict similarity thresholds. |

## 9. Future Work

- **Distributed Agents**: Move `ContextService` to a real MCP server on a different machine.
- **Graph Editing**: Allow human operators to use the Visualization UI to *edit* the agent's memory (add/delete nodes) on the fly.

## 10. Execution Plan (Incremental Rollout)

We will build confidence by starting small (Single Agent) and expanding.

### Phase 1: The "Starter App" (Single Agent Bootstrap)
**Goal**: Interactive tool to build and verify a Context Graph for one entity.
- **Inputs**: Text files (Bio, Project Docs), URL.
- **Mechanism**:
    1.  **Ingest**: Read file -> Split chunks -> Embed -> `AddContext` RPC.
    2.  **Infer Primary Node**: Auto-create the central "Self" node (e.g., "Mateo Solis").
    3.  **Visual Verification**: Use `MindMapper` to see the graph grow in real-time.
- **Deliverable**: `scripts/bootstrap_agent.ts` + `MindMapper` connected to `localhost:8083`.

### Phase 2: Interactive Capabilities (Web REPL & Visualization)
**Goal**: Move from CLI to a rich web interface for interaction and inspection.

#### Phase 2.1: Web-Hosted REPL
- **Mechanism**:
    - Expose a simple HTTP endpoint `POST /eval` on the `ContextService`.
    - Serve a static HTML/JS page (via `express` in `server.ts`) that acts as a Console.
    - Allows typing commands `!query`, `!add` from a browser instead of terminal.
    - **Why**: Prerequisite for embedding visualization next to the logs.

#### Phase 2.2: Q&A Node (Active Context Fetching)
- **Goal**: ask the node a question, have it fetch context, and form an answer.
- **Mechanism**:
    - Implement `AskContext(question)` RPC.
    - Logic:
        1.  **Embed** question.
        2.  **Retrieve** top-k context nodes.
        3.  **Synthesize** answer using LLM (Ollama) + Context.
    - **UI**: Add "Ask" tab to the Web REPL.

#### Phase 2.3: Interactive Visualization
- **Goal**: See the mind map evolve in real-time.
- **Mechanism**:
    - Integrate `MindMapper` frontend into the Web REPL.
    - Poll `GetFullGraph` (or stream updates) to render the force-directed graph.
    - **Interaction**: Click a node in the graph -> Trigger `AskContext` focused on that node.

#### Phase 2.4: Context Map Resonator
- **Goal**: Let the map self-resonate to identify "Primary Nodes".
- **Design**: See Section 11 below.

### Phase 3: Orchestrator Integration
**Goal**: Connect the "Brain" to the "Mouth".
- **Mechanism**:
    1.  Update `ConversationService` to initialize a `ContextManager` client.
    2.  Implement the `search_memory` tool in the LLM System Prompt.
    3.  Run "Monologue Test" and observe (via Logs/Visualizer) the agent querying its own memory.

## 11. Context Map Resonator
**Note**: The detailed design for the Self-Resonating Map and "Dreaming" capability has been moved to a dedicated document: [Context Map Resonator Design](context_map_resonator.md).

**Key Concepts**:
- **Multi-Axial Edges**: Semantic, Interaction, Temporal, etc.
- **Dream Process**: High-temp self-conversations to spawn new nodes.
- **Physical Metaphor**: Energy flow with attenuation.
