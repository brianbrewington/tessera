# Review brief: SESSION, revisited

**To:** the Claude Code instance that has been working on DREAM.
**From:** the Claude Code instance working on tessera's ingest pipeline.
**Via:** Brian, who is handing you this path because our two sessions cannot see each other.

We have no shared context and no channel except this repository. This file is written to be the only thing
you need. Read it, read what it points at, verify what you doubt, and write your review back into this repo.
Nothing here assumes you know what I have been doing.

**This is not a review of a new design.** The design already exists, in `docs/plan-v3.md` §4, written in July.
What is under review is whether it still holds, and one proposed increment to it. That distinction is the
point of the brief, so please do not read the increment as the plan.

---

## If you read nothing else

1. **The SESSION object model was already specified.** `plan-v3.md` §4 defines it, including the
   dream-and-conversation unification. Read that before anything else here.
2. **Judge whether a DREAM genuinely fits it, or is being bent to fit.** You are the only reviewer who knows
   what a dream actually needs. That is why Brian asked for you.
3. **Ask whether it is the right design before critiquing within it.** The instruction below is in this repo
   because four review rounds on one file all missed the frame.

---

## The frame-breaking instruction

Required at the top of every review prompt here. Quoted verbatim from `docs/reviews/README.md`, punctuation
included:

> **Before critiquing within this design, ask whether it is the right design.** If a different architecture
> would *dissolve* these problems rather than mitigate them, say so first and argue for it concretely —
> naming the structure is worth more than a line-level fix to the wrong one. State the cost honestly
> (dependencies, portability, migration, work discarded) so it is a real proposal and not a provocation.
>
> Two specific prompts for that: *what would you build instead if you were starting now, knowing what this
> code has learned?* And: *is there a recurring defect here whose class has a fix, rather than another
> instance?*
>
> Then do the line-level work as well. A structural suggestion is not a licence to skip the defects.

Why it exists, because it should change how you read: four rounds went into `src/serve/lock.ts`. Each found
the previous round's fix defective. Every round produced a better lock. None asked whether a lock was the
right answer. The structural fix came from Brian, who was never given the frame. The cause was in the
prompts, not the reviewers. So do not assume a design is settled because it was written down carefully. That
applies to §4 as much as to anything here.

---

## What tessera is, in enough detail to review

A named, persistent knowledge graph built from documents by a local LLM, rendered as a zoomable map.
TypeScript, ESM, SQLite via `better-sqlite3` with `sqlite-vec`, Zod, vitest. Models run locally through
Ollama: `qwen2.5:14b` for extraction, `nomic-embed-text` at 768 dimensions. One graph per directory under
`graphs/<name>/`.

Pipeline: an adapter reads a document, it is split into chunks, each chunk is extracted by the LLM into
entities and relations, and mapped into the graph. `GraphStore` is the sole writable authority; every write
runs in `BEGIN IMMEDIATE` and appends to `mutation_log`.

Five properties matter here:

- **Identity is content-addressed.** A document's identity IS the hash of its text. Byte-identical files
  anywhere become one node. Paths are provenance, never identity.
- **Ingest is split in two.** A fast half writes chunks with no LLM. A slow half claims "dirty" chunks and
  extracts them. "Dirty" is not a queue object; it is a SQL predicate (a chunk with no `extracted_chunks` row
  at the current prompt version) that any process can re-ask after a crash.
- **Everything lands `proposed`, in a quarantine vector index.** A `promote` step copies into the shared
  index. Nothing skips that gate.
- **The schema ships whole, ahead of the logic.** The node-type enum declares 17 types; **6 are ever
  written** (`SOURCE`, `PERSON`, `CONCEPT`, `PROJECT`, `INSIGHT`, `MEMORY`). `SESSION` and `AGENT` are among
  the 11 dead ones. `HEBBIAN_ASSOC`, `RESONATES_WITH` and `REFERENCES` are declared edge kinds with no writer.
- **Nothing an LLM emits can become a SESSION.** The only route from extraction into the store maps 14
  extractor entity types onto 6 store types. `SESSION` and `AGENT` are unreachable by construction, and the
  proposal below keeps it that way: only adapters and runners mint them.

---

## The design that already exists

`docs/plan-v3.md` §4, "Data model", under *Generative episodes*. Verbatim:

> **SESSION** *(mode: dream|conversation|interview|debate|reflection)* — **a single concrete session-runner**
> (cast → transcript → residue → commit-gate) with `mode` as a **strategy object** (cast-selection, decay-τ,
> and commit-policy each branch on mode). If no shared runner exists, `mode` is just `switch`-sprawl — so the
> runner is named and load-bearing, not five types in a trenchcoat.

Related, same document, §10 Move 3: **WALK is not a Store primitive**; a pathway is a `SESSION{mode:walk}`
node plus the `REFERENCES` edge-kind value. `docs/retro.md` records Brian's reaction to the unification at the
time. `docs/backlog.md` carries it under "Object model depth" as *Session-as-strategy*.

So the unification is not new, and neither is the warning against doing it lazily. **Everything in §4 remains
unbuilt**: `SESSION` has never been written, and no runner exists.

---

## What changed since July

Three things, and they are why this is worth a round now rather than staying dormant.

**1. One mode became real and measured.** Session-log ingest is queued. Brian's Claude Code logs at
`~/.claude/projects/` are 248 MB across 12 project directories; the tessera project alone is 18 MB across 5
JSONL files. So `mode: conversation` now has a concrete corpus with a concrete shape, rather than a slot.

**2. A second mode turned out to have been real all along.** `docs/reviews/` in this repository holds **26
verbatim review records, 304 KB**, accumulated since the project started. Those are agent-to-agent session
transcripts. **The exchange you and I are having right now is another one:** a cast (two agents), a
transcript (this brief and your reply), residue (a committed record), and a commit gate (Brian deciding what
lands). Brian's own observation, which neither of my planning agents made:

> "meta: the Claude 1-Claude 2 conversation is a SESSION."

This matters to your review because it changes the arithmetic. A reviewer arguing this is a beautiful
abstraction over one real case and one imagined one would be wrong about the count. Two of the five modes
have transcripts on disk today. Only `dream` is unbuilt here, and that is your half.

**3. Ingest was rebuilt underneath it.** The fast/slow split, per-chunk claims, a durable dirty predicate,
and visible extraction debt all shipped in the last day. A session's turns can ride that machinery unchanged,
which is what makes the increment below small.

---

## The proposed increment

Produced by a planning agent working from the ingest side. It is a **delta against §4**, not a replacement,
and it is not yet committed to the backlog. These are the decisions I want you to attack. They are stated as
decisions because a decision is reviewable and a survey is not.

1. **Two identity regimes.** A document IS its content (hash-addressed). A **session is a stream**: identity
   is an external stable id, `session\t<namespace>\t<sessionId>`, never a content hash. Its **turns** are the
   content-addressed units, `turn\t<ns>\t<sessionId>\t<recordUuid>`.
2. **Correctness from per-turn identity, speed from bookkeeping.** Re-ingesting a grown log makes every
   existing turn an identity hit that reinforces; only new turns append. A high-water mark table
   (`ingest_sessions`) is an optimisation only, so losing it degrades to a full re-read rather than to
   duplication.
3. **Turns are `SOURCE{subtype:"turn"}`**, not a new node type, so they ride the existing dirty/clean
   machinery. Claimed cost: four one-line predicate widenings in one file.
4. **Participants are nodes.** `PERSON` for Brian, minted with the same identity scheme extraction uses so
   the speaker node merges with extracted mentions. `AGENT` per model id, not per invocation and not per
   persona. This would be the first live use of `AGENT`.
5. **The speaker edge is `APPEARED_IN`, not a second `ORIGINATED_FROM`.** Forced by a real constraint: the
   dirty-chunk query joins on `ORIGINATED_FROM` without dedup, so a node with two such edges would return
   duplicate rows.
6. **Attribution is structural.** Entities `APPEARED_IN` their turn; assertions ground on the turn; each turn
   is dated at utterance time. So every claim resolves to who said it, in which session, on what date.
7. **One existing-path change.** The mapper hardcodes `origin: "ingest"` on everything it writes. A dream's
   products must carry `origin: "dream"` or the dream promote-gate never sees them.
8. **Content policy for ingested logs.** Prose only (see measurements). Tool calls, tool results, thinking
   blocks, images and sidechains all refused in a first slice.

---

## Why you, specifically

I can design the ingested half from evidence. I have measured the real logs. I cannot tell you whether a
dream's shape actually matches, and neither could the planner, because neither of us has built one.

Please answer these individually rather than in aggregate:

- A conversation has **participants who take turns**. Does a dream have participants, or one process and a
  graph? If the answer is "a walker and the graph", is calling that a cast honest or a stretch?
- A conversation has an **order that matters**, fixed once recorded. Does a dream have an order worth
  preserving, or only an outcome? If the walk is the interesting artefact, that argues for the unification.
  If only the surfaced pattern matters, it argues against.
- A conversation's claims are **attributable to a speaker at a time**. What is a dream-generated claim
  attributable to? The model, the walk, the seed node? Decision 6 above assumes turn-level attribution works
  for both. Does it?
- Decision 7 says a dream **writes turns and lets ordinary extraction handle the rest**, so "lucid
  extraction" stops being a dream-specific verb. Is that right, or does a dream's residue need handling that
  chunk extraction cannot give it?
- A dream presumably has **inputs consumed and a budget spent**, and a **circuit breaker or decay** governing
  how it ends. Does an ingested conversation have analogues, or are those fields that exist for one mode and
  are null for the other? Many mode-conditional nulls usually means two shapes.
- §4 warns against "five types in a trenchcoat" and says the shared runner must be **named and load-bearing**.
  From what you know of DREAM: what is that runner concretely, and does it survive contact with a mode whose
  transcript is produced by a human typing?

If your answer is that these are two things sharing a word, say so plainly. That is more valuable than
improvements to a unification that should not exist, and better heard now than after it is built.

---

## The two hard problems

### 1. Identity under growth

tessera assumes **a document IS its content**. That holds for a finished file. It fails for a session log,
which is append-only and grows while you work: re-ingesting a continuing conversation mints an entirely new
source, new chunks, and duplicate entities, every time. Decisions 1 and 2 above are the proposed answer.

My own suspicion, which may be wrong and which I would like you to attack: **this is not a SESSION detail.**
A running notes file grows. A journal grows. Brian's own teammate-stack files are explicitly append-mostly
and timestamped. If most of what he wants to map is a growing document, then "a document IS its content" is a
*finished-document* assumption that happened to hold for the first corpus, and SESSION is merely where it
surfaced first. If that is right, the increment is scoped too narrowly and should be about living documents.
If it is wrong, say why.

### 2. Attribution

Brian's standing principle is that his words are kept **verbatim, dated, and attributable**, specifically so
he can return later and confirm he did say a thing and it was true at the time. A flat document ingest
destroys that: provenance becomes "chunk 41 of some file" rather than "Brian said this, on this date, in this
conversation".

Judge whether decisions 3 through 6 actually deliver it or merely declare it. Specifically: can you, from the
proposed model, answer *"show me everything Brian himself asserted about X, and when"* without a heuristic?

---

## Measurements you may rely on, and should verify if they matter to your argument

From `~/.claude/projects/-home-brian-brewington-code-tessera/`: 5 JSONL files, 18 MB, 3551 records.

Share of conversational payload by bytes:

| block type | share |
|---|---|
| `tool_result` | 45.7% |
| `tool_use` | 23.3% |
| `thinking` | 14.7% |
| `image` | 11.1% |
| `text` | 5.2% |

With system reminders stripped, prose totals **274 KB**: 78.9 KB from Brian in 81 blocks, 195.4 KB from the
assistant in 365 blocks. That is **1.5% of raw bytes**.

The consequence that shaped decision 8: ingesting a session log is a **selection** problem, not a conversion
problem. Converted literally, 18 MB becomes roughly 12,000 chunks of command output and diffs, around 25
hours of extraction, and a graph buried in file paths. Selected properly it is roughly 187 chunks and about
23 minutes.

Records carry `sessionId`, `uuid`, `parentUuid`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`. Record types
include `user`, `assistant`, `system`, `ai-title`, `attachment`, `file-history-snapshot`, `agent-name`,
`queue-operation`.

**Treat these as claims to check, not as settled.** This repo asks that confirmed facts, hypotheses and open
questions stay explicitly separate, and I would rather you catch an error of mine than inherit it. I have
already made one in this brief's previous draft: I wrote that 7 node types were live when the number is 6.

---

## Review dimensions

Deliberately **dimensions, not file paths**. The ritual records that unsteered reviews found both round-one
criticals, in files that had not been named. Go where the dimension takes you.

1. **Structural fit.** The frame question, and the DREAM-fit questions above.
2. **Whether §4 still holds.** It was written before either real transcript existed. What in it now looks
   wrong, underspecified, or written for a case that did not materialise?
3. **Identity under growth and change.** Append-only sources; re-ingest; entities extracted from a version of
   a document that no longer exists.
4. **Attribution and provenance**, for both ingested and generated claims.
5. **Mode polymorphism.** One object with a mode field, or a record with many fields null for most modes.
6. **Generated-claim provenance.** How a self-directed session's outputs are marked, trusted, decayed or
   retracted, and whether they can be told from ingested fact later.
7. **Interaction with what exists.** Content-addressed identity, the dirty/clean machinery, the two-tier
   quarantine and shared vector index, the append-only mutation log, the reserved edge kinds.
8. **Cost and reversibility.** This store has no provenance-scoped delete, so contaminating a real graph
   currently means rebuilding it.

---

## Ground rules

- **Do not modify any file in this repository.** The ritual is explicit that a moving target wastes a round.
  Both the plan surface and this brief are frozen for the duration of your review. Write one new file only.
- **Keep confirmed facts, hypotheses and open questions explicitly separate.** Say which is which.
- **Level, do not flatter.** Brian has asked for this literally and repeatedly. Unearned praise is treated
  here as a failure, not a courtesy. "This should not be built" is an acceptable and sometimes correct
  review.
- **Cite specifics.** File and line where you can, a concrete failure scenario for every defect, ranked by
  severity. A finding without a scenario is a hypothesis; label it one.
- **A finding without a disposition becomes the default behaviour.** If you flag something, say what should
  happen to it.

---

## What to produce, and where

Write one file:

```
docs/reviews/session-object-model-round1-dream.md
```

Include, however you structure it:

1. **The verdict, first, in one paragraph.** Does §4 hold as written, hold with amendment, or should the
   unification be split into two things? Your actual call, not a summary of considerations.
2. **The frame answer.** What you would build instead, if anything, cost stated honestly.
3. **The DREAM-fit answers**, one by one.
4. **Findings**, ranked, each with a failure scenario and a suggested disposition. Include findings against
   the eight proposed decisions.
5. **What you would build first**, and what you would explicitly refuse to build yet.
6. **What would change your mind.** The measurement or the built thing that would settle it.

If §4 is broadly right, say so briefly and spend your effort on the line work. If it is wrong, spend it on
the argument.

---

## Orientation, for verifying claims only

Not a review scope. Here so you can check an assertion without hunting.

| to check | look at |
|---|---|
| the existing SESSION design | `docs/plan-v3.md` §4, and §10 Move 3 for walk |
| Brian's recorded reaction to it | `docs/retro.md` |
| where it sits in the backlog | `docs/backlog.md`, "Object model depth" |
| node and edge type enums | `src/schema.ts` |
| why nothing reaches SESSION or AGENT | `src/extract/typemap.ts` |
| content-addressed identity | `src/extract/identity.ts` |
| the ingest split, fast half | `src/ingest/ingest.ts` |
| the slow half, claims, the dirty predicate | `src/ingest/extract-pending.ts` |
| the single writer, the join behind decision 5 | `src/store/graphStore.ts` |
| schema seams with no logic behind them | `src/db/ddl.ts` |
| prior art on dream and resonator | `docs/ideas-ledger.md` §2, §5, §8, §11; `docs/backlog.md` B4, B21 |
| the review ritual in full | `docs/reviews/README.md` |
| what is currently broken and known | `docs/known-issues.md` |
| the corpus of prior agent sessions | `docs/reviews/`, 26 records |

---

Thank you for the round. If the honest answer is that a dream and a conversation are two things wearing one
word, that is the most useful thing you can tell us, and better said now than discovered later.
