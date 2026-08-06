# Round 4 — targeted re-check of the rewritten layout section

**Reviewer:** Grok 4.5 (`cursor-grok-4.5-medium`) via Cursor · **Date:** 2026-08-06
**Scope:** did round-3 fixes hold, and attack the NEW material introduced by those fixes

---

# Targeted re-check — durable map state design (post–round-3 revision)

**Reviewer:** Grok 4.5 · prior findings in `docs/reviews/durable-map-state-r3-grok.md` · revised `docs/durable-map-state-design.md`

**Verdict:** Prior criticals on seed index and provenance-in-`N` are genuinely fixed. The **new** layout material is **not** ready: the seeding ladder as written either dead-codes component seeding or tears new documents apart, §3.5 fights §3.4 and §11, and incremental settle still isn’t one implementable algorithm.

---

## 1. Did the fixes hold?

| # | Prior finding | Judgment | Notes |
|---|---|---|---|
| 1 | Seed index over visible list | **FIXED** | §3.2 now requires full-list seed indices, forces on visible only, “never reindex after.” Matches `template.html:198-215`. |
| 2 | `N` includes provenance | **FIXED** | `N = nodesLackingLayout() ∩ visible()` with explicit 211-node rationale. |
| 3 | Empty `nbrs∩A` → ring | **FIXED as a gap** / **new design broken** | Ladder (b)/(c) added; measured 92.9% figure kept. See job 2 — the replacement mechanism is underspecified and self-defeating. |
| 4 | `exportViewer` never carries layout | **STILL BROKEN** (under governing §11) | §3.5 requires `layout` in the bundle; §11 Slice 1 says “`file://` export unchanged” and §11 wins on conflict. Default `tessera view` → `exportViewer` (`scripts/cli.ts:109-112`, `export-viewer.ts:35`) still has no path to stored layout in the slice that claims geometry preservation. |
| 5 | Mixed layout undefined | **FIXED**, then **undercut** | §3.4 all-or-nothing is clear and correct vs `settle()` at `:240-254`. §3.5’s “apply `GRAPH.layout[id]` in place of seed” reintroduces per-node mixing — see below. |
| 6 | `content_key` drops `focus_node` | **FIXED** | Key includes `focusNode`; NUL separators; `scale.toFixed(6)`; tests added. |
| 7 | Framing math | **FIXED** | Equations map to `toScreen` / `centerOn` (`template.html:261`, `:441`). `ε` still unnamed (minor). |
| 8 | Incremental knobs | **PARTIALLY FIXED** | Jitter formula + RELATED springs stated. Ring position, `idx(n)`, incremental force schedule, A–N spring mass still missing. |
| 9 | `PUT /scenes` conflict | **FIXED** | All-or-nothing 409, nothing applied. |
| 10 | `connect.ts:64` citation | **FIXED** | Now `connector.ts:549`. |

**Prior hypotheses:** CLI↔serve lock → **FIXED** (§9). Geometry-test shared wrong seed → **FIXED** (§10). Host/`localhost` oddities → **unaddressed** (out of new-material scope).

---

## 2. Attack the new material (most severe first)

### CRITICAL — Seeding ladder (b) preempts (c); dominant drop-file case is mis-handled

**CONFIRMED** against `graphs/big` topology + spec text.

Last-document exclusive entities (faithful drop-file proxy): **N = 28**, **26/28 (92.9%)** have no RELATED neighbour in A; the 28 form **one** RELATED component; only **2** link into A. Visible edges are all `RELATED` (416). Matches §3.3.1.

Ladder order (§3.3):

1. (a) graph anchor — misses ~93%
2. (b) “nearest node in A by cosine” — **no similarity floor**
3. (c) component seed at bbox centroid — only if (b) doesn’t apply
4. (d) ring

If (b) means true nearest-in-A, it **always applies** whenever `A ≠ ∅` and embeddings exist (`putNode` always inserts `vec_node_quarantine`, `graphStore.ts:221`). Then **(c) is dead code**, and the one coherent newcomer component is seeded at **28 different A positions**. N↔N springs may partially reclump in 500 iters; that is hope, not a spec. This recreates the “park newcomers wrong” failure D1 was meant to fix, just inside the map instead of on the ring.

If (b) means the parenthetical literally — `knnNodes` then filter to A — behaviour depends entirely on **unspecified `k`**:
- small `k` → top hits are other newcomers → fall through to (c) (accidentally good for this corpus)
- large `k` / exhaustive → same as true nearest-in-A (tears the component)

Two engineers, two maps. The acceptance target “ring-fallback **&lt; 10%**” (§3.3.1, §10) is **checkable but blind**: both the tear-apart (b) implementation and the (c) clump can post ~0% ring while placing documents completely differently. “Within existing bbox” also passes under scatter.

Also **CONFIRMED:** `knnNodes` is **private** (`graphStore.ts:129`); public API is `querySimilar` (`:265-278`). “a `knnNodes` call the store already supports” is false as written.

**Failure scenario:** Drop a new doc after `view`. Implementer A uses nearest-in-A → entities sprayed across the map. Implementer B uses `k=5` filter → component centroid. Both meet “ring &lt; 10%”. Scenes and mental map diverge.

---

### CRITICAL — §3.5 vs §11: layout still doesn’t reach the default viewer in Slice 1

**CONFIRMED** document self-conflict.

- §3.5: `exportViewer()` must add `layout`; otherwise geometry-preservation / poisoned-layout are unimplementable on the path that matters.
- §11 (governs): Slice 1 ships with “`file://` export unchanged.”
- Reality: `exportViewer` emits `{nodes, edges, name}` only (`scripts/export-viewer.ts:35`); `tessera view` is that path (`cli.ts:109-112`).

**Failure scenario:** Slice 1 writes SQLite layout; user opens `graphs/…/view.html`; viewer never sees coordinates; always fallback-settles; F-2’s migration window is fiction for the actual UX. Same door as prior finding 4 — prose moved to §3.5, slice plan revoked it.

This is the “security fix that broke our client” class: a good-faith fix section contradicted by the governing cut.

---

### HIGH — §3.5 per-node layout apply vs §3.4 all-or-nothing

**CONFIRMED** contradictory instructions.

§3.4: decision is once over the whole visible set; any missing → full in-browser `settle()`, use nothing stored.

§3.5: “applies `GRAPH.layout[id]` at construction *in place of* the seed formula, and `rebuild()` skips `settle()` when completeness passes.”

Competent readings:

1. Per-node: use layout if present, else seed; settle only if incomplete → **settle moves everyone** (`template.html:240-254`), including nodes that started on stored coords → fallback trajectory ≠ pure-seed fallback; additive map depends on which subset was stored.
2. Completeness gate only: ignore all layout when incomplete → then “in place of seed” must not run per-node. Spec doesn’t say that.

**Failure scenario:** Crash leaves 10/387 missing. Viewer applies 377 stored positions + 10 seeds, then `settle()` — anchored nodes move. Or two engineers pick (1) vs (2); mixed-layout test (§10) can pass one and fail the other depending on assertion shape.

---

### HIGH — Incremental settle still not one algorithm

**CONFIRMED** underspec (new text added length, not closed knobs).

Missing, load-bearing:

| Knob | Why it matters |
|---|---|
| Force constants / `alpha` / damp / iteration count for §3.3 | §3.2 pins them for the full port; §3.3 only says “`iterations` steps.” |
| A–N spring: force on N only at 1× or 2× | A is infinite mass; equal-opposite vs one-sided changes rest-length behaviour. |
| `idx(n)` for jitter | Full `rowid` index vs index-in-`N` vs component-local → different seeds. |
| Component offset formula | “offset per component index so components don’t overlap” — no distance/angle. |
| Ring seed formula | (d) still has no `x,y` rule. |
| “usable neighbour” in (c) | Undefined relative to (a)/(b); circular. |
| Cosine threshold / `k` for (b) | Decides whether (c) exists. |

**Failure scenario:** Two “conforming” incremental settlers disagree on every drop; additive byte-identical test only covers A, not N placement.

---

### HIGH — `tessera view` on partial layout undefined (F-2 hazard)

**CONFIRMED** gap in new writer story.

§8/§11: `view` “settles + persists layout.” §10: second `view` with no graph change no-ops. No rule for “some visible rows present, some missing” (ingest-before-view; batch crash — though batch txn makes crash all-or-nothing for that write, ingest-before-any-view is still mixed).

If `view` naively runs the §3.2 full settle whenever anything is lacking, it **moves all of A** and rewrites geometry — voids F-2.

**Failure scenario:** User ingests before first `view` (newcomers + old nodes lacking layout, or only newcomers after a weird path) → `view` full-settles → later scenes/export framed against a different map than an incremental-only path would produce.

---

### MEDIUM — §7.4 still says `newNodes` after renaming to `laidOut`

**CONFIRMED** leftover footgun.

§7.1: `{ …, laidOut }` with explicit “not `newNodes`” rationale.  
§7.4 SSE `done`: still `newNodes`.

**Failure scenario:** Client watches SSE for `laidOut`, server sends `newNodes` (or the reverse). Same class of bug Codex flagged last round; half-fixed.

---

### MEDIUM — Framing equations mostly good; `ε` and viewport source still soft

**CONFIRMED** mostly fixed; residual:

- `ε` unnamed — single-anchor path still yields `scale = storedScale` for any reasonable `ε`, so low practical risk.
- Restore uses `W`/`H` — must be canvas size at restore time; not stated (today’s camera uses live `W`/`H`).

Not blocking like the ladder.

---

### MEDIUM — Duplicate `### 3.5` headings

Editorial, but implementers citing “§3.5” will collide (layout-to-viewer vs timing numbers).

---

### LOW / HYPOTHESIS — `RESONATES_WITH` springs

On `graphs/big`, visible endpoint edges are **only** RELATED. After `connect --commit`, `RESONATES_WITH` exists in the type system (`schema.ts:65-67`, `CONNECTIVE_KINDS` in `paths.ts:25`). Incremental springs are RELATED-only; full browser settle uses all visible `EDGES`. **HYPOTHESIS:** post-connect incremental placement ignores resonance springs that the full settle would use. Not hit on current `big`.

---

### HYPOTHESIS — Embedding quality of (b)

Could not re-measure cosine-to-nearest-A: `Graph.open("big")` segfaults in this environment (sqlite-vec). Topology + ladder logic above do **not** depend on that. If a threshold is later added, it must be measured; connect’s `--floor 0.75` is a plausible but unvalidated candidate.

---

## 3. What held / what’s newly sound

- Full-graph seed + visible forces (§3.2) — correct vs `template.html:198-215`.
- `∩ visible()` on `N` — correct; provenance left unlaid until slice 4.
- All-or-nothing read policy intent (§3.4) — right diagnosis of current `settle()`.
- Framing formulas (§4.2) — implementable to one camera.
- `content_key` + `focus_node` (§5) — closes prior silent merge.
- `PUT /scenes` all-or-nothing; CLI/serve lock; upload `display` opts; temp sweep — prior holes closed.
- Test plan now pins full-graph seed, provenance-unlaid, ring-dominant path, `focus_node` split — directionally right; ring-rate metric is too weak to police (b) vs (c).

---

## 4. Is the layout section buildable as written?

**No.**

You could build the **verbatim full settle port** (§3.2) and the **store API** (§3.1) from this doc. You could **not** build a single, correct **incremental settle + viewer read path** without inventing: (b)’s success criteria / threshold / `k`, whether (c) ever runs, incremental force equations, `view` on partial layout, and whether Slice 1 changes `exportViewer` (§3.5 vs §11).

**Minimum before Slice 1 code:** resolve §3.5↔§11; make §3.5 obey §3.4 (no per-node layout when incomplete); fix the ladder so (c) owns disconnected newcomer components (threshold or reorder); pin incremental constants and `idx`; define `view` on partial maps; fix SSE `laidOut`.
