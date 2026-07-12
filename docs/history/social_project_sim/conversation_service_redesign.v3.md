# Design Document: Conversation Service Extraction (v3)

## 1. Executive Summary
This document outlines the architecture for extracting the **Conversation Manager** into a standalone **TypeScript/gRPC** microservice. It features a stateless Moderator, anti-sycophancy logic, real-time streaming to prevent UI blocking, and a formal Action vocabulary.

## 2. Technology Stack & Interface

*   **Language**: **TypeScript (Node.js)**.
    *   *Reason*: Aligns with the existing simulation codebase, allowing shared type definitions where useful and leveraging the strong async ecosystem.
*   **Protocol**: **gRPC** (Protobuf).
    *   *Transport*: The service will expose a standard gRPC server (HTTP/2).
    *   *Browser Access*: To support the React frontend (which cannot speak raw gRPC), we will use **gRPC-Web** (via an Envoy proxy or `@improbable-eng/grpc-web` in-process proxy) to wrap requests in HTTP/1.1 or HTTP/2 frames.
*   **Streaming**: Mandatory. The primary interaction method is `StreamConversation`.

## 3. System Architecture

### 3.1. Components
```mermaid
graph TD
    Client[React Simulation App] -- gRPC-Web --> Proxy[gRPC-Web Proxy]
    Proxy -- gRPC --> Server[Conversation Service]
    
    subgraph Conversation Service
        Orchestrator[Turn Orchestrator]
        Decoder[Action Decoder]
        Moderator[Moderator Logic]
        Logger[Structured Logger]
        LLM[LLM Adapter (Ollama/Mock)]
    end
    
    Server --> Orchestrator
    Orchestrator --> LLM
    Orchestrator --> Logger
```

### 3.2. Lifecycle Management
*   **Start**: `npm run start-service`. Bootstraps the gRPC server and connects to the defined LLM provider.
*   **Stop**: Listens for `SIGINT`/`SIGTERM`. Gracefully drains active streams (timeout 5s) before shutting down.

### 3.3. Logging Strategy
*   **Generation**: All internal events (Turn start, LLM prompt/response pairs, Action decoding results) are logged using a structured logger (e.g., `pino`).
*   **Content**:
    *   `trace_id`: Unique ID per `SimulateConversation` request.
    *   `level`: INFO, WARN, ERROR, DEBUG.
    *   `component`: "Orchestrator", "Decoder", etc.
    *   `payload`: JSON object details.
*   **Destination**:
    *   **Stdout**: For Docker/Console collection.
    *   **File**: `logs/service.log` with daily rotation.
*   **Garbage Collection**: Uses a rotation policy (e.g., maintain last 7 days of logs, max 50MB per file) managed by the logging library or external `logrotate`.

## 4. Interface Definition (Protobuf)

```protobuf
syntax = "proto3";

package conversation.v3;

import "google/protobuf/empty.proto";

service ConversationManager {
  // Returns robust health and status metrics.
  rpc GetStatus (google.protobuf.Empty) returns (StatusResponse);

  // Primary Method: Real-time conversation simulation.
  // Streams events (tokens, status, results) to the client.
  rpc StreamConversation (ConversationRequest) returns (stream ConversationEvent);
}

// --- Status ---

message StatusResponse {
  // "READY", "DEGRADED" (if LLM slow), "MAINTENANCE"
  string state = 1; 
  // Milliseconds. Average of last 5 heartbeats to LLM.
  int32 llm_latency_ms = 2;
  // Number of currently open streaming connections.
  int32 active_streams = 3;
  // Application uptime in seconds.
  int64 uptime_seconds = 4;
  // Current configured LLM provider (e.g. "ollama:llama3").
  string llm_provider = 5;
}

// --- Core Models ---

message Participant {
  string id = 1; // Unique Entity ID
  string name = 2; // Display Name
  string type = 3; // "PERSON", "PROJECT", "TOPIC"
  // The persistent "mind" of the entity. Client is responsible for checking size.
  string current_context = 4;
}

message ConversationRequest {
  string interaction_id = 1;
  repeated Participant participants = 2;
  string topic = 3;
  int32 min_turns = 4;
  int32 max_turns = 5;
  
  // Optional: Client can pass specific feedback/preconditions
  repeated string system_overrides = 6;
}

message ConversationResponse {
  string interaction_id = 1;
  repeated Turn transcript = 2;
  
  // Analysis per participant Key: participant_id
  map<string, ParticipantOutcome> outcomes = 3;
  
  // The Moderator's final facilitating statement/conclusion
  ModeratorConclusion moderator_conclusion = 4;

  // Logs bubbled up from SYSTEM_FEEDBACK actions to be shown in UI Console
  repeated string system_logs = 5;
}

message Turn {
  string speaker_id = 1; 
  string speaker_name = 2;
  string content = 3; // For final transcript
  int64 timestamp = 4;
}

message ParticipantOutcome {
  // New summarization to append to Entity Context
  string updated_context = 1; 
  // Structured intents derived from the conversation
  repeated Action proposed_actions = 2;
}

message ModeratorConclusion {
  string summary = 1;
  string observations = 2;
}

message Action {
  ActionType type = 1;
  // Flexible key-value pairs. e.g. target_id, topic_name
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
  PUBLISH = 9;   // Triggers Broadcast Conversation
  REMEMBER = 10; // Explicit context save
  SYSTEM_FEEDBACK = 11; // Suggest vocabulary changes
}

message ConversationEvent {
  oneof event {
    // Delta text for UI typing effect
    TokenDelta token = 1;
    // Status message ("Moderator Thinking...", "P1 Thinking...")
    string status_update = 2;
    // The final complete payload, sent once at end of stream
    ConversationResponse result = 3;
    // Fatal error message
    string error = 4;
  }
}

message TokenDelta {
  string speaker_id = 1;
  string text_chunk = 2;
}
```

## 5. Core Concepts Breakdown

### 5.1. The Stateless Moderator
*   **Identity**: A System Persona that is automatically injected into `participants` list internally.
*   **Prompting**:
    *   **Civility**: "You must enforce high standards of civility."
    *   **Anti-Sycophancy**: "Interrupt if participants are merely agreeing. Challenge them to disagree constructively."
    *   **Stateless**: The Moderator sees only the current `ConversationRequest`. It has no memory of past requests.

### 5.2. Streaming Implementation
*   **Mechanism**: Server Writer Object (`call`).
*   **Flow**:
    1.  Orchestrator selects Speaker A.
    2.  Adapter calls Ollama with `stream: true`.
    3.  As Ollama yields chunks, Service yields `ConversationEvent.token` to gRPC client.
    4.  Speaker A finishes. Service yields `Turn` completion (internal state update).
    5.  Orchestrator selects Speaker B...
    6.  Loop finishes.
    7.  Decoder runs (No streaming, usually fast). Yields `status_update: "Decoding Actions..."`.
    8.  Service yields `ConversationEvent.result` and closes stream.

## 6. Testing Strategy

### 6.1. Unit Test Suite (Jest/Vitest)
Mock the LLM Adapter to return deterministic strings.

1.  **Orchestrator - Round Robin**:
    *   *Precondition*: 2 Participants, MinTurns=2.
    *   *Behavior*: Verify P1 speaks, then P2 speaks.
2.  **Orchestrator - Moderator Interruption**:
    *   *Precondition*: Mock LLM returns "INTERRUPT" score > threshold.
    *   *Behavior*: Verify Moderator inserts a Turn before the next Participant.
3.  **Action Decoder - JSON Parsing**:
    *   *Precondition*: Input text with valid JSON.
    *   *Behavior*: Verify it maps to correct `Action` proto.
    *   *Corner Case*: Input text with broken JSON ("{ type: TALK..."). Verify it attempts generic repair or returns empty list (no crash).
4.  **Action Decoder - Sys Feedback**:
    *   *Precondition*: Action `SYSTEM_FEEDBACK`.
    *   *Behavior*: Verify it is flagged for the `system_logs` response field.

### 6.2. Integration / Smoke Tests
Run against the *real* service binary (or Docker container) using a Mock LLM Mode to avoid AI costs/slowness.

1.  **Status Check**:
    *   Call `GetStatus`. Assert `state == "READY"`.
2.  **Streaming Smoke**:
    *   Call `StreamConversation`.
    *   Consume stream.
    *   Assert at least one `TokenDelta`.
    *   Assert final `ConversationResponse` structure.
3.  **Error Handling**:
    *   Kill the Mock LLM.
    *   Call `StreamConversation`.
    *   Assert `ConversationEvent.error` is received.

## 7. Open Questions
1.  **HTTP Wrapping strategy**: We will use an in-process **gRPC-Web** listener (using `@improbable-eng/grpc-web` library which supports Node.js hosting of gRPC-Web) alongside the standard gRPC port. This avoids needing a separate Envoy container for local dev.
