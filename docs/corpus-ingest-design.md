# Corpus ingest — full design (write-up)

Status: **full write-up for the second cross-agent review** (step 3 of: outline → review → write-up →
review → check-in). Supersedes `corpus-ingest-outline.md`. Incorporates the first review (Codex + Fable) and
Brian's two steers: **never anchor identity on file path**, and **soft supersession, not hard delete** (the
retraction ripple is real — so don't cascade).

## 1. Goal

Stand up a useful tessera graph from a whole corpus with one command, and add new/changed material later —
cheaply, deterministically in *identity*, and safely across machines. "Useful" = ingest **plus** the
cross-document Connector, run as a documented sequence (ingest stays ingest-only).

## 2. Foundational decisions (locked by the first review + Brian's steers)

- **FD1 — Content-addressed identity. Path is metadata, never identity or a dedup key.** Same content dedups
  globally regardless of where it lives (rolled-up, networked mount, second machine). This is the biggest
  change from today and it touches existing graphs (see §3, §9).
- **FD2 — Append-only + SOFT supersession. Never hard-delete.** Stale content is flagged non-live and filtered
  out of queries/RAG/scorecard by default; nothing is removed, so there is no retraction cascade and no
  ripple. Matches the project's append-mostly principle. Physical deletion is deferred and may never be needed.
- **FD3 — Record assertion provenance in v1.** Every edge assertion is stamped with the chunk(s) that produced
  it (the `edge_assertions.grounding` column exists and is currently written NULL). Nearly free now; the
  enabler for liveness (§4) and any future operation. Un-recordable retroactively.
- **FD4 — Manifest lives in the graph db**, transactional with the single writer and logged to `mutation_log`.
- **FD5 — `ingest` is incremental-by-default and content-dedup'd**; removed/stale surfaced via `sources`, not
  auto-acted-on. Ingest and the Connector stay strictly separate.
- **FD6 — Run-level failure accounting is load-bearing v1** (per-file status, resumable, non-zero exit).

## 3. Identity model — the change (highest-risk section)

Today (`src/extract/identity.ts`), identity is path-anchored:
- SOURCE = `source\t<path>` (the raw resolved path, un-hashed)
- CHUNK  = `chunk\t<sourceKey(path)>\t<sha16(text)>`
- PERSON = `person\t<name>\t<sourceKey(path)>` (source-qualified so two personas' "Father"s stay distinct)

Proposed (content-addressed):
- SOURCE = `source\t<sha256(normalized full doc text)>` — a document IS its content. Two identical files → one
  source. An edited file → a *new* source.
- CHUNK  = `chunk\t<source-content-hash>\t<sha16(chunk text)>` — **qualified by the SOURCE's content hash, not
  its path.** Path-free, but NOT pure-content: extraction is subject-aware (`extract(text, {subject})`), so the
  same boilerplate chunk in two different docs must extract *twice* (under each subject). A pure content-hash
  chunk id would dedup them to one node, the memo would mark it extracted after doc A, and doc B's subject-
  specific extraction would be silently dropped (both reviewers, P0). Source-content-qualifying fixes it:
  identical docs across machines still dedup (same source hash → same chunk id); the same text in *different*
  docs stays distinct. (The extraction memo key must include the same qualifier.)
- PERSON = `person\t<name>` — **drop source-qualification.** Consistent with how CONCEPT/PLACE/etc. already key
  (`<type>\t<name>`), and safe here because subject-aware extraction already names relational people distinctly
  ("Boitumelo Sebola's Wife", not a bare "Wife"). Genuine same-name-different-person collisions are the job of
  the dedup/disambiguation layer already on the roadmap — the identity model must not *fight* that layer, and
  path-qualification did (it pre-split before dedup could reason).

**Why this is the highest-risk call (for the review to stress):**
1. It changes identity for **existing graphs** (`graphs/big`, persona graphs). Recommendation: **rebuild**, not
   migrate — the change is foundational and re-ingest is cheap relative to a fragile migration. (`persona.ts`
   already has a *divergent* path-based identity scheme, flagged in the backlog — this unifies it too.)
2. Dropping PERSON source-qualification could over-merge in a corpus with real same-name collisions. Persona
   corpora are safe (distinct names); general corpora lean on dedup/disambiguation. Is name-only too eager
   before that layer exists?
3. Content-addressed SOURCE means an edited doc is a *brand-new* source with no automatic link to its prior
   version — supersession must be established some *other* way than "same path" (see §4, mark-and-sweep).

## 4. Liveness & supersession (how "changed/removed" works without deletion)

Every SOURCE, CHUNK, and edge-assertion carries a **liveness state**: `live` (default) or `superseded`.

- Queries that represent "the corpus as it is now" — RAG retrieval, `report`, the Connector's context, `paths`/
  `common` — filter to `live` by default (a `--include-superseded` escape hatch for forensics/history).
- An entity node is *effectively* live iff some live assertion/appearance still references it. Computed at query
  time (or lazily cached), never by cascading a delete.

**Establishing supersession without a path anchor — corpus-snapshot mark-and-sweep.** An `ingest` invocation
over a set of roots defines a **live content-set** (the content hashes present under those roots *now*). The
manifest knows what this graph previously ingested. After a run, any previously-live SOURCE/CHUNK whose content
is absent from the current live-set **and** was ingested under the same roots is marked `superseded`. This is
pure content-set difference — **no path in identity, path only as the run's scoping metadata** (which roots
this run covered). Editing a doc = its old content vanishes from the live-set → superseded; its new content is
just new live content. Deleting a file = same. Nothing is destroyed; the graph keeps its whole history, and the
*current* view is always the live slice.

Open for review: the mark-and-sweep needs a notion of "these roots were fully enumerated this run" so a
partial/aborted run doesn't wrongly supersede everything it didn't reach. Proposed: only sweep on a run that
completed enumeration of its declared roots (a run flag), never on a `--dry-run` or a crashed run.

## 5. The bring-up sequence (v1 — legible, not magic)

```
tessera graph create <g>
tessera ingest <g> <dir>          # content-dedup'd, incremental, mark-and-sweep supersession
tessera report <g>                # scorecard over the LIVE slice
tessera connect <g> [--commit]     # cross-doc links (dry-run first) — separate, expensive, judgment-bearing
tessera view <g>
```
A `tessera build <g> <dir>` that runs the sequence with visible per-step boundaries is **v1.1 sugar**, not v1.

## 6. CLI surface

```
tessera ingest <g> <path...> [--ext .md,.txt] [--no-recursive] [--dry-run] [--reextract]
    # paths = files or directories (recursive by default). Shell handles globs — no built-in glob in v1.
    # Incremental + content-dedup'd. Prints a run summary (see §8). --dry-run prints the plan, writes nothing.
tessera sources <g> [--superseded]     # the manifest: per-file status, live/superseded, provenance
```
Scope defaults for the walk: skip hidden dirs and `.git`/`node_modules`; follow symlinks with cycle-guard
(record realpath to avoid double-work, but identity is content so a symlinked duplicate dedups anyway).

## 7. The manifest (`sources` table, in-db)

Per ingested file (keyed on **content hash**, path as metadata — a file that moves is the same content):
`content_hash` (PK), `path` (last-seen, metadata only), `size`, `mtime` (advisory), `first_ingested_at`,
`last_seen_run`, `status` (`complete`|`partial`|`read_error`), `liveness` (`live`|`superseded`),
`extractor_model`, `prompt_version`, `chunker_version`, `chunk_count`, `parse_failures`.
All writes go through the store and into `mutation_log` (replay must not lose sync state).

## 8. Incremental & failure semantics

Per file in the walk:
- **content unseen** → NEW: ingest, record `complete`/`partial`.
- **content seen, status `complete`** → SKIP (zero LLM work *and* zero writes — the file-level skip is what
  makes an unchanged re-run truly no-op; a memo hit alone still re-embeds/re-`putNode`s every chunk).
- **content seen, status `partial`** → re-enter the per-chunk loop; the chunk memo makes completed chunks cheap
  and retries the failed ones. **(Fixes the review's F1 trap: a file-level hash skip must not freeze a
  partially-failed extraction forever — skip only when `complete`.)**
- **previously-live content absent from this run's live-set** → mark `superseded` (§4).

Failure accounting: per-file `try/catch` (one bad file never aborts the run); a run id; a run-end summary
(`new / updated / skipped / partial / failed / superseded`, with chunk/entity/edge/parse-fail counts and
elapsed); non-zero exit if any file failed; `read_error` rows so the next run and `--dry-run` see them.

## 9. Scope

- **v1:** directory intake (FD5), content-addressed identity (FD1, §3), in-db manifest (FD4/§7), incremental +
  content-dedup (§8), soft-supersession liveness + mark-and-sweep (FD2/§4), assertion provenance (FD3),
  prompt/chunker-version columns, `--dry-run`, `sources` inspector, run-level failure accounting (FD6), the
  runbook (§5), and a rebuild of the existing graphs onto the new identity.
- **Deferred:** physical deletion / GC of superseded content (may never be needed); `build` convenience (v1.1);
  non-`.md/.txt` formats; creation-time entity dedup/disambiguation (separate backlog item — noted dependency
  for FD1's PERSON change); parallel/batched extraction throughput; a structured (non-path) logical-document
  lineage if we ever want to *link* an edited doc's versions rather than just supersede.

## 10. Test plan

- **Tier-1 (deterministic, StubExtractor):** walk finds the right files/order; ext filter; hidden/`.git` skip;
  symlink cycle-guard; manifest records/updates; content dedup (same text, two paths → one source/chunk);
  identity is path-free (ingest same content from two different absolute paths → identical node ids); unchanged
  file → 0 writes; `partial` file re-enters chunk loop (F1 regression); mark-and-sweep marks absent content
  superseded and NOT on a `--dry-run`/aborted run; queries filter to live by default; `--dry-run` writes
  nothing; prompt/chunker-version bump invalidates.
- **Tier-2 (live, reported):** bring up a graph from a real folder end-to-end; edit a file, re-ingest, confirm
  the old content is superseded (not deleted) and the live scorecard reflects only current content.

## 11. Highest-risk decisions for the second review

1. **PERSON identity = `type + name`** (drop source-qualification) — over-merge risk before the dedup layer
   exists? Is subject-aware naming a sufficient disambiguator for v1's persona use case?
2. **Rebuild vs migrate** existing graphs onto content-addressed identity. Rebuild recommended — confirm.
3. **Mark-and-sweep correctness** — is "supersede content absent from a completed run's live-set, scoped to the
   run's roots" sound, or are there false-supersede traps (e.g., ingest a subset of a corpus, does it wrongly
   supersede the rest)? This is the sharpest new mechanism and wants the hardest look.
4. **Effective-liveness at query time** — recompute "is this entity still referenced by anything live" per
   query vs. maintain a cached count on write. Correctness vs cost.
5. Anything the soft-supersession model quietly breaks: the Connector's `expert_surprise`/reinforcement over a
   graph that now contains superseded assertions; the vec index returning superseded chunks in kNN (must the
   vec query filter liveness?).

---

## 12. FINAL v1 CUT (post-second-review + check-in) — this section governs

Both second reviews (Codex + Fable) returned **NO-GO as originally written but GO on all four foundations**
(content-addressed identity, soft supersession, query-time liveness, rebuild-not-migrate). The blocker was that
soft-supersession/liveness touches ~every read path (SQL views, a Connector rework, vec over-fetch) and *still*
can't fully un-corrupt reinforced node rows — roughly doubling v1 on a surface we had under-estimated. Brian's
decision: **take the clean cut.** Liveness/supersession becomes its own later slice; v1 is the bounded plumbing.

### v1 (GO) — bounded plumbing, no read-path changes beyond identity
1. **Content-addressed identity** (§3, with the corrected source-content-qualified CHUNK id). Path is metadata.
2. **Corpus ingest**: recursive directory intake (shell handles globs), **additive + content-dedup'd**. New
   content ingested; already-seen content skipped (file-level, via the manifest — truly zero-write, not just a
   memo hit). No supersession in v1 — an edited doc *adds* its new content; the old content remains (append-
   only), made **visible** by the audit below rather than filtered.
3. **Assertion provenance recorded, SET-valued** (must-fix #6): stamp each assertion with the chunk(s) that
   ground it; accumulate on reinforce (the current dedup path skips insertion — it must instead add to the
   grounding set). This is the enabler for the v1.5 liveness work and is nearly-free now, unrecoverable later.
4. **PERSON merge-audit surface** (must-fix #7, Fable — the sharpest v1 add): because generated corpora are
   *known* to collapse onto stock names (the Elara-Vance trap in this very workstream), dropping PERSON source-
   qualification could silently over-merge. v1 ships detection, not just a deferred dedup layer: a `report`
   line listing PERSON nodes whose `APPEARED_IN` chunks span >1 source, ranked by strength; and a reinforce log
   entry stamped with the incoming source when it differs from the node's origin. Over-merge becomes an
   inspectable list, not invisible corruption.
5. **In-db `sources` manifest** (§7), keyed on content hash, path as metadata, per-file `status`
   (`complete`/`partial`/`read_error`) gating the skip (must-fix: a `partial` file re-enters the chunk loop so
   a failed extraction is never frozen).
6. **Run-level failure accounting** (per-file try/catch, run id, run-end summary, non-zero exit).
7. **Rebuild** existing graphs onto the new identity (honest cost: `graphs/big` re-pays full extraction — the
   memo keys all change; keep old db files, don't port their mutation_logs). Verify `persona.ts`'s divergent
   scheme is unified by this (not yet code-checked).

### v1.5 (DEFERRED) — the liveness / supersession subsystem, as its own slice
- Liveness flag + query-time filtering via SQL views (`live_assertions → live_edges → live_nodes`), applied
  across the full read surface (`allNodes`/`allEdges`/`querySimilar`/`getSubgraph`/`getNeighbors`/`buildAdjacency`).
- **Mark-and-sweep supersession** — NOT in v1. When designed, use the conservative rule (sweep only when a run
  covers *every* root the graph has ingested from; partial runs only add) or a `run_files` sightings table;
  the single last-seen `path` in §7 is provably insufficient (moved-file / multi-path / read-error false-
  supersedes — must-fix #2).
- **Connector rework** (must-fix #3): doc-membership from `ORIGINATED_FROM` edges (a content-deduped chunk can
  belong to >1 source, so `provenance.path` is wrong), live-filtered inputs, and the all-assertions-superseded
  re-proposal decision.
- **vec over-fetch-then-filter** (must-fix #5): vec0 can't push a liveness predicate; post-filtering top-k
  silently returns <k. Over-fetch then filter.
- **Physical GC** of superseded content (vec tables grow monotonically until then — a known, stated v1 limit).

### Known v1 limitations (stated, not hidden)
- Edited docs accumulate stale content (append-only, no filtering yet) — **visible** via the PERSON audit and a
  stale-source count in `report`, but present in query results until v1.5 lands.
- Reinforce overwrites a node's description+embedding from the newest contributing chunk (`graphStore.ts`
  ~186-191); if that chunk is later superseded (v1.5), the row keeps dead content and liveness filtering can't
  revert it. Mitigation now: stamp the reinforce log with its grounding chunk. True fix (per-source description
  provenance) is deferred with v1.5.
- Node `strength`/`hebbian_weight` accumulate across all versions → the scorecard is slightly inflated vs a
  pure live slice. Accepted for v1.
