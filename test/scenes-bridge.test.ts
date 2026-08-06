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
import { selectAnchors } from "../src/scenes/scene.js";

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
  new Function("scenes", "nodes", "W", "H", "GRAPH", "document", "Blob", "URL", "alert", "setTimeout", src)(
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
      const fromTemplate = new Function("cam", "nodes", "W", "H", src)(cam, nodeList, 1200, 800);
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
