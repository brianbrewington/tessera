# tessera

*A named, persistent **knowledge graph** grown from whatever you feed it — personas, chat transcripts, code, a
wiki page, an email thread, book chapters — via LLM entity+relation extraction, rendered as a browsable map.
Pronounced, deliberately, tes-SER-uh — one tile of a larger mosaic.*

> **Status: a tracer bullet that runs.** Every architectural layer is wired end-to-end and the whole assembly
> does one basic thing well — *create a named graph, ingest a `.txt`/`.md` file, and browse its real typed
> entities and both-endpoints edges*. The identity/provenance/RAG model is reviewed and load-bearing; the
> "resonator" and "dream" engines from earlier designs are **explicitly deferred** until basic ingest is
> rock-solid. This will change under you. On purpose.

## What it does today

You keep **one named graph per domain** — say `personas` in one, `book-ideas` in another — each a persistent
SQLite database. You point ingest at a document; tessera reads it, chunks it, runs a real LLM extraction, and
maps the result into a typed graph you can open in a browser.

```
named graph → adapter (txt/md) → chunker → extractor (LLM) → graph-mapper → GraphStore → viewer
```

Everything is a **Node** or an **Edge**. The extractor pulls typed **entities** (`PERSON`, `PLACE`, `CONCEPT`,
`PROJECT`, `TECHNOLOGY`, …) and **relations** whose reason *names both endpoints* — because those reasons are
the primary retrieval signal, not decoration. A shared entity across documents (`De Doorns`, `Klipgat Farm`)
merges into **one hub**; the over-connected hubs are the trope signal you're looking for.

## Quickstart

Requires **Node ≥ 20** and a running **[Ollama](https://ollama.com)** (chat + embeddings, all local):

```bash
npm install
ollama pull qwen2.5:14b        # extraction model (default; override with TESSERA_EXTRACT_MODEL)
ollama pull nomic-embed-text   # embeddings   (default; override with TESSERA_EMBED_MODEL)

npx tsx scripts/cli.ts graph create personas
npx tsx scripts/cli.ts ingest personas path/to/a-persona.md
npx tsx scripts/cli.ts view personas     # writes graphs/personas/view.html — open it
```

`ingest` reports what it did — chunks, entities, edges, and a fail-loud warning if any chunk's model reply
couldn't be parsed. A re-ingest of the same document is idempotent (it reinforces, it doesn't duplicate).

## The identity model (the reviewed core)

The store stays domain-agnostic — it dedups on `content_hash(text)`. The **mapper owns the identity policy** by
constructing each node's `text` (the dedup basis) and its first-class `name`/`description`. This is the contract
three cross-model reviewers converged on; the full spec is **[`docs/ingest-model.md`](docs/ingest-model.md)**.

- **Hubs merge by type + name** — `PLACE "De Doorns"` is one node across every document (the trope signal).
- **Type is part of identity** — `PLACE "Java"` and `CONCEPT "Java"` are deliberately two nodes.
- **PERSON is source-qualified** — two documents naming the same person stay distinct until you *choose* to
  resolve them; cross-document "is this the same person?" is entity-resolution, and it's deferred.
- **Chunks are first-class nodes.** Each chunk is a node holding its raw text, embedded on that text, linked
  `ORIGINATED_FROM` its `SOURCE` — because a RAG built on this retrieves *chunks*, not whole documents.
- **Nodes and edges carry real GUIDs**; `RELATED` edges are canonicalized (undirected, one edge per pair); edge
  reasons are stored as idempotent assertions so re-ingest doesn't bloat them.

Node/edge record shapes, columns, and the full type enums are in **[`docs/schema.md`](docs/schema.md)**.

## Architecture at a glance

- **`src/graph.ts`** — a name → `graphs/<name>/graph.db` (+ a `meta.json` sidecar). `Graph.open/list`.
- **`src/ingest/`** — `adapters.ts` (file → `{source,title,text}`, txt/md only), `chunker.ts` (deliberately
  naive ~1500-char paragraph splitter — size/overlap tuning is coupled to the extraction model and deferred),
  `ingest.ts` (orchestrator), `mapper.ts` (extraction → typed nodes + provenance + canonical edges).
- **`src/extract/`** — `extractor.ts` (a `Chat`-backed `Extractor`; a ported LightRAG/UNIVERSAL prompt with
  NEGATIVE_CONSTRAINTS and the both-endpoints edge rule; JSON output, Zod-validated, dangling relations
  dropped), `identity.ts` (the identity strings), `typemap.ts` (fine extraction types → few store types).
- **`src/store/graphStore.ts`** — the sole writable authority: `better-sqlite3` + `sqlite-vec`, WAL,
  single-writer (`BEGIN IMMEDIATE`), every mutation appended to a replay-grade `mutation_log`.
- **`src/model.ts`** — a thin read-only value layer; `Edge` owns its graded `Assertion`s.

## What's deferred (honestly)

Earlier tessera designs reached for a prominence-ranked semantic-zoom map and a generative "dream" connection
engine. Those are real and still the destination — but **not until basic ingest is solid**. On the backlog
(**[`docs/backlog.md`](docs/backlog.md)**): more formats (PDF, docx, slides, OCR), the resonator
(decay/prominence/clustering), the dream, cross-graph entity resolution, chunker×model tuning, and an embedder
head-to-head. The design summary (**[`docs/design-summary.md`](docs/design-summary.md)**) records the full
architecture and the open questions the reviews pressure-tested.

## How it's built

Every design doc and code slice passes a **multi-model peer-review gate** — frontier models from other labs
(Codex, Grok, Composer) reviewing before a change is "done", asked to *demonstrate* a flaw, not just describe
it. The reviewed identity model above exists because that gate caught a real class of bug (type-blind dedup
silently overriding the identity policy) before it scaled.

```bash
npm test        # vitest — mapping/identity/provenance fixtures, deterministic (no network)
npm run typecheck
```

---
*Early, honest, and changing.*
