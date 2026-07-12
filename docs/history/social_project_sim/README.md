# Social Network Evolution Simulator 🤖🧠

An AI-driven simulation of social dynamics, project formation, and knowledge evolution. This application simulates interactions between "People", "Projects", and "Topics" to observe how networks form and evolve over time using Large Language Models (LLMs).

## 🚀 Quick Start

The entire system (5 microservices + frontend + vector DB) is orchestrated via a single script.

### 1. Requirements
*   **Node.js** (v18+)
*   **Docker Desktop** (or [OrbStack](https://orbstack.dev/) on Mac)
*   **Ollama** (Running locally with `llama4-ultra:latest` and `embeddinggemma:latest`)

### 2. Boot & Run
```bash
./start_all.sh
```
This script will:
*   Spin up Qdrant (Vector DB) in Docker.
*   Ingest all profiles from `context_service/profiles/`.
*   Start **5 Microservices** and the **Dashboard**.

### 3. Access
*   **Dashboard**: [http://localhost:5173](http://localhost:5173)
*   **Log Viewer**: [http://localhost:8083/logs/view](http://localhost:8083/logs/view)
*   **The Archives (Wiki)**: [http://localhost:8086/wiki](http://localhost:8086/wiki)
*   **Qdrant Dashboard**: [http://localhost:6333/dashboard](http://localhost:6333/dashboard)

---

## 🏗 System Architecture (Phase 20)
The system is built as a mesh of specialized services:

1.  **Context Service** (Port 8083): The "Brain". Manages the Knowledge Graph, Vector RAG (Qdrant), and Hebbian Memory.
2.  **Conversation Service** (Port 8081): The "Mouth". Handles LLM chat completion and dialogue state.
3.  **Interaction Queue** (Port 8082): The "Clock". Manages the event loop and priority queue for simulations.
4.  **Dream Weaver** (Port 8084): The "Subconscious". Runs background graph maintenance and deep linking.
5.  **Archivist Service** (Port 8086) **[NEW]**: The "Library". Stores crystallized knowledge ("Inventions") in Markdown format.

---

## 🌟 Key Features

### 👤 The Creator & The Curator
*   **Quinn Sterling (The Curator)**: A special AI persona who acts as a "midwife" for new ideas.
    *   Trigger: `INVENT` intention or manual invocation.
    *   Role: Interviews participants to refine "Sparks" into "Artifacts".
*   **The Archivist**: Automatically publishes these artifacts to a searchable Wiki.

### 📜 Live Log Viewer
Access real-time system logs at [http://localhost:8083/logs/view](http://localhost:8083/logs/view).
*   **Pause/Resume**: Freeze the feed to inspect details.
*   **Reverse Order**: Newest logs appear at the top.
*   **Clear Logs**: Reset the console with one click.

### 💻 Context REPL
Interact directly with the simulation brain via CLI.
```bash
npx ts-node scripts/repl.ts
```
**Commands**:
*   `!participant <id>`: Switch active persona.
*   `!ask <query>`: Test RAG retrieval.
*   `!list`: Show all known entities.
*   `!help`: Show full command list.

---

## 🛠 Advanced Usage

### Running a Manual Conversation
You can bypass the queue and force a conversation between two specific agents using the CLI script. This is great for debugging behaviors or testing prompts.

```bash
npx ts-node context_service/scripts/simulate_conversation.ts \
  --p1 "amara_okafor" \
  --p2 "quinn_sterling" \
  --topic "A new way to visualize dreams"
```

### Auto-Pilot Simulation
1.  Go to the **Dashboard** (Port 5173).
2.  Click **Queue** tab.
3.  The system automatically schedules "General Chats" and "Dreams".
4.  Watch the **Graph** evolve in real-time as edges form.

---

## 📁 Directory Structure
*   `context_service/`: Brain & Memory (Express/TypeScript).
*   `conversation_service/`: Chat Logic.
*   `archivist_service/`: Static Site Generator for Inventions.
*   `frontend_dashboard/`: React Visualization.
*   `scripts/`: Global automation utilities.
