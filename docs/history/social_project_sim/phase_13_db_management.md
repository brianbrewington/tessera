# Phase 13: DB Management Design

## 1. Goal
Provide manual backup and restore capabilities via REPL commands `!save <filename>` and `!load <filename>`, allowing the user to checkpoint interesting states of the simulation.

## 2. Requirements
- **Format**: JSON (Portable, Debuggable).
- **Location**: `context_service/saved_graphs/`.
- **Scope**: Full export of Nodes and Edges for a participant.
- **LanceDB Sync**: When loading, the VectorDB must be synced (either wiped and re-indexed, or simple upsert if ignoring strict wipe). Ideally **Wipe & Re-index** to ensure the loaded state acts as the source of truth.

## 3. Architecture

### 3.1 `GraphStorageEngine` Extensions
Add generic Import/Export methods:
```typescript
interface GraphSnapshot {
    nodes: ContextNode[];
    edges: ContextEdge[];
    metadata: any;
}

public async exportSnapshot(participantId: string): Promise<GraphSnapshot> {
    // Return all nodes and edges
}

public async importSnapshot(participantId: string, snapshot: GraphSnapshot): Promise<void> {
    // 1. Clear In-Memory Graph
    // 2. Clear Vector DB (optional but recommended for consistency)
    // 3. Load Nodes & Edges
    // 4. Re-Index into Vector DB
}
```

### 3.2 `server.ts` Commands
- `!save <name>`: Calls export, writes to `saved_graphs/<name>.json`.
- `!load <name>`: Reads JSON, calls import.

## 4. Test Strategy (DBManagement.test.ts)
1. **Seed**: Add 3 nodes, 2 edges.
2. **Export**: Verify JSON structure.
3. **Wipe**: Clear graph.
4. **Import**: Restore from JSON.
5. **Verify**: Graph contains 3 nodes, 2 edges. Vector Search returns correct nodes.

## 5. Risks
- **VectorDB Desync**: If we load a graph but don't update LanceDB, retrieval will return "Ghost Nodes" that exist in vector index but not in memory.
- **Mitigation**: `importSnapshot` MUST loop through all imported nodes and re-add them to the VectorDB to overwrite/update the index. Ideally, we `clear()` the vector table first.

## 6. Work Plan
1. Implement `exportSnapshot`/`importSnapshot` in `GraphStorageEngine`.
2. Implement `!save`/`!load` in `server.ts`.
3. Verify with `DBManagement.test.ts`.
