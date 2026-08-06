# Round 5 — narrow re-check of the component-first placement rewrite

**Reviewer:** Grok 4.5 (`cursor-grok-4.5-medium`) via Cursor · **Date:** 2026-08-06
**Note:** transport reconnects at the head of this log are cursor-agent retries, not review content.

---

Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...
Retry attempt 1...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 2)...
Retry attempt 2...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 3)...
Retry attempt 3...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 4)...
Retry attempt 4...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 5)...
Retry attempt 5...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 6)...
Retry attempt 6...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 7)...
Retry attempt 7...
Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 8)...
Retry attempt 8...
# Round 5 — narrow re-check (incremental placement + viewer read path)

**Reviewer:** Grok 4.5 · prior: `docs/reviews/durable-map-state-r4-grok.md`  
**Scope:** §3.3–§3.6, related §10 criteria, §11 Slice 1 · verified against `viewer/template.html`, `graphStore.ts`, `export-viewer.ts`, and live `graphs/big` (plain SQL / raw vec blobs; sqlite-vec segfaults in this env as in r4).

---

## Did r4’s blockers hold?

| r4 finding | Judgment |
|---|---|
| Ladder (b) scatters / dead-codes (c) | **Scatter fixed** (component-first). **Dead-code pattern returns** — see below. |
| §3.5 vs §11 export revoke | **FIXED** — §11 now requires `layout` on `exportViewer`. |
| §3.5 per-node apply vs §3.4 | **FIXED** — completeness gate; incomplete ignores all layout. |
| Incremental force knobs | **FIXED** — constants, one-sided A, N↔N, all visible springs. |
| `view` on partial layout | **FIXED** — §3.6 single rule. |
| `knnNodes` private | **Half-fixed** — cites `querySimilar`, then invents a call that API does not accept. |

Topology numbers in §3.3.1 still match live data: **N=28**, **1 component**, **2 links into A**, **92.9% / 89.7%** node-level no# Round 5 — narrow re-check (incremental placement + viewer read path)

**Prior r4:** layout not buildable — (b) starved (c) / tore documents; §3.5 fought §3.4 and §11; incremental knobs and partial-`view` missing.

**This rewrite:** viewer read path and the big r4 structural holes are fixed. The **new** placement ladder carries the same class of defect again: a later rule that cannot fire under the stated constants on the live graph, plus a call shape that is not the store API, plus an acceptance row that can go green while that is true.

---

## Did r4 blockers hold?

| r4 issue | Now |
|---|---|
| (b) scatters per-node; (c) dead | Scatter fixed by component-first. **(c) dead again** under `k=25` / `0.60` (below). |
| §3.5 vs §3.4 mixing | **FIXED** — completeness first; incomplete ignores all layout (`:197-206`). |
| §3.5 vs §11 export | **FIXED** — §11 explicitly adds `layout` (`:512`). |
| Incremental physics / `idx` | **FIXED** — constants pinned; jitter by rowid-in-C (`:105-122`). |
| Partial `view` | **FIXED** — §3.6 always `N = lacking ∩ visible` (`:212-218`). |
| Seed index / `∩ visible()` | Still hold. |

Topology re-measured on `graphs/big` (plain sqlite; harness segfaults on sqlite-vec as in r4): **N=28, 1 component, 2 links into A, 3 anchors, 92.9% / 89.7% node-level rates** — matches §3.3.1. Under **component-first**, last-doc takes **(a)**, not fallback.

---

## Findings (most severe first)

### 1. CRITICAL — CONFIRMED: rule (c) is unreachable on the live corpus with the stated (b) knobs

§3.3(b)–(c) (`:99-104`) and the claim that the floor lets (b) decline (`:155-156`).

Measured every doc-exclusive component on `graphs/big` that **misses (a)** (6 components, sizes 1–31):

| knobs | (b) | (c) |
|---|---|---|
| **`k=25`, floor=`0.60` (as written)** | **6** | **0** |
| exhaustive nearest-in-A, `0.60` | 6 | 0 |
| `k=25`, floor=`0.75` (connect’s default) | 2 | 4 |

Pairwise visible cosines (sample): median **0.537**; frac ≥ 0.60 ≈ **17%**. Best-to-A for every (a)-miss component is still **≥ 0.616**, so the floor never declines. At `k≥10`, top-k always contains an A hit for those components.

**Failure:** implementer ships the three-rung ladder; (c)’s bbox / golden-angle path is dead in production. Same pattern as r4’s unreachable rung — fixed scatter by making (b) per-component, then chose constants that starve (c) again. §3.3.1’s “floor so it can decline” is **false on the graph the doc cites**.

---

### 2. CRITICAL — CONFIRMED: §3.3(b)’s `querySimilar` call is not the store API

Spec (`:100-101`, `:158-159`):

```text
querySimilar(text, {k: 25})
```

Code (`src/store/graphStore.ts:265-268`):

```ts
querySimilar(vector: Float32Array, k: number, filters: { index: "quarantine" | "shared" })
```

No `text` argument, no options object, **index tier required**. Prior round: cited private `knnNodes`; this round: cites the public name but invents a signature. Also unspecified: vector source (`vectorOf` vs re-embed), so `tessera view` may or may not need an embedder.

**Failure:** two “conforming” ports — one invents an overload / always quarantine / `vectorOf`; one re-embeds and picks `shared` — disagree on every (b) seed; neither matches the text literally.

---

### 3. HIGH — CONFIRMED: acceptance can pass while (c) is dead / cohesion knobs are not evaluable

§10 (`:468-476`) + §3.3.1 (`:161-165`):

- “each seeding rule (a)/(b)/(c) is exercised by at least one component in the fixture” — a **hand-built** fixture can force (c) (e.g. mock empty A-hits) while **production** `k=25`/`0.60` never reaches (c) on `graphs/big`. Passes while finding #1 is present.
- “centroid within **1.5× the seed radius** of `seedPoint`” — (c) defines `r = 220+60*j`; **(a) and (b) define no seed radius** (`:97-102`). Fixture must exercise (a)/(b), so this assertion is undefined for the rules that actually fire on the drop-file case (last-doc → (a)).
- “comparable existing clusters” — undefined (size? component cut?).

Ring-rate blindness was fixed in prose; the replacement still has a green-path while the ladder defect remains.

---

### 4. MEDIUM — CONFIRMED: `j = component index` has no stable order

§3.3(c) (`:103-104`). Partition step (`:94`) does not order components (e.g. by min rowid). Two DFS/BFS orders → different `θ` / `r` whenever (c) runs (fixture or future constants). Determinism hole next to an already-dead branch.

---

### 5. MEDIUM — CONFIRMED (weaker revoke): §11 “Ships with” drops the placement-discriminating tests

§11 Slice 1 (`:512-513`) ships geometry / poisoned / additive / no-op only. Omits §10’s cohesion row, mixed-layout, layout-in-bundle, provenance-unlaid — while the slice **includes** anchored incremental settle and §3.4/§3.5. Not as blunt as r4’s “export unchanged,” but under “§11 governs,” the only test §3.3.1 says can police scatter is outside the governing checklist.

---

### HYPOTHESIS — §3.5 “absent-keyed → incomplete” vs provenance

`:194-195` says absent keys are what §3.4 reads as incomplete. Provenance is **deliberately** absent until slice 4 (`:126-130`). §3.4 correctly scopes to the **visible** set (`:169-174`). A skim that tests completeness over all `GRAPH.nodes` always falls back. Geometry-preservation should catch that; still a footgun in the new wording.

---

## What is actually clean

- **§3.4 / §3.5 / §3.6 read + writer path** — one completeness decision; incomplete ignores layout; bootstrap / incremental / empty-N covered; export carries `layout` in slice 1. This is implementable and matches `template.html:240-254` (settle moves everyone; no re-seed at `:242`).
- **Component-first** — correct diagnosis vs measured last-doc topology; (a) owns the dominant drop case.
- **Physics block** — constants, one-sided A, N↔N, all visible-endpoint springs: enough to write one incremental stepper.
- **Prior seed-index / `∩ visible()` / RELATED-only divergence** — held or fixed.

---

## Slice 1 implementable from this text?

**No.**

You can implement the **viewer all-or-nothing read path** and **CLI layout I/O** from §3.4–§3.6 + §11. You cannot implement a single correct **§3.3 seeding ladder** without inventing the real `querySimilar` call (vector + `k` + index), inventing whether (c) exists under `0.60`/`k=25` (measurement says no), and inventing “seed radius” / “comparable clusters” for the acceptance tests that are supposed to lock it.
