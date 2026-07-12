# Topic Extraction Refactor: Shifting Responsibility to Context Manager

## Current State

Currently, the `social_project_sim` extracts topics in a redundant, "simulation-first" manner during the ZIP import process (`enrichmentService.ts`).

1.  **Raw Text Parsing**: The simulation reads `.txt` files from the ZIP.
2.  **LLM Extraction (Redundant)**: It calls `aiService.extractProfileDetails` to identify:
    *   `interests` (Interests)
    *   `namedEntities` (Locations, Objects, etc.)
3.  **Deduplication (Expensive)**: For *each* extracted string, it calls `getOrCreateTopic`.
    *   This logic (recently optimized) checks for exact matches or high cosine similarity against *all existing topics*.
    *   It creates a new `Topic` entity if no match is found.
4.  **Context Hydration (Late)**: *After* the person and topics are created, the raw text is sent to the `ContextManager` (`ApiClient.ingestContext`) purely for archival/memory purposes.

## The Problem

The `ContextManager` (`context_service`) performs **almost identical work** during ingestion, but better:

1.  **Entity Extraction**: It calls its own LLM prompt (`extractEntities`) to find "Places, Objects, Fields of Study, Key Concepts".
2.  **Vector Deduplication**: It automatically embeds these entities and merges them if they match existing Concept Nodes (cosine > 0.92).
3.  **Graph Linking**: It links the Memory Node (the profile text) to these Concept Nodes.

**Inefficiencies:**
*   **Double LLM Cost**: We pay for extraction twice (once in Simulation for "Interests", once in Context for "Entities").
*   **Divergent Ontologies**: The Simulation might decide "Social Sim" is a Topic, while the Context Manager decides "Social Simulation" is a Concept. They remain separate entities in different systems, leading to "Brain Split".
*   **Wasted Compute**: The Simulation re-calculates embeddings for topics that the Context Manager just calculated.

## Proposed Solution: "Context-First" Enrichment

We should invert the flow. The `ContextManager` should be the **source of truth** for concepts (topics).

### New Workflow

1.  **Ingest First**: When a `.txt` file is loaded, the Simulation *immediately* sends the raw text to `ContextManager.addContext()`.
2.  **Refined Response**: We modify `ContextManager.addContext` (gRPC/HTTP) to return not just the `nodeId`, but a structured list of **Concept Nodes** that were linked or created during ingestion.
    *   Response: `{ nodeId: "...", concepts: [ { id: "c1", label: "Quantum Physics", type: "FIELD", embedding: [...] }, ... ] }`
3.  **Hydrate Simulation**:
    *   The Simulation receives this list of Concepts.
    *   It iterates through them and ensures a corresponding `Topic` exists in its local state (using the ID provided by Context Manager or a mapped ID).
    *   It links the `Person` to these `Topics` automatically.

### Benefits

*   **Single Source of Truth**: The "Brain" (Context Graph) defines what concepts exist. The Simulation just reflects them unless it finds completely novel runtime topics.
*   **Performance**: Topic extraction becomes "free" for the Simulation (it's a side effect of memory ingestion).
*   **Consistency**: A user looking at the "Context Brain" REPL and the Simulation "Network Graph" will see the exact same set of nodes/topics for that person.
*   **Richness**: The Context Manager's extraction prompts (`extractEntities`) are already tuned for "Concrete Objects" and "Fields", which covers both `interests` and `isNamedEntity`.

## Implementation Steps

1.  **Update Proto/API**: Modify `context.v1.proto` and `server.ts` to return `repeated ContextNode concepts` in the `AddContextResponse`.
2.  **Update ContextManager**: In `addContext`, verify that the list of `targetNodes` (concepts found) is collected and returned.
3.  **Refactor Simulation**:
    *   Remove `extractProfileDetails` reliance on `interests`/`namedEntities`.
    *   Modify `enrichmentService.ts`:
        *   Call `ApiClient.ingestContext` *first*.
        *   Use the returned concepts to populate `Person.interests` and create `Topics`.

## Expanded Strategy: Chunking & Graph-RAG Discovery

### 1. Ingestion Chunking
Currently, a profile is ingested as a single massive `Memory` node. This hurts retrieval relevance.
*   **Strategy**: Split bios/text into sliding window chunks.
    *   **Size**: 256-512 tokens (approx 1-2 paragraphs).
    *   **Overlap**: 50 tokens (to capture context across boundaries).
    *   **Type**: Each chunk is a separate `ContextNode` (Type 1: MEMORY).
    *   **Linkage**: Chunks should be sequentially linked (e.g., `NEXT_CHUNK` edge) or just linked to the same parent `Person` node.

### 2. Person & Project Discovery
The `ContextManager` should be the factory for ALL entities, not just Concepts.
*   **Update**: Modify `extractEntities` prompt to explicitly ask:
    *   "Who is the primary subject?" -> creates/finds `PERSON` node.
    *   "What is their main initiative?" -> creates/finds `PROJECT` node.
*   **Edge Types**:
    *   `Person --(WORKING_ON)--> Project`
    *   `Person --(INTERESTED_IN)--> Concept`
    *   `Person --(HAS_MEMORY)--> MemoryChunk`
*   **Simulation Hydration**: The `addContext` response will now return `{ person: {id, name}, project: {id, name}, concepts: [...] }`. The Simulation uses this to instantiate the `Participant` and `Project` objects, ensuring the IDs match the Context Service's IDs perfectly.

### 3. True Graph-RAG
Is this "True Graph-RAG"? **Yes.**
*   **Definition**: Usage of graph topology to augment retrieval.
*   **Implementation**:
    1.  **Vector Entry**: Query "Time Travel" hits "Quantum Physics" (Concept) via vector match.
    2.  **Traversal**: The system traverses `RESONATES_WITH` edges to find related Concepts ("Entropy") and `RELATED_TO` edges to find linked `Memory` chunks (Bio Paragraph 3).
    3.  **Synthesis**: It assembles a context block from these *connected* nodes, not just raw text matches.
*   **Current Capability**: The Context Service already has `RESONATES_WITH` edges (Concept-Concept and Memory-Concept). By adding `Person` and `Project` nodes, we enable fully structured traversal (e.g., "Find all Projects related to Concept X").

### Updated Implementation Steps
4.  **Implement Chunking**: In `ContextGraphManager.addContext`, apply a sliding window splitter before embedding.
5.  **Identify Subject**: Add `extractSubjectAndProject` prompt step.
6.  **Update Proto**: `AddContextResponse` returns `Person` and `Project` details.

---
*Created by Antigravity Agent - 2026-01-06*
