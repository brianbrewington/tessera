// Wiring tests (design §3.4, §3.5, §11). Both slice-1 reviewers made the same point: the algorithm tests
// were strong and the WIRING tests were absent, so "core wiring behaviour can be missing while most new
// tests still pass". These exercise the product paths — the real CLI, the real export, and the viewer's
// branch extracted from the shipped template.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { layoutPass } from "../src/layout/pass.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE = readFileSync(join(ROOT, "viewer", "template.html"), "utf8");
const meta = { actor: "test", cause: "wiring" };

const TMP_GRAPH = "__wiring_test__";
const tmpDir = join(ROOT, "graphs", TMP_GRAPH);
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Parse the injected GRAPH literal back out of an exported bundle. */
function graphDataOf(html: string): { nodes: any[]; edges: any[]; layout: Record<string, [number, number]> } {
  const marker = "const GRAPH = ";
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf("\n", start);
  return JSON.parse(html.slice(start, end).replace(/;$/, "").replace(/\\u003c/g, "<"));
}

async function buildGraph(dir: string): Promise<{ ids: string[] }> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const n = await s.putNode({ type: "CONCEPT", origin: "ingest", text: `concept\tw${i}`, name: `w${i}`, description: `w${i}` }, meta);
    ids.push(n.id);
  }
  for (let i = 1; i < ids.length; i++) {
    await s.putEdge({ from: ids[i - 1]!, to: ids[i]!, kind: "RELATED", reason: `w${i - 1} relates to w${i}`, origin: "ingest" }, meta);
  }
  s.close();
  return { ids };
}

describe("wiring — the CLI writes layout and the bundle carries it", () => {
  it("`tessera view` settles, persists, and the exported bundle contains the stored positions", async () => {
    const { ids } = await buildGraph(tmpDir);

    // the REAL cli, as a user runs it
    const out = execFileSync("npx", ["tsx", "scripts/cli.ts", "view", TMP_GRAPH], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/layout: bootstrap/);

    // positions landed in SQLite...
    const s = new GraphStore({ path: join(tmpDir, "graph.db"), embedder: new StubEmbedder(768) });
    const stored = s.getLayout();
    s.close();
    expect(stored.size).toBe(ids.length);

    // ...AND in the bundle the user actually opens (design §3.5)
    const data = graphDataOf(readFileSync(join(tmpDir, "view.html"), "utf8"));
    expect(Object.keys(data.layout).length).toBe(ids.length);
    for (const id of ids) {
      expect(data.layout[id]![0]).toBe(stored.get(id)!.x);
      expect(data.layout[id]![1]).toBe(stored.get(id)!.y);
    }
  }, 60_000);

  it("a second `tessera view` is a no-op and does not move anything", async () => {
    const s = new GraphStore({ path: join(tmpDir, "graph.db"), embedder: new StubEmbedder(768) });
    const before = s.getLayout();
    s.close();
    const out = execFileSync("npx", ["tsx", "scripts/cli.ts", "view", TMP_GRAPH], { cwd: ROOT, encoding: "utf8" });
    expect(out).not.toMatch(/layout: (bootstrap|incremental)/); // noop prints nothing
    const s2 = new GraphStore({ path: join(tmpDir, "graph.db"), embedder: new StubEmbedder(768) });
    const after = s2.getLayout();
    s2.close();
    for (const [id, p] of before) {
      expect(after.get(id)!.x).toBe(p.x);
      expect(after.get(id)!.y).toBe(p.y);
      expect(after.get(id)!.version).toBe(p.version);
    }
  }, 60_000);
});

describe("wiring — the viewer's all-or-nothing read path (design §3.4)", () => {
  // Extract the decision straight out of the shipped template, so template drift fails here rather than
  // silently reshuffling everyone's map. No jsdom needed: the branch is pure arithmetic over plain objects.
  function extractBranch(): string {
    const start = TEMPLATE.indexOf("  const complete = NODES.length>0");
    const end = TEMPLATE.indexOf("computeBounds();", start);
    expect(start).toBeGreaterThan(0);
    return TEMPLATE.slice(start, end);
  }
  const runBranch = (NODES: any[], LAYOUT: Record<string, [number, number]>) => {
    let settleCalls = 0;
    const settle = (): void => {
      settleCalls++;
    };
    // `reposition` gates the branch — false when only the edge budget changed, so a draw filter can never
    // move nodes. These tests exercise the repositioning path, so it is true here.
    new Function("NODES", "LAYOUT", "settle", "reposition", extractBranch())(NODES, LAYOUT, settle, true);
    return settleCalls;
  };
  const mkNodes = () =>
    Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, sx: i * 10, sy: -i * 10, x: i * 10, y: -i * 10, vx: 9, vy: 9 }));

  it("COMPLETE layout: uses every stored position and never calls settle", () => {
    const nodes = mkNodes();
    const layout = Object.fromEntries(nodes.map((n, i) => [n.id, [1000 + i, 2000 + i] as [number, number]]));
    expect(runBranch(nodes, layout)).toBe(0);
    nodes.forEach((n, i) => {
      expect(n.x).toBe(1000 + i);
      expect(n.y).toBe(2000 + i);
    });
  });

  it("POISONED layout is used verbatim — proving the read path is wired, not decorative", () => {
    // A naive round-trip test passes even when stored layout is ignored, because the seed is deterministic.
    // Absurd coordinates cannot be produced by settle(), so this fails if the viewer regenerates instead.
    const nodes = mkNodes();
    const layout = Object.fromEntries(nodes.map((n) => [n.id, [-999999, 424242] as [number, number]]));
    expect(runBranch(nodes, layout)).toBe(0);
    for (const n of nodes) {
      expect(n.x).toBe(-999999);
      expect(n.y).toBe(424242);
    }
  });

  it("INCOMPLETE layout: ignores stored positions ENTIRELY and restarts from the seeds", () => {
    // One missing row must not yield a stored/seeded hybrid — settle() never re-seeds, so a hybrid start
    // would move the anchored nodes along a trajectory determined by which rows happened to exist.
    const nodes = mkNodes();
    const layout = Object.fromEntries(nodes.slice(1).map((n) => [n.id, [777, 888] as [number, number]]));
    expect(runBranch(nodes, layout)).toBe(1); // fell back to the full settle
    nodes.forEach((n) => {
      expect(n.x).toBe(n.sx); // restarted from seed, NOT from the 4 stored rows
      expect(n.y).toBe(n.sy);
      expect(n.vx).toBe(0);
    });
  });

  it("no layout at all (an old db): falls back cleanly", () => {
    const nodes = mkNodes();
    expect(runBranch(nodes, {})).toBe(1);
    nodes.forEach((n) => expect(n.x).toBe(n.sx));
  });
});

describe("wiring — additive through the real product path", () => {
  it("ingesting new nodes leaves every pre-existing position byte-identical", async () => {
    // The CLI's ingest path needs a live embedder, so this exercises the same layoutPass call the CLI makes
    // rather than shelling out; the CLI-calls-layoutPass edge is covered by the `view` tests above.
    const dir = join(ROOT, "graphs", "__wiring_add__");
    const { ids } = await buildGraph(dir);
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    await layoutPass(s, meta);
    const before = s.getLayout();

    const fresh: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = await s.putNode({ type: "CONCEPT", origin: "ingest", text: `concept\tnew${i}`, name: `new${i}`, description: `new${i}` }, meta);
      fresh.push(n.id);
    }
    for (let i = 1; i < fresh.length; i++) await s.putEdge({ from: fresh[i - 1]!, to: fresh[i]!, kind: "RELATED", reason: `new${i}`, origin: "ingest" }, meta);
    await s.putEdge({ from: fresh[0]!, to: ids[0]!, kind: "RELATED", reason: "joins the map", origin: "ingest" }, meta);

    const r = await layoutPass(s, meta);
    expect(r.mode).toBe("incremental");
    const after = s.getLayout();
    for (const id of ids) {
      expect(after.get(id)!.x).toBe(before.get(id)!.x);
      expect(after.get(id)!.y).toBe(before.get(id)!.y);
    }
    for (const id of fresh) expect(after.has(id)).toBe(true);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
