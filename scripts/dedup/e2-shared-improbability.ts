/**
 * E2 proper (per-type floors) + Brian's observation, re-operationalized after the first attempt measured the
 * wrong thing.
 *
 * THE FIRST ATTEMPT WAS INVERTED, and it is worth writing down why. It scored a name by the rarity of its
 * tokens ACROSS THIS GRAPH'S ENTITY NAMES. In a corpus about a codebase, "get", "id", "graph" and "store"
 * appear in dozens of names while "software" appears in one — so the metric called
 * getIndexedIdFromGraphStore common (7.55) and Software rare (10.74), exactly backwards from what Brian
 * described. Corpus-internal document frequency is not general-language improbability.
 *
 * The re-reading of his claim, which is also a better claim: the confidence does not come from either name
 * on its own. It comes from the improbability of what the two names SHARE. Two names agreeing on 26
 * characters of getindexedidfromgraphstore cannot be a coincidence. Two names agreeing on "code" tells you
 * almost nothing. So the measure is the surprisal of the longest shared substring, scored against a
 * character model built from the corpus's own prose.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const db = new Database(process.argv[3] ?? "graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });

type Pair = { a: string; b: string; why: string };
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as { sets: Record<string, { pairs: Pair[] }> };
const e1 = JSON.parse(readFileSync(join(dir, "e1-representations.json"), "utf8")) as {
  raw_scores: Record<string, Record<string, number[]>>;
  report: Record<string, { floors: { zero_fp: number } }>;
};

const rows = db.prepare("SELECT id, subtype, name FROM nodes WHERE subtype NOT IN ('chunk','document')").all() as { id: string; subtype: string; name: string }[];
const byId = new Map(rows.map((r) => [r.id, r]));
const nm = (id: string): string => byId.get(id)?.name ?? "?";
const sub = (id: string): string => byId.get(id)?.subtype ?? "?";

// --- a character trigram model over the corpus's OWN prose ----------------------------------------------
// Background = the chunk texts. That is real English (plus code) as this corpus actually uses it, so it is a
// fairer "how surprising is this string" model than any word list, and it costs one query.
const bg = db.prepare("SELECT description FROM nodes WHERE subtype = 'chunk'").all() as { description: string }[];
const tri = new Map<string, number>();
let triTotal = 0;
for (const r of bg) {
  const s = ` ${r.description.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (let i = 0; i + 3 <= s.length; i++) { const g = s.slice(i, i + 3); tri.set(g, (tri.get(g) ?? 0) + 1); triTotal++; }
}
const V = tri.size;
/** Total bits to spell a string under the trigram model. Long improbable strings score high; "code" low. */
function bits(s: string): number {
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let b = 0;
  for (let i = 0; i + 3 <= t.length; i++) {
    const p = ((tri.get(t.slice(i, i + 3)) ?? 0) + 1) / (triTotal + V); // Laplace, so unseen trigrams are finite
    b += -Math.log2(p);
  }
  return b;
}
/** Longest common substring of the two stripped names — the thing the pair actually agrees on. */
function lcs(a: string, b: string): string {
  let best = "";
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagPrev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diagPrev + 1;
        if (prev[j]! > best.length) best = a.slice(i - prev[j]!, i);
      } else prev[j] = 0;
      diagPrev = tmp;
    }
  }
  return best;
}
const strip = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const sharedBits = (p: Pair): number => bits(lcs(strip(nm(p.a)), strip(nm(p.b))));

console.log("=== the metric, on Brian's own examples (shared-substring bits) ===");
const demo: [string, string][] = [
  ["getIndexedIdFromGraphStore", "get_indexed_id_from_graph_store"],
  ["Software", "Code"], ["Software", "software"], ["AGENT", "AGENT"],
];
for (const [a, b] of demo) console.log(`  ${(a + "  vs  " + b).padEnd(62)} shared="${lcs(strip(a), strip(b))}"  ${sharedBits({ a: "", b: "", why: "" } as Pair) === 0 ? "" : ""}${bits(lcs(strip(a), strip(b))).toFixed(1)} bits`);

// --- does it separate? -----------------------------------------------------------------------------------
const REP = "name";
const floor = e1.report[REP]!.floors.zero_fp;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pv = labels.sets["P-variant"]!.pairs.map((p, i) => ({ p, c: e1.raw_scores[REP]!["P-variant"]![i]!, s: sharedBits(p) }));
const nh = labels.sets["N-hard"]!.pairs.map((p, i) => ({ p, c: e1.raw_scores[REP]!["N-hard"]![i]!, s: sharedBits(p) }));

console.log("\n=== does shared-improbability separate true duplicates from confusable non-duplicates? ===");
console.log(`  P-variant (true dups)      n=${pv.length}  mean ${mean(pv.map((x) => x.s)).toFixed(1)} bits`);
console.log(`  N-hard (confusable, not)   n=${nh.length}  mean ${mean(nh.map((x) => x.s)).toFixed(1)} bits`);
console.log(`  P-variant CAUGHT by cosine n=${pv.filter((x) => x.c > floor).length}  mean ${mean(pv.filter((x) => x.c > floor).map((x) => x.s)).toFixed(1)} bits`);
console.log(`  P-variant MISSED by cosine n=${pv.filter((x) => x.c <= floor).length}  mean ${mean(pv.filter((x) => x.c <= floor).map((x) => x.s)).toFixed(1)} bits`);

console.log("\n  As a standalone gate (no cosine at all):");
console.log("  min bits   P-variant recall   N-hard admitted");
for (const g of [20, 40, 60, 80, 100, 140]) {
  const rec = pv.filter((x) => x.s >= g).length / pv.length;
  const adm = nh.filter((x) => x.s >= g).length;
  console.log(`   >= ${String(g).padEnd(8)} ${rec.toFixed(3).padEnd(18)} ${adm} of ${nh.length}`);
}

// --- E2 proper: does the zero-FP floor move by type? -----------------------------------------------------
// Registered question: "Does any single cosine floor work across types, or does the crossover move?"
// Decision rule: spread <= 0.03 -> one global floor defensible; over 0.03 -> per-type floors.
console.log("\n=== E2: per-type zero-FP floors (the registered question) ===");
const key = (p: Pair): string => [sub(p.a), sub(p.b)].sort().join("+");
const groups = new Map<string, number[]>();
for (const x of nh) { const k = key(x.p); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(x.c); }
const floors: { pairing: string; n: number; floor: number }[] = [];
for (const [k, cs] of groups) if (cs.length >= 20) floors.push({ pairing: k, n: cs.length, floor: Math.max(...cs) });
floors.sort((a, b) => b.floor - a.floor);
for (const f of floors) console.log(`  ${f.pairing.padEnd(26)} n=${String(f.n).padEnd(5)} floor=${f.floor.toFixed(4)}`);
const spread = floors.length ? floors[0]!.floor - floors[floors.length - 1]!.floor : NaN;
console.log(`  spread = ${spread.toFixed(4)}  -> registered rule: <= 0.03 means one global floor; over means PER-TYPE`);

// What does the global floor cost, and who sets it?
const top = nh.slice().sort((a, b) => b.c - a.c)[0]!;
console.log(`\n  the single pair setting the GLOBAL floor: "${nm(top.p.a)}" (${sub(top.p.a)}) vs "${nm(top.p.b)}" (${sub(top.p.b)}) at ${top.c.toFixed(4)}`);
const nonFile = nh.filter((x) => sub(x.p.a) !== "file" && sub(x.p.b) !== "file");
const floorNoFile = Math.max(...nonFile.map((x) => x.c));
const pvNoFile = pv.filter((x) => sub(x.p.a) !== "file" && sub(x.p.b) !== "file");
console.log(`  floor excluding 'file' entities: ${floorNoFile.toFixed(4)} (from ${nonFile.length} negatives)`);
console.log(`  P-variant recall for non-file pairs at THAT floor: ${(pvNoFile.filter((x) => x.c > floorNoFile).length / pvNoFile.length).toFixed(3)} (n=${pvNoFile.length})`);

writeFileSync(join(dir, "e2-floors.json"), JSON.stringify({
  analysis: "E2 per-type floors + shared-substring improbability (Brian's observation, re-operationalized)",
  representation: REP, global_floor: floor,
  per_type_floors: floors, spread,
  global_floor_setter: { a: nm(top.p.a), b: nm(top.p.b), cosine: top.c },
  excluding_file_subtype: { floor: floorNoFile, p_variant_recall: pvNoFile.filter((x) => x.c > floorNoFile).length / pvNoFile.length, n: pvNoFile.length },
  shared_bits: { p_variant_mean: mean(pv.map((x) => x.s)), n_hard_mean: mean(nh.map((x) => x.s)) },
}, null, 1));
db.close();
