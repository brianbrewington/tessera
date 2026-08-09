/**
 * E2-adjacent analysis, zero new compute, over E1's existing sidecar. Three questions:
 *
 *  (1) Which P-jitter pair did the human reject, and is the protocol's exclusion rule the reason?
 *  (2) Do the pairs that SET E1's zero-FP floor actually look like duplicates? This is the single biggest
 *      threat to E1's headline: the floor is max(N-hard cosine), so ONE mislabeled negative at the top of
 *      that distribution silently depresses every recall number in the table.
 *  (3) Brian's observation, made testable: "the more unusual the name, the faster I click same with
 *      confidence. Easy: getIndexedIdFromGraphStore vs get_indexed_id_from_graph_store. Hard: Software vs
 *      Code." If name-surprisal predicts where name-only matching succeeds, it is not a curiosity — it is a
 *      free confidence signal that says which merges need a verifier and which do not.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const db = new Database(process.argv[3] ?? "graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });

type Pair = { a: string; b: string; why: string };
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as {
  audit_key: { qid: string; set: string }[];
  sets: Record<string, { pairs: Pair[] }>;
};
const e1 = JSON.parse(readFileSync(join(dir, "e1-representations.json"), "utf8")) as {
  raw_scores: Record<string, Record<string, number[]>>;
  report: Record<string, { floors: { zero_fp: number } }>;
};
const answers = (JSON.parse(readFileSync(join(dir, "audit-answers.json"), "utf8")) as { answers: Record<string, string> }).answers;

const rows = db.prepare("SELECT id, subtype, name FROM nodes WHERE subtype NOT IN ('chunk','document')").all() as { id: string; subtype: string; name: string }[];
const byId = new Map(rows.map((r) => [r.id, r]));
const nm = (id: string): string => byId.get(id)?.name ?? "?";
const st = (id: string): string => byId.get(id)?.subtype ?? "?";

// The qid is sha16("<set>:<a>:<b>").slice(0,8) — recompute it to join answers back to pairs.
const { createHash } = await import("node:crypto");
const qidOf = (set: string, p: Pair): string => createHash("sha256").update(`${set}:${p.a}:${p.b}`).digest("hex").slice(0, 8);

console.log("=== (1) the one rejected P-jitter pair ===");
for (const set of ["P-jitter", "P-variant"]) {
  for (const p of labels.sets[set]!.pairs) {
    const q = qidOf(set, p);
    if (answers[q] === "not-same") {
      console.log(`  ${set}: "${nm(p.a)}" (${st(p.a)})  vs  "${nm(p.b)}" (${st(p.b)})`);
    }
  }
}

// --- (2) the floor-setters ------------------------------------------------------------------------------
console.log("\n=== (2) the N-hard pairs that SET the zero-FP floor, under name-only ===");
console.log("    (if any of these is really a duplicate, the floor is too high and 0.846 is an UNDERestimate)");
const REP = "name";
const nHardPairs = labels.sets["N-hard"]!.pairs;
const nHardScores = e1.raw_scores[REP]!["N-hard"]!;
const ranked = nHardPairs.map((p, i) => ({ p, c: nHardScores[i]! })).sort((x, y) => y.c - x.c);
for (const { p, c } of ranked.slice(0, 8)) {
  const q = qidOf("N-hard", p);
  const judged = answers[q] ? `  [AUDITED: ${answers[q]}]` : "";
  console.log(`  ${c.toFixed(4)}  "${nm(p.a)}" (${st(p.a)})  vs  "${nm(p.b)}" (${st(p.b)})${judged}`);
}

// --- (3) name-surprisal ---------------------------------------------------------------------------------
// Surprisal of a name = summed -log2(token frequency) over its tokens, against the frequency of those tokens
// across all 1714 entity names. A name made of rare tokens scores high; one made of "software", "code",
// "system" scores low. Length-normalized so a long generic name does not beat a short distinctive one.
const tokenize = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // split camelCase, so getIndexedId -> get Indexed Id
   .toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
const df = new Map<string, number>();
for (const r of rows) for (const t of new Set(tokenize(r.name))) df.set(t, (df.get(t) ?? 0) + 1);
const N = rows.length;
const surprisal = (name: string): number => {
  const ts = tokenize(name);
  if (!ts.length) return 0;
  return ts.reduce((a, t) => a + Math.log2(N / (df.get(t) ?? 1)), 0) / ts.length; // mean bits per token
};
// A pair's surprisal is the MIN of its two names: the pair is only as distinctive as its least distinctive
// side, which is what makes "Software vs Code" hard even though both are real names.
const pairSurprisal = (p: Pair): number => Math.min(surprisal(nm(p.a)), surprisal(nm(p.b)));

const floor = e1.report[REP]!.floors.zero_fp;
const pv = labels.sets["P-variant"]!.pairs.map((p, i) => ({ p, c: e1.raw_scores[REP]!["P-variant"]![i]!, s: pairSurprisal(p) }));
const caught = pv.filter((x) => x.c > floor), missed = pv.filter((x) => x.c <= floor);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

console.log("\n=== (3) does name-surprisal predict where name-only WORKS? ===");
console.log(`  P-variant caught at the zero-FP floor: n=${caught.length}, mean surprisal ${mean(caught.map((x) => x.s)).toFixed(2)} bits/token`);
console.log(`  P-variant MISSED:                      n=${missed.length}, mean surprisal ${mean(missed.map((x) => x.s)).toFixed(2)} bits/token`);
console.log(`  N-hard (should be rejected):           n=${nHardPairs.length}, mean surprisal ${mean(nHardPairs.map((p) => pairSurprisal(p))).toFixed(2)} bits/token`);

// The operational form of the question: if we only auto-trust HIGH-surprisal pairs, what do we get?
console.log("\n  If surprisal gates which matches are trusted without a verifier:");
console.log("  min bits   P-variant recall   N-hard admitted   (both at the SAME cosine floor)");
for (const gate of [0, 4, 6, 8, 10, 12]) {
  const pvG = pv.filter((x) => x.s >= gate);
  const nhG = nHardPairs.map((p, i) => ({ s: pairSurprisal(p), c: nHardScores[i]! })).filter((x) => x.s >= gate);
  const rec = pvG.length ? pvG.filter((x) => x.c > floor).length / pvG.length : NaN;
  const adm = nhG.filter((x) => x.c > floor).length;
  console.log(`   >= ${String(gate).padEnd(8)} ${(pvG.length ? rec.toFixed(3) : " n/a ").padEnd(18)} ${String(adm).padEnd(17)} (n=${pvG.length} pos, ${nhG.length} neg)`);
}

console.log("\n  Brian's own examples, scored:");
for (const n of ["getIndexedIdFromGraphStore", "get_indexed_id_from_graph_store", "Software", "Code", "Grandmother", "tessera"])
  console.log(`    ${n.padEnd(34)} ${surprisal(n).toFixed(2)} bits/token`);

writeFileSync(join(dir, "e2-surprisal.json"), JSON.stringify({
  analysis: "E2-adjacent: name-surprisal as a confidence signal (Brian's observation, 2026-08-08)",
  representation: REP, zero_fp_floor: floor,
  caught: { n: caught.length, mean_surprisal: mean(caught.map((x) => x.s)) },
  missed: { n: missed.length, mean_surprisal: mean(missed.map((x) => x.s)), pairs: missed.map((x) => ({ a: nm(x.p.a), b: nm(x.p.b), cosine: x.c, surprisal: x.s })) },
  floor_setters: ranked.slice(0, 8).map(({ p, c }) => ({ a: nm(p.a), b: nm(p.b), cosine: c, audited: answers[qidOf("N-hard", p)] ?? null })),
}, null, 1));
db.close();
