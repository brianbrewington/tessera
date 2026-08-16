/**
 * R1 — the recall primitive under `tessera ask`. Approved as decision D1 on the agent channel
 * (~/agent_to_agent_comms/messages/0027-brian.md); design commitments in message 0024.
 *
 * THE GRAPH IS THE INDEX; THE CHUNKS ARE THE EVIDENCE. Extracted entities and edges are derived artifacts
 * of a pipeline measured imperfect (claims C1, C5; E10 pilot fidelity 0.574), so recall uses them only to
 * FIND candidate chunks — nothing downstream ever quotes an edge. Graph proposes, quote decides.
 *
 * RECALL RUNS OVER THE LAYER-1 RESOLUTION VIEW. Measured on the comms corpus: "consensus" fragments into six
 * entity nodes and "span-grounding" into six more, so raw entity hits scatter what should be one
 * neighbourhood expansion. Entity hits are canonicalised through `resolveEntities` before expansion — which
 * makes this the first PROGRAMMATIC consumer of the dedup layer: duplicate collapse is recall quality here,
 * not map cosmetics.
 *
 * THE TUNING SURFACE IS FROZEN AND EXPORTED. Per the R3 eval discipline agreed with claude-code (message
 * 0025): every knob lives in RECALL_TUNING, the eval sidecar records it, and nothing tunes against the QA
 * set. n=20 is a smoke test, not a benchmark; a change to these numbers after R3 runs is a NEW experiment.
 */
import type { GraphStore } from "../store/graphStore.js";
import type { NodeRecord } from "../schema.js";
import type { Embedder } from "../embedder.js";
import { resolveEntities, type ResolveMember } from "../resolve/view.js";

export const RECALL_TUNING = {
  /** raw KNN width before partitioning into chunk hits and entity hits */
  k_vector: 24,
  /** chunks returned to the caller after merge+dedupe */
  chunk_quota: 8,
  /** canonical entities kept for expansion */
  entity_quota: 6,
  /** chunks pulled in per expanded entity via APPEARED_IN */
  expansion_chunks_per_entity: 2,
  /** score discount applied to expansion chunks (they arrived on entity evidence, not query evidence) */
  expansion_discount: 0.8,
} as const;

export interface RecallChunk {
  id: string;
  /** e.g. "chunk 2 of 0010-claude-code" */
  name: string;
  text: string;
  score: number;
  /** "vector" for a direct hit, else the canonical entity name that led here */
  via: string;
}
export interface RecallEntity {
  id: string;
  name: string;
  subtype: string;
  cosine: number;
  /** raw member names collapsed into this canonical (empty when the entity stood alone) */
  collapsed: string[];
}
export interface RecallResult {
  chunks: RecallChunk[];
  entities: RecallEntity[];
  tuning: typeof RECALL_TUNING;
}

const isChunk = (n: NodeRecord): boolean => n.subtype === "chunk";
const isEntity = (n: NodeRecord): boolean => n.subtype !== "chunk" && n.subtype !== "document";

export async function recall(store: GraphStore, embedder: Embedder, query: string): Promise<RecallResult> {
  const vec = await embedder.embed(query);
  const hits = await store.querySimilar(vec, RECALL_TUNING.k_vector, { index: "quarantine" });

  // Layer-1 view over the whole entity population, so hits on two spellings of one thing collapse before
  // they compete for expansion slots.
  const allEntities: ResolveMember[] = store
    .allNodes()
    .filter(isEntity)
    .map((n: NodeRecord) => ({ id: n.id, name: n.name ?? n.text, subtype: n.subtype ?? "other", strength: n.strength }));
  const res = resolveEntities(allEntities);
  const memberNames = new Map<string, string[]>();
  for (const g of res.groups.filter((g) => !g.heldOut)) {
    memberNames.set(g.canonical.id, g.members.map((m) => m.name));
  }

  const chunkCand = new Map<string, RecallChunk>();
  const entityBest = new Map<string, RecallEntity>();

  for (const h of hits) {
    if (h.kind !== "node") continue;
    const n = h.node;
    if (isChunk(n)) {
      const prev = chunkCand.get(n.id);
      if (!prev || h.cosine > prev.score) {
        chunkCand.set(n.id, { id: n.id, name: n.name ?? "", text: n.description ?? "", score: h.cosine, via: "vector" });
      }
    } else if (isEntity(n)) {
      const canonicalId = res.canonicalOf.get(n.id) ?? n.id;
      const canonical = canonicalId === n.id ? n : store.getNode(canonicalId) ?? n;
      const prev = entityBest.get(canonicalId);
      if (!prev || h.cosine > prev.cosine) {
        entityBest.set(canonicalId, {
          id: canonicalId,
          name: canonical.name ?? canonical.text,
          subtype: canonical.subtype ?? "other",
          cosine: h.cosine,
          collapsed: (memberNames.get(canonicalId) ?? []).filter((m) => m !== (canonical.name ?? canonical.text)),
        });
      }
    }
  }

  const entities = [...entityBest.values()].sort((a, b) => b.cosine - a.cosine).slice(0, RECALL_TUNING.entity_quota);

  // Expansion: every raw member of a canonical group contributes its APPEARED_IN chunks, because provenance
  // edges hang off the raw nodes — the whole point of the view is reaching evidence a single spelling missed.
  for (const e of entities) {
    const memberIds = res.groups.find((g) => !g.heldOut && g.canonical.id === e.id)?.members.map((m) => m.id) ?? [e.id];
    const seen: { id: string; name: string; text: string }[] = [];
    for (const mid of memberIds) {
      for (const edge of store.getEdges(mid)) {
        if (edge.kind !== "APPEARED_IN") continue;
        const chunkId = edge.from === mid ? edge.to : edge.from;
        const c = store.getNode(chunkId);
        if (c && isChunk(c)) seen.push({ id: c.id, name: c.name ?? "", text: c.description ?? "" });
      }
    }
    for (const c of seen.slice(0, RECALL_TUNING.expansion_chunks_per_entity)) {
      const score = e.cosine * RECALL_TUNING.expansion_discount;
      const prev = chunkCand.get(c.id);
      if (!prev || score > prev.score) chunkCand.set(c.id, { ...c, score, via: e.name });
    }
  }

  const chunks = [...chunkCand.values()].sort((a, b) => b.score - a.score).slice(0, RECALL_TUNING.chunk_quota);
  return { chunks, entities, tuning: RECALL_TUNING };
}
