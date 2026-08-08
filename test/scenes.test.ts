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

describe("scenes are editable, not just importable", () => {
  // importScenes is insert-only. Before reorderScenes/deleteScene existed there was no UPDATE and no DELETE
  // for scenes anywhere in the repo — while the viewer has always had an × on every scene chip. Wiring
  // served scenes to the db without these would have made that × a lie that survived until reload.
  const mk = (name: string, anchors: string[], ordinal: number) =>
    withKey({ name, narr: null, scale: 1, showProv: false, focusNode: null, anchors, ordinal });

  it("reorderScenes moves rows and leaves contentKey untouched — the invariant drag-reorder rests on", async () => {
    const s = mkStore();
    const ids = await nodes(s, 3);
    s.importScenes([mk("A", [ids[0]!], 0), mk("B", [ids[1]!], 1), mk("C", [ids[2]!], 2)], meta);
    const before = s.allScenes();
    expect(before.map((x) => x.name)).toEqual(["A", "B", "C"]);

    const moved = s.reorderScenes([before[2]!.id, before[0]!.id, before[1]!.id], meta);
    expect(moved).toBe(3);
    const after = s.allScenes();
    expect(after.map((x) => x.name)).toEqual(["C", "A", "B"]);
    // The keys are unchanged, so a later `tessera scenes import` still sees these as the SAME scenes and
    // counts them as duplicates rather than importing three new ones.
    expect(new Set(after.map((x) => x.contentKey))).toEqual(new Set(before.map((x) => x.contentKey)));
    s.close();
  });

  it("reordering to the SAME order writes nothing (the no-op rule)", async () => {
    const s = mkStore();
    const ids = await nodes(s, 2);
    s.importScenes([mk("A", [ids[0]!], 0), mk("B", [ids[1]!], 1)], meta);
    const cur = s.allScenes();
    expect(s.reorderScenes(cur.map((x) => x.id), meta)).toBe(0);
    expect(s.allScenes().map((x) => x.version)).toEqual(cur.map((x) => x.version)); // no version churn
    s.close();
  });

  it("deleteScene removes the scene AND its anchors, and is honest about a missing id", async () => {
    const s = mkStore();
    const ids = await nodes(s, 2);
    s.importScenes([mk("A", [ids[0]!, ids[1]!], 0), mk("B", [ids[1]!], 1)], meta);
    const target = s.allScenes().find((x) => x.name === "A")!;

    expect(s.deleteScene(target.id, meta)).toBe(true);
    expect(s.allScenes().map((x) => x.name)).toEqual(["B"]);
    // @ts-expect-error — deliberate private access: the orphan-anchor check is about raw rows
    const orphans = (s.db.prepare("SELECT count(*) AS n FROM scene_anchors WHERE scene_id = ?").get(target.id) as { n: number }).n;
    expect(orphans).toBe(0);
    expect(s.deleteScene(target.id, meta)).toBe(false); // already gone
    s.close();
  });

  it("a deleted scene can be saved again (its content key is free)", async () => {
    const s = mkStore();
    const ids = await nodes(s, 1);
    s.importScenes([mk("A", [ids[0]!], 0)], meta);
    s.deleteScene(s.allScenes()[0]!.id, meta);
    expect(s.importScenes([mk("A", [ids[0]!], 0)], meta).imported).toBe(1);
    s.close();
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

  it("a scene with NO focus node is fully supported — optional, not degraded", async () => {
    // Saving a view without a node open is a legitimate workflow: anchors govern the camera, focus_node only
    // restores the side panel, and the viewer's restoreScene() already falls through to showIdle(). This
    // pins that as a guarantee rather than an accident, since 5 of Brian's 6 real scenes have no focus node.
    const s = mkStore();
    const [a, b] = await nodes(s, 2);
    const r = s.importScenes(
      [withKey({ name: "No focus", narr: "still restorable", scale: 1.4, showProv: false, focusNode: null, anchors: [a!, b!], ordinal: 0 })],
      meta,
    );
    expect(r).toMatchObject({ imported: 1, skipped: 0 });
    const got = s.allScenes()[0]!;
    expect(got.focusNode).toBeNull();
    expect(got.anchors.length).toBe(2); // the scene still resolves — that is what makes it restorable
    expect(got.narr).toBe("still restorable");
    s.close();
  });

  it("two focus-less scenes over the SAME view are one scene (nothing left to distinguish them)", async () => {
    // Consequence worth stating: focus_node is in the content key to keep two scenes of one view distinct
    // when they differ only by panel selection. With no focus node there is nothing to differ by, so they
    // legitimately merge. This is why Brian's import reported "1 already present".
    const s = mkStore();
    const [a] = await nodes(s, 1);
    const one = withKey({ name: "Same", narr: null, scale: 1, showProv: false, focusNode: null, anchors: [a!], ordinal: 0 });
    const two = withKey({ name: "Same", narr: null, scale: 1, showProv: false, focusNode: null, anchors: [a!], ordinal: 1 });
    const r = s.importScenes([one, two], meta);
    expect(r).toMatchObject({ imported: 1, duplicates: 1 });
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
