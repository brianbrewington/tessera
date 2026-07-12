# Master Design: Social Evolution Simulator

> **Status**: DRAFT (2026-01-09)
> **Vision**: An AI-driven simulation of social dynamics, project formation, and knowledge evolution, powered by synthetic personas and distributed context memory.
> **Core Goal**: A system in which AI agents can collaborate autonomously in support of human-centered, human-driven creative work.

## 1. Core Philosophy & Architecture

The system is designed as a **Hybrid Microservices Architecture** that supports two distinct deployment modes to accommodate the User's "nomadic" hardware setup:

1.  **Compact Mode (Local)**: All services and the Vector DB run purely on the local machine (e.g., MacBook Pro) via Docker Compose.
2.  **Distributed Mode (Lab)**: Core services run locally or on a head node, while heavy state management (Qdrant) and compute-intensive agents (Slurm/Jetson) run on networked infrastructure.

### 1.1 The "Holy Trinity" of Services
The application is strictly divided into three primary domains, communicating via **gRPC** (internal) and **HTTP/REST** (external gateway):

1.  **Simulation Engine (The "Timekeeper")**:
    *   Manages the Event Queue (`EventLoop`).
    *   Orchestrates the lifecycle of interactions.
    *   *Refactoring Goal*: Extract from `App.tsx` into a dedicated Worker or Service.
2.  **Conversation Service (The "Mouth")**:
    *   Stateless layer handling LLM inference (Ollama/Gemini).
    *   Manages "Personas" (System Prompts).
3.  **Context Service (The "Brain")**:
    *   Manages long-term memory, knowledge graphs, and "Dreaming".
    *   **Backed by Qdrant**.

---

## 2. The 9-Step Simulation Flow

This flow defines the lifecycle of a simulation run.

### 2.1 Ingestion (The "Feeding")
*   **Mechanism**: Each Context AI is fed a set of documents (Q/A, work products, musings) to build its initial state.
*   **Permission**: Default to "Blanket Permission" for artificial personas. Support "Human-in-the-Loop" for real personas later.

### 2.2 The Interview (Building the Graph)
*   **Action**: The Simulation LLM interviews each Context Manager.
*   **Goal**: Extract high-level interest areas, projects, and values.
*   **Outcome**: These extracted concepts become **High-Level Nodes** in a graph that rides *on top* of the individual Context Managers.
### 2.2 The Interview (Building the Graph)
*   **Action**: The Simulation LLM interviews each Context Manager.
*   **Goal**: Extract high-level interest areas, projects, and values.
*   **Outcome**: These extracted concepts become **High-Level Nodes** in a graph that rides *on top* of the individual Context Managers.
*   **Questions**:
    *What are your top 3 interests? What are your top 3 projects? What are your top 3 values? You can provide fewer if you don't have that many, in any category.
    *If someone didn't know you, what might you want them to know, first?
    *Would you say you would rather have a conversation with your work, or with a person? Why?
    *What's something that makes you curious?

### 2.3 Top-Level Promotion
*   **Mechanism**: The concepts extracted in 2.2 are "promoted" to the Top-Level Simulation Graph.
*   **Storage**: A dedicated Qdrant Collection (`sim_global_knowledge`) separate from individual agent contexts.
*   **Schema**:
    *   **Nodes**: Topics (Clusters of interest) or Person-Representations (Embeddings of their summaries).
    *   **Edges**: Semantic Distance (Implicit) or Causal Links (Explicit).

### 2.4 Selection & Matchmaking (The "Annealing" Process)
*   **Selection**: The Simulation LLM observes the Top-Level Graph.
*   **Mechanism**:
    *   **Annealing**: Starts with high randomness (High Temperature) to encourage diverse mixing. Over time, "cools down" to directed matching based on intersection of promoted embeddings.
    *   **Match Types**:
        *   `Directed`: "I think you should meet [Persona] because [Reason].", where the Reason is a synthetically generated statement based on the intersection of the two agents' interests.
        *   `Random`: "Meet a stranger."

### 2.5 The Librarian (Research)
*   **Role**: A distinct AI Persona ("Curator of Knowledge") that wraps a research toolset.
*   **Mechanism**:
    *   **Input**: Natural language research request from an agent.
    *   **Process**: The Librarian LLM interprets the request, formulates search queries, and retrieves data from **Trusted Sources**.
    *   **Architecture**:
        *   **Proxy/Cache Service**: A dedicated middleware to handle external requests.
            *   *Cache*: Stores results (HTML/PDFs) to support air-gapped runs and reduce API hits.
            *   *Pre-load*: Capability to "warm" the cache with likely hits.
            *   *Rate-limited*: We'll be scraping a lot of sites, so we need to have low traffic to avoid being blocked.
*   **Trusted Sources**:
    1.  **Wikipedia** (General Knowledge).
    2.  **Arxiv** (Scientific Papers).
    3.  **Stack Overflow** (Technical Knowledge).
    4.  **GitHub** (Code Examples).
    5.  **PubMed** (Medical Knowledge).
    6.  **Google Scholar** (Academic Papers).
*   **Output**: A synthesized summary or raw excerpt returned to the requesting agent.

### 2.6 The Conversation (Moderated Dream)
*   **Implementation Spec**: `design/discussions/Phase15_MultiPersona_Simulation.md` (Phase 15)
*   **Format**: A "Moderated Dream" session. 
*   **Protocol**:
    1.  **Moderator Intro**: Summarizes both personas and sets the stage.
    2.  **Turn Logic**: Personas take turns.
    3.  **RAG Loop**:
        *   Query Context (History + Topic). This is a node that is explicitly added to the Context Manager's graph for the recipient of the communication: as each actor speaks, that text becomes a node to be chunked and added to the graph (so the agent will remember it in the future, and be able to associate it with repsonse-driving context).
        *   Assemble Context: based on the statement just made, and the history of the conversation, assemble a context that will be used to generate the next response.
        *   Generate Turn ("Be kind and curious. Extend the conversation.").

### 2.7 Outcomes & The Event Queue
*   **Structure**: Conversations are short (5-10 turns) with actionable conclusions.
*   **The Decision**: At the end, the System asks: "What would you like to do?"
*   **Action Choices**:
    *   `MEET_RANDOM`: Request to meet a stranger.
    *   `RESEARCH_CONCEPT`: Request to the Librarian to learn about $TOPIC.
    *   `MEET_SPECIFIC`: Request to meet Agent $UUID.
    *   `THINK_ABOUT`: Internal monologue or self-reflection step.
    *   `DREAM`: Trigger a Context Resonance session.
    *   `FEEDBACK_TO_SYSTEM`: Meta-feedback on simulation parameters.

### 2.8 Logging & Feedback
*   The Top-Level Simulation logs the interaction.
*   Summarizes the session.
*   Surfaces any `FEEDBACK_TO_SYSTEM` items to the user.

---

## 3. Infrastructure & Data Layer

### 3.1 Vector Database: Qdrant
We selected **Qdrant** for its ability to handle both **Vectors** (Semantic Search) and **Payloads** (Graph Metadata/Filtering) effectively.

*   **Deployment Configuration**:
    *   Controlled via `ENV` variable: `QDRANT_URL`.
    *   **Local**: `localhost:6333` (Docker container).
    *   **Distributed**: `192.168.1.X:6333` (Dedicated Server/Linux Box).
*   **Collection Strategy**:
    *   `memories`: The core narrative segments.
    *   `person_nodes`: High-level nodes promoted from interviews.
    *   `global_topics`: Shared concepts in the top-level graph.

---

## 4. Synthetic Personas (The "Ghost in the Shell")

The simulation is populated by **AI Agents** representing two categories:

1.  **The Crowd**: Statistically generated profiles.
2.  **The Anchors**: Synthetic representations of historical/intellectual figures (e.g., Feynman, Carson, Archimedes).

### 4.1 Implementation
*   **Profile Source**: `design/design_conversations/questions_for_making_profiles.ts`
*   **System Prompts**:
    *   *Cognitive Style*: "You are Richard Feynman. You challenge assumptions playfully."
*   **Artifacts**: Real or Generated docs used during Ingestion (Step 2.1).

---

## 5. Security & Stability (Refactoring Mandate)

Based on *Review 2026-01-09*:
*   **Environment**: strict `.env` usage for all configuration.
*   **CORS**: Strict allow-lists.
### 6. Meta-Cognitive & "Mercer" Features

> "The system must manage the tension between local comfort and global innovation." — *Professor Mercer*

#### 6.1 The "Variable Impedance" Handover
*   **Goal**: Solves the "Proxy Barrier" where agents shield users too much.
*   **Mechanism**: The Agent acts as a variable resistor to social friction.
    *   *High Impedance (Diplomat)*: Filters harsh feedback for new/fragile relationships.
    *   *Low Impedance (Mirror)*: Lets raw feedback through for established, high-trust links to foster growth.
    *   *Circuit Breaker*: Detects "Withdrawal" (latency spikes, short replies) and resets to High Impedance.

#### 6.2 Synesthetic Radar (Right-Brain Decoding)
*   **Goal**: Help users "grok" complex high-dimensional relationship vectors.
*   **Mechanism**: Map Qdrant relationship vectors to sensory outputs.
    *   *Visual*: Textures (Smooth = Safe, Static = High Friction).
    *   *Audio*: Harmonics (Major Chord = Alignment, Jazz/Dissonant = Creative Tension).

#### 6.3 The "Wake-Up" Protocol (Nightmare Prevention)
*   **Context**: During "Dreaming" (Step 2.6), the graph runs unsupervised.
*   **Risk**: Positive feedback loops (Panic Spirals) where negative associations amplify.
*   **Control**: A **Homeostatic Regulator** monitors "System Stress" ($\sigma$).
    *   If $\sigma > 0.8$ (Diversity collapses, infinite loops), the system "Wakes Up" (Aborts the dream, logs the trauma, resets weights).

#### 6.4 The "Zeitgeist" Sensor
*   **Feature**: `GLOBAL_MOOD_METRIC`
*   **Mechanism**: Polls the Top-Level Graph to classify aggregate sentiment (e.g., "Anxious", "Stagnant").
*   **Action**: If "Stagnant", the Librarian injects a "Chaos Seed" (controversial paper) to stir the pot.

---

## 7. Dashboard Observability & Interaction Patterns

To demystify the "Black Box" of simulation, the frontend dashboard provides deep observability into the system's cognitive state.

### 7.1 Visualizing the Graph (The "Mindmap" Model)
The primary visualization is a Force-Directed Graph that prioritizes **Stability** and **Legibility** over raw data dump.

*   **Stable Polling**: The graph updates in real-time as the simulation runs, but uses **Stable Object Persistence** (merging new data into existing d3 node objects) to prevent physics resets or "scrambling." This allows users to track node movement and evolution without visual chaos.
*   **Canvas Rendering**: We bypass standard DOM nodes for a custom Canvas renderer that draws:
    *   **Text Labels**: Directly on the canvas (Mindmap style) for immediate readability.
    *   **Semantic Sizing**: Node radius scales with `node.val` (Attention/Importance), allowing visual "Tickle" feedback.
    *   **Visibility Controls**: Toggles for Nodes, Edges, and Labels to declutter the view.

### 7.2 Human-in-the-Loop Interactions
The dashboard is not just a TV; it's a control surface.

*   **Multi-Stage Highlighting**:
    *   **1-Click**: 1-Hop Neighbors (Direct connections).
    *   **2-Click**: 2-Hop Neighbors (Contextual vicinity).
    *   **3+ Click**: Full Reachable Graph (The "Island" of connected concepts).
*   **Context Actions**:
    *   `DETAILS`: Inspect generic node metadata.
    *   `TICKLE`: Visually stimulate a node (swell animation) to "prime" it for retrieval.
    *   `FIND SIMILAR`: (Phase 2.2) Vector search via Qdrant to find conceptually related nodes.
    *   `DREAM`: (Phase 2.2) Trigger a generative consolidation event centered on the node.

### 7.3 The System Console ("The Matrix")
A dedicated text console provides a raw, transparent view of the system's "Thought Process."

*   **Live Log Stream**: Displays real-time `INFO/WARN` logs from the backend services.
*   **Queue Monitor**: Visualizes the `InteractionQueue`, showing active vs. pending tasks.
*   **Transcript Feed**: (Planned) Streams the raw LLM "inner monologue" as it generates responses.

