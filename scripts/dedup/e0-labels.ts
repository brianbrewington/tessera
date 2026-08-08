/**
 * E0 — freeze the label sets and bound contamination.
 * Protocol: docs/dedup-experiment-protocol.md, section E0. Pre-registered; nothing here is tuned after
 * seeing a result.
 *
 * THE STANDING ORDER, and it is enforced structurally rather than by intention: testgraph is the tuning
 * corpus and is NEVER written. The database is opened `readonly: true`, so a stray INSERT throws instead of
 * landing. Brian: "We have a giant test corpus to tune on now! So, don't get in a hurry to de-dupe it."
 *
 * Output: graphs/testgraph/dedup/labels.json (a sidecar; the graph is untouched) plus audit-sample.json,
 * the 40 blind pairs for the human audit.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- the entity population, and the trap in defining it ------------------------------------------------
//
// `type != 'SOURCE'` is the obvious filter and it is WRONG. It returns 1604 and silently drops 110 nodes of
// subtype `file` — `persona.ts`, `analysis/entity_resolution.py` — which are model-EXTRACTED entities with
// model-written descriptions that the mapper happens to type as SOURCE. They are exactly the kind of thing
// this experiment is about (a path named two ways in two chunks), so dropping them would bias every set
// toward the easy cases. The honest population is "everything that is not provenance plumbing": total minus
// chunks minus documents = 1714, which is the number the protocol registered.
const ENTITY_WHERE = "subtype NOT IN ('chunk','document')";

const norm = (s: string): string => s.trim().toLowerCase(); // matches src/extract/identity.ts exactly
const strip = (s: string): string => norm(s).replace(/[^a-z0-9]/g, "");
const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Deterministic RNG. The seed is recorded in the sidecar so any sampling here is reproducible by anyone. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

type Row = { id: string; type: string; subtype: string; name: string; description: string };
type Pair = { a: string; b: string; why: string };

const SEED = 20260808;
const dbPath = process.argv[2] ?? "graphs/testgraph/graph.db";
const outDir = process.argv[3] ?? "graphs/testgraph/dedup";

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rand = rng(SEED);

const rows = db.prepare(`SELECT id, type, subtype, name, description FROM nodes WHERE ${ENTITY_WHERE}`).all() as Row[];
const byId = new Map(rows.map((r) => [r.id, r]));

// Which document(s) each entity came from: entity -APPEARED_IN-> chunk -ORIGINATED_FROM-> document.
// Verified directions, not assumed: APPEARED_IN's to-side is 100% chunks, ORIGINATED_FROM's to-side is 100%
// documents.
const docsOf = new Map<string, Set<string>>();
for (const r of db.prepare(`
  SELECT ai.from_id AS ent, orf.to_id AS doc
  FROM edges ai JOIN edges orf ON orf.from_id = ai.to_id AND orf.kind = 'ORIGINATED_FROM'
  WHERE ai.kind = 'APPEARED_IN'`).all() as { ent: string; doc: string }[]) {
  if (!docsOf.has(r.ent)) docsOf.set(r.ent, new Set());
  docsOf.get(r.ent)!.add(r.doc);
}

// --- P-jitter: same normalized name, different subtype -------------------------------------------------
// The registered exclusion: any group containing person, place or event, where a genuine sense-split is
// plausible (mother; de doorns; klipgat farm). Excluded groups are LISTED in the sidecar, never silently
// dropped — a hidden exclusion is a tuned result.
const EXCLUDED_SUBTYPES = new Set(["person", "place", "event"]);
const byNorm = new Map<string, Row[]>();
for (const r of rows) {
  const k = norm(r.name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k)!.push(r);
}
const jitterGroups: { key: string; ids: string[]; subtypes: string[] }[] = [];
const excludedGroups: { key: string; ids: string[]; subtypes: string[]; reason: string }[] = [];
for (const [k, g] of byNorm) {
  const subs = [...new Set(g.map((x) => x.subtype))];
  if (subs.length < 2) continue;
  const rec = { key: k, ids: g.map((x) => x.id), subtypes: subs };
  if (subs.some((s) => EXCLUDED_SUBTYPES.has(s))) excludedGroups.push({ ...rec, reason: "contains person/place/event" });
  else jitterGroups.push(rec);
}
const pJitter: Pair[] = [];
for (const g of jitterGroups) {
  for (let i = 0; i < g.ids.length; i++) {
    for (let j = i + 1; j < g.ids.length; j++) {
      if (byId.get(g.ids[i]!)!.subtype === byId.get(g.ids[j]!)!.subtype) continue; // cross-type pairs only
      pJitter.push({ a: g.ids[i]!, b: g.ids[j]!, why: `type jitter on "${g.key}"` });
    }
  }
}

// --- P-variant: distinct normalized names, identical after stripping -----------------------------------
const byStrip = new Map<string, Row[]>();
for (const r of rows) {
  const k = strip(r.name);
  if (!k) continue;
  if (!byStrip.has(k)) byStrip.set(k, []);
  byStrip.get(k)!.push(r);
}
const pVariant: Pair[] = [];
const variantGroups: { key: string; ids: string[]; names: string[] }[] = [];
for (const [k, g] of byStrip) {
  const distinct = [...new Set(g.map((x) => norm(x.name)))];
  if (distinct.length < 2) continue; // pure type jitter, already counted above
  variantGroups.push({ key: k, ids: g.map((x) => x.id), names: distinct });
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      if (norm(g[i]!.name) === norm(g[j]!.name)) continue; // that is jitter, not variance
      pVariant.push({ a: g[i]!.id, b: g[j]!.id, why: `strip-variant "${g[i]!.name}" / "${g[j]!.name}"` });
    }
  }
}

// --- N-hard: RELATED-joined, no strip containment ------------------------------------------------------
// The control that stands in for the ANN-at-0.85 incident (92 entities swallowed). These are guaranteed
// confusable — the extractor asserted a relation between them — and almost guaranteed distinct.
const contains = (x: string, y: string): boolean => x.includes(y) || y.includes(x);
const nHardAll: Pair[] = [];
for (const e of db.prepare("SELECT from_id a, to_id b FROM edges WHERE kind='RELATED'").all() as { a: string; b: string }[]) {
  const A = byId.get(e.a), B = byId.get(e.b);
  if (!A || !B) continue;
  const sa = strip(A.name), sb = strip(B.name);
  if (!sa || !sb || contains(sa, sb)) continue;
  nHardAll.push({ a: A.id, b: B.id, why: "RELATED but no name containment" });
}
const nHard = shuffle(nHardAll, rand).slice(0, 300);

// --- N-random: uniform pairs, no shared token, different documents --------------------------------------
const tokens = (s: string): Set<string> => new Set(norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2));
const nRandom: Pair[] = [];
const seenRand = new Set<string>();
let guard = 0;
while (nRandom.length < 500 && guard++ < 200_000) {
  const A = rows[Math.floor(rand() * rows.length)]!;
  const B = rows[Math.floor(rand() * rows.length)]!;
  if (A.id === B.id) continue;
  const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
  if (seenRand.has(key)) continue;
  const ta = tokens(A.name), tb = tokens(B.name);
  if ([...ta].some((t) => tb.has(t))) continue;               // no shared name token
  const da = docsOf.get(A.id) ?? new Set(), dbs = docsOf.get(B.id) ?? new Set();
  if ([...da].some((d) => dbs.has(d))) continue;               // different source documents
  seenRand.add(key);
  nRandom.push({ a: A.id, b: B.id, why: "random, no shared token, different documents" });
}

// --- the human audit sample: 40 pairs, blind, stratified 15/10/5/10, shuffled ---------------------------
// Blind means the audit file carries NO set label and NO cosine. Brian sees two names and two descriptions
// and answers same/not-same. The key that says which set each came from lives only in labels.json, so the
// judgment cannot be anchored by the thing being measured.
const strat: [string, Pair[], number][] = [["P-jitter", pJitter, 15], ["P-variant", pVariant, 10], ["N-random", nRandom, 5], ["N-hard", nHard, 10]];
const audit: { qid: string; set: string; a: string; b: string }[] = [];
for (const [setName, pool, n] of strat) {
  for (const p of shuffle(pool, rand).slice(0, n)) {
    audit.push({ qid: sha16(`${setName}:${p.a}:${p.b}`).slice(0, 8), set: setName, a: p.a, b: p.b });
  }
}
const auditShuffled = shuffle(audit, rand);

mkdirSync(outDir, { recursive: true });
const brief = (id: string): { id: string; name: string; subtype: string; description: string } => {
  const r = byId.get(id)!;
  return { id: r.id, name: r.name, subtype: r.subtype, description: r.description };
};

writeFileSync(join(outDir, "labels.json"), JSON.stringify({
  experiment: "E0",
  protocol: "docs/dedup-experiment-protocol.md",
  generated_from: dbPath,
  seed: SEED,
  fixture_written: false,
  entity_population: {
    count: rows.length,
    rule: `nodes WHERE ${ENTITY_WHERE}`,
    note: "type!='SOURCE' would give 1604 and drop 110 extracted `file` entities — see the comment in this script",
    by_subtype: Object.fromEntries([...rows.reduce((m, r) => m.set(r.subtype, (m.get(r.subtype) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1])),
  },
  sets: {
    "P-jitter": { pairs: pJitter, groups: jitterGroups.length, excluded_groups: excludedGroups },
    "P-variant": { pairs: pVariant, groups: variantGroups.length, group_detail: variantGroups },
    "N-hard": { pairs: nHard, drawn_from: nHardAll.length },
    "N-random": { pairs: nRandom },
  },
  audit_key: auditShuffled.map((x) => ({ qid: x.qid, set: x.set })),
}, null, 1));

writeFileSync(join(outDir, "audit-sample.json"), JSON.stringify({
  instructions: "For each pair: are these two nodes THE SAME THING, extracted twice? Answer 'same' or 'not-same'. Set labels are withheld deliberately.",
  pairs: auditShuffled.map((x) => ({ qid: x.qid, a: brief(x.a), b: brief(x.b) })),
}, null, 1));

console.log(`entity population: ${rows.length}`);
console.log(`P-jitter:  ${pJitter.length} pairs across ${jitterGroups.length} groups (${excludedGroups.length} groups excluded: person/place/event)`);
console.log(`P-variant: ${pVariant.length} pairs across ${variantGroups.length} groups`);
console.log(`N-hard:    ${nHard.length} sampled from ${nHardAll.length} RELATED-but-unrelated pairs`);
console.log(`N-random:  ${nRandom.length}`);
console.log(`audit:     ${auditShuffled.length} pairs -> ${join(outDir, "audit-sample.json")}`);
db.close();
