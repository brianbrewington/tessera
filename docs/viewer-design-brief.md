# tessera viewer — design brief

*A handoff for Claude Design. Goal: mocks we can code against for the viewer's **chrome** — a
Google-Maps-style side panel that shows details on whatever you clicked, plus two navigation aids we're
calling **scenes** and **tours**. The graph rendering itself already exists and is **not** what we're
redesigning; design the interface *around* it.*

---

## What tessera is (one paragraph)

tessera is a named, persistent **knowledge graph** built from documents — personas, chat transcripts, code,
book chapters — via LLM entity+relation extraction. You keep one graph per domain (a `personas` graph, a
`book-ideas` graph). The **viewer** renders a graph as a browsable map: nodes are entities (people, places,
concepts), edges are relationships, and every edge carries a plain-language *reason* it exists. It's meant to
be explored the way you explore a map — pan, zoom, click a landmark, follow a route.

## What already exists (don't redesign this)

A single self-contained HTML file renders the graph on a full-bleed HTML `<canvas>`:

- **Dark ground**, force-settled static layout (nodes don't jitter). Pan by dragging, zoom by scroll.
- **Nodes** colored by a coarse bucket (person vs. everything-else today; more colors added deliberately),
  sized by how connected they are. **Edges** are thin lines; hovering one shows its reason in a tooltip.
- A **right-side panel** slides in on click (this is the thing we're redesigning), a bottom-right **legend**,
  and a bottom-left **help** line.
- Left-click = focus a node and highlight its neighborhood. **Right-click = deep-inspect** a node or edge.

Current color tokens (dark theme): ground `#0b0e14`, text `#e6e9ef`, dim text `#8b93a7`, accent `#7aa2f7`,
person `#e0af68`. The design can propose its own system, but it must work over a dark, full-bleed canvas.

## The layout we want (the Google-Maps mental model)

Brian's reference is Google Maps: a **persistent side panel** that does two jobs at once —

1. **Details on the thing you clicked** (Maps' "place card": name, photo, hours, reviews, actions).
2. **Navigation aids** that live alongside it (Maps' directions, saved lists, "your places").

We want that same split for tessera. The map stays full-bleed; the panel is the operating surface. Design the
panel's information architecture, states, and the two nav aids below.

---

## Surface 1 — the detail panel (node & edge inspector)

When you select a node or an edge, the panel shows its details. The data that exists per element (design
against these real fields):

**A node** (e.g. the person *Anele Sotashe*, or the place *Klipgat Farm*):
- `label` (display name), `type` + `subtype` (e.g. `CONCEPT / place`), a `strength` (how many times it was
  reinforced across the corpus), a `degree` (how many connections), and a self-contained `description`.
- **Provenance**: which source document + chunk it appeared in (e.g. "appears in: chunk 4 of *Anele Sotashe*").
- **Connections**: its neighbors, grouped by relationship kind (`RELATED`, `APPEARED_IN`…), each with the
  reason for that link (e.g. "Anele tends a community garden plot in Khayelitsha"). Each neighbor is a chip you
  click to walk to it.

**An edge** (e.g. *Klipgat Farm ↔ De Doorns*):
- Both endpoints, the `kind`, a `weight` (attestation strength), and **every** reason recorded for it (an edge
  can accumulate several — e.g. two documents each explaining the same link differently).

*Design question for you:* how do the "brief focus" (left-click) and "deep inspect" (right-click) states differ
visually, or should they be one progressive panel? How do node vs. edge details share one panel gracefully?

## Surface 2 — scenes (saved views)

A **scene** is a saved state of the map — like a pinned place or a saved Street View. It captures: the camera
(pan + zoom), which filters are on (e.g. "provenance hidden", "only people"), and the current selection.
You save a scene, name it ("The De Doorns cluster"), and return to it later in one click.

Design the **scene rack**: how saved scenes are listed, created, named, reordered, and restored. Think Google
Maps "saved lists" or a browser's bookmarks bar — lightweight, glanceable, always one click from the map.

## Surface 3 — tours (guided walkthroughs)

A **tour** is an **ordered sequence of scenes with narration** — a guided path through the graph, like a Google
Earth tour or a museum audio guide. You assemble scenes in order, add a sentence of narration to each stop, and
then *play* the tour: the camera flies from stop to stop, the panel shows each stop's detail and narration, and
the viewer can step forward/back or autoplay.

Design the **tour authoring** experience (assemble + reorder scenes, write narration per stop) and the **tour
playback** experience (the "now playing" chrome: current stop, narration, progress, next/prev/play controls).

*This is the most novel surface — Maps doesn't quite have it. The nearest analogs are Google Earth's guided
tours and a slide-deck's presenter mode, applied to a graph.*

---

## Constraints (real — the mocks must be codeable)

- **Single self-contained HTML file, offline.** No external assets — no CDN fonts, no remote images (a strict
  CSP blocks them). Anything the design needs must be inline (system font stack today; an inlined face is fine).
- **The graph is a full-bleed `<canvas>` underneath.** The panel and nav aids are HTML/CSS *over* it. The design
  is the chrome, not the graph rendering.
- **Dark theme is current**, but propose a considered palette; a light theme is welcome if it earns its keep.
- **Vanilla HTML/CSS/JS** (no framework in the viewer today). Keep the design implementable in plain markup.
- Treat all node/edge text as **model-generated** — it's escaped before display; the design shouldn't assume
  short, clean strings (descriptions can run a paragraph; some labels are long).

## Out of scope

The graph rendering (nodes/edges/layout/colors — being handled separately), the extraction pipeline, the data
model, and semantic-zoom (how detail blooms as you zoom — a separate, deferred design).

## Deliverable

Mocks / state studies we can code against, ideally covering: **(1)** the panel with a node selected, **(2)** the
panel with an edge selected, **(3)** the scene rack with a few saved scenes, **(4)** tour authoring, **(5)** tour
playback ("now playing"), and **(6)** the empty/idle state (nothing selected). Plus any open questions back to us
— we'll come back with the mocks and code against them.
