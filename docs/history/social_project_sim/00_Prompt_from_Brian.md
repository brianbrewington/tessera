# Context Audit Tool Requirements
**Author**: Brian Brewington (User)
**Date**: 2026-01-10
**Role**: Product Owner / Chief Architect
**Purpose**: Design a "Deep Dive Utility" to audit, verify, and improve the quality of the Context Graph.

## Problem Statement
The Context Manager currently suffers from parsing errors and misclassifications (e.g., Ada Lovelace as distinct Concept/Project/Person). We need to answer:
1. Does the assembled context make sense?
2. Are there duplicates?
3. Does it answer questions correctly (validated against a "Golden Set")?

## Required Features (The Deep Dive Utility)

### 1. Full Graph Introspection
- Query the graph to produce a complete list of *every node and edge*.
- **Constraint**: Log every conversation with the LLM (Cap at 1GB). Keep in memory until the end.

### 2. Node Consistency Analysis
- For **ALL** nodes: Analyze text/category for internal consistency (e.g., "Is 'Ada Lovelace' a 'Project'?").
- **Action**: Write LLM response back to Node Metadata.
- **KPI**: "Node Consistency Rate".
- **Tracking**: Maintain a ranked list of "Buggy Nodes" (ordered by node weight).

### 3. Edge Rationale & Embedding
- For **ALL** edges: Fetch endpoints.
- **Query**: Use endpoints to query the Context Manager (as if answering a question) to get 1-hop neighbors.
- **Narrative**: Ask LLM to generate a narrative explaining *why* the edge exists.
- **Embedding**: Calculate embedding for this narrative and store it on the Edge Metadata (indexable).
- **Validation**: Ask LLM "Does this explanation make sense?".
- **KPI**: "Edge Rationality Rate" (Counter).
- **Tracking**: Ranked list of False Positive Edges.

### 4. Missing Link Detection (Edge False Negatives)
- Loop over all nodes.
- **Vector Search**: Query DB by node embedding to get nearest N (e.g., 40) nodes.
- **Check**: If no edge exists between them, ask LLM: "Should this edge exist?".
- **Tracking**: Ranked list of False Negative Edges.

### 5. Pattern Recognition
- Feed the top 100 Node Errors, Edge False Positives, and Edge False Negatives to the LLM.
- **Goal**: Ask LLM to spot systemic patterns in the failures.

### 6. Reporting
- Assemble a Markdown report.
- Include details of checks run.
- Link to the full LLM conversation log.

## Deliverables
1. **Design Document**: Detailed component list and exhaustive test plan.
2. **Design Review**: Engineering critique of the design.
3. **Refined Design**: Update doc based on review.

**Status**: Design Phase Only. No Code Implementation yet.
