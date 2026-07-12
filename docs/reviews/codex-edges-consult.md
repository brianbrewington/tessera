Recommend a **hybrid with strict lifecycle**: keep **typed, thin edges** for graph logic, and attach **rich natural-language explanations as separate “edge assertions”** that can be embedded **only after grounding**.

### Why this is the stronger design

It preserves what `§4` already gets right (typed edges + explicit reason) while adding the missing safety rail for your hallucination risk profile.

```140:143:docs/plan-v1.md
**Edges** (typed): `RELATED_TO, RESONATES_WITH, ORIGINATED_FROM, HEBBIAN_ASSOC, APPEARED_IN` (a cast member
→ its SESSION). **Two separate weights that never overwrite each other:** `semanticWeight` (cosine
similarity, immutable) vs `hebbianWeight` (learned co-occurrence, grows with joint activation). Each edge
carries a `reason` string (which must name *both* endpoints — "related concept" is banned) plus provenance.
```

```157:161:docs/plan-v1.md
- **Connector (analytic):** edge candidates = embedding-proximity (cosine ≥ 0.75, top-k) + open-triangle
  closure (unconnected pairs that share neighbors), roughly 50/50; **tautology-debloat first** (drop
  "A relates to B" edges before spending an LLM call); then LLM-verify each candidate (keep if confidence ≥
  0.6) with a `reason` that names both endpoints.
```

```169:171:docs/plan-v1.md
  don't explain the connection") → *lucid-extract* (run entity-extraction on the dream text; new concepts it
  invents fold back into the graph as nodes) → *fast-decay transience* (the dream node itself decays away in
  minutes; the connections and reinforcement it sparked persist).
```

### Direct answers to your 4 questions

1) **Dumb vs explained edges**  
- Choose **explained**, but do **not** store explanation as a naive string on the edge alone.  
- Model as `edge` + `edge_assertion`:
  - `edge`: structural fact (`from`, `to`, `rel_type`, weights, lifecycle state)
  - `edge_assertion`: NL reason, provenance spans, embedding, confidence, grounding state  
- This gives semantic retrieval benefits without making every generated sentence authoritative.

2) **Do rich explanations flatten typed relationships?**  
- **Push back:** no, they do not subsume enums.  
- Keep a small relation set (including your proposed `SUPPORTS`/`REFUTES`/`DEPENDS_ON` for claims).  
- Reason: embeddings cannot reliably preserve **polarity and logical role**.  
  - Query “show refutations of claim X” fails if relation semantics live only in prose.
  - Lexical similarity often pulls support and refute text together (same topic words), creating false positives.
- Best pattern: **typed edge for machine semantics; free-text explanation for human nuance + retrieval ranking**.

3) **When should explanation graduate into a node?**  
Use this concrete promotion rule (any 1 true => graduate to `CLAIM`/`INSIGHT` node):  
- **Reusability test:** explanation would connect to >2 nodes (not just endpoint pair).  
- **Contestability test:** proposition can be supported/refuted independently of this pair.  
- **Evidence test:** needs multiple citations/quotes or multi-step rationale.  

If none are true, keep as edge assertion and cap to one atomic sentence.

4) **Quarantine + hallucination control**  
- Yes: **embedded explanations must be citation-grounded before entering default retrieval index**.  
- Lifecycle:
  - `proposed` (connector/dream output; not in default search)
  - `grounded` (has source/quote spans supporting both endpoints + relation)
  - `durable` (grounded + human accept OR repeated independent corroboration)
  - `rejected`
- Retrieval policy:
  - Default similarity search: `grounded|durable` only.
  - Optional “ideation mode”: include `proposed`, visibly flagged as speculative.
- Circuit breaker:
  - If sampled hallucination rate >5%: pause auto-promotion.
  - If >10%: disable proposal indexing globally until cleaned.

---

### Schema sketch (minimal)

```sql
-- Structural edge (machine-readable semantics)
edge(
  id, from_id, to_id,
  rel_type enum,               -- SUPPORTS/REFUTES/DEPENDS_ON/etc
  semantic_weight float,
  hebbian_weight float,
  state enum                   -- proposed/grounded/durable/rejected
);

-- Explanation as first-class semantic object
edge_assertion(
  id, edge_id,
  reason_text text,            -- must mention both endpoints
  reason_embedding vector,
  origin enum,                 -- connector/dream/user
  confidence float,
  grounded bool,
  source_quote_ids json,       -- provenance spans
  expert_surprise int,         -- 0..3
  created_at
);
```

### Worked Lincoln/Trump example

- Keep typed structural relation between two claim nodes:
  - `Claim A`: “Leadership benefits from tolerated internal dissent.”
  - `Claim B`: “Leader consolidates loyalty by eliminating rivals.”
  - `A CONTRASTS_WITH B` (or `REFUTES` depending framing)
- Store Brian-style rich text as `edge_assertion.reason_text`:
  - “Trump’s loyalty-purge culture contrasts with Lincoln’s team-of-rivals approach…”
- If this explanation begins linking to governance, organizational learning, and institutional resilience, it **graduates** into an `INSIGHT` node and edges fan out from it.

### Specific failure mode this avoids

If an ungrounded dream-generated reason is embedded immediately, it can rank highly for leadership queries and become a hub through Hebbian reinforcement, causing a **self-amplifying false cluster**. That is exactly the “actively harmful” regime you called out; the lifecycle gate prevents this.
