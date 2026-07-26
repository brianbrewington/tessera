# Answers — tessera viewer chrome questions

Responses to `QUESTIONS.md` from the handoff, grounded in tessera's actual data model. Each answer is tagged:
**[now]** = build in the tracer bullet · **[seam]** = backlog the feature but hold this joint so we're not
cornered · **[call]** = Brian's product decision (recommendation given).

The tracer-bullet cut for the chrome is **the detail panel + idle** (screens `1b`–`1e`). Scenes/tours are
tracer+1. Semantic zoom, annotations, and readings are the larger frame — backlog, seams noted.

---

## A. Blocks the panel — answer now

- **A1 (deep-inspect width).** **(a) widen 396→470, as mocked.** The map is a full-bleed canvas *under* an
  overlay panel; it never reflows regardless of panel width. Free. **[now]**
- **A2 (occlusion / pan-on-select).** **(a) yes.** The renderer already exposes the camera (`centerOn(n)` sets
  the pan offset today), so nudging a selection into the free area left of the panel is trivial — no new API. **[now]**
- **A3 (multiple edges between two nodes).** **(a) one edge per pair, today** — entity↔entity has a single
  `kind` (`RELATED`), so a pair has one edge carrying *many reasons* (assertions), not many edges. But the
  discovered-taxonomy work will introduce typed kinds, at which point it becomes **(b)**. So: build (a), and
  leave room in the edge-panel header for a kind switcher later. **[now = a; seam for b]**
- **A4 (long labels).** Node labels are LLM-extracted entity names — typically 1–5 words; realistic worst
  ~**60 chars** (e.g. "Major Producers in the Region"). Descriptions are paragraph-length. Plan cards for ~60ch
  with ellipsis; the canvas already truncates labels at 34. **[now]**

## B. Scenes & tours — tracer+1, light seams

- **B1 (ownership).** **(a) per-graph.** Graphs are named + persistent (`graphs/<name>/graph.db` + `meta.json`);
  a scene references node/edge GUIDs that exist in exactly one graph. Store scenes in that graph's sidecar. **[call → a]**
- **B2 (tour stops).** **(b) ad-hoc camera, promotable to a scene.** More flexible, matches capture-in-place;
  a stop just needs `{camera, filters, selection?, narration}`. **[call → b]**
- **B3 (narration length).** **(a) 280 now**, (c) move-into-panel is the graceful later upgrade. **[call → a]**
- **B4 (timing).** **(a) 8s now**, (b) derive-from-narration later. **[call → a]**
- *Seam:* scenes/tours need only stable GUIDs + `camera{x,y,zoom}` + a filters object — all exist. No corner.

## C. Semantic zoom (turn 2 — the deferred pyramid) 

The Church-in-Kansas pyramid (rank-normalized prominence per tile, `get_tile`) is designed but deferred.

- **C1 (cluster/community labels).** **(c) skip the continent tier for now; start at country.** No clustering
  pass exists — communities aren't computed. The degree-thresholded tiers (≥14 / ≥10 / ≥7) work on our data
  **today** (degree is live). The continent tier needs a clustering pass — same machinery as the
  discovered-edge-taxonomy backlog item. **[seam: start at country now; communities backlog]**
- **C2 (tier trigger).** **(a) zoom-only now.** Density-drop (b) needs a per-frame collision pass — defer. **[now = a]**
- **C3 (label collision).** **(b) accept overlap now.** (a) is the most expensive turn-2 item. **[backlog]**
- **C4 (minimap render).** **(a) re-render at low res on demand** — the renderer already draws all nodes; a
  small pass is cheap enough. **[near-term = a]**

## D. Annotations (turn 3 — net-new; the seams that matter most)

This is where "don't get painted into a corner" is load-bearing — it's net-new storage.

- **D1 (storage).** **(b) a separate sidecar table keyed by graph + element GUID.** Keep annotations OUT of the
  graph's replay-grade `mutation_log` — different lifecycle. **[seam: GUIDs are the keys; don't lose stable ids]**
- **D2 (agent writes).** **(b) live but marked unreviewed until accepted** — matches "read-only first, write
  earned." **[call → b]**
- **D3 (versioning).** **(b) append-only with history** — matches the append-mostly / verbatim principle. **[call → b]**
- **D4 (note mutates graph).** **(a) never, for now** — annotations sit beside the graph; graph mutations stay
  in the ingest/mapper path. (b) later via an explicit recorded action. **[now = a; seam for b]**
- **D5 (authors / visibility).** Single user today. **But add `author{kind,id}` + `visibility` fields from day
  one** even if unused — otherwise it's a migration later. **[seam]**
- **D6 (change feed).** **(c) refresh-on-action now** (single-user, local file); (b) `poll since=` later. **[now = c]**
- **D7 (citation handles).** Node/edge ids are opaque **UUID GUIDs**; the identity `text` string is stable+human.
  Make the citation ref **GUID-based** — `personas:n_<uuid8>` (e.g. `personas:n_60519e24`) — **not** a name-slug
  (`n_anele` collides: there are three source-qualified "Anele Sotashe" nodes, and names change). Carry the label
  separately for display. **[seam: GUID ref, not name-slug — this one is easy to get wrong]**

## E. Multi-valued edges / "readings" (turn 4 — partly real already)

We just shipped Option A (de-anchored reasons) + the multi-assertion model, which is the substrate for this.

- **E1 (reasons carry a date).** **(b) no today; (c) could add to extraction** (document date or in-text date).
  Without it the `temporal` conflict kind can't order, so defer that resolution. **[seam / backlog]**
- **E2 (first-hand vs summary).** **(b) not reliably knowable at extraction now** — a possible future signal. **[backlog]**
- **E3 (who computes readings).** Readings = clustering assertion embeddings — the discovered-taxonomy backlog
  item. **(c) both** eventually (cheap cluster at write, agent recluster on request). None exists yet — **but the
  seam is already in place**: assertions are individually stored with **de-anchored** embeddings, so clustering
  can be added later with zero re-ingest. **[seam already secured by Option A]**
- **E4 (`hasConflict` at graph scale).** **(b) selection-only** — per-edge conflict every frame is too costly
  until proven cheap; strands become a selection treatment. **[backlog = b]**
- **E5 (contested at altitude).** **(b) no — noise at altitude, as mocked.** **[call → b]**

## F. Nice to know

- **F1 (skip light theme).** **Agree — skip.** A light ground fights the graph; revisit only if these tokens
  travel to a document-shaped app. **[agree]**
- **F2 (other apps sharing tokens).** Your call — the mindmapper / memory-agent family are candidates; that
  decides whether the kit needs table/form/doc components. **[call]**
- **F3 (filters today).** Only **`provenance hidden`** (the `h` toggle). "Only people" is *not* implemented (I
  added person/other *coloring*, not a filter). So today's filter state is `{provenanceHidden: bool}` — but
  **serialize scenes against a filters *object*, not named booleans**, so adding filters later doesn't break
  saved scenes. **[now + seam]**
- **F4 (keyboard).** Current bindings: `Esc` (deselect), `h` (toggle provenance). No conflict with the proposed
  set (`S`/`N`/`⇧N`/`⌘⏎`/`←→`/`space`/`esc`) — just fold `h` into the eventual filter UI or keep it. **[now — no conflicts]**

---

## The seams to hold (so the tracer bullet doesn't corner us)

1. **Stable GUIDs are the reference for everything** — citations (D7), scenes, annotations. Never switch to
   name-slugs. (Already true; just don't regress.)
2. **De-anchored assertion embeddings** (Option A, shipped) — makes readings/clustering (E3) and the discovered
   taxonomy free later, no re-ingest.
3. **Filters as an extensible object**, so scenes serialize forward-compatibly (F3).
4. **Annotations: sidecar keyed by GUID, append-only, with `author{kind,id}` + `visibility` from day one** —
   decided now even though the feature is backlog, so it's never a migration (D1/D3/D5).
5. **Annotations never enter the graph `mutation_log`** — different lifecycle (D1/D4).
6. **Degree + strength drive the zoom tiers today; communities are a later clustering pass** (C1) — same
   machinery as the discovered edge taxonomy.
