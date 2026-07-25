// Object model (minimal slice) — thin value objects hydrated from GraphStore records. READS ONLY: all
// persistence still funnels through GraphStore (its single-writer authority + append-only mutation_log are
// preserved). The one real relationship this slice models is Edge-owns-Assertions; Person is a light Node
// specialization. Session-as-strategy and the processor-layer split are backlog.
import type { NodeRecord, EdgeRecord } from "./schema.js";

export class Node {
  constructor(readonly rec: NodeRecord) {}
  get id(): string { return this.rec.id; }
  get type(): string { return this.rec.type; }
  get subtype(): string | null { return this.rec.subtype; }
  /** Display name: metadata.name (personas/entities) else the node text. */
  get name(): string { return (this.rec.metadata?.name as string) ?? this.rec.text; }
  get description(): string { return (this.rec.metadata?.description as string) ?? ""; }
  get strength(): number { return this.rec.strength; }
  isPerson(): this is Person { return this.rec.type === "PERSON"; }
}

export class Person extends Node {
  get bio(): string { return (this.rec.metadata?.bio as string) ?? this.description; }
}

export function hydrateNode(rec: NodeRecord): Node {
  return rec.type === "PERSON" ? new Person(rec) : new Node(rec);
}

export class Assertion {
  constructor(readonly reason: string, readonly origin: string) {}
}

/** An edge is a thin structural spine that OWNS its explanation assertions (the design's clearest object
 *  relationship — one edge accumulates many graded reasons). */
export class Edge {
  constructor(readonly rec: EdgeRecord, readonly assertions: Assertion[] = []) {}
  get id(): string { return this.rec.id; }
  get from(): string { return this.rec.from; }
  get to(): string { return this.rec.to; }
  get kind(): string { return this.rec.kind; }
  /** the primary human explanation — the latest assertion's reason (names both endpoints). */
  get reason(): string { return this.assertions.at(-1)?.reason ?? ""; }
}
