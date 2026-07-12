// The one validated decode path (spec §2): Zod at every boundary. Heavily tested,
// non-negotiable (retro.md: hand-rolled parsers that break at runtime trap the design).
import { z } from "zod";

export const NodeType = z.enum([
  "PERSON", "AGENT", "PROJECT", "GOAL",
  "CONCEPT", "INSIGHT", "QUESTION", "CLAIM",
  "MEMORY", "SOURCE", "QUOTE",
  "SESSION",
  "PATTERN", "CONFLICT", "SYSTEM_FEEDBACK",
  "ACTION", "TASK",
]);
export type NodeType = z.infer<typeof NodeType>;

export const Origin = z.enum(["user", "connector", "dream", "ingest"]);
export type Origin = z.infer<typeof Origin>;

export const Status = z.enum(["proposed", "durable"]);
export type Status = z.infer<typeof Status>;

// Every mutating verb takes {actor, cause} (spec §4) and logs.
export const Meta = z.object({
  actor: z.string().min(1),
  cause: z.string().min(1),
  effectiveAt: z.number().int().optional(), // explicit clock for deterministic replay
});
export type Meta = z.infer<typeof Meta>;

export const PutNodeInput = z.object({
  type: NodeType,
  subtype: z.string().optional(),
  origin: Origin,
  text: z.string().min(1),
  provenance: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  pinned: z.boolean().optional(),
}).strict(); // reject unknown fields loudly (e.g. a laundered status/strength)
export type PutNodeInput = z.infer<typeof PutNodeInput>;

export interface NodeRecord {
  id: string;
  type: NodeType;
  subtype: string | null;
  origin: Origin;
  text: string;
  contentHash: string;
  strength: number;
  timestamp: number;
  provenance: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  status: Status;
  pinned: boolean;
  frameDebt: number;
  version: number;
}

export type SimilarHit = { kind: "node"; node: NodeRecord; cosine: number };

// --- Edges (spec §4: structural spine + separately-embeddable explanation) ---

export const EdgeKind = z.enum([
  "RELATED", "ORIGINATED_FROM", "APPEARED_IN", "HEBBIAN_ASSOC", "RESONATES_WITH",
  "REFERENCES", // v3.1 — the back-ref/callback a walk lays down
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const Polarity = z.enum(["elaborates", "supports", "contradicts", "depends_on"]);
export type Polarity = z.infer<typeof Polarity>;

export const PutEdgeInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKind,
  polarity: Polarity.optional(),
  reason: z.string().min(1),
  origin: Origin,
  semanticWeight: z.number().optional(),
}).strict(); // reject unknown fields — esp. a caller-supplied expert_surprise (spec §4)
export type PutEdgeInput = z.infer<typeof PutEdgeInput>;

export interface EdgeRecord {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  polarity: Polarity | null;
  semanticWeight: number;
  hebbianWeight: number;
  status: Status;
  version: number;
}

export interface Subgraph {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}
