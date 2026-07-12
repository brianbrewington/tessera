# Graph Store Spec Review

The load-bearing bets are right: two-tier vectors, `promote` as the trust choke-point, rank-in-tile not `min_strength`, Store-owned breaker, mutation log. What bites before build is mostly **underspecified seams that already contradict each other on paper** — especially user→durable without shared, concurrency without `expectedVersion`, and `getTile` without coordinates.

---

## I LIKE

**§3–§4 two-tier + chicken-and-egg test (§7).** Quarantine-first is the real fix. The explicit test — `querySimilar(..., quarantine)` hits, `shared` misses, then `promote` makes `shared` hit — is the right CI gate.

**§4 `promote` as the only trust verb + §5.3.** Centralizing graduation in the Store (not Connector/Dream) is correct. Callers should not be able to write `status=durable` or insert into `vec_shared`.

**§5.5 / §6 rank-normalized tile budget.** Absolute strength cannot tile a pyramid; this is the conservation term the earlier plans needed.

**§2 single-writer + WAL + DTO copies (§5.1, §7).** Fits sqlite-vec; “no mutable internals” is cheap insurance.

**§5.4 / §7 replay + §7 schema migration.** Treating the file as long-lived from day one is the right fear.

---

## I WISH

### 1. User shortcut vs two-tier (§4 upsertNode vs §5.2–§5.3) — **blocker**

§4: new nodes default `proposed` unless `origin=user`. Embeddings always go to quarantine; shared only via `promote`. §5.3: `promote` is the **only** path to `durable`.

**Demo:**
```
upsertNode({ text: "my note", origin: "user" }, { actor: "brian", cause: "manual" })
// → status=durable (user shortcut), vector only in quarantine

querySimilar(embed("my note"), k=5, {}, "shared")
// → []   // durable user note invisible to RAG/viewer retrieval

getNode(id).status
// → "durable"
```

**Stronger version:** Delete the user status shortcut. `origin=user` means `promote(id, { type: "user" }, …)` is immediate (no citation / no N-resurfacings), and **that** transaction sets `durable` + copies quarantine→shared. One path, invariants hold, §7 chicken-and-egg covers user notes too.

---

### 2. Optimistic concurrency is named but not on the API (§3 `version`, §5.6, §4 verbs)

Every write “bumps `version`”; stale writes are rejected — but **no verb takes `expectedVersion`**.

**Demo:**
```
A: n = getNode(id)                    // version=1, text="α"
B: reinforce(id, +1)                  // version=2
A: upsertNode({ ...n, text: "β" }, …) // no expectedVersion

// Spec-legal outcomes today:
// (a) clobber text, version=3  → silent lost reinforce metadata / lost B’s intent
// (b) somehow reject          → but nothing in the call says what to reject against
```

**Stronger version:** Every mutating verb takes `expectedVersion: number` (or `undefined` only for create). Reject with typed `VersionConflict { id, expected, actual }`. `upsertNode` create path omits it; reinforce/promote/link-update require it. Add a §7 test: stale `expectedVersion` never writes, log unchanged.

---

### 3. Text change after embed, promote copies stale vector (§4 promote “copy”, §5.2)

**Demo:**
```
id = proposeNode({ text: "Paris is the capital of France" }).id
// quarantine has e1 = embed("Paris…")

upsertNode({ id, text: "Paris is the capital of Texas" }, { expectedVersion, … })
// if re-embed: quarantine ← e2; if not: still e1

promote(id, grounding, …)
// copies whatever is in quarantine → shared

querySimilar(embed("capital of Texas"), …, "shared")  // miss if copy was e1
querySimilar(embed("capital of France"), …, "shared") // hit ghost of old text
```

**Stronger version:** On any text (or assertion-reason) mutation: re-embed → quarantine; if `status=durable`, **same transaction** updates `vec_shared` (or demote→re-promote). Promote copies **current** quarantine row under a txn that also asserts `nodes.version`. Log the embedding bytes (or content-hash + embedding) in `mutation_log.after` so replay doesn’t call Embedder.

---

### 4. Cosine-only dedup can’t carry §5.7 / §7 re-ingest (§4 upsertNode)

**Demo (real Embedder, same string twice):**
```
upsertNode({ text: "Church in Kansas", provenance: { source: "notes/a.md" } }, …)
upsertNode({ text: "Church in Kansas", provenance: { source: "notes/a.md" } }, …)
// embedder float noise → cosine 0.987 < 0.99 → second node
// node count += 1, strengths both grow on further re-ingests → §7 fails
```

**Stronger version:** Primary dedup key = stable ingest identity (`provenance.content_hash` or `source_ref + span`), cosine > 0.99 as **secondary merge** for near-paraphrase. Re-ingest test must run against a **non-deterministic stub Embedder** (small gaussian noise), not only a fixed vector map.

---

### 5. `getTile(zoom, bbox)` with no spatial model (§4, §6, §8)

Nodes have no `x,y` / tile-id / layout generation. Resonator owns clustering in plan-v3, but the Store owns `getTile`.

**Demo:**
```
// 100 promoted CONCEPT nodes, strengths varied
getTile(zoom: 2, bbox: [0, 0, 1, 1], {})
// → always [] or always full graph
// because nothing assigns coordinates; bbox is meaningless
```

**Stronger version (pick one, write it in §3 + §6):**
- **A (Store-thin):** Store stores `layout: { x, y, zoom_min }` written only via `upsertLayout(id, pose, {expectedVersion})` (Resonator client). `getTile` = bbox filter then rank top-N among durable (+ optional proposed flag).
- **B (Store-fat):** Store owns a deterministic layout fn from sticky PATTERN + rank; document the coordinate system (embedding UMAP seed, force layout seed, etc.).

§7 tiling test must seed layout, not only strengths. Prefer **A** for v1 — keeps Store from owning ML layout.

---

### 6. Circuit breaker: thresholds without a meter + “all” vs “auto” (§4, §5.3, §7, §8)

§4: >5% pauses **auto**-promotion; >10% disables **proposal indexing**. §5.3: breaker over **ALL** promotions. No definition of hallucination sample, window, or what “proposal indexing” means.

**Demo A — user locked out:**
```
// seed 20 connector promotes, 2 labeled hallucinated → rate 10%
promote(userNoteId, { type: "user" }, …)
// if ALL: BreakerTripped — human cannot graduate their own note
// if auto-only: succeeds — but then §5.3 is false
```

**Demo B — >10% “disable proposal indexing” regresses the quarantine fix:**
```
breaker.rate = 0.11
proposeNode({ text: "fresh dream residue" })
querySimilar(embed(that), …, "quarantine")
// if indexing disabled = skip vec_quarantine write:
// → []  Connector cannot ground; chicken-and-egg returns
```

**Stronger version:**
- Meter: rolling window of last `N` **non-user** promote attempts; hallucination = promote rejected by grounding check **or** explicit `reportHallucination(id, evidence)` from a critic (not the generator). Rate = flagged / sampled.
- >5%: `autoPromoteEnabled=false` — Connector/Dream paths get `BreakerPaused`; **user promote still works**.
- >10%: `rejectProposeFrom={connector,dream}` (or enqueue-but-do-not-index policy explicitly chosen) — **do not** stop quarantine writes for user ingest; name the verb `BreakerTripped { level, allows: ["user"] }`.
- §7: seed the meter via test double, don’t leave “sampled” undefined.

---

### 7. Promote edge/assertion without durable endpoints (§3 edge_assertions, §4 promote)

**Demo:**
```
a = proposeNode({ text: "Lincoln…" })
b = proposeNode({ text: "Trump…" })
e = link(a, b, { kind: "RELATED", reason: "…", origin: "dream" })
promote(e.assertionId, { type: "dream", apt: true }, …)
// assertion → durable + reason vector in shared

querySimilar(embed(reason), …, "shared")  // hits
getNode(a).status  // still proposed
// RAG cites an edge whose endpoints are untrusted / may be prune()'d next
prune()  // deletes a,b past τ → dangling durable edge or cascade?
```

**Stronger version:** `promote(assertionId)` requires both endpoints `durable` (or promotes a set transactionally). `prune` either refuses to delete endpoints of durable assertions or cascades demote. Spell cascade rules in §5.

---

### 8. Replay vs Embedder (§4, §5.4, §7)

**Demo:**
```
// production run: upsertNode → Embedder returns v1; promote copies v1
export mutation_log
new Store(embedderStubReturningV2).replay(log)
// node text hash-equal, vec_shared ≠ original → §7 “hash-equal graph” fails
```

**Stronger version:** Replay is **embedding-closed**: apply `after` blobs (including vector columns) without calling Embedder. Live writes call Embedder; replay never does. Hash includes vec tables.

---

### 9. `expert_surprise` at the Store boundary (§3)

**Demo:**
```
link(a, b, { origin: "dream", reason: "…", expert_surprise: 3 })
// Store accepts → later graduation/promote policy trusts ≥2
// generating model laundered surprise through the sole authority
```

**Stronger version:** Store **computes** surprise structurally at `link` time (e.g. pre-edge embedding distance / hop distance) into the column; API does not accept client-supplied `expert_surprise`. Optional later: `setSurpriseFromCritic(id, score, criticId)` with `actor` ≠ generator.

---

### 10. `proposeNode` / `upsertNode` / `link` overlap (§4)

Three create paths; `origin` appears in prose but not in `upsertNode` options; `proposeEdge` vs `link` unclear.

**Demo:**
```
proposeNode({ text: "x", origin: "user" })  // proposed? or durable?
upsertNode({ text: "x" }, { actor, cause }) // origin undefined → proposed
link(a, b, { origin: "user" })              // edge durable immediately? vector shared?
```

**Stronger version:** One write family:
- `putNode(input, meta)` / `putEdge(input, assertion, meta)` always land `proposed` + quarantine embed
- `promote` only graduation
- Drop `propose*` or make them thin aliases

---

## I WONDER

| Wonder | Why it matters |
|--------|----------------|
| Does `getTile` include `proposed` in the top-N budget? | If yes, dream clutter starves durable LOD. If no, viewer needs a second API for dashed overlays. **Propose:** `getTile(..., { includeProposed?: boolean })` with proposed **not** counting against durable top-N (separate small cap). |
| Is `reinforce` prominence-only or does it touch Hebbian? | §4 promote “counts toward prominence + Hebbian” but Hebbian update rule is absent — Resonator will invent one. |
| Who writes `patterns` / `sticky_id`? | §7 requires stable pattern ids; §4 has no pattern verb. **Propose:** Resonator uses `putNode(type=PATTERN, sticky_id=…)` with dedup on `sticky_id`. |
| What is the unit of `promote(id)` — node, edge, assertion? | Typed unions now: `promote({ target: "node"\|"assertion", id, grounding })`. |
| Single-process “clients” vs logical races | WAL serializes OS threads; still need `expectedVersion` for read-modify-write across await points in TS. |

---

## Positions on §8 (stronger defaults)

### Two sqlite-vec tables vs one + `tier` column

**Prefer two tables (`vec_quarantine`, `vec_shared`).**  
Promotion is a **copy into a different trust domain**, not a row update. A `tier` column invites `UPDATE … SET tier='shared'` bypasses and complicates “shared ONLY via promote.” Double-write cost is one insert on promote; correctness > micro-optimizing.

Mitigate staleness with: **one SQLite transaction** for `status` + vec copy; text edits update both tiers when durable (see wish #3).

### Embedder boundary

**Inject Embedder into the Store (lean as written), with one amendment:** Store persists the vector in `mutation_log.after` / a `embeddings` content table keyed by `(id, content_hash)`. Atomicity: `INSERT node + INSERT vec_quarantine` in one txn after `embed()`.  

Taking only pre-computed vectors looks cleaner until a client writes node row then crashes before `addVector` — split brain. Injected Embedder + txn is the stronger v1.

### `getTile` cost

**Compute on read over bbox candidates; bound with layout index — not full-scan rank.**  
Precompute-on-write per zoom fails when lazy decay changes `S_raw` without writes (`decay` is on-access).  

**Propose:** R-tree / grid on `(x,y)` (layout from Resonator); `getTile` = candidates in bbox → compute `S_raw` for those rows only → top-N. O(|bbox|), not O(n). Dirty set invalidates nothing if decay is pure function of `S_last, timestamp, now`. Optional cache: memoize `(tile_id, zoom, epoch)` where epoch bumps on reinforce/promote/prune in that bbox.

### Circuit-breaker sampling

**Don’t sample LLM output on every promote.** Meter **grounding failures + critic flags** on a rolling window of auto-promotes (wish #6). Cheap: integer counters in Store (`auto_promote_total`, `auto_promote_rejected`). Optional async audit samples durable edges later; that updates the meter via `reportHallucination`, not inline in `promote`.

---

## Highest-priority fixes before implementation

1. **User→durable must go through `promote` (or promote-equivalent txn that fills `shared`).** Current §4/§5 contradiction ships the chicken-and-egg bug for the most important notes.  
2. **`expectedVersion` on all updates.**  
3. **Spatial/layout ownership for `getTile`.**  
4. **Breaker semantics: auto vs user; never blind-disable quarantine for ingest.**  
5. **Replay embedding-closed + promote/status/vec one transaction.**  
6. **Provenance-hash dedup, cosine secondary.**  

Happy to turn this into a patch checklist against §3–§8 line-by-line if you want that next (still Ask mode — guidance only unless you switch to Agent).
