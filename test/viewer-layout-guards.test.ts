// Guards on the layout feature — the one place a browser control can overwrite geometry the CLI computed.
// Every case here is a defect a cross-agent reviewer found in the shipped code, reproduced before being fixed.
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
const fn = <T>(name: string): T => new Function(`${grab(name)}; return ${name};`)() as T;

describe("saving a layout cannot tear the map", () => {
  // FOUND BY GROK. startLayout laid out only nodes that are VISIBLE and have vectors; the save handler then
  // wrote EVERY node. Hide provenance, compute, apply, save: the hidden nodes keep their CLI positions while
  // the visible ones jump into a t-SNE disk, and the database commits the hybrid permanently. This needs no
  // diverging optimiser and no malice — it is the happy path with the `h` key pressed.
  const covers = fn<(applied: string[] | null, all: string[]) => boolean>("layoutCoversAll");

  it("refuses when the applied layout covered only some nodes", () => {
    expect(covers(["a", "b"], ["a", "b", "c"])).toBe(false);
  });
  it("refuses when no layout has been applied at all", () => {
    expect(covers(null, ["a", "b"])).toBe(false);
  });
  it("allows when every node was covered", () => {
    expect(covers(["b", "a"], ["a", "b"])).toBe(true);
  });
  it("is not fooled by matching COUNTS with different ids", () => {
    // A length check would pass this. That is exactly how a tear survives review.
    expect(covers(["a", "x"], ["a", "b"])).toBe(false);
  });
});

describe("a non-finite layout never reaches the canvas", () => {
  // FOUND BY BOTH REVIEWERS. STEP_MAX bounds a step, not a NaN: `NaN > STEP_MAX` is false, so a NaN gradient
  // still lands in Y. writeBack then computes a radius of NaN, k becomes 1, and NaN coordinates are written
  // into the live nodes. The server rejects them on save, so disk stays safe — but the session map is already
  // wrecked, and "the save endpoint will catch it" is not a reason to render garbage first.
  const ok = fn<(Y: number[][]) => boolean>("layoutIsFinite");

  it("rejects NaN and Infinity", () => {
    expect(ok([[0, 0], [NaN, 1]])).toBe(false);
    expect(ok([[0, 0], [1, Infinity]])).toBe(false);
    expect(ok([[-Infinity, 0]])).toBe(false);
  });
  it("rejects a collapsed result, which is finite but useless", () => {
    expect(ok([[0, 0], [0, 0], [0, 0]])).toBe(false);
  });
  it("accepts a healthy spread", () => {
    expect(ok([[0, 0], [12, -4], [-7, 9]])).toBe(true);
  });
});
