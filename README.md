# tessera

*A named, persistent **knowledge graph** grown from whatever you feed it — personas, chat transcripts, design
docs, session logs, book chapters — via local LLM entity+relation extraction, rendered as a browsable map.
Pronounced, deliberately, tes-SER-uh: one tile of a larger mosaic.*

> **Status: it runs, end to end, and it is still moving.** You can create a graph, drop a folder of documents
> on it, extract, and browse 2000 real typed entities in a live map with saved views. Nothing here calls out
> to a cloud: extraction and embeddings are local Ollama models. The generative "dream" engine from earlier
> designs is still deferred on purpose. Expect this to change under you.

## The one thing to know first

**Ingest and extraction are two separate commands, and that is deliberate.**

```
tessera ingest   → read, chunk, embed, store        seconds        no LLM calls
tessera extract  → entities and relations per chunk ~7.5s/chunk    one LLM call each
```

Extraction is roughly 97% of the wall-clock, so binding it to ingest meant a folder drop blocked for half an
hour and a crash in minute 28 lost everything. Splitting them makes "dirty" a durable SQL fact — *a chunk with
no extraction row for the current prompt version* — rather than a queue that can be lost. Ingest returns fast
and tells you what it owes; extract drains it, resumably, from any terminal, even after a reboot, and even if
the source file has since been deleted.

So a normal session is two commands, and the second one is the one that costs you.

## Quickstart

Requires **Node ≥ 20** and a running **[Ollama](https://ollama.com)**:

```bash
npm install
ollama pull qwen2.5:14b        # extraction  (override: TESSERA_EXTRACT_MODEL)
ollama pull nomic-embed-text   # embeddings  (override: TESSERA_EMBED_MODEL)

./tessera graph create notes
./tessera ingest notes ~/writing            # files or whole directories, recursive
./tessera extract notes                     # the expensive half; resumable
./tessera serve notes                       # live map at http://127.0.0.1:7777
```

`./tessera` is a real command in the repo root; no global install, no `npx tsx scripts/cli.ts`. Every command
also works headless, so `ingest` + `extract` can run from cron while you read the map.

Re-running `ingest` on the same document is idempotent: it reinforces, it does not duplicate. Re-running
`extract` costs nothing when everything is current, and says so.

## Commands

```
graph create <name> | graph list          list reports size and extraction debt per graph
ingest <name> <path...>                   files or dirs, recursive; --dry-run --rechunk --no-recursive
ingest-session <name> <log.jsonl...>      Claude Code session logs; --user <name>
extract <name>                            --retry-failed  --force
view <name>                               writes a standalone graphs/<name>/view.html
serve <name>                              live viewer + drag-drop ingest; --port
scenes import <name> <scenes.json>
report <name>                             the scorecard: chunks, entities, edges, what is owed
connect <name>                            cross-document Connector; --commit --floor --k --cap
paths <name> <A> <B>                      how two entities connect
common <name> <A> <B> [C ...]             what several entities share
```

## What `serve` gives you that `view` does not

`view` writes one self-contained HTML file you can mail to someone. `serve` binds a graph over
`http://127.0.0.1:PORT` and adds the things that need a writer:

- **Drag a file or a folder onto the map** and it ingests. The drop returns immediately and the chunks are
  extracted in the background; a badge tells you how many are still owed.
- **Scenes** — saved camera positions with a name and a narration, stored in the database rather than in
  browser localStorage, reorderable by dragging, and exportable. These hold the only human-authored prose in
  the system, so scene writes are all-or-nothing in one transaction.
- **`GET /status`** answers `dirty` / `failing` / `draining` as facts you can query from another terminal.

The viewer itself is a semantic-zoom map: node size and label budget follow prominence, so a continent-level
view shows landmarks and a district-level view shows most things. Provenance nodes (documents and chunks) are
present but hidden until you press `h`, because they are the RAG substrate rather than the semantic map.

## The identity model

The store is domain-agnostic: it dedups on `content_hash(text)`. The **mapper owns identity policy** by
constructing each node's `text`. Full spec: **[`docs/ingest-model.md`](docs/ingest-model.md)**; record shapes
and enums in **[`docs/schema.md`](docs/schema.md)**.

- **Entities merge by type + name.** `PLACE "De Doorns"` is one node across every document. The
  over-connected hubs that result are the signal you came for.
- **Type is part of identity.** `PLACE "Java"` and `CONCEPT "Java"` are deliberately two nodes.
- **PERSON is *not* source-qualified.** A real person appearing in two documents is **one** node. Path
  qualification used to keep them apart, which fought the dedup layer rather than helping it; same-name
  collisions are entity resolution's problem, and entity resolution is a real layer, not a workaround.
- **Chunks are first-class nodes** holding their raw text, embedded on that text, linked `ORIGINATED_FROM`
  their `SOURCE` — because RAG over this retrieves chunks, not whole documents.
- **Documents are content-addressed; sessions are not.** A document *is* its bytes, so its identity is a hash
  of its text. A session is a *stream* that grows while you work, so hashing it would mint a new source on
  every read. Sessions are addressed by a stable id and their **turns** are the content-addressed units. Two
  regimes on purpose; collapsing them reintroduces the duplication bug they exist to prevent.
- **Media is the hash of the bytes**, never of anything a model said about it. The same logo in forty
  documents is one node with forty parents. Images are manifested, not captioned — deliberately.

## Architecture

- **`src/graph.ts`** — name → `graphs/<name>/graph.db` plus a `meta.json` sidecar.
- **`src/ingest/`** — `adapters.ts` (file → document *plus enumerable parts*; `.txt`/`.md` today, with
  markdown-referenced images as the first part producer), `chunker.ts` (a deliberately naive ~1500-char
  splitter; size, overlap and extraction model are one joint tuning problem and are deferred together),
  `ingest.ts` (the fast half), `extract-pending.ts` (the LLM half, under per-chunk claims), `mapper.ts`.
- **`src/extract/`** — `extractor.ts` (a `Chat`-backed extractor whose edge reasons must name **both**
  endpoints, since those reasons are the retrieval signal; JSON out, Zod-validated, dangling relations
  dropped), `identity.ts`, `typemap.ts`.
- **`src/store/graphStore.ts`** — the sole writable authority. `better-sqlite3` + `sqlite-vec`, WAL,
  single-writer via `BEGIN IMMEDIATE`, every mutation appended to a replay-grade `mutation_log`.
- **`src/serve/`, `scripts/serve.ts`, `viewer/template.html`** — the server, its drain coordinator, and the
  single-file viewer.

Two chunk extractors never collide because a claim is one `UPDATE ... WHERE` inside a transaction: SQLite
serializes it, so the row-level claim is the concurrency primitive rather than a hand-rolled file lock.

## What is deferred, honestly

On the backlog (**[`docs/backlog.md`](docs/backlog.md)**), with reasons and revisit conditions rather than
just names: more formats (PDF, docx, OCR), the dream/walk generators, cross-graph entity resolution,
chunker × model tuning, provenance in the layout, and an admin surface across graphs.

Entity **resolution** is the live one. Measured on the tuning corpus: 1714 entities, of which 277 pairs differ
only by extracted type and 130 only by punctuation. Those are deterministic string work. The interesting
residue — the same thing named two genuinely different ways — is being worked through a pre-registered
experiment protocol (**[`docs/dedup-experiment-protocol.md`](docs/dedup-experiment-protocol.md)**) rather than
by intuition. Results, including a retraction of one of our own findings, are in
**[`docs/dedup-e0-e1-results.md`](docs/dedup-e0-e1-results.md)**.

**[`docs/queue.md`](docs/queue.md)** is what is actually being worked on next, in order.

## How it is built

Every design doc and code slice passes a **cross-agent review gate**: models from other labs (Codex, Grok,
Composer) review before a change is called done, and they are asked whether the *design* is right before they
are asked to find line-level defects. That gate has repeatedly caught things this repo would otherwise have
shipped — a scene sync that promised atomicity in a comment and ran three transactions, a background drain
that silently dropped work arriving mid-pass.

The discipline that goes with it, learned the expensive way and worth inheriting:

- **Write the failing test first and watch it fail.** A broken instrument fails toward green.
- **Verify a reviewer's claims about the code before acting on them, and your own before publishing them.**
- **A finding without a disposition quietly becomes the default behaviour.**

```bash
npm test        # 321 passing, 1 skipped — deterministic, no network
npm run typecheck
```

---
*Early, honest, and changing.*
