# Corpus ingest — bringing up a graph from a whole corpus (design OUTLINE)

Status: **outline for cross-agent review** (step 1 of: outline → review → full write-up → review → check-in).
This is deliberately a skeleton — decisions and open questions are surfaced for reviewers to poke *before*
the full write-up is invested. Not a spec yet.

## 1. Goal & use case

Stand up a useful tessera graph from an **entire corpus** (a folder of `.md`/`.txt` today) with one command,
and **incrementally add** new/changed material later without re-doing work or corrupting what's there. The
driving use case: a persona corpus, or a research/notes folder, that grows over time. "Useful" means not just
raw nodes but a graph you can traverse and run the intersection queries over — so bring-up is ingest **plus**
the cross-document Connector, in a documented sequence.

## 2. Current state (what exists — ground truth)

- `tessera ingest <graph> <file...>` — explicit file list, per-file loop, `--reextract`. (`scripts/cli.ts`)
- Chunk memo: `isExtracted`/`markExtracted` keyed on chunk **content hash**; a completed chunk is skipped on
  re-run → same file re-ingested is (mostly) a no-op. (`src/ingest/ingest.ts`)
- `readDoc(path)` / `isSupported(path)` — **single file only**, no directory walk. (`src/ingest/adapters.ts`)
- Identity is coordinator-owned and deterministic; the same entity across files merges into one hub (mapper).
- `tessera connect` (Connector), `tessera report` (scorecard), `tessera paths`/`common` (intersection) exist.

**The gap:** no directory/glob intake; no record of *what files* were ingested (only per-chunk memo); so no
principled "add the new stuff / update the changed stuff / notice the removed stuff" — i.e. no incremental sync.

## 3. Design decisions (proposed — reviewers should challenge)

- **D1. Directory + glob intake.** `ingest` accepts directories and globs, not just files. Recursive by
  default; deterministic order (sorted path); skip unsupported extensions with a count, not an error.
- **D2. A per-graph ingest manifest.** A new `sources` table (or `meta` rows) recording, per file: canonical
  path, content hash, size, mtime, ingested-at, extractor model + **prompt version**, chunk count, status.
  This is the state that makes incremental principled. (Chunk memo stays; the manifest is the file-level layer.)
- **D3. Incremental is the default, full is a flag.** Re-running `ingest <dir>` reconciles: **new** files
  ingested, **changed** files (content hash differs) re-ingested, **unchanged** skipped. `--reextract` forces
  all (prompt/model bump). This leans on the memo for cheapness.
- **D4. Removed files are DETECTED and reported, not auto-deleted (v1).** A `sync` view flags files in the
  manifest no longer on disk. Actually cascading a delete through nodes/edges/provenance is a separate, riskier
  primitive (single-writer, dedup interactions) → deferred with a clear `--prune` follow-up. v1 surfaces the
  drift so it's never silent.
- **D5. Prompt-version salt** (already in backlog) lands here: the manifest stores the prompt version; a bump
  invalidates stale extractions on the next run. Closes "silently stale after a prompt change."
- **D6. Bring-up is a documented SEQUENCE, not a magic button (v1).** `create → ingest <dir> → report →
  connect (dry-run, then --commit) → view`. A `tessera build <graph> <dir>` convenience that runs the sequence
  is *optional v1.1* — keep the steps legible first (so a failed/expensive step is visible, not buried).
- **D7. Dry-run for sync.** `ingest --dry-run <dir>` prints the plan (N new, M changed, K unchanged, R removed)
  and does nothing. The honest "what will this cost me" before a big run.

## 4. Proposed CLI surface (for review)

```
tessera ingest <graph> <path...> [--recursive] [--ext .md,.txt] [--dry-run] [--reextract] [--no-recursive]
    # paths may be files, directories, or globs; incremental by default
tessera sources <graph> [--missing]          # list the manifest; --missing shows on-disk-gone files (D4)
tessera build  <graph> <dir> [--commit]       # (v1.1?) create-if-needed → ingest → report → connect
```
Open: is `sync` a separate verb or just what `ingest <dir>` does? (Leaning: `ingest` IS sync; `sources` is the
inspector. Fewer verbs.)

## 5. Incremental semantics (the heart of it)

Per file, compare disk vs manifest by content hash:
- **absent from manifest** → NEW: ingest, record.
- **hash matches** → UNCHANGED: skip (no LLM work).
- **hash differs** → CHANGED: re-ingest. Open question: do we first *retract* the old file's chunks/entities,
  or just add the new and let the old orphan? (See open questions — this is the sharpest one.)
- **in manifest, absent on disk** → REMOVED: report (D4); prune only with explicit `--prune` (deferred).

Resumability: an interrupted big ingest resumes cheaply — the memo + manifest mean completed files/chunks are
skipped on re-run. Determinism: sorted traversal + coordinator identity → same corpus ⇒ same graph.

## 6. Scope

- **v1:** directory/glob intake (D1), manifest (D2), incremental-by-default add + change (D3), removed-detection
  (D4), prompt-version salt (D5), `--dry-run` (D7), `sources` inspector, docs runbook.
- **Deferred:** `--prune` removal cascade; `build` convenience (maybe v1.1); non-`.md/.txt` formats (existing
  adapter backlog); creation-time entity dedup (separate backlog item, but note the dependency — a big corpus
  makes dedup matter more); parallel/batched extraction throughput.

## 7. Test plan (sketch)

- Tier-1 (deterministic, StubExtractor): directory walk finds the right files & order; glob/ext filtering;
  manifest records/updates correctly; unchanged file → 0 LLM calls (memo hit); changed file → re-ingest;
  removed file → flagged not deleted; `--dry-run` writes nothing; prompt-version bump invalidates.
- Tier-2 (live, reported not asserted): bring up graphs/big from its source folder end-to-end; scorecard.

## 8. Open questions for reviewers (poke hardest here)

1. **Changed-file semantics** — retract-then-readd vs add-and-orphan. Orphaned old entities/edges corrupt the
   graph over time; retraction needs a provenance-scoped delete we don't have yet. Is v1 honest if it only
   *detects* change but can't cleanly retract? Or is changed-file support itself deferred to the `--prune`
   primitive, with v1 = add-only + detect?
2. **Manifest location** — a `sources` table in the graph db (queryable, transactional with the writer) vs a
   sidecar file. The `meta.json` sidecar precedent exists; the identity/single-writer discipline argues for
   in-db. Confirm.
3. **`ingest` = sync overload** — is making `ingest <dir>` silently incremental surprising? Should the
   reconciling behavior be a distinct verb so `ingest` stays "add these," and `sync` means "reconcile to dir"?
4. **Content hash vs mtime** — hash is correct but reads every file each run; on a huge corpus, use mtime+size
   as a fast pre-filter, hash only on suspicion? Premature optimization, or necessary for "entire corpus"?
5. **Bring-up pipeline coupling** — should ingest ever auto-run the Connector, or stay strictly ingest-only
   (Connector is expensive + wants dedup first)? Leaning strictly separate; confirm.
6. **Failure accounting** — a corpus run will have per-file parse failures; how should partial success be
   reported and resumed so a 500-file run isn't all-or-nothing? (The memo helps; is that enough?)
