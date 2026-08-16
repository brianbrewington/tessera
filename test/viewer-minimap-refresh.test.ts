// FOUND BY BRIAN, live: apply a computed layout (or save it) and the minimap keeps showing the old
// positions. The minimap's node dots are an offscreen CACHE (mmDots) over cached bounds, refreshed only by
// rebuild() — while acceptLayout() and Undo moved every node and refreshed nothing. Classic stale-cache
// shape: the cache has exactly one writer and N mutators, and nothing made the mutators pay the cache's bill.
//
// House convention (viewer-layout-guards): source-structural checks over the template, since the viewer is a
// single self-contained page with no module seams to import through.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TPL = readFileSync(new URL("../viewer/template.html", import.meta.url), "utf8");

function grab(name: string): string {
  const start = TPL.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`template has no function ${name}`);
  let depth = 0;
  for (let j = TPL.indexOf("{", start); j < TPL.length; j++) {
    if (TPL[j] === "{") depth++;
    else if (TPL[j] === "}") { depth--; if (depth === 0) return TPL.slice(start, j + 1); }
  }
  throw new Error("unbalanced");
}

describe("the minimap cache is refreshed by every position mutator", () => {
  it("refreshMinimap exists and does both halves — bounds AND the dot cache", () => {
    const f = grab("refreshMinimap");
    expect(f).toContain("computeBounds()");
    expect(f).toContain("renderMMDots()");
  });

  it("acceptLayout refreshes the minimap AFTER writing positions back", () => {
    const f = grab("acceptLayout");
    const wb = f.indexOf("writeBack(");
    const rm = f.indexOf("refreshMinimap()");
    expect(wb, "acceptLayout writes positions").toBeGreaterThan(-1);
    expect(rm, "acceptLayout refreshes the minimap").toBeGreaterThan(-1);
    expect(rm, "refresh must come after the write, or it caches the old positions").toBeGreaterThan(wb);
  });

  it("undo refreshes the minimap after restoring positions", () => {
    // The undo handler is inline in the layout panel builder, so this is an adjacency check: the restore
    // call and the refresh must appear in the same statement.
    expect(TPL).toMatch(/restore\(u\.pos\);\s*refreshMinimap\(\)/);
  });

  it("rebuild routes through the same named concept, so there is ONE refresh semantics", () => {
    // Two spellings of "refresh the minimap" is how the next mutator picks the wrong one.
    const inline = TPL.match(/computeBounds\(\);\s*renderMMDots\(\)/g) ?? [];
    expect(inline.length, "computeBounds+renderMMDots should be composed only inside refreshMinimap").toBe(1);
  });
});
