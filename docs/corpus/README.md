# corpus — source material for tessera's map

Primary-source documents fed **into** tessera to build its knowledge graph. Distinct from
`docs/history/` (raw archive of the six winter repos' dead code): this is the *content*
corpus — the attention-allocation thesis and its surrounding material — not salvaged
engineering. Each file carries provenance frontmatter (`source`, `author`, `original_date`,
`captured`, `origin`, `note`) so ingested nodes can be attributed and dated per the ledger's
provenance discipline.

Author attribution matters here: three of these are Brian's (or Brian & Claude); one is an
outside secondary source. Keep that line intact when these become CLAIM nodes.

| File | Author | What it is |
| --- | --- | --- |
| `book-chapters-and-titles.md` | Brian | Working chapter list & title candidates for *The Attention Line*. |
| `reading-list.md` | Brian | Curated short reading list — the formal core, failure canon, channel-side design. |
| `thread-summary-attention-allocation.md` | Brian & Claude | The reviewability-experiment thread: pivot from proxy-repair to a theory of the saturating channel. |
| `gemini-commentary-attention-architecture.md` | Gemini (not Brian) | Outside research/lit-review synthesis over the above. Secondary source. |

*Captured 2026-07-12 from a Google Drive export. The `.docx` originals were `.md` wrapped by
a Google Docs export; converted back to Markdown via a faithful HTML→MD pass (no smoothing —
verbatim content, structure preserved). The Gemini file arrived as Markdown and is stored as-is,
including its inline footnote-ref artifacts.*
