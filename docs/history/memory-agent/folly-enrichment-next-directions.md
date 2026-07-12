# Folly Graph Enrichment — Next Directions

Ideas surfacing from the end-to-end enrichment pipeline run (Feb 2026).
The enriched graph has **11,632 nodes** (235 entity types), **13,674 edges**
including 391 discovered edges and 1,116 cross-island linkage edges.

---

## 1. Entity Deduplication

Edge discovery revealed many near-duplicate entities with spelling variants
(e.g. "NASA" / "Nasa", "O-ring" / "o-ring seal"). A fuzzy-match pass
(Levenshtein + embedding similarity) could merge these into canonical nodes
and consolidate their edges/descriptions.

## 2. Source Provenance Mapping

`file_path` is `"unknown_source"` for most nodes — the only provenance is
chunk IDs buried in `source_id`. Map chunk IDs back to human-readable
document titles via `kv_store_text_chunks.json → full_doc_id` so that
every entity carries a readable source trail.

## 3. VDB Reindexing for Enrichment Nodes

Pattern nodes and discovered edges exist in the GraphML but have no
corresponding VDB entries. Reindex them into `vdb_entities.json` and
`vdb_relationships.json` so that vector-based retrieval can surface
enrichment results.

## 4. Taxonomy-Guided Graph Queries

The pipeline validated 14 failure patterns from the taxonomy (Normalization
of Deviance, Regulatory Capture, etc.). These could power structured
retrieval: "show me all entities linked to Groupthink" without needing
free-text search.

## 5. Graph-Aware RAG Ranking

Use the computed graph metrics (`component_id`, `betweenness`, `degree`)
as ranking signals during retrieval. High-betweenness nodes are bridge
concepts; large-component membership indicates mainstream topics.

## 6. Interactive Visualization Frontend

The admin API (`GET /admin/graphs/{agent_id}/subgraph`) already serves
subgraph data. A lightweight Sigma.js or D3-force frontend could let
users explore the graph interactively. The GEXF export (with colors and
sizes pre-computed) is Gephi-ready today.

## 7. Temporal Analysis

`created_at` timestamps on nodes could reveal ingestion-order patterns.
Plotting entity creation over time might surface batch effects or
under-represented time periods in the source corpus.

## 8. Entity Type Consolidation

235 entity types is too many — many are near-synonyms (e.g. "place" vs
"location", "concept" vs "principle"). Normalize to ~20 canonical types
via an LLM-assisted mapping table, then re-label the graph.
