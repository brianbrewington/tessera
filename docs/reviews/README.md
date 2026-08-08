# How reviews are run here

Cross-agent review is the ritual for this repo: outline → review → revise → review → full write-up → review →
build in slices, each slice reviewed. Every review is preserved verbatim in this directory; the design doc
carries a section responding to each round.

## The frame problem (added 2026-08-08, after four rounds on one file)

Four review rounds went into `src/serve/lock.ts`, and each found the previous round's fix defective. Every
round produced a better lock. None of them asked whether a lock was the right answer.

The structural fix came from **Brian**, who was never given the frame: split ingest into a fast path and an
async dirty→clean worker, so the lock is held for milliseconds instead of hours and the whole staleness
problem evaporates. A reviewer eventually made a related argument (use `flock`, bind to process lifetime,
delete the heuristics) — in round *four*.

The cause was in the prompts, not the reviewers. Across those rounds I asked, verbatim: *"attack the design",
"did the fixes hold", "attack the NEW material", "break the lock".* Every one of those invites defects
**within** the structure and silently asserts the structure is settled. A reviewer given a frame will work
inside it.

## The instruction to include

Put this near the top of any review prompt, before the specifics:

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

## Why it is bounded that way

"Be provocative" on its own invites grandiosity — rewrite-it-in-X, or a redesign that ignores the constraints
the current shape exists to satisfy. The bounds that keep it useful:

- **Only when it dissolves a class**, not when it merely rearranges. The test is whether problems *disappear*
  rather than move.
- **Cost stated honestly.** A proposal that omits what it discards is not reviewable.
- **Still do the line work.** Otherwise the structural suggestion becomes a way to avoid the tedious part,
  and the tedious part is where the criticals were.

## The rest of the discipline (unchanged)

- **Unsteered:** give *dimensions*, never file paths. Both criticals in round 1 came from unsteered runs, in
  files I had not named.
- **Re-review the fix, not just the bug.** A fix is unreviewed code written under confidence and inherits
  none of the scrutiny that produced it.
- **Don't modify files a reviewer is reading** — a moving target wastes the round.
- **Cursor reviews need a committed tree** (`-f` grants full tool access, so review from a clean checkout).
- `docs/history/social_project_sim/00_prompt_code_review_generation.md` is the original prompt template.

## Reviewer notes

- **Codex** (`gpt-5.3-codex`) — premise verification and API contracts. Caught seven factual errors in a
  section labelled "ground truth".
- **Grok** (`cursor-grok-4.5-medium`) — structural contradictions. Found an impossible migration and a build
  order that contradicted its own writer rule.
- **Composer** (`composer-2.5`) — good breadth; cheap.
- **Fable 5** — run as a local subagent, *not* via the `cursor-review` skill (which excludes Anthropic models
  by design, since its purpose is a different lab's eyes). Consistently the deepest, and the only reviewer
  that found defects by **executing probes** rather than reading — including a demonstrated 3.86-second
  double-hold on the lock.
