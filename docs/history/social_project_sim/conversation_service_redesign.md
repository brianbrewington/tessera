# Design Document: Conversation Service Extraction

## 1. Executive Summary
This document outlines the architectural design for extracting the **Conversation Manager** into a distinct, isolated microservice. This service orchestrates interactions between entities (Personas) and a system-level **Moderator**, returning transcripts and structured actions.

## 2. System Architecture

### Boundaries
*   **Simulation Service (Client)**: Manages "World State" (Entities, Relationships, Queue).
*   **Conversation Service (Server)**: Stateless orchestrator. Knows *how* to talk, not *who* exists globally.

### Component Diagram
```mermaid
graph TD
    Client[Simulation Engine] -- gRPC Request --> API[Conversation Service API]
    API --> Orchestrator[Turn Orchestrator]
    Orchestrator --> Persona[Persona Engine]
    Orchestrator --> Moderator[Moderator Engine]
    
    subgraph Conversation Service
        Orchestrator
        Persona
        Moderator
        LLM[LLM Adapter (Ollama/Mock)]
    end
```

## 3. Core Concepts & Behaviors

### 3.1. The Moderator (System Participant)
The **Moderator** replaces the concept of a "Coach".
*   **Presence**: The Moderator is an active participant in *every* conversation.
*   **Role**: Helper/Facilitator. Seeks to help participants on individual journeys.
*   **Behavior**: Can speak during the conversation (usually listens).
*   **Conclusion**: At the end, the Moderator provides a "Closing Statement" containing:
    *   Observations of all parties.
    *   Questions back to participants.
    *   Suggestions for next conversations.
    *   New topics/People/Projects mentioned.

### 3.2. Participant Actions (Formal Vocabulary)
Participants do not just "talk"; they output structured intent. After the generic conversation loop, the service asks each participant to generate **Actions** based on the discussion.
*   **Format**: JSON.
*   **Decoding**: Decoded safely into Protobuf `Action` types.

**Proposed Vocabulary (ActionType)**:
*   `TALK_TO`: Schedule a conversation with a specific entity.
*   `THINK_ABOUT`: Schedule a self-reflection (monologue) on a topic.
*   `CREATE`: Spawn a new Entity (Project or Topic).
*   `FIND_SOURCES`: Perform research / look for resources.
*   `FOLLOW`: Subscribe to another entity's updates (if PubSub implemented).
*   `JOIN`: Request to join a Project.
*   `REFER`: Suggest two *other* entities should meet.
*   `UPDATE_GOAL`: Change one's own internal directive/profile.

### 3.3. LLM Interface (Infrastructure)
The service must be model-agnostic but patterned after the current Ollama implementation. **Gemini integration is dropped.**

**Interface Definition**:
```typescript
interface LLMProvider {
  name: string;
  // Core generation
  generate(prompt: string, options?: GenerationOptions): Promise<string>;
  // Verification/Health check
  ping(): Promise<boolean>;
}

interface GenerationOptions {
  temperature?: number;
  stop?: string[];
  response_format?: 'json' | 'text'; // Critical for Action extraction
}

interface LLMConfig {
  provider: 'ollama' | 'mock';
  baseUrl: string; // e.g. "http://localhost:11434"
  modelName: string; // e.g. "llama3"
  contextWindow: number; // e.g. 4096
}
```

## 4. Interface Definition (Protocol Buffers)

```protobuf
syntax = "proto3";

package conversation.v1;

service ConversationManager {
  rpc SimulateConversation (ConversationRequest) returns (ConversationResponse);
}

// --- Data Models ---

message Participant {
  string id = 1;
  string name = 2;
  string type = 3; 
  // Persistent memory of the entity
  string current_context = 4;
}

message ConversationRequest {
  string interaction_id = 1;
  repeated Participant participants = 2;
  string topic = 3;
  
  // Configuration
  int32 min_turns = 4;
  int32 max_turns = 5;
  
  // Moderator Context: The service tracks the Moderator's memory?
  // OPEN QUESTION: Does the Moderator have persistent memory across ALL interactions?
  // If so, who stores it? The Client? Or the Service? 
  // Assumption: Client stores generic "Moderator Node", passes it here.
  string moderator_context = 6; 
}

message ConversationResponse {
  string interaction_id = 1;
  repeated Turn transcript = 2;
  
  // Analysis/Actions per participant
  map<string, ParticipantOutcome> outcomes = 3;
  
  // The Moderator's specific conclusion
  ModeratorConclusion moderator_conclusion = 4;
}

message Turn {
  string speaker_id = 1; // "MODERATOR" if implied system ID
  string speaker_name = 2;
  string content = 3;
  int64 timestamp = 4;
}

message ParticipantOutcome {
  string updated_context = 1; 
  repeated Action proposed_actions = 2;
}

message ModeratorConclusion {
  string updated_moderator_context = 1;
  string observations = 2;
  repeated string questions_for_participants = 3;
  repeated string suggested_topics = 4;
  repeated string suggested_entities = 5; // Mentions
}

message Action {
  ActionType type = 1;
  // Payload is flexible map, e.g. {"target_id": "123", "reason": "..."}
  map<string, string> parameters = 2;
}

enum ActionType {
  UNKNOWN = 0;
  TALK_TO = 1;
  THINK_ABOUT = 2;
  CREATE = 3;
  FIND_SOURCES = 4;
  FOLLOW = 5;
  JOIN = 6;
  REFER = 7;
  UPDATE_GOAL = 8;
}
```

## 5. Components Breakdown

### 5.1. Turn Orchestrator
*   Manages the loop.
*   **Step**: Decides if Moderator should intervene.
    *   *Constraint*: Moderator speaks rarely (e.g., < 10% chance, or if deadlock).
*   **Step**: Selects next Participant.

### 5.2. Action Decoder
*   Runs after the conversation closes.
*   Prompt: *"Based on the conversation, output a JSON list of actions you want to take using vocabulary: [TALK_TO, ...]"*
*   Parses JSON, Maps to `Action` proto.
*   *Corner Case*: Invalid JSON. Fallback to empty list or Retry (1x).

### 5.3. Mock LLM Service
*   For testing/CI.
*   Accepts prompt.
*   Returns deterministic responses based on regex matching logic (e.g. if prompt contains "Action", return valid JSON).

## 6. Open Questions & Discussion points

1.  **Moderator Persistence**: Who owns the Moderator's memory? 
    *   *Current Design*: Client owns it (passed in request). This allows multiple "Timelines" or "Forks".
    *   *Risk*: Context size explosion if Moderator remembers *everything*. Need pruning strategy.
2.  **Action Payload Schema**: `map<string, string>` is loose. 
    *   *Discussion*: Should we define strict messages for `TalkToPayload`, `CreatePayload`?
    *   *Trade-off*: Proto `oneof` is type-safe but rigid. Map is flexible for LLM hallucinations.
3.  **Local vs Remote LLM Latency**:
    *   If running against localhost Ollama, latency is high. Service needs `Streaming` response support (defined in Proto) to keep UI alive.
4.  **Moderator Interruption**:
    *   When does the Moderator interrupt? If 2 participants are fighting? If silence?
    *   *Proposal*: The Moderator has a "Interrupt Function" called every turn (cheap LLM check) or heuristic (keyword detection).

## 7. Implementation Roadmap
1.  **Interface**: Define `conversation.proto`.
2.  **Infrastructure**: Build `LLMProvider` abstractions (Ollama + Mock).
3.  **Core**: Implement `Orchestrator` with Moderator injection.
4.  **Integration**: Replace `simulationEngine.ts` logic with client calls to this service.
