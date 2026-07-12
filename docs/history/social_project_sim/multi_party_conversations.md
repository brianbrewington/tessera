# Design: Multi-Party Conversations & Project Teams

## Context
Currently, the `simulate_conversation.ts` script (and the Interaction Queue) is strictly dyadic (`p1`, `p2`).
As we evolve into **Phase 21 (Project Formation)**, agents will need to form "Project Teams" (e.g., 3-5 agents) to collaborate on complex ideas.

## Challenges
1.  **Queue Structure**: The `QueueItem` interface already supports `participants: Participant[]`, but the consumer (`process_queue.ts`) often assumes `participants[0]` and `participants[1]`.
2.  **Turn-Taking Logic**: `simulate_conversation.ts` simply toggles `[activeId, otherId] = [otherId, activeId]`. In a group of 3+, this fails.
3.  **Context Retrieval**: `!ask` currently retrieves for the *active speaker* based on the *last message*. In a group, context is shared but specific to the individual's perspective.
4.  **Addressing**: Agents need to know *who* they are talking to (everyone? specific person?).

## Proposed Architecture

### 1. Queue Update
The `InteractionQueueService` is already roughly compatible, but we must ensure `process_queue.ts` passes **ALL** participants to the simulation script.
- **Command**: `npx ts-node scripts/simulate_group.ts --participants="id1,id2,id3" --topic="..."`
- OR genericize `simulate_conversation.ts` to handle N participants.

### 2. Simulation Logic (Round Table vs. Dynamic)

#### Option A: Round Robin (Simple)
`[A, B, C]` -> A speaks, then B, then C, then A...
- *Pros*: easy to implement.
- *Cons*: robotic, unnatural for debates.

#### Option B: Dynamic "Hand-Raising" (Advanced)
After a message, the LLM (or a lightweight "Moderator" prompt) decides who speaks next based on:
- Who was addressed ("What do you think, Quinn?").
- Who has high resonance with the topic.
- Random noise.

**Recommendation for Phase 21**:
Start with **Modified Round Robin**:
- List of participants.
- Randomize order at start.
- Iterate, but allow "Interjections" (if we get fancy later).
- **CRITICAL**: The System Prompt for each agent must list *everyone* in the room.
  - `You are in a group chat with: [A, B, C].`

### 3. Script Changes (`simulate_conversation.ts`)

Refactor to `simulate_session.ts` (or modify existing):

```typescript
// Current
const p1Id = args.p1;
const p2Id = args.p2;

// Proposed
const pIds = args.participants.split(','); // "id1,id2,id3"
let turnIndex = 0;

while (turn < MAX_TURNS) {
    const speakerId = pIds[turnIndex % pIds.length];
    const audience = pIds.filter(id => id !== speakerId);
    
    // Prompt Update
    const prompt = `
    You are in a room with ${audience.join(', ')}.
    History: ...
    Instruction: Speak to the group.
    `;
    
    // ...
    turnIndex++;
}
```

### 4. Memory Ingestion
- **Transcript**: The header must list all participants.
- **Ingestion**: The full group transcript is ingested into *every* participant's graph.
- **Intentions**: Each participant generates intentions independently at the end.

### 5. Project Teams
A "Project Team" is simply a named group that persist.
- When an `INVENT` intention matures, Quinn might suggest: "Lets form a team with X and Y."
- This creates a `PROJECT` node, or uses an existing one (when applicable)
- Future interactions are scheduled with the *Project ID* as the topic context, and the *Team Members* as participants.

## Implementation Steps
1.  **Refactor `process_queue.ts`** to join participant IDs into a comma-separated list.
2.  **Update `simulate_conversation.ts`** to accept `--participants` list instead of just `--p1/--p2`.
    - Fallback: if p1/p2 args exist, map to list.
3.  **Update Loop**: Implement circular turn-taking.
4.  **Update Prompts**: Inject "Group Context".

## "Quinn's Role" in Groups
## "Quinn's Role" in Groups
If Quinn is in a group (e.g. "Review Board" or "Brainstorming"), he acts as the **Scribe/Moderator** and **Provocateur**.

### Scribe & Moderator
- He tracks the flow of the conversation, ensuring acts as the "institutional memory" of the session.
- He typically speaks last in a "round" (or periodically) to **summarize** the emerging consensus or open questions.
- He is responsible for triggering the final "Drafting" phase when he senses the group has reached a solid conclusion.

### The Provocateur (Anti-Groupthink)
- Quinn has a "hard edge" when necessary. He is allergic to shallow agreement.
- If he detects **Groupthink** (everyone agreeing too quickly, lack of diverse perspectives), he **MUST** intervene.
- **Actions**:
    - Offer a provocation or counter-argument: "Are we sure this is ambitious enough?"
    - Call out specific quiet members: "Brian, you've been quiet. Do you see a flaw here?"
    - Challenge the premise: "This sounds safe. Is 'safe' what we want?"
