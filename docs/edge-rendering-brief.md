# tessera viewer — edge rendering at scale (design brief)

*A handoff for Claude Design. Goal: a **visual language for edges** so a dense graph reads as *structure*, not a
hairball. The node treatment and the detail panel are already designed (see the earlier chrome brief); this is
specifically about the **lines between nodes** on the full-bleed canvas. Deliverable: mocks/specs we code against.*

---

## The problem (concrete)

tessera now links a persona to its own content, so a single persona is a **degree-39 hub**, and a multi-persona
graph runs to **hundreds of nodes and 1,000+ edges**. At anything but close zoom, every edge draws at roughly the
same weight, so the field turns to visual noise — you can't see *which connections carry the structure*. Zooming
out should reveal the skeleton (the important links); zooming in should bloom the detail. Right now it just gets
denser.

**Interim already shipped** (a floor to beat, not the answer): edges **fade and thin as you zoom out**
(`alpha = clamp(0.16 × zoom, 0.045, 0.30)`, width `0.7px`), firming up as you zoom in. It helps, but it treats
all edges equally — it doesn't encode which edges *matter*.

## What exists (unchanged, design around it)

A single self-contained HTML file renders the graph on an HTML `<canvas>` (no SVG/DOM per edge — there can be
thousands, so per-edge DOM is off the table for performance). Dark ground. Nodes are colored by a coarse bucket
(person vs. other), sized by degree; that stays. Design tokens (dark): ground `#0a0c11`, dim line
`rgba(230,233,239,.09)`, accent `#7aa2f7`, a resonance/conflict rose `#f7768e`, text `#e6e9ef`.

## What we can rank an edge by (real data, per edge)

- **`kind`** — `RELATED` (the semantic links), `RESONATES_WITH` (near-duplicate similarity, drawn rose today),
  `APPEARED_IN` / `ORIGINATED_FROM` (provenance — hidden by default; substrate, not structure), `REFERENCES`.
- **`weight`** (attestation) — how many times the same pair was independently asserted. Mostly `1` on a small
  corpus, **meaningful at scale** (a link stated across many chunks/docs is a stronger claim).
- **`reasons[]`** — an edge owns multiple facets ("is kin to" AND "shares a pursuit"); count is a richness signal.
- **Endpoint importance** — each node has a `degree` and `strength`; an edge between two hubs vs. two leaves is
  structurally different. (A hub-to-hub link is arterial; a hub-to-leaf spoke is a detail.)

## What to design

1. **An edge rank → visual encoding.** Map "importance" to opacity / width / color. Decide what *importance* is —
   attestation `weight`, or connecting high-degree nodes, or a blend — and show it reading at a glance without a
   legend. (The eye should find the arterial links first.)
2. **Edge level-of-detail by zoom.** Which edges are drawn at which altitude — at a distance, only the top-rank
   skeleton; detail blooms on zoom-in. This must **compose with the node semantic-zoom tiers** (a separate, later
   brief: continent → country → region → city → district → building) — edges and nodes reveal together.
3. **Hub legibility.** A degree-39 subject is 39 spokes from one point — a starburst that occludes everything near
   it. How should a hub's edges render so the hub reads as a landmark, not a blot? (Fan-out, halo, on-hover-only
   spokes, bundling…)
4. **Bundling / aggregation.** When many edges run between two clusters (persona A's world ↔ persona B's world),
   consider bundling them into a single weighted strand; expand on focus.
5. **Provenance edges**, when revealed (`h` toggles them on): they're substrate — render clearly *subordinate* to
   semantic edges (thinner, dimmer, maybe dashed) so they never compete with structure.
6. **States** (some exist): default, hover-edge (whitens + shows the reason tooltip), focus-neighborhood (the
   selected node's edges at full strength, the rest dimmed to ~18%). Refine these into the rank language.

## Constraints (real — the mocks must be codeable)

- **Canvas, not SVG/DOM.** Thousands of edges; everything is drawn per frame. Encodings must be cheap per edge
  (stroke style + width + a path). No per-edge filters/blurs that don't scale.
- **Undirected today.** `RELATED` and `RESONATES_WITH` are undirected (canonicalized). **Do not design arrowheads
  that imply a direction we don't have.** (Directed/typed edges are backlogged; if you want to show direction,
  flag it as needing that.)
- **Self-contained, offline, dark**, no external assets (strict CSP) — same as the rest of the viewer.

## Out of scope

Node rendering (color/size/labels — settled), the detail panel (designed), and the *node* semantic-zoom tiers
(their own brief). Edge-LOD should *compose* with those, but isn't redesigning them.

## Deliverable

Mocks / state studies for: **(1)** the rank encoding (a dense graph with the skeleton reading through — same
graph, low vs. mid vs. close zoom), **(2)** a hub-legibility study (the degree-39 subject), **(3)** provenance
shown vs. hidden, **(4)** the refined hover/focus states. Real data is available — I'll hand over a ~12-persona
graph (hundreds of nodes, 1,000+ edges) to mock against, not lorem.
