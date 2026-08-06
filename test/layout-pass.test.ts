// The layout pass (design §3.3, §3.6, §10). The two tests that matter most here are COMPONENT COHESION and
// BRANCH REACHABILITY — a fallback-*rate* metric cannot tell a cohesive placement from a scattered one
// (both score ~0%), and a rule that never fires in production is the defect that survived three rewrites of
// the design. Both run under the shipped SEMANTIC_FLOOR, never a test override.
import { describe, it, expect } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { layoutPass } from "../src/layout/pass.js";
import { SEMANTIC_FLOOR } from "../src/layout/incremental.js";

const meta = { actor: "test", cause: "layout-pass" };
const mkStore = (): GraphStore => new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });

// StubEmbedder hashes tokens into distinct dims, so cosine = shared/total for equal-length token sets:
// 4 shared of 5 -> 0.80 (above the 0.75 floor), 3 of 5 -> 0.60 (below it).
const HI = (tag: string): string => `alpha beta gamma delta ${tag}`; // ~0.80 against another HI
const LO = (tag: string): string => `omega psi chi ${tag}`; // disjoint from HI -> ~0

async function addNode(s: GraphStore, text: string, name: string): Promise<string> {
  const n = await s.putNode({ type: "CONCEPT", origin: "ingest", text, name, description: name }, meta);
  return n.id;
}
async function addProv(s: GraphStore, sub: "chunk" | "document", tag: string): Promise<string> {
  const n = await s.putNode({ type: "SOURCE", subtype: sub, origin: "ingest", text: `${sub}\t${tag}`, name: tag, description: tag }, meta);
  return n.id;
}
async function link(s: GraphStore, a: string, b: string): Promise<void> {
  await s.putEdge({ from: a, to: b, kind: "RELATED", reason: `${a} relates to ${b}`, origin: "ingest" }, meta);
}

const bbox = (pts: Array<{ x: number; y: number }>) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const diag = (pts: Array<{ x: number; y: number }>): number => {
  const b = bbox(pts);
  return Math.hypot(b.w, b.h);
};
const posOf = (s: GraphStore, ids: string[]) => {
  const l = s.getLayout();
  return ids.map((id) => ({ x: l.get(id)!.x, y: l.get(id)!.y }));
};

/** An anchored map: one connected cluster of HI-vocabulary concepts, plus provenance that must stay unlaid. */
async function anchoredMap(s: GraphStore): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(await addNode(s, HI(`anchor${i}`), `anchor${i}`));
  for (let i = 1; i < ids.length; i++) await link(s, ids[i - 1]!, ids[i]!);
  await addProv(s, "document", "doc0");
  for (let i = 0; i < 4; i++) await addProv(s, "chunk", `chunk${i}`);
  await layoutPass(s, meta);
  return ids;
}

describe("layout pass — bootstrap and idempotence", () => {
  it("bootstraps every visible node and leaves provenance unlaid (§3.3 ∩ visible)", async () => {
    const s = mkStore();
    const ids = await anchoredMap(s);
    const layout = s.getLayout();
    for (const id of ids) expect(layout.has(id)).toBe(true);
    // the 5 provenance nodes must NOT have rows — that is slice 4's job, and doing it now would be
    // slice-4 geometry delivered in slice 1, with scenes not yet anchored
    expect(layout.size).toBe(ids.length);
    expect(s.nodesLackingLayout().length).toBe(5);
    s.close();
  });

  it("a second pass is a true no-op — nothing written, nothing logged", async () => {
    const s = mkStore();
    await anchoredMap(s);
    // @ts-expect-error — mutation_log volume IS the assertion
    const before = (s.db.prepare("SELECT count(*) AS n FROM mutation_log").get() as { n: number }).n;
    const r = await layoutPass(s, meta);
    expect(r.mode).toBe("noop");
    expect(r.written).toBe(0);
    // @ts-expect-error — same
    const after = (s.db.prepare("SELECT count(*) AS n FROM mutation_log").get() as { n: number }).n;
    expect(after).toBe(before);
    s.close();
  });

  it("is deterministic — same state, same positions, no Math.random anywhere", async () => {
    const build = async (): Promise<Array<{ x: number; y: number }>> => {
      const s = mkStore();
      const ids = await anchoredMap(s);
      const p = posOf(s, ids);
      s.close();
      return p;
    };
    expect(await build()).toEqual(await build());
  });
});

describe("layout pass — additive placement", () => {
  it("ANCHORED NODES NEVER MOVE when newcomers arrive (byte-identical, the F-2 guarantee)", async () => {
    const s = mkStore();
    const anchor = await anchoredMap(s);
    const before = s.getLayout();

    const n1 = await addNode(s, HI("newcomer1"), "newcomer1");
    const n2 = await addNode(s, HI("newcomer2"), "newcomer2");
    await link(s, n1, n2);
    await link(s, n1, anchor[0]!); // gives this component a graph anchor

    const r = await layoutPass(s, meta);
    expect(r.mode).toBe("incremental");
    expect(r.laidOut).toBe(2);

    const after = s.getLayout();
    for (const id of anchor) {
      expect(after.get(id)!.x).toBe(before.get(id)!.x); // byte-identical, not approximate
      expect(after.get(id)!.y).toBe(before.get(id)!.y);
      expect(after.get(id)!.version).toBe(before.get(id)!.version); // and no version churn
    }
    s.close();
  });

  it("THE RELAX ACTUALLY RUNS — deleting settleIncremental must fail a test", async () => {
    // Both reviewers predicted this mutation was untried, and they were right: removing the
    // settleIncremental call from pass.ts left all 15 tests green. The relax is §3.3 step 4 — the core of
    // the incremental placement — and nothing guarded it.
    //
    // Threshold measured, not guessed: springs pull chained neighbours toward rest=90, while the raw jitter
    // spiral packs them at ~18*sqrt(m+1). Mean nearest-neighbour distance, seeds-only vs relaxed:
    //   size  4 : 33.2 -> 103.8      size 12 : 30.3 -> 72.5      size 28 : 30.4 -> 72.4
    // 50 separates them at every size with margin on both sides.
    const s = mkStore();
    const anchor = await anchoredMap(s);
    const comp: string[] = [];
    for (let i = 0; i < 12; i++) comp.push(await addNode(s, HI(`relaxed${i}`), `relaxed${i}`));
    for (let i = 1; i < comp.length; i++) await link(s, comp[i - 1]!, comp[i]!);
    await link(s, comp[0]!, anchor[2]!);
    await layoutPass(s, meta);

    const pts = posOf(s, comp);
    const nn = pts.map((p, i) =>
      Math.min(...pts.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
    );
    const meanNN = nn.reduce((a, b) => a + b, 0) / nn.length;
    expect(meanNN).toBeGreaterThan(50); // un-relaxed seeds sit at ~30
    s.close();
  });

  it("SEED POLICY is policed PRE-RELAX — the component is placed as one thing", async () => {
    // Two failed attempts got here, both making the same mistake:
    //   1. an absolute post-relax threshold with no control — a scattered placement passed it too;
    //   2. a two-armed post-relax comparison whose "scatter" arm pre-wrote layout rows, which put those
    //      nodes in A, so layoutPass saw N = ∅ and no-opped. The scatter arm never relaxed. That is the
    //      SAME confound as the benchmark bug the reviewers caught, reproduced one level down.
    //
    // Post-relax shape cannot police seed policy: measured separation is 1.90x at size 4 but 1.05x at
    // sizes 12 and 28 — the relax washes the seed out. So assert the thing that IS determined by the
    // policy: before the relax, every member sits within the jitter spiral of ONE seedPoint.
    const s = mkStore();
    const anchor = await anchoredMap(s);
    const comp: string[] = [];
    for (let i = 0; i < 16; i++) comp.push(await addNode(s, HI(`seed${i}`), `seed${i}`));
    for (let i = 1; i < comp.length; i++) await link(s, comp[i - 1]!, comp[i]!);
    await link(s, comp[0]!, anchor[5]!);

    const r = await layoutPass(s, meta);
    expect(r.components).toBe(1);
    // jitter spiral bound: rho = 18*sqrt(m+1), so max radius is 18*sqrt(|C|)
    expect(r.preRelaxSpread).toBeLessThanOrEqual(18 * Math.sqrt(comp.length) + 1e-9);
    // and it is not trivially zero — the members really are spread within that disc, never coincident
    expect(r.preRelaxSpread).toBeGreaterThan(18);
    s.close();
  });

  it.skip("COMPONENT COHESION at realistic sizes — NO POST-RELAX METRIC WORKS (design §10)", () => {
    // Skipped, not deleted: the gap is real and should stay visible.
    //
    // CORRECTION. An earlier version of this note reported that the bbox criterion was INVERTED
    // (cohesive 513 vs scattered 351 at size 12). That was an artifact of my own benchmark: the scatter
    // arm wrote seed coordinates and never relaxed, so it compared relaxed-cohesive against
    // unrelaxed-scattered. Both cross-agent reviewers caught it independently. The comment in that harness
    // said "then relaxed" while the code did not — I read my comment instead of my code.
    //
    // Re-measured with BOTH arms relaxed (scripts/bench/cohesion-metric.mts), intra/inter ratio:
    //   size  4 : cohesive 0.53  scattered 1.02   -> 1.90x separation (real)
    //   size 12 : cohesive 1.17  scattered 1.22   -> 1.05x (none)
    //   size 28 : cohesive 1.25  scattered 1.32   -> 1.05x (none)
    //
    // So the inversion was false, but the conclusion survives in narrower form: post-relax geometry cannot
    // police seed policy above |C| ~= 4, because 500 iterations of gravity + springs converge to an
    // equilibrium that washes the seed out. Seed policy is therefore asserted PRE-relax (see the
    // "SEED POLICY is policed PRE-RELAX" test), which is what a reviewer recommended and what actually
    // discriminates.
    //
    // Still open: whether rule (c)'s peripheral park (r = 220 + 60j) means anything after the relax pulls
    // unlinked components ~200 units back toward the origin. If the product intent is that stranded
    // components STAY peripheral, that is a physics change (weaker gravity, fewer iterations, or a soft
    // pin), not a metric retune. Do not un-skip this until that is decided.
  });

  it("newcomers never coincide — the welding guard, end to end through the real pass", async () => {
    const s = mkStore();
    const anchor = await anchoredMap(s);
    const comp: string[] = [];
    for (let i = 0; i < 15; i++) comp.push(await addNode(s, HI(`m${i}`), `m${i}`));
    for (let i = 1; i < comp.length; i++) await link(s, comp[i - 1]!, comp[i]!);
    await link(s, comp[0]!, anchor[1]!);
    await layoutPass(s, meta);
    const pts = posOf(s, comp);
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(comp.length);
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    s.close();
  });
});

describe("layout pass — branch reachability under the SHIPPED constants", () => {
  it("all three seeding rules fire, with SEMANTIC_FLOOR at its production value", async () => {
    // The design's own history: a floor of 0.60 sat below every observed cosine, so rule (c) was
    // unreachable dead code while a fixture-based test could still force it green. This asserts the rules
    // under the real constant instead.
    expect(SEMANTIC_FLOOR).toBe(0.75);
    const s = mkStore();
    const anchor = await anchoredMap(s);

    // (a) graph anchor — an edge into the anchored field
    const a1 = await addNode(s, LO("graphAnchored"), "graphAnchored");
    await link(s, a1, anchor[0]!);

    // (b) semantic anchor — no edge, but HI vocabulary => cosine ~0.80 >= 0.75 against the anchored cluster
    const b1 = await addNode(s, HI("semanticOnly"), "semanticOnly");

    // (c) map seed — no edge, disjoint vocabulary => best cosine ~0 < 0.75
    const c1 = await addNode(s, LO("strandedAlone"), "strandedAlone");

    const r = await layoutPass(s, meta);
    expect(r.byRule.graph).toBeGreaterThanOrEqual(1);
    expect(r.byRule.semantic).toBeGreaterThanOrEqual(1);
    expect(r.byRule.map).toBeGreaterThanOrEqual(1);
    expect([a1, b1, c1].every((id) => s.getLayout().has(id))).toBe(true);
    s.close();
  });

  it("a semantically-close component is seeded NEAR its match, not out in open space", async () => {
    const s = mkStore();
    const anchor = await anchoredMap(s);
    const anchorPts = posOf(s, anchor);
    const centre = {
      x: anchorPts.reduce((t, p) => t + p.x, 0) / anchorPts.length,
      y: anchorPts.reduce((t, p) => t + p.y, 0) / anchorPts.length,
    };
    const near = await addNode(s, HI("semanticNear"), "semanticNear");
    const far = await addNode(s, LO("semanticFar"), "semanticFar");
    const r = await layoutPass(s, meta);
    expect(r.byRule.semantic).toBeGreaterThanOrEqual(1);
    expect(r.byRule.map).toBeGreaterThanOrEqual(1);

    const l = s.getLayout();
    const dNear = Math.hypot(l.get(near)!.x - centre.x, l.get(near)!.y - centre.y);
    const dFar = Math.hypot(l.get(far)!.x - centre.x, l.get(far)!.y - centre.y);
    expect(dNear).toBeLessThan(dFar); // the semantic hit lands closer than the stranded one
    s.close();
  });
});
