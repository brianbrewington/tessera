# Review brief — v3.1 delta: path-dependent prominence, the generative walk, ε-as-audit

*You are a teammate reviewer, not an adversary. Critique to sharpen, not to attack — but shield us from nothing.
This is a **proposed delta** to a plan of record (`plan-v3.md §10`); your job is to find where it breaks before it
touches the Graph Store contract. **Review convention: when you assert a flaw, provide the smallest concrete
input→wrong-output (or a code/pseudocode snippet) that demonstrates it.** A flaw with a runnable demonstration
outranks a flaw described in prose.*

## Context (what already exists)

**tessera** is a zoomable, prominence-ranked idea-graph with a generative "dream." Graph Store = sole writable
authority (SQLite + sqlite-vec, WAL single-writer, TS). Prominence today = `rank(S_raw)` **within a tile** (top-N
budget per zoom — relative, not absolute-threshold). Read API is tile-addressable: `get_tile(zoom, bbox)`. A
two-tier vector index (quarantine = all embeddings; shared = durable only; `promote` copies across) with a
hallucination circuit-breaker over promotions. A "dream" surfaces non-obvious connections via ε-teleport.

Prior validated result we're building on — `embeddings_experiment/EXP-006` (cycle-length edge discovery):
stretching a closure path (A→B→C→D→E, propose A↔E) with a **chain-aware prompt** "pressures the LLM to synthesize,
not just relay"; the GENERATIVE fraction of discovered edges rises with cycle length while discovery rate falls.

## The delta under review (three moves)

**1. Prominence becomes path-dependent: `prominence(node, path_context)`, not `f(node)`.** The current walk/history
re-ranks the map — personalized-PageRank / random-walk-with-restart seeded from the path. Rationale: this is the
Google-Maps mechanism (search-history + place-visits → highlighting) on idea-space, and it unifies MAP and WALK (the
walk re-tiles the map). "A minor idea becomes major with the backlinks." Contract delta: `get_tile(zoom, bbox,
path_context?)`; context-free term ships v1, personalized term v2.

**2. The walk synthesizes hidden "third nodes," it doesn't just traverse.** Path length = a RELAY↔SYNTHESIZE dial
(per EXP-006). A narrative transition = an **archetypal-question BRIDGE node** the walk *manufactures* to make two
endpoints cohere; a back-reference = a newly-created edge. So the walk **grows the graph** (walk → craft bridges +
callbacks → new nodes/edges → prominence shifts → richer walks). Contract delta: walk verbs that mint BRIDGE nodes
via the EXP-006 chain-aware prompt + REFERENCES edges; a savable ordered **pathway** primitive. This promotes WALK
from a viewer affordance to a first-class Store primitive.

**3. ε-explore is reframed as a frame-AUDIT, not a bubble-antidote.** Claim: the "filter bubble" and the "click"
(understanding crystallizing onto a tighter, usable frame) are the *same* mechanism — path-dependent convergence —
differing only in whether the converged frame is *true* (fits the world) or merely *comfortable* (fits history). So
we *want* convergence; ε exists to test the converged frame against off-path reality and keep it honest (the
change-detection thesis turned inward). Contract delta: ε-budget is a non-optional counterweight, framed as a
staleness/honesty audit.

## The four questions we most need pressure on

- **(a) Tractability.** Is `f(node, path)` prominence computable on read at 10⁵ nodes, or does it force a
  per-session materialized RWR cache? Show the cost. Where does the tile budget (top-N per tile) interact badly with
  a per-path re-rank — can the geography flicker unusably as the path grows?
- **(b) Generative-growth safety.** The walk minting BRIDGE nodes reopens the hallucination-breaker / GC surface the
  dream already has. Are BRIDGE nodes `proposed` and subject to the same promote gate + breaker + TTL — and does the
  walk→prominence→walk flywheel create a positive-feedback loop that inflates its own bridges? Demonstrate a
  runaway.
- **(c) Is WALK actually a new primitive?** Or is a "pathway" just an ordered query + a couple of edge kinds over the
  existing MAP contract, and we're inventing a primitive we don't need? Argue the cheaper decomposition if it exists.
- **(d) Measurable honesty.** Does ε-as-audit need a *measurable* per-frame staleness signal to mean anything, or is
  the existing per-type decay-τ sufficient? If it needs one, propose the cheapest signal that would falsify "this
  frame is still true."

Return: the single most load-bearing flaw first (with its demonstration), then the rest, then any place the delta is
*under*-reaching (a stronger version of the idea we're not yet proposing).
