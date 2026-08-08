// The migration bridge, end to end (design §5, §11). This is the ONE-WAY DOOR: a file:// page cannot write
// SQLite, so the crossing is two artifacts — the viewer downloads scenes.json, the CLI imports it. After
// `serve` moves the origin, that file is the ONLY copy of a user's scenes and narration.
//
// A helper that never touches localStorage would not test the door. So this drives the REAL export function
// extracted from the shipped template, against a fake localStorage, and then the REAL CLI importer.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { layoutPass } from "../src/layout/pass.js";
import { selectAnchors, frameAnchors } from "../src/scenes/scene.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE = readFileSync(join(ROOT, "viewer", "template.html"), "utf8");
const meta = { actor: "test", cause: "bridge" };

const GRAPH_NAME = "__bridge_test__";
const dir = join(ROOT, "graphs", GRAPH_NAME);
const jsonPath = join(dir, "scenes.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Pull the anchor constants out of the template, so the test uses the SHIPPED values, not copies. */
function extractAnchorConsts(): string {
  const m = TEMPLATE.match(/const ANCHOR_CAP=\d+, ANCHOR_FALLBACK=\d+;/);
  if (!m) throw new Error("anchor constants not found in template.html");
  return m[0];
}

/** Pull a named function verbatim out of the shipped viewer. */
function extractFn(name: string): string {
  const start = TEMPLATE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found in template.html`);
  const end = TEMPLATE.indexOf("\n}", start);
  return TEMPLATE.slice(start, end + 2);
}

/** Run the viewer's own exportScenes() in a tiny fake DOM, returning the JSON it would download. */
function runExport(sceneList: any[], nodeList: any[], W: number, H: number, graphName: string): any {
  let captured = "";
  const doc = {
    createElement: () => ({ href: "", download: "", click(): void {}, remove(): void {} }),
    body: { appendChild(): void {} },
  };
  const Blob_ = class {
    constructor(parts: string[]) {
      captured = parts[0]!;
    }
  };
  const URL_ = { createObjectURL: () => "blob:x", revokeObjectURL(): void {} };
  const src = `${extractAnchorConsts()}\n${extractFn("anchorsForCamera")}\n${extractFn("exportScenes")}\nexportScenes();`;
  new Function("scenes", "NODES", "W", "H", "GRAPH", "document", "Blob", "URL", "alert", "setTimeout", src)(
    sceneList, nodeList, W, H, { name: graphName }, doc, Blob_, URL_, () => {}, () => {},
  );
  return JSON.parse(captured);
}

async function buildGraph(): Promise<string[]> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push((await s.putNode({ type: "CONCEPT", origin: "ingest", text: `c\t${i}`, name: `c${i}`, description: `c${i}` }, meta)).id);
  }
  for (let i = 1; i < ids.length; i++) {
    await s.putEdge({ from: ids[i - 1]!, to: ids[i]!, kind: "RELATED", reason: `r${i}`, origin: "ingest" }, meta);
  }
  await layoutPass(s, meta);
  s.close();
  return ids;
}

describe("the export side agrees with the import side", () => {
  it("the viewer's anchorsForCamera matches selectAnchors in src/ (they cannot drift)", () => {
    // Two implementations of one rule, one in TS and one inlined in the template. If they disagree, scenes
    // get anchored to different nodes than the tests believe, so pin them against each other directly.
    const nodeList = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, x: (i % 8) * 120 - 400, y: Math.floor(i / 8) * 120 - 200, deg: (i * 7) % 11 }));
    const cams = [
      { ox: 600, oy: 400, scale: 1 },
      { ox: 600, oy: 400, scale: 0.35 },
      { ox: -90000, oy: -90000, scale: 1 }, // frames empty space -> fallback path
    ];
    const src = `${extractAnchorConsts()}\n${extractFn("anchorsForCamera")}\nreturn anchorsForCamera(cam);`;
    for (const cam of cams) {
      const fromTemplate = new Function("cam", "NODES", "W", "H", src)(cam, nodeList, 1200, 800);
      const fromSrc = selectAnchors(nodeList, cam, { w: 1200, h: 800 });
      expect(fromTemplate).toEqual(fromSrc);
    }
  });
});

describe("crossing the door, end to end", () => {
  it("localStorage scenes -> export -> CLI import -> scenes table, losslessly", async () => {
    const ids = await buildGraph();
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const layout = s.getLayout();
    const nodeList = ids.map((id, i) => ({ id, x: layout.get(id)!.x, y: layout.get(id)!.y, deg: i }));
    s.close();

    // A REAL localStorage payload, including the two things that matter: narration, and COLLIDING ids
    // ('sc' + performance.now() is ms since page load, so two sessions produce the same value).
    const legacy = [
      { id: "sc4211", name: "The hub", ox: 600, oy: 400, scale: 1, showProv: false, node: ids[3]!, narr: "start here — this is the trope" },
      { id: "sc4211", name: "The far side", ox: 300, oy: 200, scale: 0.6, showProv: true, node: ids[9]!, narr: "and this is where it reappears" },
    ];

    const payload = runExport(legacy, nodeList, 1200, 800, GRAPH_NAME);
    expect(payload.scenes.length).toBe(2);
    expect(payload.scenes.every((x: any) => x.anchors.length > 0)).toBe(true);
    writeFileSync(jsonPath, JSON.stringify(payload));

    // the REAL CLI, as a user runs it
    const out = execFileSync("npx", ["tsx", "scripts/cli.ts", "scenes", "import", GRAPH_NAME, jsonPath], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/imported 2 scene\(s\)/);

    const s2 = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const got = s2.allScenes();
    s2.close();

    expect(got.length).toBe(2); // colliding legacy ids did NOT merge
    const hub = got.find((x) => x.name === "The hub")!;
    const far = got.find((x) => x.name === "The far side")!;
    expect(hub.narr).toBe("start here — this is the trope"); // narration survived the crossing
    expect(far.narr).toBe("and this is where it reappears");
    expect(far.showProv).toBe(true);
    expect(hub.focusNode).toBe(ids[3]!);
    expect(hub.anchors.length).toBeGreaterThan(0);
    expect(new Set(got.map((x) => x.id)).size).toBe(2);
  }, 60_000);

  it("re-importing the same file is a no-op — safe to run twice", async () => {
    const out = execFileSync("npx", ["tsx", "scripts/cli.ts", "scenes", "import", GRAPH_NAME, jsonPath], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/imported 0 scene\(s\), 2 already present/);
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    expect(s.allScenes().length).toBe(2);
    s.close();
  }, 60_000);

  it("ANCHORS SURVIVE A RE-SETTLE — the whole point of slice 2", async () => {
    // Scenes were camera coordinates; a re-settle silently reframed them. Anchors are node ids, so the same
    // scene still resolves to the same NODES no matter where the layout moves them.
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const before = s.allScenes().map((x) => ({ name: x.name, anchors: [...x.anchors].sort() }));

    // force a full re-settle: wipe layout, lay out again from scratch
    // @ts-expect-error — deliberate test-only escape hatch; no product path triggers a full re-settle
    s.db.prepare("DELETE FROM layout").run();
    await layoutPass(s, meta);

    const after = s.allScenes().map((x) => ({ name: x.name, anchors: [...x.anchors].sort() }));
    expect(after).toEqual(before); // same scenes, same nodes — unchanged by the geometry moving
    s.close();
  });
});

describe("the export must not anchor to hidden provenance (Fable, HIGH)", () => {
  it("anchorsForCamera draws only from the VISIBLE set", async () => {
    // The corruption this prevents, and it is permanent: provenance nodes get no stored layout until slice 4,
    // so they sit at their seed-ring coordinates near the world origin — inside exactly the frames people
    // save. They also keep a stale `deg` from any earlier `h` toggle, so they can OUTRANK real nodes in the
    // degree sort. Anchoring a scene to them writes invisible chunk ids through the one-way door.
    //
    // The parity test above cannot catch this: it feeds both implementations the same curated list, so it
    // proves they agree on their input while nothing constrains which input the page supplies.
    const src = `${extractAnchorConsts()}\n${extractFn("anchorsForCamera")}\nreturn anchorsForCamera(cam);`;
    const cam = { ox: 600, oy: 400, scale: 1 };

    const real = Array.from({ length: 6 }, (_, i) => ({ id: `real${i}`, x: i * 30 - 90, y: 0, deg: 2 }));
    // provenance at the seed ring near the origin, carrying an inflated stale degree
    const hidden = Array.from({ length: 4 }, (_, i) => ({ id: `chunk${i}`, x: i * 5, y: i * 5, deg: 99 }));

    // NODES is the visible set — the fixed code reads this, so hidden nodes cannot be selected
    const got = new Function("cam", "NODES", "W", "H", src)(cam, real, 1200, 800) as string[];
    expect(got.every((id) => id.startsWith("real"))).toBe(true);

    // and if the hidden ones WERE in the pool, their inflated degree would take every slot — which is
    // exactly what the pre-fix code did, since it read the global `nodes` array
    const ifUnfiltered = new Function("cam", "NODES", "W", "H", src)(cam, [...real, ...hidden], 1200, 800) as string[];
    expect(ifUnfiltered.filter((id) => id.startsWith("chunk")).length).toBe(4);
  });

  it("the template reads NODES, not the global all-nodes array", () => {
    const fn = extractFn("anchorsForCamera");
    expect(fn).toContain("const pool = NODES;");
    expect(fn).not.toMatch(/=\s*nodes\.filter/); // the pre-fix form
  });
});

describe("the scenes rack is reorderable, and the reorder is extractable", () => {
  // Drag-reorder was deferred to v1.5 ("named tours, drag-reorder"); Brian pulled it forward. The array move
  // is extracted from the template so the ordering logic is testable without a DOM and without dispatching
  // synthetic drag events, which test the browser more than they test us.
  const moveScene = new Function(`${extractFn("moveScene")}; return moveScene;`)() as <T>(l: T[], f: number, t: number) => T[];

  it("moves an item and shifts the rest", () => {
    expect(moveScene(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveScene(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveScene(["a", "b", "c"], 1, 2)).toEqual(["a", "c", "b"]);
  });

  it("returns the SAME array reference for a no-op, so a drop-in-place persists nothing", () => {
    const l = ["a", "b", "c"];
    expect(moveScene(l, 1, 1)).toBe(l); // identity, not just equality — reorderScenes early-returns on this
  });

  it("refuses out-of-range indices rather than corrupting the list", () => {
    const l = ["a", "b"];
    expect(moveScene(l, -1, 0)).toBe(l);
    expect(moveScene(l, 0, 9)).toBe(l);
  });
});

describe("cameraForAnchors mirrors frameAnchors — the restore half of the bridge", () => {
  // anchorsForCamera (save) already had a mirror test. Its inverse did not exist in the viewer until served
  // scenes needed it: a scene from the database carries node ids, not a camera. Two implementations of the
  // same framing equations will drift unless something fails when they do.
  const camFor = (ids: string[], stored: number, nodeList: any[], W: number, H: number) =>
    new Function("ids", "storedScale", "NODES", "byId", "W", "H",
      `${extractFn("cameraForAnchors")}
       ${TEMPLATE.match(/const FIT_FRACTION=[^\n]*\n/)![0]}
       return cameraForAnchors(ids, storedScale);`,
    )(ids, stored, nodeList, new Map(nodeList.map((n) => [n.id, n])), W, H);

  const nodes = [
    { id: "a", x: -100, y: -50, deg: 3 },
    { id: "b", x: 300, y: 150, deg: 2 },
    { id: "c", x: 20, y: 900, deg: 1 },
  ];

  it("agrees with frameAnchors on the same anchors", () => {
    const ids = ["a", "b"];
    const pts = nodes.filter((n) => ids.includes(n.id)).map((n) => ({ x: n.x, y: n.y }));
    const ts = frameAnchors(pts, 1.4, { w: 1200, h: 800 });
    const vw = camFor(ids, 1.4, nodes, 1200, 800);
    expect(vw.scale).toBeCloseTo(ts.scale, 9);
    expect(vw.ox).toBeCloseTo(ts.ox, 9);
    expect(vw.oy).toBeCloseTo(ts.oy, 9);
  });

  it("agrees on the single-anchor case, where stored scale must win", () => {
    const ts = frameAnchors([{ x: -100, y: -50 }], 2.5, { w: 1200, h: 800 });
    const vw = camFor(["a"], 2.5, nodes, 1200, 800);
    expect(vw.scale).toBeCloseTo(ts.scale, 9);
    expect(vw.scale).toBeCloseTo(2.5, 9); // the deliberate close-up is not thrown away
    expect(vw.ox).toBeCloseTo(ts.ox, 9);
  });

  it("returns null when every anchor is gone, rather than guessing a camera", () => {
    // frameAnchors THROWS on an empty set ("a scene must resolve to something"). In the browser a throw
    // would break the click; returning null leaves the camera where it is, which is the honest no-op.
    expect(camFor(["vanished"], 1, nodes, 1200, 800)).toBeNull();
    expect(() => frameAnchors([], 1, { w: 1200, h: 800 })).toThrow();
  });
});
