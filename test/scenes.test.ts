// Scenes (design §4, §5, §11). This slice is the ONE-WAY DOOR: localStorage is origin-scoped, so once
// `serve` ships on http://127.0.0.1:PORT every scene saved under file:// is unreachable — including `narr`,
// the only human-authored prose in the system. These tests guard the crossing.
import { describe, it, expect } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { contentKey, selectAnchors, frameAnchors, type SceneExport } from "../src/scenes/scene.js";

const meta = { actor: "test", cause: "scenes" };
const mkStore = (): GraphStore => new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
const VP = { w: 1200, h: 800 };

async function nodes(s: GraphStore, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await s.putNode({ type: "CONCEPT", origin: "ingest", text: `c\t${i}`, name: `c${i}`, description: `c${i}` }, meta)).id);
  }
  return ids;
}
const withKey = (s: SceneExport) => ({ ...s, contentKey: contentKey(s) });

describe("contentKey — the import idempotency key", () => {
  const base: SceneExport = { name: "Cape Town", narr: "the hinge", scale: 1.5, showProv: false, focusNode: "n1", anchors: ["b", "a"], ordinal: 0 };

  it("is stable under anchor ORDER but not under anchor SET", () => {
    expect(contentKey({ ...base, anchors: ["a", "b"] })).toBe(contentKey({ ...base, anchors: ["b", "a"] }));
    expect(contentKey({ ...base, anchors: ["a", "c"] })).not.toBe(contentKey(base));
  });

  it("INCLUDES focus_node — two scenes differing only in panel selection are different scenes", () => {
    // Both slice-1 reviewers found this independently. focus_node is independent of the anchors: anchors
    // govern the camera, focus_node governs the panel. Omitting it lets the unique index silently merge them.
    expect(contentKey({ ...base, focusNode: "n2" })).not.toBe(contentKey(base));
  });

  it("separates fields so concatenation cannot collide", () => {
    expect(contentKey({ ...base, name: "ab", narr: "c" })).not.toBe(contentKey({ ...base, name: "a", narr: "bc" }));
  });

  it("is stable under float formatting of scale", () => {
    expect(contentKey({ ...base, scale: 1.5 })).toBe(contentKey({ ...base, scale: 1.5000000000001 }));
  });
});

describe("importScenes — crossing the one-way door", () => {
  it("imports scenes with COLLIDING legacy ids as two distinct rows", async () => {
    // 'sc' + performance.now() is milliseconds since PAGE LOAD, so two scenes saved at similar page ages in
    // different sessions share an id. Keying the import on it would merge or drop one of them, permanently.
    const s = mkStore();
    const [a, b, c] = await nodes(s, 3);
    const r = s.importScenes(
      [
        withKey({ name: "First", narr: "one", scale: 1, showProv: false, focusNode: a!, anchors: [a!, b!], legacyId: "sc1234", ordinal: 0 }),
        withKey({ name: "Second", narr: "two", scale: 2, showProv: true, focusNode: c!, anchors: [c!], legacyId: "sc1234", ordinal: 1 }),
      ],
      meta,
    );
    expect(r.imported).toBe(2);
    const all = s.allScenes();
    expect(all.length).toBe(2);
    expect(all.map((x) => x.name).sort()).toEqual(["First", "Second"]);
    expect(new Set(all.map((x) => x.id)).size).toBe(2); // minted ids, not the colliding legacy one
    expect(all.every((x) => x.legacyId === "sc1234")).toBe(true); // kept as provenance only
    s.close();
  });

  it("preserves name AND narr — the only human-authored content in the system", async () => {
    const s = mkStore();
    const [a] = await nodes(s, 2);
    s.importScenes([withKey({ name: "The turn", narr: "stop here and look at the hub", scale: 1.25, showProv: true, focusNode: a!, anchors: [a!], ordinal: 3 })], meta);
    const got = s.allScenes()[0]!;
    expect(got.name).toBe("The turn");
    expect(got.narr).toBe("stop here and look at the hub");
    expect(got.scale).toBe(1.25);
    expect(got.showProv).toBe(true);
    expect(got.ordinal).toBe(3);
    s.close();
  });

  it("is idempotent on CONTENT — re-running the import writes nothing new", async () => {
    const s = mkStore();
    const [a, b] = await nodes(s, 2);
    const payload = [withKey({ name: "Once", narr: null, scale: 1, showProv: false, focusNode: null, anchors: [a!, b!], ordinal: 0 })];
    expect(s.importScenes(payload, meta).imported).toBe(1);
    const second = s.importScenes(payload, meta);
    expect(second).toMatchObject({ imported: 0, duplicates: 1 });
    expect(s.allScenes().length).toBe(1);
    s.close();
  });

  it("drops unresolvable anchors with a count, and SKIPS a scene left with none", async () => {
    const s = mkStore();
    const [a] = await nodes(s, 1);
    const r = s.importScenes(
      [
        withKey({ name: "Partly", narr: null, scale: 1, showProv: false, focusNode: null, anchors: [a!, "ghost1"], ordinal: 0 }),
        withKey({ name: "Orphan", narr: "lost", scale: 1, showProv: false, focusNode: null, anchors: ["ghost2", "ghost3"], ordinal: 1 }),
      ],
      meta,
    );
    expect(r).toMatchObject({ imported: 1, skipped: 1, droppedAnchors: 3 });
    const kept = s.allScenes();
    expect(kept.length).toBe(1);
    expect(kept[0]!.anchors).toEqual([a!]); // an anchorless scene is unrestorable — never written empty
    s.close();
  });

  it("nulls a focus_node that no longer exists rather than failing the import", async () => {
    const s = mkStore();
    const [a] = await nodes(s, 1);
    s.importScenes([withKey({ name: "S", narr: null, scale: 1, showProv: false, focusNode: "gone", anchors: [a!], ordinal: 0 })], meta);
    expect(s.allScenes()[0]!.focusNode).toBeNull();
    s.close();
  });
});

describe("anchor selection (design §4.2)", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, x: i * 50, y: 0, deg: i }));

  it("takes in-view nodes ranked by degree, capped", () => {
    const got = selectAnchors(mk(30), { ox: 0, oy: 400, scale: 1 }, VP, 5);
    expect(got.length).toBe(5);
    // nodes sit at x = i*50, so i <= 24 is on-screen for a 1200px viewport (the bound is inclusive —
    // a node exactly on the edge is visible). n24 therefore has the highest degree in view.
    expect(got[0]).toBe("n24");
    expect(got).toEqual(["n24", "n23", "n22", "n21", "n20"]); // strictly degree-ranked, capped at 5
  });

  it("falls back to the nearest nodes when the viewport frames empty space", () => {
    // A scene over a void must still resolve — otherwise it can never be restored.
    const got = selectAnchors(mk(10), { ox: -99999, oy: -99999, scale: 1 }, VP);
    expect(got.length).toBe(3);
  });

  it("a single-anchor scene (saved from the node panel) works", () => {
    const got = selectAnchors([{ id: "solo", x: 10, y: 10, deg: 0 }], { ox: 0, oy: 0, scale: 1 }, VP);
    expect(got).toEqual(["solo"]);
  });
});

describe("restore framing (design §4.2)", () => {
  it("centres the anchors' bbox", () => {
    const cam = frameAnchors([{ x: 0, y: 0 }, { x: 100, y: 200 }], 10, VP);
    expect(0 * cam.scale + cam.ox).toBeCloseTo(VP.w / 2 - 50 * cam.scale);
    expect(50 * cam.scale + cam.ox).toBeCloseTo(VP.w / 2); // bbox centre lands at viewport centre
  });

  it("zooms OUT when the cluster has spread, but never in past the user's chosen scale", () => {
    const tight = frameAnchors([{ x: 0, y: 0 }, { x: 10, y: 10 }], 2, VP);
    expect(tight.scale).toBe(2); // still fits — honour the stored zoom
    const spread = frameAnchors([{ x: -5000, y: -5000 }, { x: 5000, y: 5000 }], 2, VP);
    expect(spread.scale).toBeLessThan(2); // refit so the thing they saved is still visible
  });

  it("a single anchor keeps the stored scale (bbox is degenerate)", () => {
    expect(frameAnchors([{ x: 42, y: 42 }], 3.5, VP).scale).toBe(3.5);
  });

  it("refuses to frame nothing rather than producing NaN", () => {
    expect(() => frameAnchors([], 1, VP)).toThrow(/must resolve to something/);
  });
});
