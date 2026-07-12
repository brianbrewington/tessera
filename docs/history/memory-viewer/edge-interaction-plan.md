# Edge Interaction Plan

## Problem

Edges carry rich metadata — label, description, weight, keywords — but are
currently non-interactive colored lines. Users have no way to discover or
inspect the relationships that connect nodes.

## Data available per edge (`SubgraphEdge`)

| Field         | Example                              | Notes                          |
|---------------|--------------------------------------|--------------------------------|
| `label`       | `"designed"`, `"depends_on"`         | Short relationship verb/noun   |
| `description` | `"Brian designed the felt-signal…"`  | Full prose, may contain `<SEP>`|
| `weight`      | `0.85`                               | 0–1, controls line thickness   |
| `keywords`    | `"memory, feedback, emotion"`        | Comma-sep tags                 |
| `source`      | `"Brian"`                            | Source node ID                 |
| `target`      | `"Felt-Signal Memory"`               | Target node ID                 |
| `embedding`   | `[0.12, …]`                          | Optional vector (omit from UI) |

## Proposed interactions

### 1. Hover tooltip (lightweight)

When the cursor hovers an edge, show a floating tooltip near the cursor:

```
  ╭──────────────────────────────╮
  │  designed           ⚖ 0.85  │
  │  Brian → Felt-Signal Memory  │
  ╰──────────────────────────────╯
```

**Implementation:**
- `onLinkHover` callback → store `hoveredEdge` in component state
- Render a small `position: fixed` div at cursor position
- Content: label (bold), weight badge, source → target
- Dismiss on mouse-out (onLinkHover receives `null`)

### 2. Edge highlight on hover

When hovering an edge:
- Increase edge opacity to full (override the `30` alpha suffix)
- Widen the edge slightly (e.g. +1px)
- Add a subtle glow via `linkCanvasObjectMode: "after"` to draw a wider
  translucent stroke behind the hovered edge
- Brighten the two endpoint nodes (set a transient flag the node painter reads)

**Implementation:**
- Store `hoveredEdgeRef` (like existing `hoveredIdRef` for nodes)
- `linkColor` callback checks if link === hovered → return full-opacity color
- `linkWidth` callback checks if link === hovered → return boosted width
- Optional: `linkCanvasObjectMode: "after"` + custom `linkCanvasObject`
  that draws a glow stroke only for the hovered edge

### 3. Click to inspect edge (primary interaction)

Clicking an edge opens the right panel in "edge inspect" mode, showing:

```
  ┌─────────────────────────────────┐
  │  ◎ designed              × │
  │  ──────────────────────────     │
  │  Source: [Brian]  → Target: …   │  ← clickable, navigate to node
  │                                 │
  │  DESCRIPTION                    │
  │  Brian designed the felt-signal │
  │  memory system, which captures  │
  │  user feedback in real-time…    │
  │                                 │
  │  WEIGHT                         │
  │  ███████████░░░░  0.85          │  ← visual bar
  │                                 │
  │  KEYWORDS                       │
  │  memory · feedback · emotion    │  ← pill tags
  └─────────────────────────────────┘
```

**Implementation:**
- Add `selectedEdge: SubgraphEdge | null` to `useGraphStore`
- Add `edgeInspectOpen: boolean` to store
- `onLinkClick` callback → `setSelectedEdge(edge)`, `setEdgeInspectOpen(true)`
- New `EdgeInspectPanel` component (or extend `InspectPanel` with a
  discriminated union — separate component is cleaner)
- Source/Target links are clickable buttons that call `setSelectedNode`
  to jump to that node's inspect view
- Description runs through `cleanSep()`
- Keywords rendered as styled pill tags

### 4. Right-click context menu for edges

A smaller context menu, similar to the node one:

```
  ┌────────────────────────┐
  │  designed               │
  │  ────────────────────── │
  │  ◎ Inspect Edge         │
  │  ⊛ Similarity Search    │
  │  ──────────────────     │
  │  → Go to Source Node    │
  │  → Go to Target Node    │
  └────────────────────────┘
```

**Implementation:**
- Add `edgeContextMenu` state to store (or unify with existing `contextMenu`
  by making it a discriminated union: `{ kind: 'node', … } | { kind: 'edge', … }`)
- `onLinkRightClick` callback → populate menu state
- Reuse `ContextMenu` component structure, swapping items for edge actions
- "Inspect Edge" → open EdgeInspectPanel
- "Similarity Search" → use `SimilarityAnchor.type = 'relationship'`
- "Go to Source/Target" → `setSelectedNode` + open inspect

### 5. Edge labels at high zoom (LOD extension)

At high zoom levels (globalScale > 2), render the edge `label` along the
midpoint of the edge line. Use the same LOD philosophy: only show labels
for high-weight edges, truncate long labels.

**Implementation:**
- `linkCanvasObjectMode: "after"` with a custom `linkCanvasObject` callback
- At the link midpoint, draw text rotated to align with the line direction
- Only render when `globalScale > 2` and `link.weight > 0.5` (tunable)
- Font size scales inversely with zoom (like node labels)
- Text: `link.label`, truncated to ~20 chars

## Store changes summary

```typescript
// Additions to GraphState:
selectedEdge: SubgraphEdge | null
edgeInspectOpen: boolean
setSelectedEdge: (edge: SubgraphEdge | null) => void
setEdgeInspectOpen: (open: boolean) => void
```

## Component changes summary

| Component               | Change                                         |
|-------------------------|-------------------------------------------------|
| `ForceGraph.tsx`        | Add onLinkClick, onLinkRightClick, onLinkHover  |
|                         | Add hoveredEdge state + ref                      |
|                         | Update linkColor/linkWidth for hover highlight   |
|                         | Add linkCanvasObjectMode + linkCanvasObject      |
|                         | Expose onEdgeRightClick via props                |
| `NodeGlow.ts`           | No change                                        |
| `GraphViewer.tsx`       | Handle edge right-click, render EdgeInspectPanel |
|                         | Render edge context menu variant                 |
|                         | Wire edge-click → edgeInspectOpen                |
| `EdgeInspectPanel.tsx`  | New component for edge detail view               |
| `ContextMenu.tsx`       | Extend to accept edge context (or new component) |
| `stores/graph.ts`       | Add selectedEdge, edgeInspectOpen + setters       |
| `FilterSidebar.tsx`     | No change                                        |

## Suggested implementation order

1. **Store** — Add edge selection state
2. **Hover tooltip** — Quick win, immediately surfaces label + weight
3. **Click inspect** — EdgeInspectPanel with full details
4. **Hover highlight** — Visual feedback (opacity, width boost)
5. **Right-click menu** — Edge-specific context actions
6. **Edge labels at zoom** — LOD-aware label rendering on canvas

Steps 1–3 are the core value; 4–6 are polish.

## Open questions

- Should edge inspect replace the node inspect panel, or stack beside it?
  → **Replace**: only one right panel at a time keeps the UI clean.
- Should we unify the context menu component or keep node/edge menus separate?
  → **Unify with discriminated union**: less code duplication, same visual style.
- Should edge hover highlight also dim non-connected nodes (like query mode)?
  → **No**: that's too heavy for a transient hover. Just boost the edge itself.
