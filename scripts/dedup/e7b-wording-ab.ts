/**
 * E7-W — the wording A/B. One frozen trial set, two question-2 wordings, everything else identical.
 *
 * WHY IT EXISTS. The E7 pilot reported that both arms named a relation for nearly every random FLOOR pair,
 * and that was written up as evidence that an LLM asked "are these related?" will almost always say yes.
 * A cross-agent review then found that the question itself was leading: the affirmative branch had a prose
 * instruction and the negative branch had only a token in the JSON template. So the headline is confounded
 * with my own wording, and it cannot be decomposed after the fact.
 *
 * A re-pilot under the new wording does NOT settle it either, because that run also changed the structural
 * bar and the RNG streams, so the trial set moved underneath the comparison. Three variables, one delta.
 *
 * This is the version that can settle it: build the trial set ONCE, then run each arm twice over those exact
 * same pairs, changing nothing but the Q2 string. Any difference is the wording, because nothing else can
 * differ. Same trials, same seed, same models, same temperature, same order.
 *
 * The registered read: if floor relation-rate falls materially from v1 to v2, the pilot's headline was my
 * artifact and must stay retracted. If it does not move, models really do over-relate and the finding
 * survives on better evidence than it was first published on. Either outcome is worth the GPU minutes; a
 * retraction with nothing in its place is not.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTrials, runArm, score, grade, renderUser, SYSTEM_PROMPT, Q2_WORDINGS, type Wording, type Trial } from "./e7-merge-proposals.js";

const ARMS = {
  "gemma3:12b": { name: "gemma3:12b", kind: "ollama" as const, model: "gemma3:12b" },
  "qwen2.5:14b": { name: "qwen2.5:14b", kind: "ollama" as const, model: "qwen2.5:14b" },
  "haiku": { name: "haiku", kind: "claude-cli" as const, model: "claude-haiku-4-5" },
};

function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const dir = flag("dir", "graphs/testgraph/dedup")!;
const dbPath = flag("db", "graphs/testgraph/graph.db")!;
const seed = Number(flag("seed", "20260816"));
const n = Number(flag("n", "8"));
const armNames = (flag("arms", "gemma3:12b,haiku")!).split(",");

// ONE trial set, built once, shared by every (arm, wording) cell. This is the whole point.
const { trials, meta } = buildTrials({
  dbPath, dir, seed, contextChars: Number(flag("context-chars", "700")),
  counts: { ceiling: n, containment: n, token: n, disjoint: n, floor: n },
});
console.log(`frozen trial set: ${trials.length} trials  ${JSON.stringify(meta.pools)}`);

const wordings: Wording[] = ["e7-v1", "e7-v2"];
const out: Record<string, unknown> = {
  experiment: "E7-W (wording A/B)",
  question: "does Q2's phrasing, alone, move the floor relation-rate?",
  seed,
  system_prompt: SYSTEM_PROMPT,
  q2_wordings: Q2_WORDINGS,
  frozen_trial_set: trials.map((t) => ({
    trial: t.trial, stratum: t.stratum, swapped: t.swapped,
    a: { id: t.a.id, name: t.a.name, subtype: t.a.subtype },
    b: { id: t.b.id, name: t.b.name, subtype: t.b.subtype },
  })),
  cells: {} as Record<string, unknown>,
};
const outPath = join(dir, "e7w-wording-ab.json");

const floorRel = (s: ReturnType<typeof score>): number | null =>
  (s.per_stratum.floor as { relation_rate: number | null } | undefined)?.relation_rate ?? null;

for (const an of armNames) {
  const arm = ARMS[an as keyof typeof ARMS];
  if (!arm) { console.error(`unknown arm '${an}'`); process.exit(2); }
  for (const wording of wordings) {
    process.stdout.write(`\n${arm.name} / ${wording}: `);
    const responses = await runArm(arm, trials, {
      host: flag("host", "http://127.0.0.1:11434")!,
      concurrency: arm.kind === "ollama" ? 1 : 4,
      wording,
      onProgress: (d, t) => process.stdout.write(d % 10 === 0 || d === t ? `${d}/${t} ` : ""),
    });
    const s = score(trials, responses);
    (out.cells as Record<string, unknown>)[`${arm.name}|${wording}`] = { score: s, grade: grade(s), responses };
    console.log(`\n  floor relation-rate ${floorRel(s)}   parse failures ${s.overall.parse_failures}/${s.overall.n}`);
    writeFileSync(outPath, JSON.stringify(out, null, 1));
  }
}

// The one number this script exists to produce.
console.log("\n=== the wording delta, per arm (floor relation-rate) ===");
for (const an of armNames) {
  const c = out.cells as Record<string, { score: ReturnType<typeof score> }>;
  const v1 = c[`${an}|e7-v1`], v2 = c[`${an}|e7-v2`];
  if (!v1 || !v2) continue;
  const a = floorRel(v1.score), b = floorRel(v2.score);
  const delta = a !== null && b !== null ? (b - a).toFixed(3) : "n/a";
  console.log(`  ${an.padEnd(14)} v1 ${a}  →  v2 ${b}   delta ${delta}`);
}
console.log(`\nwrote ${outPath}`);
