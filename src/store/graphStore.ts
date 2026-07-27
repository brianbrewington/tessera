// Graph Store — sole writable authority for tessera's typed graph (spec §1).
// Slice 1: schema + putNode + two-tier node index + querySimilar + a minimal atomic
// promoteNode (needed by the chicken-and-egg test). Later slices add edges, the pyramid,
// the breaker, replay, backup/restore — each behind its own test and review gate.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash, randomUUID } from "node:crypto";
import { ddl } from "../db/ddl.js";
import { type Embedder, cosine } from "../embedder.js";
import {
  Meta,
  PutNodeInput,
  PutEdgeInput,
  type NodeRecord,
  type EdgeRecord,
  type EdgeKind,
  type Polarity,
  type Subgraph,
  type SimilarHit,
  type Status,
  type NodeType,
  type Origin,
} from "../schema.js";
import {
  buildAdjacency,
  pathsBetween as findPaths,
  connectorsOf as findConnectors,
  affinity as computeAffinity,
  type Adjacency,
  type WeightedPath,
  type Connector,
  type PathsOptions,
  type ConnectorsOptions,
  type AffinityOptions,
} from "../graph/paths.js";

const DEDUP_COSINE = 0.99; // secondary near-dup threshold (primary = content_hash)

export function normalizeText(t: string): string {
  return t.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}
function contentHash(t: string): string {
  return createHash("sha256").update(normalizeText(t)).digest("hex");
}
function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function fromBlob(b: Buffer): Float32Array {
  // Copy into a fresh, 4-byte-aligned ArrayBuffer: a Buffer handed back from SQLite may
  // be a view into a pooled allocation whose byteOffset is not a multiple of 4, which
  // would make `new Float32Array(b.buffer, b.byteOffset, ...)` throw.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer, 0, b.byteLength / 4);
}

type NodeRow = {
  id: string; type: string; subtype: string | null; origin: string; text: string;
  name: string | null; description: string | null;
  content_hash: string; strength: number; timestamp: number; provenance: string | null;
  metadata: string | null; status: string; pinned: number; frame_debt: number; version: number;
};

function hydrate(r: NodeRow): NodeRecord {
  return {
    id: r.id,
    type: r.type as NodeType,
    subtype: r.subtype,
    origin: r.origin as Origin,
    text: r.text,
    name: r.name,
    description: r.description,
    contentHash: r.content_hash,
    strength: r.strength,
    timestamp: r.timestamp,
    provenance: r.provenance ? JSON.parse(r.provenance) : null,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    status: r.status as Status,
    pinned: r.pinned === 1,
    frameDebt: r.frame_debt,
    version: r.version,
  };
}

type EdgeRow = {
  id: string; from_id: string; to_id: string; kind: string; polarity: string;
  semantic_weight: number; hebbian_weight: number; status: string; version: number;
};
function hydrateEdge(r: EdgeRow): EdgeRecord {
  return {
    id: r.id,
    from: r.from_id,
    to: r.to_id,
    kind: r.kind as EdgeKind,
    polarity: r.polarity === "" ? null : (r.polarity as Polarity),
    semanticWeight: r.semantic_weight,
    hebbianWeight: r.hebbian_weight,
    status: r.status as Status,
    version: r.version,
  };
}

export interface GraphStoreOptions {
  path: string; // ":memory:" or a file
  embedder: Embedder;
}

export class GraphStore {
  private db: Database.Database;
  private embedder: Embedder;

  constructor(opts: GraphStoreOptions) {
    this.embedder = opts.embedder;
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000"); // writers serialize behind BEGIN IMMEDIATE, don't error
    sqliteVec.load(this.db);
    this.db.exec(ddl(this.embedder.dim));
  }

  close(): void {
    this.db.close();
  }

  // KNN against a node vec tier. Returns cosine (both vectors unit-normalized, so the
  // Euclidean L2 distance d that sqlite-vec returns relates to cosine as cos = 1 - d^2/2).
  private knnNodes(table: string, vec: Float32Array, k: number): { node_id: string; cosine: number }[] {
    const rows = this.db
      .prepare(`SELECT node_id, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(toBlob(vec), k) as { node_id: string; distance: number }[];
    return rows.map((r) => ({ node_id: r.node_id, cosine: 1 - (r.distance * r.distance) / 2 }));
  }

  // putNode — always lands `proposed`, embeds to node-quarantine. Dedup primary key =
  // content_hash; cosine > 0.99 is an OPT-IN secondary near-dup merge (nearDupMerge:true).
  // On dedup: reinforce, do NOT create (spec §4). Async because embedding is async; the dedup + write run as ONE
  // BEGIN IMMEDIATE transaction so the write lock serializes concurrent writers (even a
  // second connection) — no read-before-write TOCTOU that could split a duplicate.
  async putNode(
    input: PutNodeInput,
    meta: Meta,
    vector?: Float32Array,
    opts: { nearDupMerge?: boolean } = {},
  ): Promise<{ id: string; reinforced: boolean }> {
    const inp = PutNodeInput.parse(input);
    const m = Meta.parse(meta);
    const hash = contentHash(inp.text);
    const vec = vector ?? (await this.embedder.embed(inp.text));
    if (vec.length !== this.embedder.dim) throw new Error(`vector dim ${vec.length} != ${this.embedder.dim}`);
    const at = m.effectiveAt ?? Date.now();
    const embeddingB64 = toBlob(vec).toString("base64");

    const tx = this.db.transaction((): { id: string; reinforced: boolean } => {
      // Dedup read INSIDE the immediate txn (holds the write lock).
      let dupId: string | undefined = (
        this.db.prepare("SELECT id FROM nodes WHERE content_hash = ?").get(hash) as { id: string } | undefined
      )?.id;
      // Secondary cosine near-dup merge is content-based and OPT-IN (nearDupMerge:true). By default
      // content_hash(text) is the SOLE identity key, so distinct identities with similar CONTENT (two
      // docs same title; "place\tjava" vs "concept\tjava"; two source-qualified people with near-identical
      // bios) never collapse on embedding geometry. Only a caller that means text-IS-content (a plain notes
      // store) should opt in. The content embedding is for RAG/similarity, not identity.
      if (!dupId && opts.nearDupMerge === true) {
        const near = this.knnNodes("vec_node_quarantine", vec, 1);
        if (near.length && near[0]!.cosine > DEDUP_COSINE) dupId = near[0]!.node_id;
      }

      if (dupId) {
        const before = this.db
          .prepare("SELECT strength, version, type, name, description FROM nodes WHERE id = ?")
          .get(dupId) as { strength: number; version: number; type: string; name: string | null; description: string | null } | undefined;
        // A TYPE CONFLICT (different type collided on identity — only reachable via opt-in cosine merge,
        // since content_hash includes the type prefix) is NOT evidence for the existing node: leave it
        // untouched, don't inflate strength, and log the conflict for audit. Never clobber across types.
        if (!!before && before.type !== inp.type) {
          this.log(m, at, "typeConflict", dupId, { type: before.type, name: before.name }, { attemptedType: inp.type, attemptedName: inp.name ?? null });
          return { id: dupId, reinforced: true };
        }
        // Genuine reinforce: bump strength; keep the RICHER description; fill name only if empty. When the
        // description upgrades, refresh the stored embedding too — else querySimilar/surprise keep running on
        // the stale first-mention vector while the text has moved on. Log carries the merged values so replay
        // can reconstruct the upgrade (spec §5.4).
        const mergedName = before?.name || inp.name || null;
        const descUpgraded = !!inp.description && (!before?.description || inp.description.length > before.description.length);
        const mergedDesc = descUpgraded ? inp.description! : (before?.description ?? null);
        this.db
          .prepare("UPDATE nodes SET strength = strength + 1, version = version + 1, name = ?, description = ? WHERE id = ?")
          .run(mergedName, mergedDesc, dupId);
        if (descUpgraded) this.db.prepare("UPDATE vec_node_quarantine SET embedding = ? WHERE node_id = ?").run(toBlob(vec), dupId);
        this.log(m, at, "reinforce", dupId, before, {
          strength: (before?.strength ?? 0) + 1,
          name: mergedName,
          description: mergedDesc,
          ...(descUpgraded ? { embedding_b64: embeddingB64 } : {}),
        });
        return { id: dupId, reinforced: true };
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO nodes (id, type, subtype, origin, text, name, description, content_hash, strength, timestamp, provenance, metadata, status, pinned, frame_debt, version)
           VALUES (@id, @type, @subtype, @origin, @text, @name, @description, @content_hash, 1, @timestamp, @provenance, @metadata, 'proposed', @pinned, 0, 1)`,
        )
        .run({
          id,
          type: inp.type,
          subtype: inp.subtype ?? null,
          origin: inp.origin,
          text: inp.text,
          name: inp.name ?? null,
          description: inp.description ?? null,
          content_hash: hash,
          timestamp: at,
          provenance: inp.provenance ? JSON.stringify(inp.provenance) : null,
          metadata: inp.metadata ? JSON.stringify(inp.metadata) : null,
          pinned: inp.pinned ? 1 : 0,
        });
      this.db.prepare("INSERT INTO vec_node_quarantine (node_id, embedding) VALUES (?, ?)").run(id, toBlob(vec));
      // Replay-grade log (spec §5.4): `after` carries the vector so replay never re-embeds.
      this.log(m, at, "putNode", id, null, {
        id,
        type: inp.type,
        subtype: inp.subtype ?? null,
        origin: inp.origin,
        text: inp.text,
        name: inp.name ?? null,
        description: inp.description ?? null,
        content_hash: hash,
        status: "proposed",
        embedding_b64: embeddingB64,
      });
      return { id, reinforced: false };
    });
    return tx.immediate();
  }

  // promoteNode — the only path to durable for a node (spec §4). ONE BEGIN IMMEDIATE
  // transaction: set status=durable, copy quarantine->shared vector, append log. Atomic:
  // on crash, either fully durable+in-shared or fully proposed. (Breaker + full grounding
  // rules land in slice 2; slice 1 needs the atomic copy for the chicken-and-egg test.)
  promoteNode(id: string, grounding: unknown, meta: Meta): void {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status FROM nodes WHERE id = ?").get(id) as { status: string } | undefined;
      if (!row) throw new Error(`promoteNode: no such node ${id}`);
      if (row.status === "durable") return; // idempotent
      this.db.prepare("UPDATE nodes SET status = 'durable', version = version + 1 WHERE id = ?").run(id);
      const copied = this.db
        .prepare(
          `INSERT OR REPLACE INTO vec_node_shared (node_id, embedding)
           SELECT node_id, embedding FROM vec_node_quarantine WHERE node_id = ?`,
        )
        .run(id);
      if (copied.changes !== 1) throw new Error(`promoteNode: quarantine vector missing for ${id}`);
      this.log(m, at, "promoteNode", id, { status: "proposed" }, { status: "durable", grounding });
    });
    tx.immediate();
  }

  // querySimilar — vector search against the chosen tier; empty index -> [] (never crash).
  async querySimilar(
    vector: Float32Array,
    k: number,
    filters: { index: "quarantine" | "shared" },
  ): Promise<SimilarHit[]> {
    const table = filters.index === "shared" ? "vec_node_shared" : "vec_node_quarantine";
    const near = this.knnNodes(table, vector, k);
    const hits: SimilarHit[] = [];
    for (const n of near) {
      const node = this.getNode(n.node_id);
      if (node) hits.push({ kind: "node", node, cosine: n.cosine });
    }
    return hits;
  }

  getNode(id: string): NodeRecord | null {
    const r = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return r ? hydrate(r) : null;
  }

  countNodes(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
  }

  // Read-back the stored vector for a node (test/inspection helper).
  vectorOf(id: string, tier: "quarantine" | "shared"): Float32Array | null {
    const table = tier === "shared" ? "vec_node_shared" : "vec_node_quarantine";
    const r = this.db.prepare(`SELECT embedding FROM ${table} WHERE node_id = ?`).get(id) as
      | { embedding: Buffer }
      | undefined;
    return r ? fromBlob(r.embedding) : null;
  }

  // putEdge — upsert an edge on (from, to, kind, polarity); attach a NEW assertion to it
  // each call (idempotent edge, accumulating explanations); embed the reason -> assert
  // quarantine. `expert_surprise` is computed by the Store, never accepted from the caller
  // (spec §4: the generating model must not launder surprise through the sole authority).
  async putEdge(
    input: PutEdgeInput,
    meta: Meta,
    reasonVector?: Float32Array,
  ): Promise<{ edgeId: string; assertionId: string; created: boolean }> {
    const inp = PutEdgeInput.parse(input);
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    const pol = inp.polarity ?? ""; // '' not NULL — SQLite treats NULLs as distinct in UNIQUE
    const rvec = reasonVector ?? (await this.embedder.embed(inp.reason));
    if (rvec.length !== this.embedder.dim) throw new Error(`reason vector dim ${rvec.length} != ${this.embedder.dim}`);
    const surprise = this.computeSurprise(inp.from, inp.to);
    const reasonB64 = toBlob(rvec).toString("base64");

    const tx = this.db.transaction((): { edgeId: string; assertionId: string; created: boolean } => {
      const f = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(inp.from);
      const t = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(inp.to);
      if (!f) throw new Error(`putEdge: missing endpoint ${inp.from}`);
      if (!t) throw new Error(`putEdge: missing endpoint ${inp.to}`);

      const existing = this.db
        .prepare("SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND kind = ? AND polarity = ?")
        .get(inp.from, inp.to, inp.kind, pol) as { id: string } | undefined;

      let edgeId: string;
      let created: boolean;
      if (existing) {
        edgeId = existing.id;
        created = false;
        this.db
          .prepare("UPDATE edges SET hebbian_weight = hebbian_weight + 1, version = version + 1 WHERE id = ?")
          .run(edgeId);
      } else {
        edgeId = randomUUID();
        created = true;
        this.db
          .prepare(
            `INSERT INTO edges (id, from_id, to_id, kind, polarity, semantic_weight, hebbian_weight, status, version)
             VALUES (?, ?, ?, ?, ?, ?, 1, 'proposed', 1)`,
          )
          .run(edgeId, inp.from, inp.to, inp.kind, pol, inp.semanticWeight ?? 0);
      }

      // Assertion idempotency: if this exact reason already backs this edge, reuse it — don't insert a
      // duplicate assertion or its vector on re-ingest. Bounds unbounded edge_assertions/vec growth.
      const dupAssert = this.db
        .prepare("SELECT id FROM edge_assertions WHERE edge_id = ? AND reason = ?")
        .get(edgeId, inp.reason) as { id: string } | undefined;
      const assertionId = dupAssert?.id ?? randomUUID();
      if (!dupAssert) {
        this.db
          .prepare(
            `INSERT INTO edge_assertions (id, edge_id, reason, origin, grounding, expert_surprise, status, version)
             VALUES (?, ?, ?, ?, NULL, ?, 'proposed', 1)`,
          )
          .run(assertionId, edgeId, inp.reason, inp.origin, surprise);
        this.db
          .prepare("INSERT INTO vec_assert_quarantine (assert_id, embedding) VALUES (?, ?)")
          .run(assertionId, toBlob(rvec));
      }

      this.log(m, at, created ? "putEdge" : "reinforceEdge", edgeId, null, {
        edgeId,
        assertionId,
        kind: inp.kind,
        polarity: pol,
        expert_surprise: surprise,
        reason_embedding_b64: reasonB64,
        created,
      });
      return { edgeId, assertionId, created };
    });
    return tx.immediate();
  }

  // expert_surprise from endpoint embedding distance: distant endpoints (low cosine) are
  // more surprising. Structural, pre-edge — not self-scored by any generating model.
  private computeSurprise(fromId: string, toId: string): number | null {
    const a = this.vectorOf(fromId, "quarantine");
    const b = this.vectorOf(toId, "quarantine");
    if (!a || !b) return null;
    const c = cosine(a, b); // ~[-1, 1] for unit vectors
    return Math.max(0, Math.min(3, Math.round((1 - c) * 1.5)));
  }

  // --- Read side / traversal (makes the graph walkable) ---

  getEdge(edgeId: string): EdgeRecord | null {
    const r = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(edgeId) as EdgeRow | undefined;
    return r ? hydrateEdge(r) : null;
  }

  getEdges(nodeId: string): EdgeRecord[] {
    return (
      this.db.prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ?").all(nodeId, nodeId) as EdgeRow[]
    ).map(hydrateEdge);
  }

  getNeighbors(nodeId: string): NodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.* FROM nodes n
         JOIN edges e ON (e.to_id = n.id AND e.from_id = @id) OR (e.from_id = n.id AND e.to_id = @id)`,
      )
      .all({ id: nodeId }) as NodeRow[];
    return rows.map(hydrate);
  }

  // BFS from seeds out to `hops`, returning the induced subgraph (spec §6: induced edges
  // only — no edge to a node outside the set). The traversal primitive under the viewer.
  getSubgraph(seedIds: string[], hops: number): Subgraph {
    const seen = new Set<string>();
    let frontier: string[] = [];
    for (const id of seedIds) {
      if (this.getNode(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
    for (let h = 0; h < hops && frontier.length; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of this.getNeighbors(id)) {
          if (!seen.has(nb.id)) {
            seen.add(nb.id);
            next.push(nb.id);
          }
        }
      }
      frontier = next;
    }
    const nodes: NodeRecord[] = [];
    for (const id of seen) {
      const n = this.getNode(id);
      if (n) nodes.push(n);
    }
    const edges = (this.db.prepare("SELECT * FROM edges").all() as EdgeRow[])
      .filter((e) => seen.has(e.from_id) && seen.has(e.to_id))
      .map(hydrateEdge);
    return { nodes, edges };
  }

  // --- Weighted intersection queries (src/graph/paths.ts): "how are these connected, how strongly?" ---
  // The adjacency is built fresh from the current edge set each call — cheap relative to the LLM work
  // around it, and it keeps these reads stateless (no cache to invalidate on a write).
  private connectiveAdjacency(kinds?: EdgeKind[]): Adjacency {
    return buildAdjacency(this.allEdges(), kinds ? { kinds } : {});
  }

  // Ranked weighted paths a→b over the connective spine (bottleneck strength). Each result carries the
  // hydrated node chain alongside the numeric strength/hops so callers get names, not just ids.
  pathsBetween(a: string, b: string, opts: PathsOptions & { kinds?: EdgeKind[] } = {}): (WeightedPath & { path: NodeRecord[] })[] {
    const adj = this.connectiveAdjacency(opts.kinds);
    return findPaths(adj, a, b, opts).map((p) => ({
      ...p,
      path: p.nodes.map((id) => this.getNode(id)).filter((n): n is NodeRecord => n !== null),
    }));
  }

  // The shared intermediates that bind a set of seeds, ranked rare-bridge-first (see connectorsOf).
  connectorsOf(seeds: string[], opts: ConnectorsOptions & { kinds?: EdgeKind[] } = {}): (Connector & { node: NodeRecord | null })[] {
    const adj = this.connectiveAdjacency(opts.kinds);
    return findConnectors(adj, seeds, opts).map((c) => ({ ...c, node: this.getNode(c.id) }));
  }

  // Scalar "how strongly connected" for organizing personas by pairwise closeness.
  affinity(a: string, b: string, opts: AffinityOptions & { kinds?: EdgeKind[] } = {}): number {
    return computeAffinity(this.connectiveAdjacency(opts.kinds), a, b, opts);
  }

  allNodes(): NodeRecord[] {
    return (this.db.prepare("SELECT * FROM nodes").all() as NodeRow[]).map(hydrate);
  }
  allEdges(): EdgeRecord[] {
    return (this.db.prepare("SELECT * FROM edges").all() as EdgeRow[]).map(hydrateEdge);
  }

  countEdges(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n;
  }
  // Chunk extraction memo (see ddl `extracted_chunks`). `markExtracted` is called only AFTER a chunk's
  // extraction fully completed, so `isExtracted` is a true completion predicate — a chunk that crashed
  // mid-map or failed to parse is NOT marked and will be retried on re-ingest. Idempotent.
  markExtracted(chunkId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO extracted_chunks (chunk_id) VALUES (?)").run(chunkId);
  }
  isExtracted(chunkId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM extracted_chunks WHERE chunk_id = ?").get(chunkId);
  }
  countAssertions(edgeId: string): number {
    return (
      this.db.prepare("SELECT count(*) AS n FROM edge_assertions WHERE edge_id = ?").get(edgeId) as { n: number }
    ).n;
  }
  edgeReason(edgeId: string): string | null {
    const r = this.db
      .prepare("SELECT reason FROM edge_assertions WHERE edge_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(edgeId) as { reason: string } | undefined;
    return r?.reason ?? null;
  }
  // ALL of an edge's assertion reasons (an edge accumulates one per distinct reason) — the scorecard scores
  // every reason, not just the newest, so the quality metric is order-of-ingest independent.
  edgeReasons(edgeId: string): string[] {
    return (this.db.prepare("SELECT reason FROM edge_assertions WHERE edge_id = ? ORDER BY rowid").all(edgeId) as { reason: string }[]).map((r) => r.reason);
  }
  assertionSurprise(assertionId: string): number | null {
    const r = this.db.prepare("SELECT expert_surprise FROM edge_assertions WHERE id = ?").get(assertionId) as
      | { expert_surprise: number | null }
      | undefined;
    return r ? r.expert_surprise : null;
  }

  private log(m: Meta, at: number, op: string, targetId: string | null, before: unknown, after: unknown): void {
    this.db
      .prepare(
        `INSERT INTO mutation_log (effective_at, actor, cause, op, target_id, before, after)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, m.actor, m.cause, op, targetId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
  }
}

export { cosine };
