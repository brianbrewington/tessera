# tessera — distributed "mining" with a fleet of small models (idea doc)

*A backlog/vision doc to cook, not a build plan. The seed (Brian): plug a few Jetson-class boxes on the network,
each running a small local LLM, and give each tasks suited to its size — parallelizing graph construction. "What
can a little model do that, if we had 10 of them, might speed us up?"*

---

## The reframe (the important one)

The naive read — "run the same extraction on 10 small boxes for 10× throughput" — is half the story and the
weaker half: a small model doing the *whole* extraction job is noisy, and you'd spend the parallelism fighting
quality. **The strong read: decompose graph construction into narrow, independently-verifiable micro-tasks, and
run a swarm of cheap PROPOSERS and VERIFIERS.** Small models are bad at synthesis and multi-hop reasoning but
genuinely good at *narrow, local, checkable* judgments — "is this a real entity? y/n", "does this sentence
support this claim? y/n". That's exactly the shape of most of graph construction once you break it down.

This isn't speculative for tessera: `embeddings_experiments` already found that a **two-gate approach — cheap
proposal, then LLM verification — got to ~0% false merges** where geometry alone over-merged catastrophically. A
Jetson fleet is that verification gate, at scale, in parallel. The distributed part is the delivery vehicle; the
*decomposition into verifiable pieces* is the actual idea.

## Why tessera is unusually ready for this

- **Chunks are the natural shard.** Ingest is already chunk-parallel and the chunk memo is idempotent — a
  coordinator can hand chunk N to any worker and re-runs are safe.
- **Identity is deterministic and coordinator-owned.** Workers only *propose*; the mapper owns identity via
  `content_hash` of the identity string, so parallel workers can't corrupt the graph — merges are deterministic.
- **De-anchored reasons cluster by relationship kind** — verification and clustering micro-tasks operate on
  clean, node-independent units.
- **The scorecard is the fitness function.** Any swarm change is measurable against `tessera report`
  (entities/doc, de-anchored %, banned-phrase, orphans) — so this can be tuned empirically, not by faith.

## What a little model does well — and doesn't

**Good fits (1–3B, narrow, local, verifiable) — the swarm's bread and butter:**
- **Entity spotting** in one sentence: "list the specific named things here." *(Brian's #1)*
- **Graph-worthiness filter** (binary): "is `<entity>` a specific named thing worth a node, or a generic common
  noun? y/n." *(Brian's #2 — directly attacks KI-3 noise; a filter-swarm votes on every proposed entity.)*
- **Type classification**: "`<entity>` in context → PERSON / PLACE / ORG / CONCEPT / …" (and its inverse: catch
  the `Imifino` CONCEPT-vs-PRODUCT type-jitter by majority vote).
- **Edge evidence verification**: "does this passage support `<A> — reason — B>`? y/n + confidence." *(Brian's #3
  — verification is the single best swarm task: cheap, parallel, and consensus of N smalls rivals one big model.)*
- **Reason-quality checks**: "is this reason vague (like 'related to')? y/n" · "does it restate the endpoint
  names? y/n" — the scorecard's heuristics, done by a model, per edge.
- **Local coreference**: "given the subject is Anele, who is 'he' in this sentence?" (feeds subject-aware extraction).
- **Dedup / alias verification**: "are `<a>` and `<b>` the same entity? y/n" (KI-4 name-variant folding; the
  two-gate verify gate).
- **Pairwise reason-kind similarity**: "same kind of relationship: `<r1>` vs `<r2>`? y/n" — the pairwise judgments
  that build the discovered edge taxonomy from clustered reason embeddings.

**Poor fits (keep on the big adjudicator — the Mac Studio / qwen-14b):** writing a good de-anchored reason
(synthesis), whole-document subject resolution, deciding the final merged entity set, nuanced disambiguation,
multi-hop reasoning. The pattern: **smalls propose + filter + verify; the big model synthesizes + adjudicates.**

## Task menu, grouped by pipeline stage

- **Propose** (fan out per sentence/chunk): entity spotting, relation spotting, chunk-boundary detection
  (semantic chunking beats size-splitting), chunk gisting.
- **Filter** (binary votes): graph-worthiness, buzzword/NEGATIVE_CONSTRAINTS enforcement, dangling-relation drop.
- **Verify** (the highest-leverage swarm): edge evidence support, reason vagueness, de-anchoring, entity-type
  agreement, **adversarial refutation** ("try to refute this edge" — the code-review pattern applied to edges).
- **Resolve / dedup**: coref, alias folding, cross-doc entity-resolution candidates (the deferred hard problem —
  smalls as the verify gate over embedding-proposed pairs).
- **Cluster / taxonomize** (background): pairwise reason-kind similarity, cluster labeling, community boundary checks.
- **Rate / score**: 1–5 evidence-support rating per edge; confidence per entity — turns the graph into a *ranked*
  graph the resonator/prominence layer can use.

## Architecture patterns to sketch

- **Map-reduce**: coordinator splits doc → workers extract/verify → coordinator merges via the deterministic
  identity contract. The safe default.
- **Task queue / work-stealing**: a heterogeneous queue of micro-tasks; workers pull what they can run. Load-balances
  a mixed fleet (a couple of Orins + several Pis + the Mac Studio).
- **Cascade / triage**: smalls do the cheap first pass and *escalate only the hard/ambiguous cases* to the big
  model. Cost-optimal — the big model only touches what the swarm couldn't settle.
- **Consensus / ensemble**: K smalls on the same unit; keep what ≥M agree on; disagreement → escalate. Small-model
  noise cancels by voting — this is how a swarm reaches big-model quality on extraction itself.
- **Specialist roles**: assign each box a role (proposer / type-classifier / edge-verifier) rather than N
  generalists — a pipeline of specialists, each prompt-tuned for its one job.

## The "mining" framing (the evocative part)

The boxes as **always-on miners** pulling from a task queue: new docs → mine entities/edges; idle time → *re-mine*
— re-verify aging edges, hunt dedup candidates, propose cross-doc links, recompute prominence/decay. That idle-time
background pass **is the deferred resonator** — the Jetson fleet is a natural compute substrate for it. Mining graph
structure instead of hashes.

## Honest assessment / open questions

- **Hardware reality check.** A base **Jetson Nano (4GB, older) is genuinely underpowered** — realistically tiny
  quantized models (≤3B), slowly. The *pattern* is right regardless of the exact box; **Orin Nano/NX (8–16GB)** is
  the realistic proposer/verifier tier, with the **Mac Studio as the adjudicator**. Don't marry the idea to the Nano.
- **Where the win actually is:** parallelism *plus* verification *plus* always-on background mining — not "small
  model does the same job." If it degenerates into the latter, it's not worth the coordination cost.
- **Granularity vs chatter:** per-sentence micro-tasks may be too network-chatty; per-chunk is the safer unit.
- **Coordination overhead vs. a bigger single model:** be honest per task — for pure extraction throughput, one
  bigger model may still win; the swarm's edge is *verification at scale* and *background re-mining*, which a single
  model can't do continuously.
- **Energy/cost**: a Nano fleet's watts vs. cloud vs. the Mac. Worth an actual measurement before committing.

## The minimal first experiment (when we pick this up — build by hand first)

Don't build the fleet. Prove ONE micro-task swarm on the machines we have: **edge evidence-verification.** Take an
existing graph's RELATED edges, fan each `(chunk, A, reason, B)` out to K small models asking "supported? y/n",
keep the majority verdict, and **measure against the scorecard** — did the verified subset have fewer bad edges
than the raw set? If a swarm of smalls measurably beats the raw extraction on edge quality, the architecture has
earned the hardware. Start there, hand-run, one task, one number.
