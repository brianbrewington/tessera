// Graph Store — sole writable authority for tessera's typed graph (spec §1).
// Slice 1: schema + putNode + two-tier node index + querySimilar + a minimal atomic
// promoteNode (needed by the chicken-and-egg test). Later slices add edges, the pyramid,
// the breaker, replay, backup/restore — each behind its own test and review gate.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash, randomUUID } from "node:crypto";
import { ddl, migrate } from "../db/ddl.js";
// The memo table is an EXTRACTION memo, so its default salt comes from the prompt it describes. Imported
// only to backfill pre-salt rows at migration time; every read/write path takes the version explicitly.
import { PROMPT_VERSION } from "../extract/extractor.js";
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

/** A chunk owing extraction, carrying everything an extractor needs without touching the filesystem. */
export interface DirtyChunk {
  id: string;
  name: string | null;
  /** The chunk's raw text. This is why a deleted source file no longer means an unhealable chunk. */
  text: string | null;
  /** null = never extracted; a different value = extracted under an older prompt. */
  storedVersion: string | null;
  attempts: number;
  lastError: string | null;
  provenance: Record<string, unknown> | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceProvenance: Record<string, unknown> | null;
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
    migrate(this.db, PROMPT_VERSION);
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
    grounding?: string, // node id (chunk/source) that produced this assertion — recorded set-valued (FD3)
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
      // Provenance (FD3): record the grounding node set-valued. Done even when the reason was a DUPLICATE
      // (dupAssert) so a relationship re-asserted from another chunk accumulates both sources, not just the first.
      if (grounding) {
        this.db.prepare("INSERT OR IGNORE INTO assertion_sources (assertion_id, source_id) VALUES (?, ?)").run(assertionId, grounding);
      }

      this.log(m, at, created ? "putEdge" : "reinforceEdge", edgeId, null, {
        edgeId,
        assertionId,
        kind: inp.kind,
        polarity: pol,
        expert_surprise: surprise,
        reason_embedding_b64: reasonB64,
        grounding: grounding ?? null, // the log is replay-sufficient (carries embeddings); provenance belongs in it too (FD3)
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

  // ORDER BY rowid is EXPLICIT, not decorative (design §3.2). Layout seeds are index-derived
  // (`Math.cos(i)*220`), so this order is part of the map's geometry: change it and every stored position
  // becomes wrong. `SELECT *` with no ORDER BY happened to return rowid order, and the viewer has always
  // depended on that accident. Making it explicit is behaviour-preserving and takes the dependency out of
  // SQLite's discretion. test/layout-store.test.ts pins it.
  allNodes(): NodeRecord[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY rowid").all() as NodeRow[]).map(hydrate);
  }
  allEdges(): EdgeRecord[] {
    return (this.db.prepare("SELECT * FROM edges ORDER BY rowid").all() as EdgeRow[]).map(hydrateEdge);
  }

  // --- layout (design §3.1) ------------------------------------------------------------------------
  // The `layout` table is a seam the store spec reserved for the Resonator (`docs/specs/graph-store-spec-v2.md:33,64`).
  // We implement the spec'd putLayout rather than writing the table ad hoc, so the Resonator inherits a
  // working API instead of colliding with one.

  /**
   * Write one node's position. Returns `changed:false` and does nothing at all when the coordinates are
   * unchanged — no version bump, no mutation_log row. That no-op rule is load-bearing: without it every
   * `tessera view` rewrites N rows, churns N versions, and appends N log ops, and the byte-identical-position
   * test that protects the map from drifting becomes meaningless.
   */
  putLayout(
    nodeId: string,
    pos: { x: number; y: number; zoomMin?: number | null },
    opts: { expectedVersion?: number },
    meta: Meta,
  ): { version: number; changed: boolean } {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      throw new Error(`putLayout: non-finite position for ${nodeId} (${pos.x}, ${pos.y})`);
    }
    const zoomMin = pos.zoomMin ?? null;
    const tx = this.db.transaction((): { version: number; changed: boolean } => {
      const before = this.db
        .prepare("SELECT x, y, zoom_min AS zoomMin, version FROM layout WHERE node_id = ?")
        .get(nodeId) as { x: number; y: number; zoomMin: number | null; version: number } | undefined;

      if (opts.expectedVersion !== undefined && (before?.version ?? 0) !== opts.expectedVersion) {
        throw new Error(
          `putLayout: version conflict for ${nodeId} (expected ${opts.expectedVersion}, found ${before?.version ?? 0})`,
        );
      }
      if (before && before.x === pos.x && before.y === pos.y && before.zoomMin === zoomMin) {
        return { version: before.version, changed: false }; // no-op: identical coordinates
      }
      if (!before) {
        const exists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(nodeId);
        if (!exists) throw new Error(`putLayout: no such node ${nodeId}`);
        this.db
          .prepare("INSERT INTO layout (node_id, x, y, zoom_min, version) VALUES (?, ?, ?, ?, 1)")
          .run(nodeId, pos.x, pos.y, zoomMin);
        this.log(m, at, "putLayout", nodeId, null, { x: pos.x, y: pos.y, zoomMin, version: 1 });
        return { version: 1, changed: true };
      }
      const version = before.version + 1;
      this.db
        .prepare("UPDATE layout SET x = ?, y = ?, zoom_min = ?, version = ? WHERE node_id = ?")
        .run(pos.x, pos.y, zoomMin, version, nodeId);
      this.log(m, at, "putLayout", nodeId, before, { x: pos.x, y: pos.y, zoomMin, version });
      return { version, changed: true };
    });
    return tx.immediate();
  }

  /**
   * The normal path — one transaction for the whole settle pass, and ONE summarising mutation_log op rather
   * than one per node. Applies the same no-op rule per row, so a re-run with an unchanged map writes nothing
   * and logs nothing.
   */
  putLayoutBatch(
    entries: ReadonlyArray<{ nodeId: string; x: number; y: number; zoomMin?: number | null }>,
    meta: Meta,
  ): { written: number; unchanged: number } {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    for (const e of entries) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
        throw new Error(`putLayoutBatch: non-finite position for ${e.nodeId} (${e.x}, ${e.y})`);
      }
    }
    const tx = this.db.transaction((): { written: number; unchanged: number } => {
      const sel = this.db.prepare("SELECT x, y, zoom_min AS zoomMin, version FROM layout WHERE node_id = ?");
      const ins = this.db.prepare("INSERT INTO layout (node_id, x, y, zoom_min, version) VALUES (?, ?, ?, ?, 1)");
      const upd = this.db.prepare("UPDATE layout SET x = ?, y = ?, zoom_min = ?, version = version + 1 WHERE node_id = ?");
      const exists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?");
      let written = 0;
      let unchanged = 0;
      for (const e of entries) {
        const zoomMin = e.zoomMin ?? null;
        const before = sel.get(e.nodeId) as { x: number; y: number; zoomMin: number | null; version: number } | undefined;
        if (before && before.x === e.x && before.y === e.y && before.zoomMin === zoomMin) {
          unchanged++;
          continue;
        }
        if (!before) {
          if (!exists.get(e.nodeId)) throw new Error(`putLayoutBatch: no such node ${e.nodeId}`);
          ins.run(e.nodeId, e.x, e.y, zoomMin);
        } else {
          upd.run(e.x, e.y, zoomMin, e.nodeId);
        }
        written++;
      }
      // One op for the batch. A wholly unchanged pass logs NOTHING — that is what makes "a second `view`
      // appends zero mutation_log ops" a real assertion rather than a hopeful one.
      if (written > 0) this.log(m, at, "putLayoutBatch", null, null, { written, unchanged, total: entries.length });
      return { written, unchanged };
    });
    return tx.immediate();
  }

  getLayout(): Map<string, { x: number; y: number; zoomMin: number | null; version: number }> {
    const rows = this.db
      .prepare("SELECT node_id AS nodeId, x, y, zoom_min AS zoomMin, version FROM layout")
      .all() as Array<{ nodeId: string; x: number; y: number; zoomMin: number | null; version: number }>;
    return new Map(rows.map((r) => [r.nodeId, { x: r.x, y: r.y, zoomMin: r.zoomMin, version: r.version }]));
  }

  /**
   * Nodes with no layout row, in rowid order. The primary newcomer mechanism (design §3.1): it heals ANY
   * writer path — `connect --commit` today, anything added later — rather than only the one the drop target
   * calls. Callers intersect with the visible set themselves (design §3.3); this is deliberately unfiltered
   * so slice 4 can use it for provenance without a second method.
   */
  // --- edge prominence -------------------------------------------------------------------------------

  /** Replace all values for one measure in a single transaction; one summarising mutation_log op. */
  putEdgeProminence(measure: string, values: ReadonlyMap<string, number>, meta: Meta): { written: number } {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    const tx = this.db.transaction((): { written: number } => {
      this.db.prepare("DELETE FROM edge_prominence WHERE measure = ?").run(measure);
      const ins = this.db.prepare("INSERT OR REPLACE INTO edge_prominence (edge_id, measure, value) VALUES (?, ?, ?)");
      let written = 0;
      for (const [edgeId, v] of values) {
        if (!Number.isFinite(v)) throw new Error(`putEdgeProminence: non-finite value for ${edgeId}`);
        ins.run(edgeId, measure, v);
        written++;
      }
      if (written > 0) this.log(m, at, "putEdgeProminence", null, null, { measure, written });
      return { written };
    });
    return tx.immediate();
  }

  /** Remove a measure entirely. Used when a pass declines to compute it — stale prominence is worse than none. */
  clearEdgeProminence(measure: string, meta: Meta): { removed: number } {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    const tx = this.db.transaction((): { removed: number } => {
      const r = this.db.prepare("DELETE FROM edge_prominence WHERE measure = ?").run(measure);
      if (r.changes > 0) this.log(m, at, "clearEdgeProminence", null, null, { measure, removed: r.changes });
      return { removed: r.changes };
    });
    return tx.immediate();
  }

  edgeProminence(measure: string): Map<string, number> {
    return new Map(
      (this.db.prepare("SELECT edge_id AS id, value FROM edge_prominence WHERE measure = ?").all(measure) as Array<{ id: string; value: number }>)
        .map((r) => [r.id, r.value]),
    );
  }

  prominenceMeasures(): string[] {
    return (this.db.prepare("SELECT DISTINCT measure FROM edge_prominence ORDER BY measure").all() as Array<{ measure: string }>).map((r) => r.measure);
  }

  // --- scenes (design §4) ---------------------------------------------------------------------------

  /**
   * Import scenes, idempotent on CONTENT rather than on the incoming id (design §5). The localStorage id is
   * milliseconds-since-page-load and collides across sessions, so keying on it would silently merge or drop
   * distinct scenes at the one-way door. Unresolvable anchors are dropped with a count; a scene left with no
   * resolvable anchor is skipped rather than written empty, because an anchorless scene cannot be restored.
   */
  importScenes(
    scenes: ReadonlyArray<{
      name: string; narr?: string | null; scale: number; showProv: boolean;
      focusNode?: string | null; anchors: string[]; legacyId?: string | null; ordinal: number;
      contentKey: string;
    }>,
    meta: Meta,
  ): { imported: number; duplicates: number; skipped: number; droppedAnchors: number } {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    const tx = this.db.transaction(() => {
      const nodeExists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?");
      const seen = this.db.prepare("SELECT 1 FROM scenes WHERE content_key = ?");
      const insScene = this.db.prepare(
        `INSERT INTO scenes (id, name, narr, scale, show_prov, focus_node, ordinal, legacy_id, content_key, version, created_at)
         VALUES (@id, @name, @narr, @scale, @showProv, @focusNode, @ordinal, @legacyId, @contentKey, 1, @at)`,
      );
      const insAnchor = this.db.prepare("INSERT OR IGNORE INTO scene_anchors (scene_id, node_id) VALUES (?, ?)");
      let imported = 0, duplicates = 0, skipped = 0, droppedAnchors = 0;
      for (const sc of scenes) {
        const resolved = sc.anchors.filter((a) => !!nodeExists.get(a));
        droppedAnchors += sc.anchors.length - resolved.length;
        if (resolved.length === 0) { skipped++; continue; }
        if (seen.get(sc.contentKey)) { duplicates++; continue; }
        const id = `scn_${randomUUID()}`;
        insScene.run({
          id, name: sc.name, narr: sc.narr ?? null, scale: sc.scale, showProv: sc.showProv ? 1 : 0,
          focusNode: sc.focusNode && nodeExists.get(sc.focusNode) ? sc.focusNode : null,
          ordinal: sc.ordinal, legacyId: sc.legacyId ?? null, contentKey: sc.contentKey, at,
        });
        for (const a of resolved) insAnchor.run(id, a);
        imported++;
      }
      if (imported > 0) this.log(m, at, "importScenes", null, null, { imported, duplicates, skipped, droppedAnchors });
      return { imported, duplicates, skipped, droppedAnchors };
    });
    return tx.immediate();
  }

  allScenes(): Array<{
    id: string; name: string; narr: string | null; scale: number; showProv: boolean;
    focusNode: string | null; ordinal: number; legacyId: string | null; contentKey: string;
    version: number; anchors: string[];
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, name, narr, scale, show_prov AS showProv, focus_node AS focusNode,
                ordinal, legacy_id AS legacyId, content_key AS contentKey, version
         FROM scenes ORDER BY ordinal, rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    const anchorStmt = this.db.prepare("SELECT node_id AS nodeId FROM scene_anchors WHERE scene_id = ? ORDER BY node_id");
    return rows.map((r) => ({
      id: r.id as string, name: r.name as string, narr: (r.narr as string | null) ?? null,
      scale: r.scale as number, showProv: !!r.showProv, focusNode: (r.focusNode as string | null) ?? null,
      ordinal: r.ordinal as number, legacyId: (r.legacyId as string | null) ?? null,
      contentKey: r.contentKey as string, version: r.version as number,
      anchors: (anchorStmt.all(r.id) as Array<{ nodeId: string }>).map((a) => a.nodeId),
    }));
  }

  nodesLackingLayout(): string[] {
    return (
      this.db
        .prepare("SELECT n.id AS id FROM nodes n LEFT JOIN layout l ON l.node_id = n.id WHERE l.node_id IS NULL ORDER BY n.rowid")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
  }

  countEdges(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n;
  }
  // ---- Chunk extraction memo + dirty-chunk queue (see ddl `extracted_chunks`, `chunk_extraction_state`).
  //
  // `markExtracted` is called only AFTER a chunk's extraction fully completed, so the memo is a true
  // COMPLETION predicate — a chunk that crashed mid-map or failed to parse is not marked and stays dirty.
  // Salted by promptVersion: extracted under an older prompt counts as dirty, not clean.

  /** Mark a chunk extracted under `promptVersion`. Idempotent; also clears any claim and attempt history. */
  markExtracted(chunkId: string, promptVersion: string, meta: Meta): void {
    const m = Meta.parse(meta);
    const at = m.effectiveAt ?? Date.now();
    this.db.transaction(() => {
      // ON CONFLICT UPDATE, not OR IGNORE: re-extraction after a PROMPT_VERSION bump must overwrite the old
      // version, or the chunk would stay dirty forever and be re-extracted on every run.
      this.db
        .prepare(
          `INSERT INTO extracted_chunks (chunk_id, prompt_version) VALUES (?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET prompt_version = excluded.prompt_version`,
        )
        .run(chunkId, promptVersion);
      // Success resets the attempt count, so a chunk that failed twice before succeeding is not still
      // reported as "failing" the next time a version bump makes it dirty again.
      this.db
        .prepare(
          `INSERT INTO chunk_extraction_state (chunk_id, attempts, last_error, last_attempt_at, claimed_by, claimed_at)
           VALUES (?, 0, NULL, ?, NULL, NULL)
           ON CONFLICT(chunk_id) DO UPDATE SET
             attempts = 0, last_error = NULL, last_attempt_at = ?, claimed_by = NULL, claimed_at = NULL`,
        )
        .run(chunkId, at, at);
      // B23: the memo used to mutate without a log row, so a replay rebuilt the graph but not the memo and
      // would re-pay the LLM for every chunk. Logged now that extraction is a first-class, resumable step.
      this.log(m, at, "markExtracted", chunkId, null, { promptVersion });
    }).immediate();
  }

  isExtracted(chunkId: string, promptVersion: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM extracted_chunks WHERE chunk_id = ? AND prompt_version = ?")
      .get(chunkId, promptVersion);
  }

  /**
   * Claim a chunk for extraction. Returns false if someone else holds a live claim.
   *
   * The whole exclusivity mechanism is the WHERE clause: SQLite serializes the UPDATE, so either this
   * transaction changed the row or it did not. No staleness heuristic guarding another staleness heuristic.
   * `ttlMs` bounds a claim held by a process that died mid-extraction; expiry costs at worst a double
   * extraction, which is reinforcement churn rather than corruption.
   */
  claimChunk(chunkId: string, claimant: string, now: number, ttlMs: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO chunk_extraction_state (chunk_id) VALUES (?)").run(chunkId);
      const r = this.db
        .prepare(
          `UPDATE chunk_extraction_state SET claimed_by = ?, claimed_at = ?
           WHERE chunk_id = ? AND (claimed_at IS NULL OR claimed_at <= ?)`,
        )
        .run(claimant, now, chunkId, now - ttlMs);
      return r.changes === 1;
    }).immediate() as boolean;
  }

  releaseChunkClaim(chunkId: string): void {
    this.db
      .prepare("UPDATE chunk_extraction_state SET claimed_by = NULL, claimed_at = NULL WHERE chunk_id = ?")
      .run(chunkId);
  }

  /** A chunk was attempted and did not complete. Bumps attempts, records why, releases the claim. */
  recordExtractionFailure(chunkId: string, error: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO chunk_extraction_state (chunk_id, attempts, last_error, last_attempt_at)
         VALUES (@id, 1, @err, @at)
         ON CONFLICT(chunk_id) DO UPDATE SET
           attempts = attempts + 1, last_error = @err, last_attempt_at = @at,
           claimed_by = NULL, claimed_at = NULL`,
      )
      .run({ id: chunkId, err: error.slice(0, 2000), at: now });
  }

  /**
   * Chunks owing extraction at `promptVersion`: no memo row at all (never extracted) or a row at a
   * different version (stale prompt). `storedVersion` distinguishes the two — a background drain heals
   * only never-extracted chunks, because re-extracting a whole corpus after a prompt bump is a decision
   * a user should make, not something a file drop triggers.
   */
  /** Chunk ids belonging to a SOURCE, by its identity string, in chunk order. */
  chunkIdsForSource(sourceIdentityText: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT n.id
           FROM nodes n
           JOIN edges e ON e.from_id = n.id AND e.kind = 'ORIGINATED_FROM'
           JOIN nodes s ON s.id = e.to_id AND s.text = ?
           WHERE n.subtype = 'chunk'
           ORDER BY COALESCE(json_extract(n.provenance, '$.index'), 2147483647), n.rowid`,
        )
        .all(sourceIdentityText) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  dirtyChunks(
    promptVersion: string,
    opts: {
      includeStale?: boolean; maxAttempts?: number; limit?: number; ids?: string[];
      /** Drop the dirty predicate entirely — the `--reextract` path, which re-runs already-clean chunks. */
      includeClean?: boolean;
    } = {},
  ): DirtyChunk[] {
    // `ids` is an optional restriction (ingestFile extracts only the file it just chunked). Interpolated as
    // a placeholder list, never as values — the ids are still bound.
    const idFilter = opts.ids ? ` AND n.id IN (${opts.ids.map(() => "?").join(",")})` : "";
    if (opts.ids && opts.ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT n.id, n.name, n.description AS text, n.provenance,
                e.prompt_version AS storedVersion,
                COALESCE(s.attempts, 0) AS attempts, s.last_error AS lastError,
                src.id AS sourceId, src.name AS sourceName, src.provenance AS sourceProvenance
         FROM nodes n
         LEFT JOIN extracted_chunks e ON e.chunk_id = n.id
         LEFT JOIN chunk_extraction_state s ON s.chunk_id = n.id
         LEFT JOIN edges eo ON eo.from_id = n.id AND eo.kind = 'ORIGINATED_FROM'
         LEFT JOIN nodes src ON src.id = eo.to_id
         WHERE n.subtype = 'chunk'
           AND (? = 1 OR e.chunk_id IS NULL OR e.prompt_version IS NOT ?)
           AND (? = 1 OR ? = 1 OR e.chunk_id IS NULL)
           AND COALESCE(s.attempts, 0) < ?${idFilter}
         ORDER BY n.rowid
         LIMIT ?`,
      )
      .all(
        opts.includeClean ? 1 : 0,
        promptVersion,
        opts.includeClean ? 1 : 0,
        opts.includeStale === false ? 0 : 1,
        opts.maxAttempts ?? Number.MAX_SAFE_INTEGER,
        ...(opts.ids ?? []),
        opts.limit ?? -1, // SQLite: LIMIT -1 means no limit
      ) as Array<Record<string, unknown>>;
    const parse = (v: unknown): Record<string, unknown> | null =>
      v ? (JSON.parse(v as string) as Record<string, unknown>) : null;
    return rows.map((r) => ({
      id: r.id as string,
      name: (r.name as string | null) ?? null,
      text: (r.text as string | null) ?? null,
      storedVersion: (r.storedVersion as string | null) ?? null,
      attempts: r.attempts as number,
      lastError: (r.lastError as string | null) ?? null,
      provenance: parse(r.provenance),
      sourceId: (r.sourceId as string | null) ?? null,
      sourceName: (r.sourceName as string | null) ?? null,
      sourceProvenance: parse(r.sourceProvenance),
    }));
  }

  /**
   * The first chunk of a source, by recorded chunk index. Used to recover a persona document's subject for
   * graphs ingested before the subject was persisted on the SOURCE node: the PROFILE: header lives in chunk
   * zero, exactly where readDoc found it. Without this, re-extracting an old chunk would lose subject-aware
   * extraction and silently reintroduce KI-1 for precisely the chunks that most need healing.
   */
  firstChunkText(sourceId: string): string | null {
    const r = this.db
      .prepare(
        `SELECT n.description AS text
         FROM nodes n
         JOIN edges e ON e.from_id = n.id AND e.kind = 'ORIGINATED_FROM' AND e.to_id = ?
         WHERE n.subtype = 'chunk'
         ORDER BY COALESCE(json_extract(n.provenance, '$.index'), 2147483647), n.rowid
         LIMIT 1`,
      )
      .get(sourceId) as { text: string | null } | undefined;
    return r?.text ?? null;
  }

  /** Counts for `tessera report`, `GET /status` and the viewer badge. Cheap: three aggregate scans. */
  dirtyCounts(promptVersion: string, failingAt = 3): {
    chunks: number; dirty: number; never: number; stale: number; failing: number;
  } {
    const r = this.db
      .prepare(
        `SELECT
           count(*) AS chunks,
           sum(CASE WHEN e.chunk_id IS NULL OR e.prompt_version IS NOT @v THEN 1 ELSE 0 END) AS dirty,
           sum(CASE WHEN e.chunk_id IS NULL THEN 1 ELSE 0 END) AS never,
           sum(CASE WHEN e.chunk_id IS NOT NULL AND e.prompt_version IS NOT @v THEN 1 ELSE 0 END) AS stale,
           sum(CASE WHEN (e.chunk_id IS NULL OR e.prompt_version IS NOT @v)
                     AND COALESCE(s.attempts, 0) >= @failingAt THEN 1 ELSE 0 END) AS failing
         FROM nodes n
         LEFT JOIN extracted_chunks e ON e.chunk_id = n.id
         LEFT JOIN chunk_extraction_state s ON s.chunk_id = n.id
         WHERE n.subtype = 'chunk'`,
      )
      .get({ v: promptVersion, failingAt }) as Record<string, number | null>;
    return {
      chunks: r.chunks ?? 0, dirty: r.dirty ?? 0, never: r.never ?? 0,
      stale: r.stale ?? 0, failing: r.failing ?? 0,
    };
  }

  /** Reset the attempt counters so `--retry-failed` can reach chunks a drain has given up on. */
  clearExtractionFailures(): number {
    return this.db.prepare("UPDATE chunk_extraction_state SET attempts = 0, last_error = NULL").run()
      .changes as number;
  }

  // Ingest manifest (see ddl `ingest_sources`). File-level record keyed on doc content hash — lets a corpus
  // re-run skip an unchanged doc with zero writes, and gates the skip on status='complete' so a partially-
  // failed ingest re-enters rather than freezing. `path`/`title` are metadata (a moved file is same content).
  getIngestedSource(contentHash: string): { status: string; chunkCount: number; parseFailures: number; path: string | null } | null {
    const r = this.db
      .prepare("SELECT status, chunk_count AS chunkCount, parse_failures AS parseFailures, path FROM ingest_sources WHERE content_hash = ?")
      .get(contentHash) as { status: string; chunkCount: number; parseFailures: number; path: string | null } | undefined;
    return r ?? null;
  }
  recordIngestedSource(rec: {
    contentHash: string; path: string | null; title: string | null;
    status: "complete" | "partial"; chunkCount: number; parseFailures: number;
    extractorModel: string | null; at: number;
  }, meta: Meta): void {
    const m = Meta.parse(meta);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ingest_sources (content_hash, path, title, status, chunk_count, parse_failures, extractor_model, ingested_at)
           VALUES (@contentHash, @path, @title, @status, @chunkCount, @parseFailures, @extractorModel, @at)
           ON CONFLICT(content_hash) DO UPDATE SET
             path=@path, title=@title, status=@status, chunk_count=@chunkCount,
             parse_failures=@parseFailures, extractor_model=@extractorModel, ingested_at=@at`,
        )
        .run(rec);
      // B23: the file-level manifest used to mutate without a log row, so a replay would reconstruct the
      // graph but not "which documents have been seen" and would re-ingest every unchanged doc.
      this.log(m, rec.at, "recordIngestedSource", rec.contentHash, null, {
        status: rec.status, chunkCount: rec.chunkCount, parseFailures: rec.parseFailures,
      });
    }).immediate();
  }
  // Provenance read (see ddl `assertion_sources`): the grounding node ids recorded for an assertion, sorted.
  assertionSources(assertionId: string): string[] {
    return (this.db.prepare("SELECT source_id FROM assertion_sources WHERE assertion_id = ? ORDER BY source_id").all(assertionId) as { source_id: string }[]).map((r) => r.source_id);
  }
  assertionIdsForEdge(edgeId: string): string[] {
    return (this.db.prepare("SELECT id FROM edge_assertions WHERE edge_id = ?").all(edgeId) as { id: string }[]).map((r) => r.id);
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
