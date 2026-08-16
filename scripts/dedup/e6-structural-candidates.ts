/**
 * E6 — structural candidate mining. Step 2 of `docs/dedup-plan.md`, and the thing that unblocks everything
 * above Layer 1.
 *
 * WHY THIS EXISTS, in one sentence from the plan: *"every labeled positive we hold is a string match, and
 * string matches need no model at all."* E0's four label sets were all built by string rules, so any feature
 * measured against them is graded by its own definition — the retraction of 2026-08-09 already cost this
 * project one cross-validated 1.000 that meant nothing. A candidate set the string features CANNOT SEE is
 * the only way out, and structure is the cheapest such mechanism: zero LLM calls, pure SQL plus set algebra.
 *
 * TWO CHANNELS, KEPT SEPARATE. They are evidence of different things and fusing them would repeat the
 * mistake Layer 2 was written to avoid.
 *
 *   - CO-OCCURRENCE (APPEARED_IN): the two entities were extracted from the same chunks. Note honestly that
 *     this is primarily evidence of RELATEDNESS, not sameness — a writer usually uses one name per chunk, so
 *     two names in one chunk are more often two things than one thing. That is a feature here, not a bug:
 *     the experiment this feeds asks a second question ("are they related, and if so how?"), so a candidate
 *     set rich in related-but-distinct pairs supplies that question's positives and this question's hard
 *     negatives at the same time.
 *   - SHARED NEIGHBOURS (RELATED): the two entities point at the same other entities. This is the channel
 *     that can actually indicate sameness across documents, because a duplicate inherits its original's
 *     neighbourhood. It is also the thinner of the two: median degree on this fixture is 1.
 *
 * FOUR LEXICAL STRATA, recorded per pair and never averaged together. The whole point is to know which
 * population a number came from:
 *
 *   identical   — strip(norm(a)) === strip(norm(b)). Layer 1's territory. EXCLUDED from the output entirely;
 *                 a string rule already resolves these for free and including them would re-contaminate the
 *                 label set exactly as before.
 *   containment — one stripped name contains the other ("Brian" / "Brian Brewington"). The protocol's own
 *                 example of the residue.
 *   token       — share at least one normalized token, neither contains the other.
 *   disjoint    — share no token at all. THIS IS THE NEVER-MEASURED POPULATION and the reason for the run.
 *
 * WRITES NOTHING. Read-only over graph.db; one JSON sidecar. No thresholds are baked in: raw counts and the
 * per-level histograms are emitted so a candidate budget can be chosen from the distribution rather than
 * guessed ahead of it.
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stratumOf, type Stratum } from "./lexical.js";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const dbPath = process.argv[3] ?? "graphs/testgraph/graph.db";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// ---------------------------------------------------------------------------------------------------------
// entities — the same population E0 counted (2055 total minus chunks and documents = 1714 on this fixture)
// ---------------------------------------------------------------------------------------------------------
type Row = { id: string; name: string; subtype: string; description: string | null };
const rows = db
  .prepare(
    `SELECT id, COALESCE(name, text) AS name, COALESCE(subtype,'other') AS subtype, description
       FROM nodes WHERE COALESCE(subtype,'other') NOT IN ('chunk','document')
      ORDER BY id`,
  )
  .all() as Row[];
const byId = new Map(rows.map((r) => [r.id, r]));

const stratum = (a: string, b: string): Stratum => stratumOf(byId.get(a)!.name, byId.get(b)!.name);

// ---------------------------------------------------------------------------------------------------------
// channel 1 — chunk co-occurrence, via an inverted index rather than all-pairs (1714 entities is 1.47M pairs)
// ---------------------------------------------------------------------------------------------------------
const appeared = db
  .prepare(`SELECT from_id AS e, to_id AS c FROM edges WHERE kind='APPEARED_IN' ORDER BY from_id, to_id`)
  .all() as { e: string; c: string }[];
const chunkMembers = new Map<string, string[]>();
for (const { e, c } of appeared) {
  if (!byId.has(e)) continue;
  if (!chunkMembers.has(c)) chunkMembers.set(c, []);
  chunkMembers.get(c)!.push(e);
}

const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
type Sig = { chunks: number; chunkWeight: number; neighbours: number; related: boolean };
const sig = new Map<string, Sig>();
const get = (a: string, b: string): Sig => {
  const k = key(a, b);
  let s = sig.get(k);
  if (!s) { s = { chunks: 0, chunkWeight: 0, neighbours: 0, related: false }; sig.set(k, s); }
  return s;
};

for (const [, members] of chunkMembers) {
  const uniq = [...new Set(members)];
  // A crowded chunk is weak evidence: co-occurring in a 20-entity chunk means much less than co-occurring in
  // a 3-entity one. Raw count stays the primary number; this weight is recorded alongside so a budget can be
  // set on either without re-mining.
  const w = uniq.length > 1 ? 1 / (uniq.length - 1) : 0;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const s = get(uniq[i]!, uniq[j]!);
      s.chunks++;
      s.chunkWeight += w;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// channel 2 — shared RELATED neighbours. Undirected: an edge's direction is an extraction artefact here.
// ---------------------------------------------------------------------------------------------------------
const relEdges = db
  .prepare(`SELECT from_id AS a, to_id AS b FROM edges WHERE kind='RELATED' ORDER BY from_id, to_id`)
  .all() as { a: string; b: string }[];
const nbr = new Map<string, Set<string>>();
const addN = (x: string, y: string) => {
  if (!byId.has(x) || !byId.has(y)) return;
  if (!nbr.has(x)) nbr.set(x, new Set());
  nbr.get(x)!.add(y);
};
const directlyRelated: [string, string][] = [];
for (const { a, b } of relEdges) {
  addN(a, b);
  addN(b, a);
  if (byId.has(a) && byId.has(b) && a !== b) directlyRelated.push([a, b]); // a self-loop shares itself with itself
}
// For each shared neighbour n, every pair of n's neighbours shares it.
let starsSkipped = 0, hubMaxDegree = 0;
for (const [, set] of nbr) {
  const ns = [...set];
  hubMaxDegree = Math.max(hubMaxDegree, ns.length);
  // A 200+ hub says nothing about any pair inside it. The skip is now COUNTED rather than silent: measured
  // on testgraph the max RELATED degree is 35, so the cutoff drops nothing today and a reader has no way to
  // know that from the report. If a future corpus grows a real hub, this number is how anyone finds out.
  if (ns.length > 200) { starsSkipped++; continue; }
  if (ns.length < 2) continue;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) get(ns[i]!, ns[j]!).neighbours++;
  }
}
/**
 * A directly-RELATED pair is a candidate in its own right, not merely an annotation on one.
 *
 * The old line only *flagged* keys the two channels had already created. On this fixture that happened to
 * cover all 1239 RELATED pairs — a relation is extracted from a chunk where both endpoints appear, so the
 * co-occurrence channel picks it up — but the code did not guarantee it, and the failure is nasty: a pair
 * whose only evidence is `A RELATED B`, with no shared chunk and no shared third node, would be absent from
 * the candidate file, which is exactly what E7 reads as "zero structural signal" when drawing its FLOOR
 * control. `SUPPORTS`/`REFUTES` could have been scored as a random pair, and any model that named their
 * relation would have been charged with inventing edges. Using get() here mints the pair if it is missing.
 * Caught by cross-agent review (Grok 4.6, 2026-08-16).
 */
for (const [a, b] of directlyRelated) get(a, b).related = true;

// ---------------------------------------------------------------------------------------------------------
// assemble, stratify, report
// ---------------------------------------------------------------------------------------------------------
type Cand = {
  a: string; b: string;
  aName: string; bName: string;
  aSubtype: string; bSubtype: string;
  stratum: Stratum;
  chunks: number; chunkWeight: number; neighbours: number; related: boolean;
};
const cands: Cand[] = [];
let identicalDropped = 0;
for (const [k, s] of sig) {
  const [a, b] = k.split("|") as [string, string];
  const st = stratum(a, b);
  if (st === "identical") { identicalDropped++; continue; } // Layer 1 owns these
  const ra = byId.get(a)!, rb = byId.get(b)!;
  cands.push({
    a, b,
    aName: ra.name, bName: rb.name,
    aSubtype: ra.subtype, bSubtype: rb.subtype,
    stratum: st,
    chunks: s.chunks, chunkWeight: Number(s.chunkWeight.toFixed(4)), neighbours: s.neighbours, related: s.related,
  });
}

const strata: Stratum[] = ["containment", "token", "disjoint"];
const hist = (pick: (c: Cand) => number) => {
  const out: Record<string, Record<string, number>> = {};
  for (const st of strata) {
    const rowOut: Record<string, number> = {};
    for (const lvl of [1, 2, 3, 5, 10]) rowOut[`>=${lvl}`] = cands.filter((c) => c.stratum === st && pick(c) >= lvl).length;
    out[st] = rowOut;
  }
  return out;
};

const report = {
  experiment: "E6",
  plan: "docs/dedup-plan.md step 2 — structural candidate mining",
  db: dbPath,
  entities: rows.length,
  appeared_in_edges: appeared.length,
  related_edges: relEdges.length,
  pairs_with_any_signal: cands.length,
  identical_pairs_dropped_to_layer1: identicalDropped,
  by_stratum: Object.fromEntries(strata.map((st) => [st, cands.filter((c) => c.stratum === st).length])),
  directly_related_pairs: cands.filter((c) => c.related).length,
  hub_max_related_degree: hubMaxDegree,
  hub_stars_skipped: starsSkipped,
  co_occurrence_histogram: hist((c) => c.chunks),
  shared_neighbour_histogram: hist((c) => c.neighbours),
  // the money cell: pairs that share structure but no lexical overlap at all, and are not already an edge
  disjoint_unrelated: {
    chunks_ge2: cands.filter((c) => c.stratum === "disjoint" && !c.related && c.chunks >= 2).length,
    neighbours_ge2: cands.filter((c) => c.stratum === "disjoint" && !c.related && c.neighbours >= 2).length,
  },
};

writeFileSync(join(dir, "e6-candidates.json"), JSON.stringify({ report, candidates: cands }, null, 1));
console.log(JSON.stringify(report, null, 2));
console.log(`\nwrote ${cands.length} candidates to ${join(dir, "e6-candidates.json")}`);
