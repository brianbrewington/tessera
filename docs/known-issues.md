# tessera — known issues (defect log)

Concrete defects in current *output* (distinct from `backlog.md`, which is deferred *features*). Each has a
repro so it can feed the I1 extraction-quality work. Fix when cheap; otherwise these are I1 acceptance targets.

---

## KI-1 — the document's subject isn't linked to what the document says about it  *(FIXED 2026-07-26)*
**Repro:** ingest a persona (e.g. Anele Sotashe); open the `Father` node. It links to `Camera`, `Photography`,
`plot` — but has **no `RELATED` edge to Anele**. The only tie is provenance (`appears in: Anele Sotashe`), so
you cannot traverse persona → father.
**Why:** chunk-local extraction + first person. The chunk says *"my father's camera"* — the model links
`Father`↔`Camera` but never sees "Anele" (she's `I`/`my`), so no `Father —→ Anele` edge is emitted. The
document's own subject is invisible to the chunks that describe it.
**Fix (also fixed KI-2):** **subject-aware extraction** — the adapter derives the subject from a persona's
`PROFILE:` line; `Extractor.extract(text, {subject})` appends a `subjectClause` to the prompt that resolves
first/third-person refs to the subject, extracts the subject as an entity, links it to what the text says, and
names relational people `<Subject>'s <Relation>` with a relation back to the subject. **Verified live:** Anele's
graph went from a floating `Father` to `Anele Sotashe's Father` + `Anele Sotashe` at RELATED degree 39 (kin,
places, projects all linked). Plumbing unit-tested in `test/tracer-ingest.test.ts` ("subject-aware extraction").
The live-quality (does the model obey) is a Tier-2 acceptance concern, not hard-asserted.

## KI-2 — vague relational-role entity names  *(FIXED 2026-07-26 via KI-1)*
**Repro:** the `Father` node above is named bare `Father`; other personas yield `Mother`, `Sister`, etc.
**Why:** an unnamed person referred to only by relation gets the role as its name.
**Fix:** the KI-1 subject injection names them `<Subject>'s <Relation>` (e.g. `Anele's Father`) — specific,
and distinct across personas (PERSON identity is already source-qualified, so they never merge; this only
fixes the human-facing display name). Alternatively, drop unnamed relational people unless graph-worthy.

## KI-3 — extraction is noisy: ~52 entities/doc vs. ~5–15 target; generic + type-jitter  *(the I1 headline)*
**Repro:** `tessera report <graph>` → `entities/doc: 52`; hubs include generic nodes (`Plot`, `Major Producers
in the Region`); `Imifino` appears as both `CONCEPT` and `PRODUCT` (type-jitter fragments a hub into two nodes).
**Fix:** tighten the prompt's NEGATIVE_CONSTRAINTS + type rubric; a same-name/different-type reconciliation
pass within a doc. Drive the number down against the scorecard. (This is the I1 workstream itself.)
