/**
 * E3 — can a small local model answer the one-to-many merge question? Decoy-calibrated.
 * Protocol: docs/dedup-experiment-protocol.md, section E3. Rules frozen before this ran.
 *
 * The design decision that makes this measurable: THE SCHEMA HAS NO CONFIDENCE FIELD. Every metric is a
 * choice rate, never a self-reported score. Brian, from scoring image reconstruction with model-emitted
 * numbers at NVIDIA: "it wasn't reliable."
 *
 * The other one: A PLANTED DECOY SITS IN EVERY LIST. Same subtype, different source document, no shared
 * stripped tokens. It cannot be the answer. So the decoy-pick rate IS a continuously-measured false-positive
 * rate that needs no labels at all — if the model reaches for the decoy, it is pattern-matching on shape
 * rather than reading, and no amount of accuracy elsewhere redeems that.
 *
 * NO COSINES ARE SHOWN TO THE MODEL. Geometry in the prompt is geometry deciding.
 * Read-only over the fixture. Sidecar out. Fixture never written.
 */
import Database from "better-sqlite3";
import { OllamaChat } from "../../src/llm.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
const SEED = 20260809;
const FAMILIES = ["qwen2.5:14b", "gemma3:12b"];

type Pair = { a: string; b: string; why: string };
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as {
  sets: Record<string, { pairs: Pair[] }>;
  audit_key: { qid: string; set: string }[];
};
const answers = (JSON.parse(readFileSync(join(dir, "audit-answers.json"), "utf8")) as { answers: Record<string, string> }).answers;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const rand = rng(SEED);
function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [x[i], x[j]] = [x[j]!, x[i]!]; }
  return x;
}

type Row = { id: string; subtype: string; name: string; description: string };
const rows = db.prepare("SELECT id, subtype, name, description FROM nodes WHERE subtype NOT IN ('chunk','document')").all() as Row[];
const byId = new Map(rows.map((r) => [r.id, r]));
const docsOf = new Map<string, Set<string>>();
for (const r of db.prepare(`
  SELECT ai.from_id AS ent, orf.to_id AS doc FROM edges ai
  JOIN edges orf ON orf.from_id = ai.to_id AND orf.kind='ORIGINATED_FROM' WHERE ai.kind='APPEARED_IN'`).all() as { ent: string; doc: string }[]) {
  if (!docsOf.has(r.ent)) docsOf.set(r.ent, new Set());
  docsOf.get(r.ent)!.add(r.doc);
}
const stripToks = (s: string): Set<string> =>
  new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/** A planted decoy: same subtype, different source document, no shared stripped token. Cannot be the answer. */
function pickDecoy(probe: Row, exclude: Set<string>): Row | null {
  const pt = stripToks(probe.name), pd = docsOf.get(probe.id) ?? new Set();
  for (let i = 0; i < 400; i++) {
    const c = rows[Math.floor(rand() * rows.length)]!;
    if (c.id === probe.id || exclude.has(c.id)) continue;
    if (c.subtype !== probe.subtype) continue;
    const cd = docsOf.get(c.id) ?? new Set();
    if ([...cd].some((d) => pd.has(d))) continue;
    if ([...stripToks(c.name)].some((t) => pt.has(t))) continue;
    return c;
  }
  return null;
}
/** A distractor from the N-hard pool: something the extractor asserted a relation to, so genuinely confusable. */
const nHardNeighbours = new Map<string, string[]>();
for (const p of labels.sets["N-hard"]!.pairs) {
  for (const [x, y] of [[p.a, p.b], [p.b, p.a]] as [string, string][]) {
    if (!nHardNeighbours.has(x)) nHardNeighbours.set(x, []);
    nHardNeighbours.get(x)!.push(y);
  }
}
function distractors(probe: Row, n: number, exclude: Set<string>): Row[] {
  const out: Row[] = [];
  for (const id of shuffle(nHardNeighbours.get(probe.id) ?? [])) {
    if (out.length >= n || exclude.has(id)) continue;
    const r = byId.get(id); if (r) { out.push(r); exclude.add(id); }
  }
  while (out.length < n) {
    const c = rows[Math.floor(rand() * rows.length)]!;
    if (exclude.has(c.id) || c.id === probe.id) continue;
    out.push(c); exclude.add(c.id);
  }
  return out;
}

type Trial = { kind: "HIT" | "NULL" | "JUDGMENT"; probe: Row; cands: Row[]; truth: string | null; decoy: string | null; qid?: string };
const trials: Trial[] = [];

// HIT — the true duplicate is present, alongside 2 confusable distractors and 1 planted decoy.
for (const p of shuffle(labels.sets["P-variant"]!.pairs).slice(0, 100)) {
  const probe = byId.get(p.a)!, truth = byId.get(p.b)!;
  const ex = new Set([probe.id, truth.id]);
  const decoy = pickDecoy(probe, ex); if (!decoy) continue;
  ex.add(decoy.id);
  trials.push({ kind: "HIT", probe, cands: shuffle([truth, decoy, ...distractors(probe, 2, ex)]), truth: truth.id, decoy: decoy.id });
}
// NULL — no true duplicate exists. The correct answer is NONE. This is where an eager model is caught.
for (const p of shuffle(labels.sets["N-hard"]!.pairs).slice(0, 100)) {
  const probe = byId.get(p.a)!;
  const ex = new Set([probe.id]);
  const decoy = pickDecoy(probe, ex); if (!decoy) continue;
  ex.add(decoy.id);
  trials.push({ kind: "NULL", probe, cands: shuffle([decoy, ...distractors(probe, 3, ex)]), truth: null, decoy: decoy.id });
}
// JUDGMENT — the 40 audited pairs, so kappa against Brian costs him nothing further (protocol: reuse E0's sample).
const qidOf = (set: string, p: Pair): string => createHash("sha256").update(`${set}:${p.a}:${p.b}`).digest("hex").slice(0, 8);
for (const set of ["P-jitter", "P-variant", "N-hard", "N-random"]) {
  for (const p of labels.sets[set]!.pairs) {
    const q = qidOf(set, p);
    if (!(q in answers)) continue;
    const probe = byId.get(p.a)!, other = byId.get(p.b)!;
    const ex = new Set([probe.id, other.id]);
    const decoy = pickDecoy(probe, ex); if (!decoy) continue;
    ex.add(decoy.id);
    trials.push({ kind: "JUDGMENT", probe, cands: shuffle([other, decoy, ...distractors(probe, 2, ex)]), truth: other.id, decoy: decoy.id, qid: q });
  }
}

const SYSTEM = `You decide whether an entity extracted from documents is the SAME REAL THING as one of several candidates.
Two entries are the same thing only if they refer to the identical referent, not merely a related or similar one.
A candidate that is a sibling, a counterpart, an opposite, or a component of the probe is NOT the same thing.
Most of the time the correct answer is NONE. Prefer NONE whenever you are not sure.
Reply with ONLY a JSON object: {"same_as": "<candidate letter or NONE>", "reason": "<one short sentence>"}`;

const LETTERS = "ABCD".split("");
const renderTrial = (t: Trial): string =>
  `PROBE\nname: ${t.probe.name}\ntype: ${t.probe.subtype}\ndescription: ${t.probe.description}\n\nCANDIDATES\n` +
  t.cands.map((c, i) => `${LETTERS[i]}. name: ${c.name}\n   type: ${c.subtype}\n   description: ${c.description}`).join("\n\n") +
  `\n\nWhich candidate, if any, is the SAME REAL THING as the probe?`;

type Res = { pick: string | null; parseFail: boolean; pos: number | null };
function parse(out: string, t: Trial): Res {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { pick: null, parseFail: true, pos: null };
  try {
    const j = JSON.parse(m[0]) as { same_as?: string };
    const v = String(j.same_as ?? "").trim().toUpperCase();
    if (!v || v === "NONE" || v === "NULL") return { pick: null, parseFail: false, pos: null };
    const idx = LETTERS.indexOf(v[0]!);
    if (idx < 0 || idx >= t.cands.length) return { pick: null, parseFail: true, pos: null };
    return { pick: t.cands[idx]!.id, parseFail: false, pos: idx };
  } catch { return { pick: null, parseFail: true, pos: null }; }
}

const kappa = (a: boolean[], b: boolean[]): number => {
  const n = a.length; if (!n) return NaN;
  let agree = 0, a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) agree++; if (a[i]) a1++; if (b[i]) b1++; }
  const po = agree / n;
  const pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n);
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
};

async function main(): Promise<void> {
  console.log(`${trials.length} trials (${trials.filter((t) => t.kind === "HIT").length} HIT, ${trials.filter((t) => t.kind === "NULL").length} NULL, ${trials.filter((t) => t.kind === "JUDGMENT").length} JUDGMENT) x ${FAMILIES.length} families`);
  const all: Record<string, unknown> = {};
  for (const model of FAMILIES) {
    const chat = new OllamaChat(model);
    const rec: { t: Trial; r: Res }[] = [];
    let done = 0;
    for (const t of trials) {
      let out = "";
      try { out = await chat.complete(SYSTEM, renderTrial(t), { temperature: 0, model }); }
      catch { out = ""; }
      rec.push({ t, r: parse(out, t) });
      if (++done % 25 === 0) process.stdout.write(`\r  ${model}: ${done}/${trials.length}   `);
    }
    process.stdout.write(`\r  ${model}: ${trials.length}/${trials.length} done          \n`);

    const hit = rec.filter((x) => x.t.kind === "HIT"), nul = rec.filter((x) => x.t.kind === "NULL");
    const decoyPicks = rec.filter((x) => x.r.pick && x.r.pick === x.t.decoy).length;
    const parseFails = rec.filter((x) => x.r.parseFail).length;
    const posCount = [0, 0, 0, 0];
    for (const x of rec) if (x.r.pos !== null) posCount[x.r.pos]!++;
    const jud = rec.filter((x) => x.t.kind === "JUDGMENT" && x.t.qid);
    const modelSame = jud.map((x) => x.r.pick === x.t.truth);
    const humanSame = jud.map((x) => answers[x.t.qid!] === "same");

    const m = {
      trials: rec.length,
      decoy_pick_rate: decoyPicks / rec.length,
      null_abstention: nul.length ? nul.filter((x) => x.r.pick === null).length / nul.length : NaN,
      hit_recall: hit.length ? hit.filter((x) => x.r.pick === x.t.truth).length / hit.length : NaN,
      kappa_vs_brian: kappa(modelSame, humanSame),
      parse_failures: parseFails,
      position_counts: posCount,
      judgment_n: jud.length,
    };
    all[model] = m;
    const pass = m.decoy_pick_rate <= 0.02 && m.null_abstention >= 0.95 && m.hit_recall >= 0.90 && m.kappa_vs_brian >= 0.6;
    console.log(`  decoy-pick ${(100 * m.decoy_pick_rate).toFixed(1)}% (<=2%) | null-abstain ${(100 * m.null_abstention).toFixed(1)}% (>=95%) | hit-recall ${(100 * m.hit_recall).toFixed(1)}% (>=90%) | kappa ${m.kappa_vs_brian.toFixed(2)} (>=0.6) | parse-fail ${parseFails} | pos ${posCount.join("/")}  =>  ${pass ? "VERIFIER-GRADE" : "not verifier-grade"}`);
  }
  writeFileSync(join(dir, "e3-verifier.json"), JSON.stringify({
    experiment: "E3", protocol: "docs/dedup-experiment-protocol.md", seed: SEED,
    decision_rule: "verifier-grade = decoy-pick <=2% AND null-abstention >=95% AND hit-recall >=90% AND kappa >=0.6, for >=1 family",
    no_confidence_field: true, cosines_shown_to_model: false, families: all,
  }, null, 1));
  db.close();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
