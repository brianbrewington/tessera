// Geometry preservation (design §3.2, §10). Slice 1 must not move the map: saved scenes are still raw
// camera coordinates until slice 2 anchors them, so any drift silently reframes every scene a user saved.
//
// The reference is EXTRACTED FROM viewer/template.html AT TEST TIME, not copied into the test. A test that
// compares the port against its own transcription passes even when both share a wrong assumption — which is
// exactly how the "seed over the visible list" defect survived a review round. Extracting the real thing also
// means editing the template's physics fails this test instead of quietly rewriting everyone's stored layout.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { settle, seedPositions, SETTLE, type LayoutNode, type LayoutEdge } from "../src/layout/settle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(HERE, "..", "viewer", "template.html"), "utf8");

/** Pull `function settle(){ ... }` verbatim out of the shipped template. */
function extractSettleSource(html: string): string {
  const start = html.indexOf("function settle(){");
  if (start < 0) throw new Error("settle() not found in template.html — did the viewer change?");
  const end = html.indexOf("\n}", start);
  if (end < 0) throw new Error("could not find the end of settle() in template.html");
  return html.slice(start, end + 2);
}

/** Pull the seed expressions out of the template's node-construction line. */
function extractSeed(html: string): (i: number) => { x: number; y: number } {
  const m = html.match(/x:\s*(Math\.cos\(i\)[^,]+),\s*y:\s*(Math\.sin\(i\)[^,]+),/);
  if (!m) throw new Error("seed expressions not found in template.html — did the viewer change?");
  return new Function("i", `return { x: ${m[1]}, y: ${m[2]} };`) as (i: number) => { x: number; y: number };
}

/** Run the template's own settle() over template-shaped nodes (edges hold object refs, not indices). */
function runTemplateSettle(
  nodes: Array<{ x: number; y: number; vx: number; vy: number }>,
  edges: Array<{ a: number; b: number }>,
): void {
  const tplEdges = edges.map((e) => ({ a: nodes[e.a], b: nodes[e.b] }));
  const fn = new Function("NODES", "EDGES", `${extractSettleSource(TEMPLATE)}\nsettle();`);
  fn(nodes, tplEdges);
}

/** A deterministic little graph: ids in "rowid" order, some marked provenance. */
function fixture(nTotal: number, provEvery: number): { ids: string[]; visible: string[]; edges: LayoutEdge[] } {
  const ids = Array.from({ length: nTotal }, (_, i) => `n${i}`);
  const visible = ids.filter((_, i) => i % provEvery !== 0);
  const edges: LayoutEdge[] = [];
  for (let k = 0; k < Math.round(visible.length * 1.07); k++) {
    const a = k % visible.length;
    const b = (k * 7 + 3) % visible.length;
    if (a !== b) edges.push({ a, b });
  }
  return { ids, visible, edges };
}

describe("settle port — geometry preservation", () => {
  it("produces bit-identical output to the settle() shipped in viewer/template.html", () => {
    const { ids, visible, edges } = fixture(120, 4);
    const seeds = seedPositions(ids);

    const mine: LayoutNode[] = visible.map((id) => ({ id, ...seeds.get(id)!, vx: 0, vy: 0 }));
    const theirs = visible.map((id) => ({ ...seeds.get(id)!, vx: 0, vy: 0 }));

    settle(mine, edges);
    runTemplateSettle(theirs, edges);

    expect(mine.length).toBe(theirs.length);
    for (let i = 0; i < mine.length; i++) {
      // bit-identical, not approximate — same engine, same arithmetic, same order of operations
      expect(mine[i]!.x).toBe(theirs[i]!.x);
      expect(mine[i]!.y).toBe(theirs[i]!.y);
    }
  });

  it("COINCIDENT nodes never separate — repulsion cannot break a tie (constrains §3.3 seeding)", () => {
    // Found by mutation testing. Changing the `|| 0.01` softening left every fixture green, and the reason
    // turns out to be a property of the algorithm, not a gap in the tests: when dx = dy = 0, the force is
    // fx = f*dx/d = 0 for ANY softening value. The guard only prevents a 0/0 NaN; its magnitude is
    // unobservable. The consequence is what matters — two nodes seeded at exactly the same point are welded
    // together forever, because nothing in the physics can push them apart.
    //
    // §3.3 seeds every member of a component from one seedPoint, so this is a live constraint there: the
    // jitter MUST produce distinct positions. src/layout/incremental.ts is tested for that separately.
    const edges: LayoutEdge[] = [{ a: 0, b: 1 }];
    const mk = () => [
      { x: 100, y: 100, vx: 0, vy: 0 },
      { x: 100, y: 100, vx: 0, vy: 0 }, // exactly coincident
      { x: 240, y: -80, vx: 0, vy: 0 },
    ];
    const mine: LayoutNode[] = mk().map((p, i) => ({ id: `n${i}`, ...p }));
    const theirs = mk();
    settle(mine, edges);
    runTemplateSettle(theirs, edges);

    // still matches the template exactly on this path
    for (let i = 0; i < mine.length; i++) {
      expect(mine[i]!.x).toBe(theirs[i]!.x);
      expect(mine[i]!.y).toBe(theirs[i]!.y);
    }
    // no NaN — the guard does its one real job
    expect(Number.isFinite(mine[0]!.x)).toBe(true);
    expect(Number.isFinite(mine[1]!.y)).toBe(true);
    // and the pair is still welded: identical seeds settle to identical positions, forever
    expect(mine[0]!.x).toBe(mine[1]!.x);
    expect(mine[0]!.y).toBe(mine[1]!.y);
  });

  it("seeds from the FULL node list, not the visible subset (the defect that survived a review round)", () => {
    const tplSeed = extractSeed(TEMPLATE);
    const { ids, visible } = fixture(60, 4);
    const seeds = seedPositions(ids);

    // every id's seed matches the template's expression at its FULL-list index
    ids.forEach((id, i) => {
      const want = tplSeed(i);
      expect(seeds.get(id)!.x).toBe(want.x);
      expect(seeds.get(id)!.y).toBe(want.y);
    });

    // and the visible-only seeding a careless reader would write is genuinely different, so this
    // assertion has teeth rather than being trivially true
    const wrong = seedPositions(visible);
    const differing = visible.filter((id) => wrong.get(id)!.x !== seeds.get(id)!.x).length;
    expect(differing).toBeGreaterThan(visible.length * 0.9);
  });

  it("does not re-seed: settling twice continues from current positions (template.html:242)", () => {
    const { ids, visible, edges } = fixture(40, 4);
    const seeds = seedPositions(ids);
    const once: LayoutNode[] = visible.map((id) => ({ id, ...seeds.get(id)!, vx: 0, vy: 0 }));
    settle(once, edges);
    const after1 = once.map((n) => ({ x: n.x, y: n.y }));
    settle(once, edges);
    const moved = once.some((n, i) => n.x !== after1[i]!.x || n.y !== after1[i]!.y);
    expect(moved).toBe(true); // second pass keeps moving from where the first left off
  });

  it("exposes the template's constants (drift in either direction fails)", () => {
    const src = extractSettleSource(TEMPLATE);
    expect(src).toContain(`kRep=${SETTLE.kRep}`);
    expect(src).toContain(`kSpring=${SETTLE.kSpring}`);
    expect(src).toContain(`rest=${SETTLE.rest}`);
    expect(src).toContain(`grav=${SETTLE.grav}`);
    expect(src).toContain(`it<${SETTLE.iterations}`);
    expect(src).toContain(`${SETTLE.damp}`);
  });
});
