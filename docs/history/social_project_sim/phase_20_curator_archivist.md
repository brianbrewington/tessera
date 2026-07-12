# Phase 20: The Curator & The Archivist

## 0. Original Requirements
> **Author**: Brian Brewington
> **Date**: 2026-01-11
> ... (See original prompt in history) ...

---

## 1. Overview
This phase introduces a formal pipeline for "Invention", separating concerns into distinct services and personas to avoid "God Objects".

1.  **The Curator (Quinn)**: A creative catalyst persona who interviews agents to refine ideas.
2.  **The Archivist (Service)**: A standalone microservice (Port 8086) for long-term storage, indexing, and "Wiki-style" serving of knowledge.
3.  **The Librarian (Consumer)**: Integrating the Archive as a primary knowledge source.

## 2. The Curator (Persona)
**Name**: Quinn Sterling ("The Catalyst")
**Role**: Invention Curator & Novelty Seeker
**Profile**:
-   **Creativity**: High. Loves wild ideas.
-   **Practicality**: High. "How does this help humans?"
-   **Tone**: Encouraging, inquisitive, collaborative.
-   **Output**: Produces structured Markdown documents.

## 3. The Archivist (Service)
**Type**: Standalone Microservice (Node.js/Express)
**Port**: 8086
**Responsibility**: "They only archive."

### 3.1 Core Features
1.  **Storage**: Saves Markdown files to `data/archive/{guid}.md`.
2.  **Identification**: Generates a GUID for every document.
3.  **Wiki UI**: Serves a basic HTML frontend to browse/read documents.
4.  **Librarian Hook**: On save, pushes the content to `ContextService` for vector ingestion (Type: `KNOWLEDGE`).

### 3.2 Indexing Strategy (Hybrid)
To support both "Semantic Retrieval" (Librarian) and "Structured Browsing" (Wiki UI), we use a hybrid approach:
1.  **Semantic Index (Vector)**:
    *   The **Librarian** relies on the `ContextService`'s Vector DB (LanceDB or Qdrant, configured via env).
    *   The full Markdown content is embedded and stored as a `KNOWLEDGE` node.
    *   **Metadata** (Author, Date, Title) is stored in the node's `metadata` field, allowing for future pre-filtering.
    *   *Usage*: Agent asks "What ideas did Alice have about space?", Vector DB finds the document node.
2.  **Structured Catalog (JSON/SQLite)**:
    *   The **Archivist** maintains a lightweight `catalog.json` (or simple DB).
    *   **Fields**: `id`, `title`, `authors` (array), `tags` (array), `created_at`, `summary`.
    *   *Usage*: The **Wiki UI** uses this for "Filter by Author", "Sort by Date", and "Tag Cloud".

### 3.3 Linking Strategy
The Curator should be prompted to include links where possible:
1.  **External**: Standard Markdown links to Wikipedia or other valid URLs. `[Concept](https://en.wikipedia.org/wiki/Concept)`
2.  **Internal**: Wiki-style links `[[Topic Name]]`.
    *   **Resolution**: The Wiki UI will intercept `[[...]]` patterns.
    *   **Logic**: It searches `catalog.json` for a matching *Title*.
    *   **match**: Renders a link to `/wiki/:id`.
    *   **no match**: Renders a "red link" (simulating a "Create Page" loop or just search).

### 3.4 API Contract
-   `POST /api/documents`:
    -   Body: `{ title, content, authors: [], tags: [] }`
    -   Returns: `{ id: "uuid", url: "http://archivist:8086/wiki/uuid" }`
-   `GET /api/documents/:id`: Raw Markdown.
-   `GET /wiki/:id`: HTML Rendered view.
-   `GET /wiki/`: Index page (List of inventions).

## 4. The `INVENT` Workflow

### Step 1: The Spark
*   **Trigger**: Agent Intention `INVENT` detected in `simulate_conversation.ts`.
*   **Action**: System schedules a conversation with Quinn.

### Step 2: Refinement Session
*   **Participants**: Originator (e.g., Alice) + Quinn.
*   **Context**: Transcript of the "spark" conversation is injected.
*   **Interaction**: Quinn asks questions to clarify novelty, impact, and feasibility.

### Step 3: Drafting & Archiving
*   **Trigger**: Conversation End.
*   **System Action (Quinn)**: The system prompts Quinn's LLM with a special "Drafting Prompt".
    *   *Prompt*: "Draft a Markdown document... Include Origin, Credits, Description, Impact, Follow-up Questions."
*   **System Action (Archivist)**: 
    *   The generated draft is sent to `POST http://archivist:8086/api/documents`.
    *   Archivist returns a GUID.

### Step 4: Notification & Loop
*   **System Action**: The system schedules a **Follow-up Conversation**.
    *   **Participants**: Quinn + Originator.
    *   **Context**: The newly minted Document (via ID/Content).
    *   **Goal**: Quinn tells the Originator: "I've filed this as [Title]. Here are some questions for next time..."

## 5. Librarian Integration
*   The Archivist acts as a "Source of Truth".
*   When a document is created, the Archivist calls `ContextService.ingest` (or Librarian pulls):
    *   **Type**: `NodeType.KNOWLEDGE`
    *   **Content**: The Markdown text.
    *   **Metadata**: `{ source: "archive", url: "...", archiveId: "..." }`
*   **Result**: Agents can now `!ask` or `LEARN_MORE` about these inventions.

## 6. Testing Strategy
*   **Archivist**: Test API isolation. Verify file creation and simple HTML rendering.
*   **Curator**: Test drafting prompt output consistency.
*   **End-to-End**: `INVENT` -> Chat -> Draft -> Archive -> Notify -> Search.

## 7. Clarifying Questions (Resolved)
1.  **Architecture**: Separate Service (Confirmed).
2.  **Drafting**: Separate System Step (Confirmed).
3.  **Librarian**: Wiki-like access + Vector Ingestion (Confirmed).

## 8. Log Viewer (Observability Tool)
*   User Request: "A link from the main frontend to a log reader panel".
*   **Architecture**: 
    *   Since `conversation.log` is on the file system (`context_service/logs/`), the simplest approach for a "link" is a simple static HTML/JS page served by `ContextService` (Port 8083) or the Archivist (if volume mounted).
    *   *Decision*: Add a route `GET /logs/view` to `ContextService`. It serves a simple HTML page that polls `GET /api/logs/tail`.
*   **API**:
    *   `GET /api/logs/tail?file=conversation&lines=50`: Returns last N lines of the log file.
*   **UI**:
    *   A simple, dark-mode terminal-like viewer.
    *   Auto-refresh every 2 seconds.
    *   Clickable / expandable JSON objects if possible (using `json-view` lib or similar simple toggle).

