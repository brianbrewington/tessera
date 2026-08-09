# Work queue

**What is next, in order, and why.** `backlog.md` is the item store: it holds the reasoning, the
dispositions and the revisit conditions, and it is long. This file is short on purpose. One line per item,
a status, and a pointer to where the thinking lives.

Statuses: **DOING** · **NEXT** · **BLOCKED** (on a named thing) · **DEFERRED** (with a condition) · **DONE**

Last reordered: 2026-08-08 (item 14 to the top, per Brian).

---

## Picking this up cold

Short, because git carries the rest: the commit messages on this branch are written to be read.

**Branch.** `viewer/durable-state`, pushed, **57 commits ahead of `main` and unmerged.** Tests green
(316 passing, 1 skipped). `npm test`, `npm run typecheck`, and `./tessera` is a real command now.

**FIRST THING NEXT SESSION (Brian, 2026-08-08): a cross-agent review is overdue.** Run `/cursor-review` with
**Grok**, then **Composer** (Codex hit its monthly limit on 2026-08-08), over `git diff main...HEAD`. That
diff is now large and carries a full day of work that has had only two review rounds, both early in it.
Apply the fixes, then stage, commit and push. Only after that pick up the queue below.

**Shipped in the last stretch**, newest first: the dedup plan + experiment protocol · the appears-in layout
fix · session-log ingest · media manifest · the parts seam · a work queue · the SESSION
round folded into the backlog · the `origin` thread and the multi-parent join fix · `./tessera` · the
serve/viewer half · the ingest split. `git log --oneline main..HEAD` is the honest index.

**Unactioned, and easy to lose:**
- `graphs/big` still has **2 chunks never extracted**. The fix exists and was proven on a *copy*: one healed,
  one failed to parse again. The real graph has not been run through `./tessera extract big`.
- `docs/reviews/session-object-model-round1-dream.md` is read and dispositioned in `backlog.md`, but two of
  its findings are unbuilt on purpose: the provenance-scoped delete (item 5) and `HEBBIAN_ASSOC`'s first
  writer (item 6).
- No `CLAUDE.md` in this repo. A cold session gets the global teammate stack and the project memories, and
  then has to find `docs/queue.md` and `docs/backlog.md` on its own. Worth deciding whether that is a gap.

**Three things not to re-litigate**, each decided with reasons recorded:
1. **Do not write a new SESSION plan.** `plan-v3.md` §4 already specifies it; the delta lives in
   `backlog.md` under "Object model depth". A second design document would be copy-fork-edit.
2. **Do not point a generator (dream, walk) at a graph anyone cares about.** Origin marking exists; a
   provenance-scoped delete does not, and there is no delete for nodes or edges anywhere in the repo.
3. **Do not caption images.** Manifesting is deliberate, not a stub. Read the media entry in `backlog.md`
   before adding a vision model.

**The habit this codebase rewards**, learned the expensive way and worth inheriting: write the failing test
first and watch it fail; verify a reviewer's claims about the code before acting on them, and your own before
publishing them; and treat a declared-but-unwritten schema seam as a debt, not as progress.

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
| 1 | **Parts seam** — `readDoc` yields a primary document plus enumerable parts | **DONE** 2026-08-08 | `{doc, parts, skipped}`. Markdown-referenced local images are the first producer. Only the part kinds with a producer are declared. |
| 2 | **Media manifest** — byte-hash images, link to parents, no VLM, no extraction | **DONE** 2026-08-08 | Bytes in `media_blobs`, identity = sha256 of bytes, one node per distinct image with an edge to every parent. Never a dirty chunk, never captioned. |
| 3 | **Session-log ingest** — Claude Code JSONL, prose only | **DONE** 2026-08-08 | `./tessera ingest-session`. Stream-addressed session, turn keyed by record uuid, speaker + timestamp in provenance, no SESSION/AGENT node minted. Kill test passed: a plain SOURCE sufficed. |
| 14 | **Dedup experiments** — E0+E1 **DONE** 2026-08-08, E2-E5 open | **DOING** | Read-only, zero chat calls, under an hour plus 15 min of Brian. **Moved above item 4 by Brian, 2026-08-08**, and his reason is stronger than the one first recorded here. I wrote "nothing couples the two, so the swap costs nothing." Wrong: they are coupled, and that coupling is the whole argument. Brian: *"the reason we are running these experiments first is that they materially impact our performance analysis of extraction. we'll re-craft ingest, review+test, then re-extract and then measure/profile things as we go to see where the opportunity is."* E4 asks whether canonical-name output can ride in `EXTRACTION_SYSTEM`; if it can, the prompt gets longer and the per-chunk cost changes. Profiling first would characterise a prompt that is about to be replaced, and the numbers would have to be thrown away. Protocol, controls and pre-committed verdicts: `docs/dedup-experiment-protocol.md`; results so far in `docs/dedup-e0-e1-results.md`. **Blocked on one thing only: the 40-pair blind audit at `graphs/testgraph/dedup/audit.html`, ~15 min, Brian.** Until it runs, E1's verdict stays provisional because the contamination bound is unmeasured. |
| 4 | **Performance analysis of `tessera extract`** (Brian, 2026-08-08) | NEXT (after the re-extract) | *"not particularly snappy, in my opinion."* Re-scoped 2026-08-08: not a one-shot analysis before the work, but measurement taken **as the re-crafted ingest lands** — dedup experiments, then re-craft ingest, then review + test, then re-extract, profiling along the way to find where the opportunity actually is. Detail below. |
| 15 | **Resolution view, slice 1** (forms table + read-time union + first anti-edge writer) | NEXT (after 14) | Deterministic, zero LLM calls; testgraph's entity view goes 1714 → ~1394 with no stored row touched. After 14 because E0's frozen labels supply its acceptance counts. Reasoning: `backlog.md`, "Identity as a read-time resolution view" (B27). |
| 5 | **Provenance-scoped delete** | BLOCKED-BY-DESIGN | Gates pointing any generator at a real graph. Origin marking exists; removal does not. Until it does, first dream ingest goes at a throwaway graph. |
| 6 | **`HEBBIAN_ASSOC` first writer** | DEFERRED | The one edge a dream exists to produce. Its acceptance test, when the dream path is built. |
| 7 | **I1 extraction quality** — KI-3, then B7 | DEFERRED, condition below | Promote to #1 the moment we want to claim anything about corpus-scale results. B5 layer 1 has moved: it is now slice 1 of the resolution view (item 15); the jitter half of KI-3 dissolves at read there, the generic-entities half stays prompt work here. |
| 8 | **SESSION / AGENT node types** | DEFERRED | Until a runner exists or the structural predicate replaces `mode`. See Object model depth. |
| 9 | **Dream / walk runners** | DEFERRED | Standing rule: not until ingest is solid. |
| 10 | **Slice 4** — provenance in the layout | DEFERRED | Removes the 36.6 s `h`-toggle cliff by construction. Changes geometry, so not while ingest topology is moving. |
| 11 | **Clustering / mining experiment** | DEFERRED | Fully specified and read-only. Gated on the resolution view (B27, which superseded B5 in shape) for the Connector half; the measurement half could run any time. |

Items 14 and 15 are numbered past 12 and 13 (the raised-needs-a-plan items below) and slotted by table
position, not by number.

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

## Raised 2026-08-08, needs a plan before writing (Brian)

Both come from the same session: he ingested into one graph, served another, and had no surface that would
have told him. `graph list` now reports sizes and the empty case is loud everywhere, which is the floor, not
the answer.

**12. An admin page — "see all the tesserae".** DEFERRED, needs a plan. Brian: *"In prior iterations of
mindmaps I've benefitted from an 'admin page' where I could see all the various tesserae."* Open questions a
plan has to answer: does it live in `serve` (which today serves exactly one graph, so this changes what
serve IS), or is it a separate surface? Is it read-only, or does it switch, rename, merge and delete — which
is backlog item "Named-graph management", already recorded and unbuilt? What does it show per graph beyond
size: last ingest, extraction debt, origins, media? Note the design constraint: `serve` binds one graph at
startup and the store is opened per graph, so multi-graph is not a view change.

**13. A REPL.** DEFERRED, needs a plan. Brian: *"as well as from a REPL."* Open questions: what is the unit
of interaction — queries against one graph, or a session that can switch? What does it return, given the
store's reads are typed value objects and the interesting questions (paths, common, affinity, provenance)
already exist as commands? Does it write, and if so what happens to the single-writer discipline and the
advisory lock while a human sits at a prompt with the graph open?

Both are worth doing and neither is worth improvising. Plan first, per the standing rule.

---

## Conditions that reorder this list

- **We want to claim something about what the graph shows** → item 7 moves to the top.
- **A corpus ingest is expected to run over 6 hours** → the lock heartbeat comes back (backlog B25 revisit).
- **A generator is pointed at a graph anyone cares about** → item 5 becomes blocking, not deferred.
- **Real corpora turn out to be scans rather than photographs and charts** → OCR-as-adapter beats captioning,
  and item 2 grows a sibling.
