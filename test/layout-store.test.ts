// Layout store API (design §3.1). The no-op rule is the load-bearing part: without it every `tessera view`
// rewrites every row, churns versions, and floods mutation_log — and the byte-identical-position test that
// protects saved scenes from drifting stops meaning anything.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const meta = { actor: "test", cause: "layout" };
const mkStore = (): GraphStore => new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });

async function seedNodes(s: GraphStore, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const node = await s.putNode(
      { type: "CONCEPT", origin: "ingest", text: `concept\tc${i}`, name: `c${i}`, description: `node ${i}` },
      meta,
    );
    ids.push(node.id);
  }
  return ids;
}

const logCount = (s: GraphStore): number =>
  // @ts-expect-error — reaching into the private handle is deliberate: mutation_log volume IS the assertion
  (s.db.prepare("SELECT count(*) AS n FROM mutation_log").get() as { n: number }).n;

const logCountFor = (s: GraphStore, op: string): number =>
  // @ts-expect-error — same
  (s.db.prepare("SELECT count(*) AS n FROM mutation_log WHERE op = ?").get(op) as { n: number }).n;

describe("putLayout", () => {
  it("inserts, then no-ops on identical coordinates — no version bump, no log row", async () => {
    const s = mkStore();
    const [id] = await seedNodes(s, 1);
    const first = s.putLayout(id!, { x: 10, y: 20 }, {}, meta);
    expect(first).toEqual({ version: 1, changed: true });

    const before = logCountFor(s, "putLayout");
    const again = s.putLayout(id!, { x: 10, y: 20 }, {}, meta);
    expect(again).toEqual({ version: 1, changed: false }); // version did NOT move
    expect(logCountFor(s, "putLayout")).toBe(before); // and nothing was logged
    s.close();
  });

  it("bumps version and logs when coordinates actually change", async () => {
    const s = mkStore();
    const [id] = await seedNodes(s, 1);
    s.putLayout(id!, { x: 1, y: 1 }, {}, meta);
    const r = s.putLayout(id!, { x: 1, y: 2 }, {}, meta);
    expect(r).toEqual({ version: 2, changed: true });
    expect(logCountFor(s, "putLayout")).toBe(2);
    s.close();
  });

  it("treats a zoomMin change as a change even when x/y are identical", async () => {
    const s = mkStore();
    const [id] = await seedNodes(s, 1);
    s.putLayout(id!, { x: 5, y: 5 }, {}, meta);
    const r = s.putLayout(id!, { x: 5, y: 5, zoomMin: 3 }, {}, meta);
    expect(r.changed).toBe(true);
    expect(s.getLayout().get(id!)!.zoomMin).toBe(3);
    s.close();
  });

  it("enforces expectedVersion (optimistic concurrency, per the store spec)", async () => {
    const s = mkStore();
    const [id] = await seedNodes(s, 1);
    s.putLayout(id!, { x: 0, y: 0 }, {}, meta);
    expect(() => s.putLayout(id!, { x: 9, y: 9 }, { expectedVersion: 7 }, meta)).toThrow(/version conflict/);
    expect(() => s.putLayout(id!, { x: 9, y: 9 }, { expectedVersion: 1 }, meta)).not.toThrow();
    s.close();
  });

  it("rejects a non-finite position instead of persisting NaN", async () => {
    const s = mkStore();
    const [id] = await seedNodes(s, 1);
    expect(() => s.putLayout(id!, { x: NaN, y: 0 }, {}, meta)).toThrow(/non-finite/);
    expect(() => s.putLayout(id!, { x: 0, y: Infinity }, {}, meta)).toThrow(/non-finite/);
    expect(s.getLayout().size).toBe(0);
    s.close();
  });

  it("rejects an unknown node rather than orphaning a layout row", async () => {
    const s = mkStore();
    expect(() => s.putLayout("nope", { x: 0, y: 0 }, {}, meta)).toThrow(/no such node/);
    s.close();
  });
});

describe("putLayoutBatch", () => {
  it("writes once per changed row and logs exactly ONE op for the batch", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 20);
    const before = logCount(s);
    const r = s.putLayoutBatch(ids.map((id, i) => ({ nodeId: id, x: i, y: -i })), meta);
    expect(r).toEqual({ written: 20, unchanged: 0 });
    expect(logCount(s) - before).toBe(1); // ONE op, not 20
    s.close();
  });

  it("a re-run with an unchanged map writes NOTHING and logs NOTHING", async () => {
    // This is the assertion behind "a second `tessera view` appends zero mutation_log ops".
    const s = mkStore();
    const ids = await seedNodes(s, 20);
    const entries = ids.map((id, i) => ({ nodeId: id, x: i, y: -i }));
    s.putLayoutBatch(entries, meta);
    const after1 = logCount(s);
    const r = s.putLayoutBatch(entries, meta);
    expect(r).toEqual({ written: 0, unchanged: 20 });
    expect(logCount(s)).toBe(after1);
    s.close();
  });

  it("mixed batch: only the moved rows are written, versions of the others stay put", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 5);
    const entries = ids.map((id, i) => ({ nodeId: id, x: i, y: 0 }));
    s.putLayoutBatch(entries, meta);
    const v0 = s.getLayout();

    const moved = entries.map((e, i) => (i === 2 ? { ...e, y: 99 } : e));
    const r = s.putLayoutBatch(moved, meta);
    expect(r).toEqual({ written: 1, unchanged: 4 });

    const v1 = s.getLayout();
    ids.forEach((id, i) => {
      if (i === 2) {
        expect(v1.get(id)!.version).toBe(v0.get(id)!.version + 1);
        expect(v1.get(id)!.y).toBe(99);
      } else {
        expect(v1.get(id)!.version).toBe(v0.get(id)!.version);
        expect(v1.get(id)!).toEqual(v0.get(id)!);
      }
    });
    s.close();
  });

  it("is atomic — a bad row aborts the whole batch, leaving no partial state", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 3);
    expect(() =>
      s.putLayoutBatch([{ nodeId: ids[0]!, x: 1, y: 1 }, { nodeId: "ghost", x: 2, y: 2 }], meta),
    ).toThrow(/no such node/);
    expect(s.getLayout().size).toBe(0); // the first row did NOT survive
    s.close();
  });

  it("validates all positions before writing any of them", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 3);
    expect(() =>
      s.putLayoutBatch([{ nodeId: ids[0]!, x: 1, y: 1 }, { nodeId: ids[1]!, x: NaN, y: 0 }], meta),
    ).toThrow(/non-finite/);
    expect(s.getLayout().size).toBe(0);
    s.close();
  });
});

describe("nodesLackingLayout + ordering", () => {
  it("returns exactly the unlaid nodes, and empties as they are laid out", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 6);
    expect(s.nodesLackingLayout()).toEqual(ids);

    s.putLayoutBatch(ids.slice(0, 4).map((id, i) => ({ nodeId: id, x: i, y: i })), meta);
    expect(s.nodesLackingLayout()).toEqual(ids.slice(4));

    s.putLayoutBatch(ids.slice(4).map((id, i) => ({ nodeId: id, x: i, y: i })), meta);
    expect(s.nodesLackingLayout()).toEqual([]);
    s.close();
  });

  it("allNodes() is in rowid order — seeds are index-derived, so this IS the geometry", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 25);
    expect(s.allNodes().map((n) => n.id)).toEqual(ids);

    // reinforcing a node (an UPDATE) must not reorder it — otherwise every stored position downstream
    // of it would silently refer to a different seed index
    await s.putNode(
      { type: "CONCEPT", origin: "ingest", text: "concept\tc3", name: "c3", description: "much longer description" },
      meta,
    );
    expect(s.allNodes().map((n) => n.id)).toEqual(ids);
    s.close();
  });

  it("the ORDER BY rowid clause is present in the SQL itself", () => {
    // HONEST LABEL: this is a tripwire, not a behavioural test. Mutation-testing showed that deleting
    // `ORDER BY rowid` from allNodes() leaves every behavioural assertion above green — SQLite already
    // returns rowid order for a plain table scan, so there is no observable difference *today*. The clause
    // exists to take the ordering out of the query planner's discretion tomorrow (a new index, a new SQLite
    // version, an added WHERE). Since the behaviour is indistinguishable, asserting the source is the only
    // way to catch a silent removal — and layout seeds are index-derived, so a reordering would invalidate
    // every stored position in the database.
    const src = readFileSync(join(HERE, "..", "src", "store", "graphStore.ts"), "utf8");
    expect(src).toMatch(/SELECT \* FROM nodes ORDER BY rowid/);
    expect(src).toMatch(/SELECT \* FROM edges ORDER BY rowid/);
    expect(src).toMatch(/FROM nodes n LEFT JOIN layout l[\s\S]*?ORDER BY n\.rowid/);
  });

  it("nodesLackingLayout() is in rowid order too (component indices depend on it)", async () => {
    const s = mkStore();
    const ids = await seedNodes(s, 8);
    s.putLayoutBatch([{ nodeId: ids[3]!, x: 0, y: 0 }], meta);
    const lacking = s.nodesLackingLayout();
    expect(lacking).toEqual(ids.filter((id) => id !== ids[3]));
    s.close();
  });
});
