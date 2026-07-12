# Phase 12: Multi-Resolution Chunking Design

## 1. Introduction
The current ingestion pipeline chunks text strictly by paragraph boundaries. While this preserves semantic structure, it can be brittle for texts with poor formatting (huge paragraphs) or specific detail retrieval needs. Phase 12 introduces **Multi-Resolution Chunking**, generating two complementary streams of chunks:
1.  **Semantic Chunks (Paragraph-based)**: Preserves narrative flow.
2.  **Windowed Chunks (Fixed-size Sliding)**: Ensures coverage for density and cross-boundary context.

## 2. Requirements
1.  **Dual Chunking**: `IngestionPipeline` must process text through *both* strategies if the text length warrants it.
2.  **Metadata Tagging**: Nodes resulting from different strategies must be distinguishable via `metadata.chunkStrategy` ('semantic' vs 'window').
3.  **Window Parameters**:
    - `WINDOW_SIZE`: 1000 characters.
    - `WINDOW_OVERLAP`: 500 characters (50%).
4.  **Deduplication**:
    - If a Window Chunk is identical (or nearly identical) to a Semantic Chunk, we should rely on the Unified Graph's existing Deduplication logic to prevent bloat. *However*, we should ensure the *metadata* reflects the primary strategy (Semantic preference).

## 3. Architecture Changes

### 3.1. `ChunkingLogic.ts`
Add a new method `slidingWindowChunk`:

```typescript
static slidingWindowChunk(text: string, windowSize: number = 1000, overlap: number = 500): string[] {
    // Standard sliding window implementation
}
```

### 3.2. `IngestionPipeline.ts`
Update `chunkText` or the ingestion flow to return a structured object:

```typescript
interface Chunk {
    text: string;
    strategy: 'semantic' | 'window';
}

public chunkTextMultiResolution(text: string): Chunk[] {
    // 1. Semantic Chunks
    const semantic = ChunkingLogic.chunkText(text).map(t => ({ text: t, strategy: 'semantic' }));
    
    // 2. Window Chunks (Only if text is large enough)
    const window = ChunkingLogic.slidingWindowChunk(text).map(t => ({ text: t, strategy: 'window' }));
    
    return [...semantic, ...window];
}
```

### 3.3. `UnifiedGraphManager` Integration
When creating nodes from chunks, inject the `strategy` into `metadata`.

## 4. Test Strategy
### `ChunkingResolution.test.ts`
1.  **Verify Sliding Window**:
    - Input: "ABC...Z" string.
    - Assert: Chunks overlap correctly.
2.  **Verify Multi-Resolution**:
    - Input: Multi-paragraph text.
    - Assert: Returns both Paragraph chunks AND Window chunks.
3.  **Verify Integration**:
    - Ingest large text.
    - Verify Nodes created in storage have `chunkStrategy` metadata.

## 5. Risks & Mitigation
- **Risk**: Explosion of nodes (2x storage).
- **Mitigation**: 
    - Deduplication (UnifiedGraphManager) handles exact matches.
    - Window Chunks are only generated for text > `WINDOW_SIZE`.
    - `ResonanceEngine` ensures relevant nodes surface regardless of strategy.
