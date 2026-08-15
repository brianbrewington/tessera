// PUT /layout validation. This drives the SHIPPED validateLayoutPayload rather than a copy of it — the first
// version of these tests reimplemented the logic inline, and both reviewers called that out as decoration:
// a cloned validator keeps passing while the real handler drifts away from it.
import { describe, it, expect } from "vitest";
import { validateLayoutPayload } from "../src/serve/server.js";

const known = new Set(["a", "b", "c"]);

describe("validateLayoutPayload", () => {
  it("rejects anything that is not { positions: {...} }", () => {
    for (const bad of [null, undefined, 42, "positions", {}, { positions: null }, { positions: "x" }, { positions: [] }])
      expect(validateLayoutPayload(bad).ok).toBe(false);
  });

  it("rejects an empty set rather than reporting a successful write of nothing", () => {
    expect(validateLayoutPayload({ positions: {} })).toMatchObject({ ok: false, error: "no positions" });
  });

  it("rejects NON-FINITE coordinates, naming the offender", () => {
    // Not hypothetical: the client optimiser ran to 1.2e+31 on the real corpus before a step clamp was added,
    // and a NaN gradient still lands in the buffer because `NaN > STEP_MAX` is false. Writing these would
    // corrupt every node's geometry at once, and there is no undo on disk.
    for (const v of [[Infinity, 0], [0, NaN], [-Infinity, 5], ["a", 1], [1], []]) {
      const r = validateLayoutPayload({ positions: { b: v } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("b");
    }
  });

  it("rejects finite-but-absurd coordinates", () => {
    // Number.isFinite(1e308) is true. It stores cleanly and renders as one visible node and 2054 invisible
    // ones. Finite is not the same as sane.
    const r = validateLayoutPayload({ positions: { a: [1e308, 0] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("out of range");
  });

  it("rejects an id the graph does not contain, when the id set is supplied", () => {
    // Found by Composer: the handler's comment claimed ids were checked and nothing checked them, so an
    // unknown id was deferred to putLayoutBatch — either an opaque failure after the user already applied, or
    // a silent partial write reported as a success.
    const r = validateLayoutPayload({ positions: { a: [1, 2], nope: [3, 4] } }, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nope");
  });

  it("accepts a well-formed batch and returns parsed entries", () => {
    const r = validateLayoutPayload({ positions: { a: [1, 2], b: [-3.5, 0] } }, known);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(2);
      expect(r.entries.find((e) => e.nodeId === "b")).toMatchObject({ x: -3.5, y: 0 });
    }
  });

  it("does not require an id set (the check is opt-in)", () => {
    expect(validateLayoutPayload({ positions: { anything: [0, 0] } }).ok).toBe(true);
  });
});
