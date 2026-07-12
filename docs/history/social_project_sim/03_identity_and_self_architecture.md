# Identity Architecture: The "Self" in the Graph

## 1. The Core Dilemma
We are balancing two competing needs in the Social Simulator:
*   **The Philosophical Goal**: "I am the Graph." Identity, Values, and Mood should be *emergent properties* of the entire network of memories and beliefs, not a single static node. This aligns with a "No-Self" or "Bundle Theory" of mind.
*   **The Technical Need**: "I need an Anchor." For mechanics like Resonance (`linkTo`), Dream Weaver (`distanceFrom`), and Vector Querying, we often need a concrete coordinate $(x,y,z)$ or NodeID to represent the Subject.

## 2. Perspectives Considered

### Option A: The Subjective Frame (Preferred Philosophically)
*   **Definition**: The `participantId` defines the universe boundaries. There is no specific node representing "Me".
*   **Implication**: "Self" is the sum of all edges.
*   **Problem**: Hard to calculate "How does this new Concept relate to Me?" without a centroid. Hard to store self-reflexive facts like "I am proud of X".

### Option B: The Explicit Ego Node (Pragmatic)
*   **Definition**: A dedicated `SELF` node exists in every graph.
*   **Implication**: All personal memories link to this Ego Node.
*   **Problem**: Can lead to a "homunculus" fallacy where we treat the Node as the person, ignoring the rich context of the rest of the graph.

### Option C: The Metadata Tag
*   **Definition**: Just a `PERSON` node with `isSelf: true`.
*   **Status**: Rejected as too "soft".

## 3. Open Questions & The Path Forward

### Q1: How do we encode "Perspective" in Dreams?
*   **Requirement**: Dreams must be experienced from the *First Person* perspective, not a detached camera.
*   **Challenge**: If we just feed the LLM a list of nodes, it tends to write 3rd person fiction ("Alice did this").
*   **Proposed Solution**: The Prompt Engineering layer must explicitly enforce the "Experiencing Self".
    *   *Prompt*: "You are the Experiencing Self of [ParticipantName]. These concepts are appearing in YOUR mind..."

### Q2: Experiencing Self vs. Observing Self
*   **Mindfulness Context**: We need to distinguish between the thinker (Experiencer) and the watcher (Observer).
*   **Speculation**: 
    *   **Experiencer**: The active agent traversing the graph (The Walker).
    *   **Observer**: The Graph Manager / Analysis Service that looks at the `semanticWeight` distributions.

### Q3: Emergence of Mood & Integration
*   **Goal**: Mood shouldn't be a variable `mood = sad`. It should be the aggregate color of the currently active/resonant subgraph.
*   **Mechanism**: If the "Dream Walker" is currently traversing a cluster of "Sad/Red" nodes, the emergent mood is Sadness.

### Q4: The "Emotional Reflection" Node (Meta-Commentary)
*   **Concept**: We need a way to store the *reaction* to an experience ("That was weird", "I felt scared"). This is the "Inner Monologue".
*   **Requirement**: Implicitly carries the identity of the thinker.
*   **Formalism Questions**:
    *   **Is it a new Node Type?** (`REFLECTION` / `THOUGHT`?).
    *   **How is it generated?** Does *every* ingestion trigger a "Reaction Step" where the LLM reflects on the input?
    *   **Where does it fit?** A `REFLECTION` node should probably link *to* the `MEMORY` it is reflecting on (`ABOUT` edge), and *to* the `SELF` node (`FELT_BY` edge?).
    *   **Example**: 
        *   Memory: "Met a strange dog."
        *   Reflection: "I felt an odd kinship with it." (Linked to Memory).

## 4. Proposed Hybrid Implementation (Draft)
For now, we lean towards **Option B (Explicit Node)** purely as a *gravitational anchor* for physics calculations, while strictly teaching the LLM/Prompt layer to treat the **Whole Graph** as the Identity.

*   `SELF` Node = The "Body" / "Anchor".
*   The Graph = The "Mind".
