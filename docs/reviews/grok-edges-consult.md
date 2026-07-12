**Stronger design: explained edges with a thin structural polarity, embeddable only after promote — and a hard graduation rule when the reason stops being “why A↔B” and becomes “a claim that happens to mention A and B.”**

This aligns with §4 (edges already carry `reason` + provenance), §2/§6 (click edge → read why), Codex’s edge lifecycle, and the proposal/quarantine seam from the prior review — while respecting the embeddings-experiment failure line (hallucination >10% = approach broken).

---

### 1. Dumb vs explained: take explained, but not “always in ANN”

**Do not ship dumb edges.** Tessera’s own bar requires inspectable why (§2, §6). Ledger already treats edge-reason quality as the primary retrieval lever. Dumb `{from,to,weight,type}` fails the product and throws away the prior experiment’s upside.

**But do not ship “every LLM reason is a first-class retrieval object.”** That is the failure mode the Wikipedia experiment was designed to catch: hallucinated edges in context are worse than no edges.

| Layer | What it is | Cost if unbounded |
|--------|------------|-------------------|
| Topology | `from`, `to`, weights, thin type/polarity | Hairball if over-linked (§8.3) |
| Explanation | NL `reason` naming both endpoints (§4) | Storage small; hallucination harm large if trusted |
| Retrieval object | `reasonEmbedding` in the same ANN as nodes | Retrieval noise + poisoned multi-hop if ungrounded |

**Proposal:** every durable edge has a reason (display + audit). **Only promoted edges get `reasonEmbedding` and enter mixed node/edge similarity search.** Proposed edges keep `reason` text for the inspect panel and for tautology/ExpertSurprise gates — they do not light up the map as semantic neighbors until grounded/promoted.

That keeps the ee bet (edges as semantic objects) without making Connector/Dream residue into an unfiltered RAG corpus.

---

### 2. Rich edges vs typed enums: push back on full subsumption

Brian’s intuition is right for **content**:  
`"Trump’s culture of cultivating sycophants… is the exact opposite of Lincoln’s team of rivals"` is richer than `REFUTES` and is searchable once embedded.

It is wrong for **structure**. Free-text does not replace a small typed/polarity layer for three jobs rich reasons fail at:

1. **Filter without embedding.** Epistemic zoom / “show disagreements” needs `polarity = contradicts` (or edge type `REFUTES`), not “retrieve phrases that sound oppositional.”
2. **UI without reading.** Contradiction edges need a distinct stroke/glyph; you cannot derive that reliably from cosine over reasons.
3. **Graph algorithms.** Open-triangle closure, community detection, and “conflict subgraph” want discrete predicates. “Reason mentions ‘opposite’” is not a predicate.

**Stronger reconciliation (not Codex’s fat enum, not Brian’s enum-kill):**

```
edge.kind     ∈ { RELATED, ORIGINATED_FROM, APPEARED_IN, HEBBIAN_ASSOC }  // structural / system
edge.polarity ∈ { none | elaborates | supports | contradicts | depends_on } // optional epistemic axis
edge.reason   : string   // mandatory for human/LLM-authored links; both endpoints named
```

Keep §4’s system kinds (`ORIGINATED_FROM`, `APPEARED_IN`, `HEBBIAN_ASSOC`, `RESONATES_WITH` as analytic proximity). Collapse most “idea–idea” semantics into **`RELATED` + polarity + reason**.

- `REFUTES` becomes `polarity=contradicts` + rich reason — not a sprawling ontology.
- A CONFLICT **node** (from the prior review) is still useful when disagreement is an *n-way object* with its own prominence and zoom behavior — not when it is only a binary link. Binary opposition stays an edge; a debate that becomes a first-class map landmark graduates to CONFLICT/CLAIM.

**Concrete counterexample to “reason subsumes enum”:**  
Query: “all contradictions involving Lincoln.”  
- With polarity: `WHERE polarity='contradicts' AND endpoints touch Lincoln` — exact.  
- With reason-only ANN: you get some hits, miss paraphrases (“antithesis,” “foil,” “inverts the cabinet logic”), and false-positives (“Lincoln opposed slavery”). Polarity is the cheap invariant; reason is the content.

---

### 3. Graduation rule: when reason becomes a node

**Rule (operational):**  
**Keep as edge attribute when the text’s job is to justify the link.**  
**Graduate to INSIGHT/CLAIM when the text’s job is to be a reusable idea that other things can attach to.**

Tests (graduate if ≥2 fire):

| Test | Edge-stay | Graduate |
|------|-----------|----------|
| **Detachability** | Drop endpoints → sentence becomes empty or nonsense | Sentence still asserts something interesting alone |
| **Fan-in** | Only useful for this pair | Likely to SUPPORT/REFUTE other nodes later |
| **Contestability** | Mere gloss (“both concern leadership”) | Contestable thesis (CLAIM) or aha (INSIGHT) |
| **Retrieval intent** | “Why are these linked?” | “Find this idea again under other queries” |
| **Prominence** | Should ride endpoint elevation | Deserves its own strength/τ/pin |

**Lincoln/Trump — graduate.**  
Detached: “Cultivating sycophants and eliminating rivals is the opposite of a team of rivals.” Still a thesis. Contestable. Will fan into other PERSON/CLAIM nodes. That is a **CLAIM** (or INSIGHT if session-born aha), not an edge caption.

**Schema sketch for the graduate case:**

```
CLAIM:c1  text: "Sycophant-cultivation leadership is the antithesis of Lincoln's team of rivals"
EDGE: Lincoln --[polarity=elaborates, reason="historical exemplar of rival inclusion"]--> c1
EDGE: Trump   --[polarity=elaborates, reason="exemplar of rival-elimination culture"]--> c1
# optional later:
EDGE: c1 --[polarity=contradicts]--> CLAIM:c2  # if another thesis emerges
```

**Edge-stay example:**  
`Connector` links CONCEPT:prominence ↔ CONCEPT:PageRank with  
`reason: "Both score node importance from graph structure; tessera uses decayed strength instead of classic PageRank in v1 (§8.4)"`  
Detachability fails (needs both). Fan-in low. Stays on the edge; embed after promote.

**Failure mode if you never graduate:** every insightful dream leaves a fat edge reason that cannot be reinforced, pinned, conflicted-with, or cited as a first-class idea — while similarity search keeps resurfacing the *pair* instead of the *thesis*. The map fills with clever wires and no durable claims.

**Failure mode if you always graduate:** “Denver is in Colorado”-class reasons become CLAIM nodes → type sprawl / ExpertSurprise≈0 pollution. Gate graduation with detachability + ExpertSurprise≥2 (or human promote).

---

### 4. Quarantine + embedding: proposed reasons are visible, not retrievable

Reconcile §5 Connector/Dream with proposal/commit (prior review) and Codex’s `proposed → tentative → durable`:

```
status: proposed | tentative | durable

proposed:
  - reason text OK (inspect panel, ExpertSurprise/tautology gates)
  - NO reasonEmbedding in shared ANN
  - NO contribution to mixed node/edge similarity
  - dream/Connector default (§8.5 lucid-extract residue)

tentative:  // optional mid-tier
  - citation present OR repeated independent resurfacing
  - may embed into a *quarantine* index (viewer “proposals” search only)

durable:
  - citation-grounded (Connector/analytic) OR human accept OR N independent resurfacings
  - reasonEmbedding written; eligible for mixed retrieval
  - counts toward pyramid/Hebbian as real structure
```

**Must explanations be citation-grounded before retrieval?**

**Yes for analytic Connector edges** — reuse ee’s three-layer check (mechanical substring → semantic reason↔citation → grounding). Unsupported/contradicted stays `proposed` (or discarded). Partial can be `tentative` with UI tint (§6 epistemic stub).

**No absolute citation for dream residue** — dreams invent. They must not enter durable ANN on weave alone. Path: `proposed` → human apt/not (your success metric) or consolidation → if accepted without a SOURCE quote, mark `origin: dream-synthesized` and **still require promote before `reasonEmbedding`**. Dream insights that graduate to CLAIM/INSIGHT nodes follow the same commit ethics as lucid-extract (propose first).

**Specific failure mode:** Dream proposes Lincoln↔Trump with a fluent reason, embeds immediately, ExpertSurprise looks high. Next query “cabinet composition / loyalty vs competence” retrieves the **hallucinated edge** into RAG context. Model elaborates the fake contrast as fact. That is worse than a missing link — exactly the ee >10% break condition. Quarantine without embed prevents that; inspect-panel reason still satisfies “click edge → read why” for proposed edges (dimmed / dashed stroke).

---

### Worked pipeline (one object through the system)

1. Connector or Dream emits candidate pair `(Lincoln, Trump)`.  
2. LLM reason: sycophants vs team-of-rivals (ExpertSurprise≈3).  
3. Detachability fires → extract **CLAIM** node + two elaborates edges (or one RELATED with polarity=contradicts if you keep binary).  
4. All land as `proposed`; reasons shown on click; **not** in ANN.  
5. Grounding: if Connector, require citations from corpus notes; if Dream, wait for user “apt” or a SOURCE/QUOTE later.  
6. On promote: write embeddings for CLAIM text (always) and for any remaining edge reasons; only then can similarity mix nodes and edges.

---

### Verdict (what to write into the plan)

| Question | Decision |
|----------|----------|
| Dumb vs explained | **Explained** (already §4); embed reasons **only when durable** |
| Enum vs rich reason | **Thin kind + polarity + rich reason**; rich text does **not** kill polarity/CONFLICT-as-node for n-way debate |
| Graduate when | **Detachability + fan-in/contestability**; Lincoln/Trump → CLAIM; gloss links stay edge `reason` |
| Hallucination | **Proposed reasons never enter mixed retrieval**; Connector needs citation verdict before durable; Dream needs promote (human or consolidation), with `origin` stamped |

That is the stronger design: edges remain semantic objects (ledger + ee), but **authority and retrieval are gated by status**, and **insightful prose graduates to nodes** so the pyramid and epistemic zoom have something to elevate besides a caption on a wire.
