# tessera

*A zoomable, prominence-ranked map of idea-space — with a generative "dream" connection engine — growing
toward **proactive, inspectable memory** for human–AI thinking. Pronounced, deliberately, tes-SER-uh — one
tile of a larger mosaic.*

> ⚠️ **Work in progress — design & adversarial-review phase, not a running system.** No implementation yet;
> the first code slice begins from `docs/specs/graph-store-spec-v2.md`. The plan will change under you. On purpose.

## What it is

Ingest heterogeneous material (markdown, PDF, docx, images) → a typed **idea-graph** → **prominence** (an
elevation that rises with use, decays with neglect) → a **semantic-zoom map** (a map-tile pyramid: zoom out to
the landmarks, zoom in as detail blooms) → a **"dream"** that generatively surfaces *non-obvious* connections
you'd never hand-author, keeping only what survives.

Two load-bearing bets: **(1) prominence-gated semantic zoom** (a living map, not a flat force-graph) and
**(2) the dream** (a pass that *makes* connections, not just finds similar ones). The through-line: it's an
**attention-allocation instrument** — deciding what surfaces, at what scale, is attention shaping.

## Status & layout

- `docs/plan-v3.md` — current plan of record (hardened across review rounds).
- `docs/specs/graph-store-spec-v2.md` — the first build artifact, gated by a full multi-model review.
- `docs/reviews/`, `docs/specs/reviews/` — the review record + a meta-study of *reviewer attention*.
- `docs/ideas-ledger.md`, `docs/retro.md` — durable ideas + decision log.
- `experiments/habituation/` — a runnable harness (a described experiment is a narrative; this one runs).

## How it's built

Every spec and implementation passes a **multi-model peer-review gate** — frontier models (Codex, Grok), local
models, and a blind Claude subagent — before it's "done", with reviewers asked to **demonstrate** flaws (a
runnable failing sequence), not just describe them. A running meta-study tracks what each reviewer catches.

---
*Early, honest, and changing.*
