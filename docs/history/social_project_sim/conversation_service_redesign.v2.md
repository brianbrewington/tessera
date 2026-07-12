# Design Document: Conversation Service Extraction (v2)

## 1. Executive Summary
This document outlines the architectural design for extracting the **Conversation Manager** into a distinct, isolated microservice. This service orchestrates interactions between entities (Personas) and a system-level **Moderator**, returning transcripts and structured actions. 

**v2 Updates**: Includes `PUBLISH/REMEMBER/SYSTEM_FEEDBACK` actions, Stateless Moderator, Anti-Sycophancy logic, and Streaming speculation.

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
*   **Statelessness**: The Moderator enters and leaves the conversation stateless. They only accumulate state *during* the conversation execution. This state is discarded at the end (unless explicitly returned in `ModeratorConclusion` for the Client to log, but it is not persisted by the Service).
*   **Role**: Facilitator & Challenger.
*   **Anti-Sycophancy**: The Moderator is explicitly instructed to interrupt if the conversation becomes unproductive, overly agreeable, or sycophantic. It challenges participants to be intellectually honest and not to stretch "yes, and" into dishonesty.
*   **Civility**: The Moderator enforces high standards of respect. Disagreement is encouraged but must be civilized.

### 3.2. Participant Actions (Formal Vocabulary)
After the conversation loop, participants generate **Actions** (JSON) which are decoded into Protobuf.

**Vocabulary (ActionType)**:
*   `TALK_TO`: Schedule a conversation.
*   `THINK_ABOUT`: Schedule a self-reflection.
*   `CREATE`: Spawn a new Entity.
*   `FIND_SOURCES`: Research resources.
*   `FOLLOW`: Subscribe to another entity.
*   `JOIN`: Request to join a Project.
*   `REFER`: Suggest introductions.
*   `UPDATE_GOAL`: Change internal directive.
*   `PUBLISH`: Broadcast a message. (Client maps this to a PubSub "Conversation" where subscribers listen).
*   `REMEMBER`: Explicitly save a note to `current_context`.
*   `SYSTEM_FEEDBACK`: Suggest vocabulary expansion to the Service Owner.

### 3.3. System Preconditions (Defaults)
The following System Instructions are injected into *every* prompt by default:
1.  **Civility**: All interactions must be respectful.
2.  **Intellectual Honesty**: Do not agree for the sake of agreement. State disagreements clearly and constructively.
3.  **Anti-Pollyanna**: Avoid toxic positivity. Be realistic.

## 4. Interface Definition (Protocol Buffers)

```protobuf
syntax = "proto3";

package conversation.v2;

service ConversationManager {
  rpc SimulateConversation (ConversationRequest) returns (ConversationResponse);
  
  // Future: Streaming support
  rpc StreamConversation (ConversationRequest) returns (stream ConversationEvent);
}

// --- Data Models ---

message Participant {
  string id = 1;
  string name = 2;
  string type = 3; 
  string current_context = 4;
}

message ConversationRequest {
  string interaction_id = 1;
  repeated Participant participants = 2;
  string topic = 3;
  int32 min_turns = 4;
  int32 max_turns = 5;
  // Moderator starts fresh every time.
}

message ConversationResponse {
  string interaction_id = 1;
  repeated Turn transcript = 2;
  
  map<string, ParticipantOutcome> outcomes = 3;
  
  ModeratorConclusion moderator_conclusion = 4;

  // Bubbles up SYSTEM_FEEDBACK logs to the console
  repeated string system_logs = 5;
}

message Turn {
  string speaker_id = 1; 
  string speaker_name = 2;
  string content = 3; // "Thinking..." (Stream) or Final Text
  int64 timestamp = 4;
}

message ParticipantOutcome {
  string updated_context = 1; 
  repeated Action proposed_actions = 2;
}

message ModeratorConclusion {
  // Summary for client to display/log
  string summary = 1;
  // Observations to be shown to user
  string observations = 2;
}

message Action {
  ActionType type = 1;
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
  PUBLISH = 9;
  REMEMBER = 10;
  SYSTEM_FEEDBACK = 11;
}

message ConversationEvent {
  oneof event {
    Turn turn_delta = 1; // Token stream
    string status = 2;
    ConversationResponse result = 3;
  }
}
```

## 5. Handling Latency: Streaming Strategy

### 5.1. Current Challenge
Ollama (local) can be slow. Waiting for the full `SimulateConversation` request to complete causes UI freeze/hanging.

### 5.2. Streaming Design (Future Work)
The Service should implement `StreamConversation`.
*   **Granularity**: The Service emits `ConversationEvent` messages.
*   **Token Streaming**: When an LLM (Orchestrator or Persona) is generating text, the Service forwards tokens in real-time via `Turn.content` (delta updates).
*   **UI Client**: The React client subscribes to the stream and renders "typing" indicators.
*   **Status Updates**: Emits "Moderator Thinking...", "Analyzing Actions..." events to keep the user informed during non-text generation phases.

## 6. Open Questions & Logic

1.  **Manifesting `PUBLISH`**: 
    *   *Design*: When a Participant returns `PUBLISH` Action, the *Client* (Simulation Engine) is responsible for:
        1.  Identifying all Subscribers (Followers).
        2.  Creating a "Broadcast Conversation" (1 Publisher -> N Subscribers).
        3.  Calling `SimulateConversation` again for that group.
2.  **`SYSTEM_FEEDBACK` Mechanics**:
    *   *Flow*: Participant generates `SYSTEM_FEEDBACK` action -> Service Action Decoder sees it -> Service appends the text payload to `ConversationResponse.system_logs` -> Simulation Engine receives response -> Engine calls `console.info("SYSTEM FEEDBACK:", log)`.
3.  **Moderator State Isolation**:
    *   Since the Moderator is stateless (starts fresh), it cannot "hold a grudge" or remember a specific user's habit across sessions unless the *Client* passes that context in `ConversationRequest`. (Currently decided: Client does NOT pass Moderator context, so Moderator is truly fresh).

## 7. Implementation Roadmap
1.  **Interface**: Define `conversation.v2.proto`.
2.  **Infrastructure**: LLM Adapter (Ollama/Mock).
3.  **Core**: Orchestrator with Moderator injection + Anti-Sycophancy Prompting.
4.  **Streaming**: Implement gRPC streaming or Server-Sent Events (SSE) early to mitigate generic Ollama latency.
