/**
 * E10 — span-grounded extraction, with the small-model ladder riding on the same harness.
 * Protocol: docs/dedup-experiment-protocol.md § E10. All rules frozen before this ran.
 *
 * THE IDEA, one sentence: a relation must carry its evidence — a verbatim quote from the chunk that asserts
 * it — and a quote that does not verify mechanically kills the relation at parse time, for the cost of a
 * substring search. This is Phase A1 of the plan converged with the embeddings_experiments session: it
 * replaces multi-run consensus as the default cheap gate because it attacks the same confabulation class
 * (E7/E7-W: models invent relations nearly always when ungated; Mercer forensics: consensus's 0.0% was
 * n=13/0-events) at 1× extraction cost instead of k×.
 *
 * NO GRAPH IS WRITTEN, ANYWHERE — E4's discipline verbatim. Fixture opened read-only, PROMPT_VERSION not
 * bumped, sidecars only. Arm A′ is the churn floor: at temperature 0.4 the same prompt does not answer the
 * same twice, so every A-vs-S delta is reported in units of A-vs-A′.
 */
import Database from "better-sqlite3";
import { z } from "zod";
import { OllamaChat } from "../../src/llm.js";
import { EXTRACTION_SYSTEM, Entity, Relation, jsonObjectCandidates } from "../../src/extract/extractor.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// --- the S prompt, frozen -------------------------------------------------------------------------------
// Two edits to the incumbent: the JSON shape gains a `quote` field, and one rule explains it. Everything
// else — entity rules, DO-NOT-EXTRACT, reason discipline — is byte-identical, so the arms differ by exactly
// one ingredient (E5's rule).
export const ARM_S_PROMPT = EXTRACTION_SYSTEM.replace(
  `{"entities":[{"name":"","type":"","description":""}],"relations":[{"source":"","target":"","reason":""}]}`,
  `{"entities":[{"name":"","type":"","description":""}],"relations":[{"source":"","target":"","reason":"","quote":""}]}`,
).replace(
  "- Two entities may share MORE THAN ONE relationship",
  `- quote: a VERBATIM snippet copied character-for-character from the document that asserts this
  relationship — the sentence or phrase a reader would point to as the evidence. Do not paraphrase, do not
  abridge with ellipses, do not fix typos: copy the exact text. If no span of the document asserts the
  relationship, DO NOT EMIT THE RELATION.
- Two entities may share MORE THAN ONE relationship`,
);

// --- quote verification — promoted to src/ask/quotes.ts when R2 (`tessera ask`) adopted the same rule at
// answer time; re-exported here so E10's tests and sidecars keep their import path -------------------------
export { normQuote, verifyQuote, withinEditDistance, type QuoteVerdict } from "../../src/ask/quotes.js";
import { verifyQuote as vq, type QuoteVerdict } from "../../src/ask/quotes.js";

// --- template-reason detector (the Mercer junk class, Brian's ban) --------------------------------------
const TEMPLATE_REASONS = [
  /^related( to)?( concept)?$/i, /^associated( with)?$/i, /^connected( to)?$/i, /^uses( this)?$/i,
  /^is part of$/i, /^relates to$/i, /^linked( to)?$/i, /^improves performance in$/i, /^works with$/i,
];
export const isTemplateReason = (r: string): boolean => {
  const t = r.trim();
  return t.length < 4 || TEMPLATE_REASONS.some((re) => re.test(t));
};

/**
 * Quote-preserving parse — THE PILOT'S FIRST FINDING, and it was an instrument failure, not a model one.
 *
 * The first Arm-S run reported quote-fidelity 0.000 with all 66 relations "missing" — a clean, publishable-
 * looking "models cannot quote" verdict. It was false: production `parseExtraction` validates relations with
 * a strict Zod object, which STRIPS unknown keys, so the harness never saw a quote the model actually wrote.
 * The instrument ate the evidence and failed toward a verdict. (The house memory calls this the instrument-
 * failure pattern; this is its third appearance in this experiment line.) This parse mirrors production
 * candidate-selection and salvage semantics exactly, with one change: the relation schema carries `quote`.
 */
const RelationQ = Relation.extend({ quote: z.string().optional() });
export function parseWithQuotes(raw: string): { entities: z.infer<typeof Entity>[]; relations: z.infer<typeof RelationQ>[] } | null {
  let obj: Record<string, unknown> | null = null;
  let fallback: Record<string, unknown> | null = null;
  for (const cand of jsonObjectCandidates(raw)) {
    let o: unknown;
    try { o = JSON.parse(cand); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    fallback ??= rec;
    if (Array.isArray(rec.entities) || Array.isArray(rec.relations)) { obj = rec; break; }
  }
  obj ??= fallback;
  if (!obj) return null;
  const sal = <S extends z.ZodTypeAny>(arr: unknown, schema: S): z.infer<S>[] =>
    Array.isArray(arr) ? arr.flatMap((x) => { const r = schema.safeParse(x); return r.success ? [r.data] : []; }) : [];
  const entities = sal(obj.entities, Entity);
  const names = new Set(entities.map((e) => e.name.trim().toLowerCase()));
  const relations = sal(obj.relations, RelationQ).filter(
    (r) => names.has(r.source.trim().toLowerCase()) && names.has(r.target.trim().toLowerCase()),
  );
  return { entities, relations };
}

// --- harness --------------------------------------------------------------------------------------------
interface ArmResult {
  model: string;
  arm: "A" | "A'" | "S";
  chunks: number;
  parse_failures: number;
  entities: number;
  relations_emitted: number;
  quote_verdicts?: Record<QuoteVerdict, number>;
  relations_surviving?: number;
  quote_fidelity?: number | null;
  template_reasons: number;
  median_s: number | null;
  p90_s: number | null;
  /** killed relations, kept verbatim for the GROUNDED audit — the rule needs ≥20 audited */
  kills?: { chunk: string; source: string; target: string; reason: string; quote: string; verdict: QuoteVerdict }[];
}

function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

async function runArm(
  model: string,
  armKey: "A" | "A'" | "S",
  chunks: { id: string; name: string; text: string }[],
  chat: OllamaChat,
): Promise<ArmResult> {
  const system = armKey === "S" ? ARM_S_PROMPT : EXTRACTION_SYSTEM;
  const times: number[] = [];
  const res: ArmResult = {
    model, arm: armKey, chunks: chunks.length, parse_failures: 0, entities: 0,
    relations_emitted: 0, template_reasons: 0, median_s: null, p90_s: null,
    ...(armKey === "S" ? { quote_verdicts: { verified: 0, near_miss: 0, unmatched: 0, missing: 0 }, relations_surviving: 0, kills: [] } : {}),
  };
  let done = 0;
  for (const chunk of chunks) {
    const t0 = Date.now();
    let raw = "";
    try {
      raw = await chat.complete(system, chunk.text, { temperature: 0.4, model });
    } catch {
      res.parse_failures++; // transport death counts as unusable, same rule as E7
      continue;
    }
    times.push((Date.now() - t0) / 1000);
    const parsed = parseWithQuotes(raw);
    if (!parsed) { res.parse_failures++; continue; }
    res.entities += parsed.entities.length;
    for (const rel of parsed.relations) {
      res.relations_emitted++;
      if (isTemplateReason(rel.reason ?? "")) res.template_reasons++;
      if (armKey === "S") {
        const verdict = vq(rel.quote, chunk.text);
        res.quote_verdicts![verdict]++;
        if (verdict === "verified") res.relations_surviving!++;
        else res.kills!.push({ chunk: chunk.name, source: rel.source, target: rel.target, reason: rel.reason ?? "", quote: rel.quote ?? "", verdict });
      }
    }
    process.stdout.write(++done % 5 === 0 || done === chunks.length ? `${done}/${chunks.length} ` : "");
  }
  res.median_s = pctl(times, 0.5);
  res.p90_s = pctl(times, 0.9);
  if (armKey === "S") res.quote_fidelity = res.relations_emitted ? res.relations_surviving! / res.relations_emitted : null;
  return res;
}

// --- CLI ------------------------------------------------------------------------------------------------
function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = flag("dir", "graphs/testgraph/dedup")!;
  const dbPath = flag("db", "graphs/testgraph/graph.db")!;
  const pilot = process.argv.includes("--pilot");
  const nChunks = Number(flag("chunks", pilot ? "20" : "150"));
  const models = (flag("models", "qwen2.5:14b")!).split(",");
  const arms = (flag("arms", pilot ? "A,S" : "A,A',S")!).split(",") as ("A" | "A'" | "S")[];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // Stratified-by-position sample of chunks, deterministic: every k-th chunk in id order. The registered
  // scored run uses the 150-chunk subsample; the pilot takes the same rule at n=20.
  const all = db
    .prepare(`SELECT id, COALESCE(name,'') AS name, description AS text FROM nodes WHERE subtype='chunk' AND description IS NOT NULL ORDER BY id`)
    .all() as { id: string; name: string; text: string }[];
  const step = Math.max(1, Math.floor(all.length / nChunks));
  const chunks = all.filter((_, i) => i % step === 0).slice(0, nChunks);

  const chat = new OllamaChat();
  const out: Record<string, unknown> = {
    experiment: pilot ? "E10-PILOT (not scored)" : "E10",
    protocol: "docs/dedup-experiment-protocol.md § E10",
    arm_s_prompt: ARM_S_PROMPT,
    chunk_count: chunks.length,
    chunk_selection: `every ${step}th of ${all.length} in id order`,
    arms: [] as ArmResult[],
  };
  const outPath = join(dir, pilot ? "e10-pilot.json" : "e10-span.json");

  for (const model of models) {
    for (const armKey of arms) {
      process.stdout.write(`\n${model} / ${armKey}: `);
      const r = await runArm(model, armKey, chunks, chat);
      (out.arms as ArmResult[]).push(r);
      console.log(
        `\n  parse-fail ${r.parse_failures}/${r.chunks}  ents/chunk ${(r.entities / Math.max(1, r.chunks - r.parse_failures)).toFixed(2)}  rels ${r.relations_emitted}` +
        (armKey === "S" ? `  fidelity ${r.quote_fidelity?.toFixed(3)}  verdicts ${JSON.stringify(r.quote_verdicts)}` : "") +
        `  template ${r.template_reasons}  median ${r.median_s?.toFixed(1)}s`,
      );
      writeFileSync(outPath, JSON.stringify(out, null, 1)); // survive a crash arm-by-arm
    }
  }
  console.log(`\nwrote ${outPath}`);
}
