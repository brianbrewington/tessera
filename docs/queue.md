# Work queue

**What is next, in order, and why.** `backlog.md` is the item store: it holds the reasoning, the
dispositions and the revisit conditions, and it is long. This file is short on purpose. One line per item,
a status, and a pointer to where the thinking lives.

Statuses: **DOING** · **NEXT** · **BLOCKED** (on a named thing) · **DEFERRED** (with a condition) · **DONE**

Last reordered: 2026-08-08.

---

## The order, and the tension in it

Two defensible orderings, and they disagree. Recorded rather than resolved silently.

**Quality first** (argued by the scope reviewer of the SESSION round): KI-3, B5 and B7 are open, extraction
emits far too many too-generic entities, and every downstream measurement (prominence, betweenness, hub
structure) is currently computed over noise. Nothing designed on top of that graph can be validated.

**Plumbing first** (the current order below): the parts seam is small, unblocks two queued features, and does
not depend on extraction quality or make it worse. Session-log ingest is the higher-yield corpus per unit of
work (1.5% of bytes carry all the signal), and it is the one place where getting the shape wrong now
forecloses something later.

**Reconciliation used here:** plumbing first, because it is cheap and time-sensitive; quality before any
*claim* about corpus-scale results. The moment we want to say something about what the graph shows rather
than what it can hold, KI-3 moves to the top.

---

## Queue

| # | Item | Status | Why here |
|---|---|---|---|
| 1 | **Parts seam** — `readDoc` yields a primary document plus enumerable parts | **NEXT** | Critical path. Unblocks 2 and 3. Small. |
| 2 | **Media manifest** — byte-hash images, link to parents, no VLM, no extraction | NEXT | Rides the seam. Answers "images get lost" at zero LLM cost, and measures the corpus before anyone decides about captioning. |
| 3 | **Session-log ingest** — Claude Code JSONL, prose only | NEXT | Highest yield per unit of work. **Binding constraint: turns must be preserved with speaker and timestamp**, or attribution and the SESSION unification are foreclosed. |
| 4 | **Performance analysis of `tessera extract`** (Brian, 2026-08-08) | NEXT, after 1-3 | *"not particularly snappy, in my opinion."* Detail below. |
| 5 | **Provenance-scoped delete** | BLOCKED-BY-DESIGN | Gates pointing any generator at a real graph. Origin marking exists; removal does not. Until it does, first dream ingest goes at a throwaway graph. |
| 6 | **`HEBBIAN_ASSOC` first writer** | DEFERRED | The one edge a dream exists to produce. Its acceptance test, when the dream path is built. |
| 7 | **I1 extraction quality** — KI-3, then B5 layer 1, then B7 | DEFERRED, condition below | Promote to #1 the moment we want to claim anything about corpus-scale results. |
| 8 | **SESSION / AGENT node types** | DEFERRED | Until a runner exists or the structural predicate replaces `mode`. See Object model depth. |
| 9 | **Dream / walk runners** | DEFERRED | Standing rule: not until ingest is solid. |
| 10 | **Slice 4** — provenance in the layout | DEFERRED | Removes the 36.6 s `h`-toggle cliff by construction. Changes geometry, so not while ingest topology is moving. |
| 11 | **Clustering / mining experiment** | DEFERRED | Fully specified and read-only. Gated on B5 for the Connector half; the measurement half could run any time. |

---

## 4. Performance analysis of `tessera extract` — the shape of it

**Measured baseline, 2026-08-08.** 13 chunks, 4 files, on this machine:

| phase | time |
|---|---|
| `tessera ingest` (read, chunk, embed) | **5.2 s** |
| `tessera extract` (13 chunks) | **97 s** (~7.5 s/chunk) |
| second `tessera extract` (all clean) | instant |

`scripts/bench/README.md` records ~9.9 s/chunk warm on a larger run, with extraction ~97% of ingest
wall-clock and embeddings ~3%. So 7.5 s/chunk is in family, and the cost is one LLM call per chunk.

**The leading hypothesis, stated so it can be wrong: it is sequential, not slow.** `extractPending` runs one
chunk at a time. Nothing in the design requires that — the per-chunk row-level claim was built precisely so
two extractors cannot take the same chunk, which is the hard part of running several at once. The backlog
already records "parallel extraction: the claim primitive makes it possible later; one sequential loop now."

**What the analysis should actually establish, before changing anything:**
- Where the 7.5 s goes: model inference, prompt evaluation, per-call overhead, embedding, or store writes.
  Measure, do not assume it is all inference.
- Whether concurrency helps or just queues. One local GPU serving one Ollama model may serialise anyway, in
  which case parallelism buys nothing and the answer is elsewhere.
- Whether chunk size is the real lever (backlog B2: chunk size, overlap and extraction model are a joint
  function, and must be swept together, not tuned in isolation).
- What a smaller or quantised extraction model costs in quality, measured against the scorecard rather than
  by impression.
- Whether prompt length matters: `EXTRACTION_SYSTEM` is long and is re-evaluated on every call.

**Why it is item 4 and not item 1.** Brian's own sequencing: *"that analysis can follow getting caught up on
the items we know already."* Also honest: 4 files took 97 seconds, which is tolerable; the pain arrives at
corpus scale, and at corpus scale the chunk-size and model questions (B2) probably dominate the concurrency
question. Doing the analysis after the parts seam also means it can be run against session logs, which are a
very different chunk-size distribution from prose documents.

---

## Conditions that reorder this list

- **We want to claim something about what the graph shows** → item 7 moves to the top.
- **A corpus ingest is expected to run over 6 hours** → the lock heartbeat comes back (backlog B25 revisit).
- **A generator is pointed at a graph anyone cares about** → item 5 becomes blocking, not deferred.
- **Real corpora turn out to be scans rather than photographs and charts** → OCR-as-adapter beats captioning,
  and item 2 grows a sibling.
