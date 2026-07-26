// Connector (hardened) — the cross-document concept linker (clustering-mining-sketch §3.3).
//
// GOVERNING RULE (§1, from embeddings_experiments): *geometry proposes, never decides.*
//   - PROPOSE: kNN over node quarantine vectors. Geometry's cosine is a candidate-RATE knob, an
//     unvalidated budget dial — NOT a quality claim and NEVER stored as confidence. Block pairs
//     already joined by RELATED (nothing to add) and same-document pairs (chunk co-mention already
//     had its chance within a doc — the Connector's whole value is CROSS-document links). Cap the run.
//   - EVALUATE (two gates, DIVERSE model families): a verifier (qwen family) reads both nodes'
//     name+description+one provenance chunk each and (a) answers "is there a real, STATABLE
//     relationship? y/n" and (b) if yes WRITES a de-anchored reason (the relationship, not the
//     endpoint names). A SECOND-family checker (gemma/llama) then screens that reason for vagueness.
//     Only pairs surviving BOTH land. The cosine is discarded.
//
// Why this replaces the naive pass: the old connector wrote RELATED edges at cosine >= 0.55 with
// reason "semantic proximity (cos=...)" — a banned-phrase-grade non-reason, no verification, and (on
// graphs/big) a floor sitting at the MEDIAN of the pairwise cosine distribution, i.e. "link half of
// everything." The prior work's load-bearing finding is that embedding geometry does not predict edge
// quality (cosine 0.85 over-merged catastrophically; ~0.92 was ENTITY-DEDUP, the wrong anchor for
// concept-relatedness). So the floor here is a starting budget, validated after the fact by the
// reject-rate-by-band curve — not a threshold that certifies a link.
//
// Output discipline: DRY-RUN sidecar by default (no store writes). Edges land only under an explicit
// commit flag, as origin:"connector" status:"proposed" (never auto-durable — single-writer +
// wire-on-use "don't hairball" lesson). The per-run cap bounds committed edges.

import type { NodeRecord, EdgeRecord, PutEdgeInput, Meta, SimilarHit } from "../schema.js";
import type { Chat } from "../llm.js";
import { canonical } from "../extract/identity.js";
import { jsonObjectCandidates } from "../extract/extractor.js";

// The store surface the connector needs. GraphStore satisfies it structurally; tests pass a stub so
// proposal blocking / cap / floor are checked deterministically without a live embedder or Ollama.
export interface ConnectorStore {
  allNodes(): NodeRecord[];
  allEdges(): EdgeRecord[];
  getNode(id: string): NodeRecord | null;
  vectorOf(id: string, tier: "quarantine" | "shared"): Float32Array | null;
  querySimilar(
    vector: Float32Array,
    k: number,
    filters: { index: "quarantine" | "shared" },
  ): Promise<SimilarHit[]>;
  putEdge(
    input: PutEdgeInput,
    meta: Meta,
    reasonVector?: Float32Array,
  ): Promise<{ edgeId: string; assertionId: string; created: boolean }>;
}

// Vagueness ban list — the relationship reason must NOT be generic filler. Mirrors
// scripts/ingest-report.ts BANNED_PHRASES and EXTRACTION_SYSTEM's BAD list; the codebase keeps this
// list duplicated-with-a-sync-comment (ingest-report already mirrors the extractor the same way) rather
// than crossing the src<-scripts boundary. Keep the three in sync. Word-boundary matched so "connected"
// flags "the two are connected" but not "disconnected"/"interconnected".
export const CONNECTOR_BANNED_PHRASES = ["related concept", "uses this", "connected", "is part of", "associated with"];
const BANNED_RE = new RegExp(
  `\\b(?:${CONNECTOR_BANNED_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

const isProvenance = (n: NodeRecord): boolean => n.subtype === "document" || n.subtype === "chunk";

// --- Node context: document membership (for same-doc blocking) + one provenance chunk (for the verifier).
// Derived from the graph spine: entity --APPEARED_IN--> chunk, chunk.provenance.path = its document,
// chunk.description = its raw text. An entity may span several docs (a shared concept); we keep the set.
export interface NodeCtx {
  docs: Set<string>;
  chunkText: string | null;
}

export function buildNodeContext(store: ConnectorStore): Map<string, NodeCtx> {
  const nodes = store.allNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ctx = new Map<string, NodeCtx>();
  for (const n of nodes) if (!isProvenance(n)) ctx.set(n.id, { docs: new Set<string>(), chunkText: null });
  for (const e of store.allEdges()) {
    if (e.kind !== "APPEARED_IN") continue; // from=entity, to=chunk (see mapper.ts)
    const c = ctx.get(e.from);
    if (!c) continue;
    const chunk = byId.get(e.to);
    if (!chunk) continue;
    const path = chunk.provenance && typeof chunk.provenance.path === "string" ? chunk.provenance.path : null;
    if (path) c.docs.add(path);
    if (!c.chunkText && chunk.description) c.chunkText = chunk.description;
  }
  return ctx;
}

const shareDoc = (a: NodeCtx, b: NodeCtx): boolean => {
  for (const d of a.docs) if (b.docs.has(d)) return true;
  return false;
};

// ---------------------------------------------------------------------------------------------------
// PROPOSE — geometry proposes candidate pairs; it does not decide.
// ---------------------------------------------------------------------------------------------------

export interface ProposeOptions {
  k?: number; // neighbors per node (default 6)
  floor?: number; // cosine budget knob, NOT a quality bar (default 0.75)
  cap?: number; // max candidate pairs per run (default 50, hard ceiling)
}

export interface Candidate {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  cosine: number; // reported for the band curve only — DISCARDED, never stored as confidence
}

export interface ProposeStats {
  entityNodes: number;
  rawHits: number; // kNN hits examined
  blockedSelfOrProvenance: number;
  blockedBelowFloor: number;
  blockedAlreadyRelated: number;
  blockedSameDoc: number;
  uniquePairs: number; // distinct candidate pairs surviving all blocks (pre-cap)
  cappedOut: number; // pairs dropped because the cap was hit
}

export interface ProposeResult {
  candidates: Candidate[];
  stats: ProposeStats;
}

const nameOf = (n: NodeRecord | null): string => n?.name ?? n?.text?.slice(0, 60) ?? "?";

export async function propose(
  store: ConnectorStore,
  ctx: Map<string, NodeCtx>,
  opts: ProposeOptions = {},
): Promise<ProposeResult> {
  const k = opts.k ?? 6;
  const floor = opts.floor ?? 0.75;
  const cap = opts.cap ?? 50;

  // Blocked-pair set: canonical key of every existing RELATED edge (both proposed and durable).
  const related = new Set<string>();
  for (const e of store.allEdges()) {
    if (e.kind !== "RELATED") continue;
    const [f, t] = canonical(e.from, e.to);
    related.add(`${f}|${t}`);
  }

  const nodes = store
    .allNodes()
    .filter((n) => !isProvenance(n))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // deterministic iteration

  const stats: ProposeStats = {
    entityNodes: nodes.length,
    rawHits: 0,
    blockedSelfOrProvenance: 0,
    blockedBelowFloor: 0,
    blockedAlreadyRelated: 0,
    blockedSameDoc: 0,
    uniquePairs: 0,
    cappedOut: 0,
  };
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const node of nodes) {
    const vec = store.vectorOf(node.id, "quarantine");
    if (!vec) continue;
    const hits = await store.querySimilar(vec, k + 1, { index: "quarantine" }); // +1 for self
    for (const h of hits) {
      stats.rawHits++;
      const other = h.node;
      if (other.id === node.id || isProvenance(other)) {
        stats.blockedSelfOrProvenance++;
        continue;
      }
      if (h.cosine < floor) {
        stats.blockedBelowFloor++;
        continue;
      }
      const [from, to] = canonical(node.id, other.id);
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      if (related.has(key)) {
        stats.blockedAlreadyRelated++;
        seen.add(key);
        continue;
      }
      const ca = ctx.get(from);
      const cb = ctx.get(to);
      if (ca && cb && shareDoc(ca, cb)) {
        stats.blockedSameDoc++;
        seen.add(key);
        continue;
      }
      seen.add(key);
      const fromNode = from === node.id ? node : other;
      const toNode = to === node.id ? node : other;
      candidates.push({ from, to, fromName: nameOf(fromNode), toName: nameOf(toNode), cosine: h.cosine });
    }
  }

  // Cap: strongest-cosine-first is the candidate budget policy (geometry picks WHICH to spend the
  // verify budget on, still never deciding quality). Sorting is stable-broken by pair key for determinism.
  candidates.sort((a, b) => b.cosine - a.cosine || (`${a.from}|${a.to}` < `${b.from}|${b.to}` ? -1 : 1));
  stats.uniquePairs = candidates.length;
  const kept = candidates.slice(0, cap);
  stats.cappedOut = candidates.length - kept.length;

  return { candidates: kept, stats };
}

// ---------------------------------------------------------------------------------------------------
// EVALUATE — two gates, diverse families. Geometry is gone from here on.
// ---------------------------------------------------------------------------------------------------

export const VERIFY_SYSTEM = `You judge whether two concepts from a knowledge graph have a REAL, STATABLE relationship: a specific fact or link you could assert in ONE sentence, grounded in what the source excerpts actually say.

A real relationship is a concrete connection — a shared person or event, one employs/produces/depends-on/is-kin-to/mentors the other, they are two facets of one activity, etc. Mere similarity is NOT a relationship: "both are vineyards", "both are concepts", "both mention farming" are co-category, not a statable link — answer no.

You are given NODE A and NODE B, each with a name, a description, and one source excerpt. Output ONLY a JSON object, no prose, no fence:
{"related": true, "reason": "..."}  or  {"related": false, "reason": ""}

Rules for "reason" (only when related is true):
- State the RELATIONSHIP ITSELF, as a standalone phrase. Do NOT restate node A's or node B's name — the graph already records which two are linked; repeating names anchors retrieval to the nodes instead of the KIND of link.
- Be specific and concrete. GOOD: "both concern seasonal grape-harvest labour in the same valley"; "one is the wine brand the other's fruit is grown for". BAD (never produce): "related", "associated with", "connected", "is part of", "shares similarities".
- If you cannot state a specific relationship grounded in the excerpts, answer {"related": false, "reason": ""}. When in doubt, say no.`;

export const VAGUENESS_SYSTEM = `You screen a single proposed relationship statement for VAGUENESS. A GOOD statement names a specific, concrete relationship between two things. A BAD statement is generic filler that could describe almost any pair ("related", "associated with", "connected", "is part of", "shares similarities", "both are concepts", "have things in common").

Output ONLY a JSON object, no prose: {"specific": true} if the statement names a concrete, specific relationship, or {"specific": false} if it is vague filler.`;

function excerpt(text: string | null, max = 700): string {
  if (!text) return "(no source excerpt available)";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function buildVerifyUser(a: NodeRecord, actx: NodeCtx, b: NodeRecord, bctx: NodeCtx): string {
  return [
    `NODE A: ${nameOf(a)}`,
    `  description: ${a.description ?? "(none)"}`,
    `  source excerpt: ${excerpt(actx.chunkText)}`,
    ``,
    `NODE B: ${nameOf(b)}`,
    `  description: ${b.description ?? "(none)"}`,
    `  source excerpt: ${excerpt(bctx.chunkText)}`,
  ].join("\n");
}

// Tolerant JSON extraction from a possibly-chatty model reply (reuses the extractor's brace scanner).
function firstJson(raw: string): Record<string, unknown> | null {
  for (const cand of jsonObjectCandidates(raw)) {
    try {
      const o = JSON.parse(cand);
      if (o && typeof o === "object") return o as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export interface Verdict {
  related: boolean; // gate 1: verifier says a statable relationship exists
  reason: string; // the verifier's de-anchored reason ("" if not related)
  bannedPhrase: boolean; // gate 2a: reason hit the mechanical ban list
  checkerSpecific: boolean; // gate 2b: second-family checker judged it specific
  survived: boolean; // landed = related && reason && !bannedPhrase && checkerSpecific
  verifierRaw?: string;
  checkerRaw?: string;
}

export interface Evaluators {
  verifier: Chat; // gate 1 — qwen family (proposes/verifies)
  checker: Chat; // gate 2b — a DIFFERENT family (gemma/llama judges)
  verifierModel?: string;
  checkerModel?: string;
}

export async function evaluateCandidate(
  a: NodeRecord,
  actx: NodeCtx,
  b: NodeRecord,
  bctx: NodeCtx,
  ev: Evaluators,
): Promise<Verdict> {
  const verifierRaw = await ev.verifier.complete(VERIFY_SYSTEM, buildVerifyUser(a, actx, b, bctx), {
    temperature: 0,
    model: ev.verifierModel,
  });
  const vj = firstJson(verifierRaw);
  const related = vj?.related === true;
  const reason = related && typeof vj?.reason === "string" ? vj.reason.trim() : "";

  if (!related || !reason) {
    return { related, reason, bannedPhrase: false, checkerSpecific: false, survived: false, verifierRaw };
  }

  // Gate 2a — mechanical vagueness ban (cheap, deterministic, from the scorecard list).
  const bannedPhrase = BANNED_RE.test(reason.toLowerCase());
  if (bannedPhrase) {
    return { related, reason, bannedPhrase: true, checkerSpecific: false, survived: false, verifierRaw };
  }

  // Gate 2b — a SECOND-family model screens the reason for vagueness (diversity is load-bearing:
  // K copies of one family share its blind spot; a different family is an independent screen).
  const checkerRaw = await ev.checker.complete(VAGUENESS_SYSTEM, reason, { temperature: 0, model: ev.checkerModel });
  const cj = firstJson(checkerRaw);
  const checkerSpecific = cj?.specific === true;

  return {
    related,
    reason,
    bannedPhrase: false,
    checkerSpecific,
    survived: checkerSpecific,
    verifierRaw,
    checkerRaw,
  };
}

// ---------------------------------------------------------------------------------------------------
// RUN — orchestrate: measure distribution, propose, evaluate, band the reject-rate, optionally commit.
// ---------------------------------------------------------------------------------------------------

export interface CosineDistribution {
  pairs: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  bands: { band: string; count: number }[];
}

// Full pairwise cosine over entity-node quarantine vectors (§5: measure it before trusting any floor).
export function measureCosineDistribution(store: ConnectorStore): CosineDistribution {
  const nodes = store.allNodes().filter((n) => !isProvenance(n));
  const vecs: Float32Array[] = [];
  for (const n of nodes) {
    const v = store.vectorOf(n.id, "quarantine");
    if (v) vecs.push(v);
  }
  const cs: number[] = [];
  for (let i = 0; i < vecs.length; i++) {
    const a = vecs[i]!;
    for (let j = i + 1; j < vecs.length; j++) {
      let dot = 0;
      const b = vecs[j]!;
      for (let d = 0; d < a.length; d++) dot += a[d]! * b[d]!;
      cs.push(dot); // vectors are unit-normalized, so dot == cosine
    }
  }
  cs.sort((x, y) => x - y);
  const q = (p: number): number => (cs.length ? Math.round(cs[Math.floor(p * (cs.length - 1))]! * 1000) / 1000 : 0);
  const bandEdges = [0.55, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.01];
  const bands = bandEdges.slice(0, -1).map((lo, i) => {
    const hi = bandEdges[i + 1]!;
    return { band: `[${lo.toFixed(2)},${hi.toFixed(2)})`, count: cs.filter((x) => x >= lo && x < hi).length };
  });
  return { pairs: cs.length, p5: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), p99: q(0.99), max: q(1), bands };
}

// Band a cosine into the reject-rate buckets (floor-anchored, 0.05 wide).
function bandOf(cosine: number, floor: number): string {
  const width = 0.05;
  const lo = floor + Math.floor((cosine - floor) / width) * width;
  const hi = lo + width;
  return `[${lo.toFixed(2)},${hi.toFixed(2)})`;
}

export interface EvaluatedCandidate extends Candidate {
  band: string;
  verdict: Verdict;
}

export interface BandStat {
  band: string;
  candidates: number;
  verifierNo: number;
  vaguenessRejected: number;
  survived: number;
  rejectRate: number; // (candidates - survived) / candidates
}

export interface ConnectorCounts {
  entityNodes: number;
  uniquePairs: number;
  cappedOut: number;
  evaluated: number;
  verifierYes: number;
  verifierNo: number;
  bannedPhraseRejected: number;
  vaguenessRejected: number;
  survived: number;
  committed: number;
}

export interface ConnectorRunConfig extends ProposeOptions, Evaluators {
  commit?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ConnectorRun {
  config: { k: number; floor: number; cap: number; verifierModel: string; checkerModel: string; commit: boolean };
  cosineDistribution: CosineDistribution;
  proposeStats: ProposeStats;
  counts: ConnectorCounts;
  rejectRateByBand: BandStat[];
  candidates: EvaluatedCandidate[];
}

export async function runConnector(store: ConnectorStore, cfg: ConnectorRunConfig): Promise<ConnectorRun> {
  const k = cfg.k ?? 6;
  const floor = cfg.floor ?? 0.75;
  const cap = cfg.cap ?? 50;
  const commit = cfg.commit ?? false;
  const log = cfg.onProgress ?? ((): void => {});

  log("measuring node-vector cosine distribution…");
  const cosineDistribution = measureCosineDistribution(store);

  log("proposing candidate pairs (kNN over quarantine vectors)…");
  const ctx = buildNodeContext(store);
  const { candidates, stats } = await propose(store, ctx, { k, floor, cap });
  log(`  ${stats.uniquePairs} unique pairs, ${candidates.length} after cap (blocked: ${stats.blockedAlreadyRelated} already-RELATED, ${stats.blockedSameDoc} same-doc)`);

  const evaluated: EvaluatedCandidate[] = [];
  const counts: ConnectorCounts = {
    entityNodes: stats.entityNodes,
    uniquePairs: stats.uniquePairs,
    cappedOut: stats.cappedOut,
    evaluated: 0,
    verifierYes: 0,
    verifierNo: 0,
    bannedPhraseRejected: 0,
    vaguenessRejected: 0,
    survived: 0,
    committed: 0,
  };

  for (const c of candidates) {
    const a = store.getNode(c.from);
    const b = store.getNode(c.to);
    if (!a || !b) continue;
    const actx = ctx.get(c.from) ?? { docs: new Set<string>(), chunkText: null };
    const bctx = ctx.get(c.to) ?? { docs: new Set<string>(), chunkText: null };
    log(`  evaluating: ${c.fromName}  ~  ${c.toName}  (cos=${c.cosine.toFixed(3)})`);
    const verdict = await evaluateCandidate(a, actx, b, bctx, cfg);
    counts.evaluated++;
    if (verdict.related) counts.verifierYes++;
    else counts.verifierNo++;
    if (verdict.related && verdict.bannedPhrase) counts.bannedPhraseRejected++;
    if (verdict.related && !verdict.bannedPhrase && !verdict.checkerSpecific) counts.vaguenessRejected++;
    if (verdict.survived) counts.survived++;
    evaluated.push({ ...c, band: bandOf(c.cosine, floor), verdict });
  }

  // Reject-rate by cosine band — the live re-test of "geometry != quality": if reject rate does NOT
  // rise as cosine falls, the floor is meaningless (higher cosine did not buy better edges).
  const bandMap = new Map<string, BandStat>();
  for (const e of evaluated) {
    const s = bandMap.get(e.band) ?? { band: e.band, candidates: 0, verifierNo: 0, vaguenessRejected: 0, survived: 0, rejectRate: 0 };
    s.candidates++;
    if (!e.verdict.related) s.verifierNo++;
    if (e.verdict.related && !e.verdict.survived) s.vaguenessRejected++;
    if (e.verdict.survived) s.survived++;
    bandMap.set(e.band, s);
  }
  const rejectRateByBand = [...bandMap.values()]
    .map((s) => ({ ...s, rejectRate: s.candidates ? Math.round(((s.candidates - s.survived) / s.candidates) * 1000) / 1000 : 0 }))
    .sort((a, b) => (a.band > b.band ? -1 : 1)); // high band first

  if (commit) {
    for (const e of evaluated) {
      if (!e.verdict.survived) continue;
      const r = await store.putEdge(
        { from: e.from, to: e.to, kind: "RELATED", reason: e.verdict.reason, origin: "connector" },
        { actor: "connector", cause: "hardened-connector-pass" },
      );
      if (r.created || !r.created) counts.committed++; // reinforcement still counts as a landed assertion
    }
    log(`committed ${counts.committed} proposed edge(s) as origin:connector status:proposed`);
  }

  return {
    config: {
      k,
      floor,
      cap,
      verifierModel: cfg.verifierModel ?? "(default)",
      checkerModel: cfg.checkerModel ?? "(default)",
      commit,
    },
    cosineDistribution,
    proposeStats: stats,
    counts,
    rejectRateByBand,
    candidates: evaluated,
  };
}
