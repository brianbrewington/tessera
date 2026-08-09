/**
 * E4 — does asking for more (or less) in the extraction call degrade extraction?
 * Protocol: docs/dedup-experiment-protocol.md, section E4 plus the 2026-08-09 addendum. All rules frozen
 * before this ran; the addendum was committed before the harness was written.
 *
 * Brian's original question, verbatim: adding canonical-name output "could sink a tiny LLM into confusion.
 * We can try both ways and compare?" This is the comparison.
 *
 * NO GRAPH IS WRITTEN, ANYWHERE. The fixture is opened read-only and is never re-extracted; every arm writes
 * a JSON sidecar. PROMPT_VERSION is deliberately NOT bumped, because bumping it would re-dirty and rewrite
 * the fixture, which is forbidden. The memo-salt route is how a winning arm SHIPS, not how it is tested.
 *
 * Arm A' is the whole experiment's spine. At temperature 0.4 the same prompt does not give the same answer
 * twice, so a raw A-vs-B delta is meaningless without knowing what A-vs-A costs. Every delta below is
 * reported in units of that churn.
 */
import Database from "better-sqlite3";
import { OllamaChat } from "../../src/llm.js";
import { EXTRACTION_SYSTEM, parseExtraction } from "../../src/extract/extractor.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dir = argv[0] ?? "graphs/testgraph/dedup";
const N_CHUNKS = Number(argv[1] ?? 150);           // registered: the 150-chunk stratified subsample
// --arms=A,B re-runs a subset. Its ONLY legitimate use is re-running an arm whose measurement was broken;
// it must never be used to re-roll an arm whose RESULT was disliked, which is how a pre-registered
// experiment quietly becomes a search. Any subset run writes to its own sidecar and says so.
const armFilter = (process.argv.find((a) => a.startsWith("--arms=")) ?? "").slice(7).split(",").filter(Boolean);
const TEMP = 0.4;                                   // reproduces the fixture's regime; identical across arms
const MODEL = "qwen2.5:14b";
const SEED = 20260809;

// --- the arms, frozen -----------------------------------------------------------------------------------
// Arm B adds a canonical field, honouring Brian's framing: "it is ok to name your canonical form_s_ if you
// might have more than one. common forms bridge the connection."
const ARM_B_PROMPT = EXTRACTION_SYSTEM.replace(
  `{"entities":[{"name":"","type":"","description":""}],"relations":[{"source":"","target":"","reason":""}]}`,
  `{"entities":[{"name":"","type":"","description":"","canonical":[""]}],"relations":[{"source":"","target":"","reason":""}]}`,
).replace(
  "- Capture SPECIFIC named things even if mentioned only ONCE (a place, a product, a person, a dated event).",
  `- Capture SPECIFIC named things even if mentioned only ONCE (a place, a product, a person, a dated event).
- canonical: one or more normalized forms of the name that another document would plausibly use for the SAME thing (expansions of abbreviations, the spelled-out form of an identifier, a full name for a first name). List more than one when several common forms exist, since common forms bridge the connection. Use [] when the name is already the only sensible form.`,
);

// Arm C strips the description down. E1 says identity rides on the name; descriptions are most of the
// generated tokens, and generation is where the time goes.
const ARM_C_PROMPT = EXTRACTION_SYSTEM.replace(
  "- description: a self-contained, retrieval-ready sentence — what it is AND why it matters here. For WISDOM/LESSON/MEMORY, name who it is attributed to when the text says so.",
  "- description: a terse label, at most a dozen words. Not a sentence. Just enough to disambiguate the name.",
);

const ALL_ARMS: { key: string; prompt: string; note: string }[] = [
  { key: "A", prompt: EXTRACTION_SYSTEM, note: "current EXTRACTION_SYSTEM (the fixture's regime)" },
  { key: "A'", prompt: EXTRACTION_SYSTEM, note: "VARIANCE CONTROL — identical to A, fresh run" },
  { key: "B", prompt: ARM_B_PROMPT, note: "canonical field added" },
  { key: "C", prompt: ARM_C_PROMPT, note: "lean descriptions" },
];
const ARMS = armFilter.length ? ALL_ARMS.filter((a) => armFilter.includes(a.key)) : ALL_ARMS;
const SUBSET = ARMS.length !== ALL_ARMS.length;
const OUT = SUBSET ? `e4-arms-${ARMS.map((a) => a.key).join("")}.json` : "e4-arms.json";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
const allChunks = db.prepare("SELECT id, name, description FROM nodes WHERE subtype = 'chunk' ORDER BY id").all() as { id: string; name: string; description: string }[];
// Stratified by chunk LENGTH, so the subsample is not accidentally all short chunks — length drives both
// generation time and entity yield, which are the two things being measured.
const rand = rng(SEED);
const sorted = [...allChunks].sort((a, b) => a.description.length - b.description.length);
const stride = sorted.length / N_CHUNKS;
const chunks = Array.from({ length: Math.min(N_CHUNKS, sorted.length) }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor(i * stride + rand() * stride))]!);

const norm = (s: string): string => s.trim().toLowerCase();
const strip = (s: string): string => norm(s).replace(/[^a-z0-9]/g, "");
const BANNED = ["related concept", "uses this", "connected", "is part of", "associated with"];

type ArmResult = {
  arm: string; note: string;
  chunks: number; parseFailures: number;
  entities: number; relations: number; bannedReasons: number;
  descChars: number[]; secs: number[];
  names: { name: string; type: string }[];
  canonicalOffered: number;
  canonicalForms: string[];
};

async function runArm(a: { key: string; prompt: string; note: string }): Promise<ArmResult> {
  const chat = new OllamaChat(MODEL);
  const r: ArmResult = { arm: a.key, note: a.note, chunks: 0, parseFailures: 0, entities: 0, relations: 0, bannedReasons: 0, descChars: [], secs: [], names: [], canonicalOffered: 0, canonicalForms: [] };
  for (const c of chunks) {
    const t0 = process.hrtime.bigint();
    let raw = "";
    try { raw = await chat.complete(a.prompt, c.description, { temperature: TEMP, model: MODEL }); } catch { raw = ""; }
    r.secs.push(Number(process.hrtime.bigint() - t0) / 1e9);
    r.chunks++;
    // parseExtraction is REUSED rather than reimplemented, so "parse failure" means mechanically the same
    // thing here as it does in production.
    const out = parseExtraction(raw);
    if (!out.parsed) { r.parseFailures++; continue; }
    r.entities += out.extraction.entities.length;
    r.relations += out.extraction.relations.length;
    for (const e of out.extraction.entities) {
      r.descChars.push((e.description ?? "").length);
      r.names.push({ name: e.name, type: e.type });
      // NOTE: canonical is NOT counted here, and must not be. `Entity` is a bare z.object, so Zod STRIPS
      // unknown keys — reading e.canonical after parseExtraction always yields undefined no matter what the
      // model said. The first run of this harness did exactly that and reported "canonical offered on
      // 0/1052 entities", which measured the parser and not the model. Counted from the RAW json below.
    }
    for (const rel of out.extraction.relations) if (BANNED.some((b) => norm(rel.reason ?? "").includes(b))) r.bannedReasons++;
    // Canonical, counted from the RAW model output, because the production schema cannot represent it.
    // This is the instrument the first run lacked.
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]) as { entities?: { canonical?: unknown }[] };
        for (const e of j.entities ?? []) {
          const c = e.canonical;
          if (Array.isArray(c) ? c.filter((x) => String(x ?? "").trim()).length > 0 : String(c ?? "").trim().length > 0) r.canonicalOffered++;
          if (Array.isArray(c)) r.canonicalForms.push(...c.map((x) => String(x)));
          else if (c) r.canonicalForms.push(String(c));
        }
      }
    } catch { /* raw was not clean JSON; parse-failure is already counted above */ }
    if (r.chunks % 20 === 0) process.stdout.write(`\r  arm ${a.key}: ${r.chunks}/${chunks.length}   `);
  }
  process.stdout.write(`\r  arm ${a.key}: ${r.chunks}/${chunks.length} done        \n`);
  return r;
}

/** What each arm's output WOULD mint: entities differing only by type, and only by punctuation. */
function dedupStats(names: { name: string; type: string }[]): { jitterGroups: number; variantGroups: number; distinct: number } {
  const byNorm = new Map<string, Set<string>>(), byStrip = new Map<string, Set<string>>();
  for (const n of names) {
    const k = norm(n.name);
    if (!byNorm.has(k)) byNorm.set(k, new Set());
    byNorm.get(k)!.add(n.type);
    const s = strip(n.name);
    if (!s) continue;
    if (!byStrip.has(s)) byStrip.set(s, new Set());
    byStrip.get(s)!.add(k);
  }
  return {
    jitterGroups: [...byNorm.values()].filter((v) => v.size > 1).length,
    variantGroups: [...byStrip.values()].filter((v) => v.size > 1).length,
    distinct: byNorm.size,
  };
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const p90 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(0.9 * (s.length - 1))]! : NaN; };
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main(): Promise<void> {
  mkdirSync(dir, { recursive: true });
  console.log(`E4: ${ARMS.length} arms x ${chunks.length} chunks, ${MODEL} @ temp ${TEMP}`);
  console.log(`estimated ${Math.round(ARMS.length * chunks.length * 7.5 / 60)} min. Fixture is read-only; no graph is written.\n`);
  // The arm prompts are written to the sidecar BEFORE any call, per the protocol.
  writeFileSync(join(dir, SUBSET ? `e4-prompts-${ARMS.map((a) => a.key).join("")}.json` : "e4-prompts.json"), JSON.stringify({ frozen_before_run: true, model: MODEL, temperature: TEMP, n_chunks: chunks.length, arms: ARMS }, null, 1));

  const res: ArmResult[] = [];
  for (const a of ARMS) res.push(await runArm(a));

  const A = res.find((x) => x.arm === "A")!;
  // Without A' there is NO churn floor, and a delta reported in units of a floor that was not measured is
  // worse than no delta at all. A subset run says so instead of quietly substituting A for its own control.
  const A2 = res.find((x) => x.arm === "A'") ?? null;
  if (!A2) console.log("\nNOTE: A' was not run, so there is no churn floor. Deltas below are RAW and the\nSAFE verdict is NOT computable — re-run the full set to decide anything.");
  const epc = (x: ArmResult): number => x.entities / x.chunks;
  const pf = (x: ArmResult): number => x.parseFailures / x.chunks;
  const churnEnt = A2 ? (Math.abs(epc(A2) - epc(A)) || 1e-9) : NaN;
  const churnPF = A2 ? Math.abs(pf(A2) - pf(A)) : NaN;
  const churnTime = A2 ? Math.abs(median(A2.secs) - median(A.secs)) : NaN;

  console.log("\narm  entities/chunk  parse-fail  banned  desc chars  median s  p90 s   jitter  variant  canon");
  for (const x of res) {
    const d = dedupStats(x.names);
    console.log(
      `${x.arm.padEnd(4)} ${epc(x).toFixed(2).padEnd(15)} ${(100 * pf(x)).toFixed(1).padEnd(11)} ${String(x.bannedReasons).padEnd(7)} ` +
      `${mean(x.descChars).toFixed(0).padEnd(11)} ${median(x.secs).toFixed(2).padEnd(9)} ${p90(x.secs).toFixed(2).padEnd(7)} ` +
      `${String(d.jitterGroups).padEnd(7)} ${String(d.variantGroups).padEnd(8)} ${x.canonicalOffered}`,
    );
  }
  console.log(`\nA-vs-A' CHURN FLOOR — entities/chunk ${churnEnt.toFixed(3)} · parse-fail ${(100 * churnPF).toFixed(1)}pp · median time ${churnTime.toFixed(2)}s`);

  const verdicts: Record<string, unknown> = {};
  for (const key of ["B", "C"].filter((k) => ARMS.some((a) => a.key === k))) {
    const x = res.find((r) => r.arm === key)!;
    const dEnt = Math.abs(epc(x) - epc(A)), dPF = Math.abs(pf(x) - pf(A));
    const safe = dEnt <= 1.5 * churnEnt && dPF <= 1.5 * Math.max(churnPF, 0.01);
    const dA = dedupStats(A.names), dX = dedupStats(x.names);
    const jitterHalved = (dX.jitterGroups + dX.variantGroups) <= 0.5 * (dA.jitterGroups + dA.variantGroups);
    const faster = median(A.secs) - median(x.secs);
    const worthIt = faster > 2 * Math.max(churnTime, 0.05);
    verdicts[key] = { delta_entities_in_churn_units: dEnt / churnEnt, delta_parsefail_pp: 100 * dPF, safe, jitterHalved, median_faster_by_s: faster, worthIt };
    if (key === "B") console.log(`\nArm B: entity delta = ${(dEnt / churnEnt).toFixed(2)}x churn · SAFE=${safe} · jitter+variant halved=${jitterHalved} (${dA.jitterGroups + dA.variantGroups} -> ${dX.jitterGroups + dX.variantGroups}) · canonical offered on ${x.canonicalOffered}/${x.entities} entities`);
    if (key === "C") console.log(`Arm C: entity delta = ${(dEnt / churnEnt).toFixed(2)}x churn · SAFE=${safe} · median ${faster >= 0 ? "faster" : "SLOWER"} by ${Math.abs(faster).toFixed(2)}s (churn ${churnTime.toFixed(2)}s) · WORTH IT=${worthIt}`);
  }

  writeFileSync(join(dir, OUT), JSON.stringify({
    experiment: "E4", protocol: "docs/dedup-experiment-protocol.md + 2026-08-09 addendum",
    model: MODEL, temperature: TEMP, n_chunks: chunks.length, seed: SEED, fixture_written: false, prompt_version_bumped: false,
    churn: { entities_per_chunk: churnEnt, parse_fail: churnPF, median_seconds: churnTime },
    arms: res.map((x) => ({ arm: x.arm, note: x.note, entities_per_chunk: epc(x), parse_fail_rate: pf(x), banned_reasons: x.bannedReasons,
      mean_desc_chars: mean(x.descChars), median_s: median(x.secs), p90_s: p90(x.secs), total_s: x.secs.reduce((a, b) => a + b, 0),
      canonical_offered: x.canonicalOffered, canonical_sample: x.canonicalForms.slice(0, 40), dedup: dedupStats(x.names) })),
    verdicts,
  }, null, 1));
  db.close();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
