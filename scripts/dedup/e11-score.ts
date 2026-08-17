/**
 * E11 scoring — metrics 3 and 4 over the arms' sidecar. Protocol §E11 + amendments; run after the arms.
 *
 * METRIC 3 — novel-entity suppression (0051's "quiet killer"): for each chunk, the entities arm A found
 * whose strip-form was NOT on arm C's offered list at that point are the chunk's NOVEL entities. If C (or B)
 * fails to extract a strip-equal entity in the same chunk, the novel entity was suppressed. Reported
 * per-chunk (the registered independent unit), as mean suppression rate over chunks that had novel entities.
 *
 * METRIC 4 — false merges, split per the 0057 amendment:
 *   CORE: the ~6 named collisions. Scoring is mention-table + audit: this script emits, per arm per core
 *   surface, every (chunk, raw form, type, nodeId) mention so the distinct-meanings-one-node judgment is
 *   made against evidence rather than asserted. Any core merge disqualifies the arm.
 *   EXTENDED: n≥60 hard negatives mined MECHANICALLY with a provenance rule — a containment pair (strip-
 *   distinct, one contains the other) whose two members were co-extracted as separate entities IN THE SAME
 *   CHUNK by arm A. The extractor's own same-breath witness is the distinctness evidence; no human labels,
 *   no judgment of mine. An arm false-merges the pair if its records map both members to one nodeId.
 *   Zero events at n≥60 bounds the rate under ~5% (rule of three), which is what "clean" is allowed to mean.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripName } from "./lexical.js";

const dir = process.argv[2] ?? "graphs/comms/dedup";
const d = JSON.parse(readFileSync(join(dir, "e11-injection.json"), "utf8"));

interface Ent { raw: string; type: string; canonical: string; nodeId: string | null; offered: boolean }
interface ChunkRes { chunk: string; offered: string[]; entities: Ent[]; relations: unknown[]; parse_failed: boolean }
const arms: Record<string, ChunkRes[]> = Object.fromEntries(
  Object.entries(d.arms as Record<string, { per_chunk: ChunkRes[] }>).map(([k, v]) => [k, v.per_chunk]),
);
const A = arms.A!, B = arms.B, C = arms.C, A2 = arms.A2;

// --- metric 3: suppression -------------------------------------------------------------------------------
function suppression(target: ChunkRes[]): { mean_rate: number | null; chunks_with_novel: number; suppressed_examples: string[] } {
  const rates: number[] = [];
  const examples: string[] = [];
  for (let i = 0; i < A.length; i++) {
    const a = A[i]!, t = target[i]!;
    if (a.parse_failed || t.parse_failed) continue;
    const offeredStrip = new Set((t.offered ?? []).map(stripName));
    const novel = a.entities.filter((e) => !offeredStrip.has(stripName(e.raw)));
    if (!novel.length) continue;
    const tStrip = new Set(t.entities.map((e) => stripName(e.raw)));
    const missed = novel.filter((e) => !tStrip.has(stripName(e.raw)));
    rates.push(missed.length / novel.length);
    for (const m of missed.slice(0, 2)) examples.push(`${a.chunk}: "${m.raw}"`);
  }
  return { mean_rate: rates.length ? rates.reduce((x, y) => x + y, 0) / rates.length : null, chunks_with_novel: rates.length, suppressed_examples: examples.slice(0, 12) };
}

// Baseline extraction churn: A-vs-A comparison is impossible (one run), so report B/C suppression alongside
// the A-entity count they were tested against; interpretation carries the churn caveat in the writeup.

// --- metric 4 CORE: mention tables for audit -------------------------------------------------------------
const CORE = (d.core_collisions as { surface: string }[]).map((c) => c.surface);
function coreTable(armName: string, rows: ChunkRes[]): Record<string, { chunk: string; raw: string; type: string; nodeId: string | null }[]> {
  const out: Record<string, { chunk: string; raw: string; type: string; nodeId: string | null }[]> = {};
  for (const surface of CORE) {
    const ss = stripName(surface);
    const mentions = rows.flatMap((r) => r.entities.filter((e) => stripName(e.raw) === ss || stripName(e.raw).includes(ss) && ss.length >= 5)
      .map((e) => ({ chunk: r.chunk, raw: e.raw, type: e.type, nodeId: e.nodeId })));
    if (mentions.length) out[surface] = mentions;
  }
  return out;
}

// --- metric 4 EXTENDED: same-chunk co-extraction as the distinctness witness -----------------------------
interface HardNeg { small: string; big: string; witness_chunk: string }
function mineExtended(): HardNeg[] {
  // Widened same-chunk → same-MESSAGE after the first pass mined only n=7 (0/7 bounds at 43%, ruled
  // worthless by the 0057 amendment). Provenance witness unchanged in kind: the extractor produced both
  // members as SEPARATE entities within one document's context, which is its own testimony of distinctness.
  const byMsg = new Map<string, Ent[]>();
  for (const r of A) {
    if (r.parse_failed) continue;
    const msg = / of (\S+)/.exec(r.chunk)?.[1] ?? r.chunk;
    if (!byMsg.has(msg)) byMsg.set(msg, []);
    byMsg.get(msg)!.push(...r.entities);
  }
  const pairs = new Map<string, HardNeg>();
  for (const [msg, es] of byMsg) {
    void msg;
    for (let i = 0; i < es.length; i++) for (let j = 0; j < es.length; j++) {
      if (i === j) continue;
      const si = stripName(es[i]!.raw), sj = stripName(es[j]!.raw);
      if (si.length >= 4 && sj.length > si.length && sj.includes(si)) {
        const key = `${si}|${sj}`;
        if (!pairs.has(key)) pairs.set(key, { small: es[i]!.raw, big: es[j]!.raw, witness_chunk: "same-message" });
      }
    }
  }
  return [...pairs.values()];
}

function extendedFalseMerges(rows: ChunkRes[], set: HardNeg[]): { n: number; merges: HardNeg[]; bound: string } {
  // an arm false-merges (small, big) if any of its records map BOTH raws (strip-forms) to ONE nodeId
  const nodeOf = new Map<string, Set<string>>(); // strip(raw) -> nodeIds seen
  for (const r of rows) for (const e of r.entities) {
    if (!e.nodeId) continue;
    const s = stripName(e.raw);
    if (!nodeOf.has(s)) nodeOf.set(s, new Set());
    nodeOf.get(s)!.add(e.nodeId);
  }
  const merges = set.filter((p) => {
    const a = nodeOf.get(stripName(p.small)), b = nodeOf.get(stripName(p.big));
    if (!a || !b) return false;
    for (const id of a) if (b.has(id)) return true;
    return false;
  });
  const bound = merges.length === 0 ? `0/${set.length} → rate < ${(300 / Math.max(1, set.length)).toFixed(1)}% (rule of three)` : `${merges.length}/${set.length}`;
  return { n: set.length, merges, bound };
}

const extendedSet = mineExtended();
// THE CHURN FLOOR (E4's spine, added after the first scoring pass ran without it): A2 is a second
// no-injection run, so suppression(A2) measures pure run-to-run extraction churn — entities A found that a
// SECOND IDENTICAL RUN did not. Only the EXCESS of an injection arm's rate over this floor is attributable
// to injection. Without it the first pass read ~58% for both arms, which smelled like churn and was.
const floor = A2 ? suppression(A2) : null;
const excess = (r: { mean_rate: number | null } | null) =>
  r?.mean_rate != null && floor?.mean_rate != null ? +(r.mean_rate - floor.mean_rate).toFixed(4) : null;
const supB = B ? suppression(B) : null, supC = C ? suppression(C) : null;
const report = {
  metric3_suppression: {
    churn_floor_A_vs_A2: floor,
    B: supB, C: supC,
    B_excess_over_floor: excess(supB), C_excess_over_floor: excess(supC),
  },
  metric4_core_mention_tables: { A: coreTable("A", A), B: B ? coreTable("B", B) : null, C: C ? coreTable("C", C) : null },
  metric4_extended: {
    mining_rule: "containment pair co-extracted as SEPARATE entities in one chunk by arm A (the extractor's same-breath witness)",
    n: extendedSet.length,
    set: extendedSet,
    A: extendedFalseMerges(A, extendedSet),
    B: B ? extendedFalseMerges(B, extendedSet) : null,
    C: C ? extendedFalseMerges(C, extendedSet) : null,
  },
};
writeFileSync(join(dir, "e11-score.json"), JSON.stringify(report, null, 1));
console.log("metric 3 (suppression):", JSON.stringify(report.metric3_suppression, (k, v) => k === "suppressed_examples" ? undefined : v));
console.log("metric 4 extended: n=" + extendedSet.length,
  "A:", report.metric4_extended.A.bound, "| B:", report.metric4_extended.B?.bound, "| C:", report.metric4_extended.C?.bound);
console.log("core mention tables written for audit → e11-score.json");
