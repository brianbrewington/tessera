/**
 * R3 — the QA eval for `tessera ask`. Design agreed on the agent channel (0024 proposal, 0025 conditions,
 * D1 approval in 0027). The two conditions claude-code's yes was contingent on are both structural here:
 *
 *   FLOOR QUESTIONS: 5 of the 20 items are questions the corpus verifiably cannot answer, where declining
 *   is the only correct behaviour. Without them, grounded-answer rate is gameable by answering everything.
 *
 *   THE RETRIEVAL/ANSWERING SPLIT: Recall@K (did any gold seq's chunk surface in R1's candidates?) is
 *   scored independently of answer grades, because a wrong answer over correct retrieval and a wrong answer
 *   over failed retrieval are different bugs. The RECALL_TUNING surface is recorded in the sidecar and was
 *   frozen before this ran; changing it afterward is a NEW experiment, not a re-run.
 *
 * Every grade is deterministic (src/ask/graders.ts): EM/F1 vendored from HotpotQA-official, citation
 * membership by string, staleness against claims.md as gold, decline by flag. No LLM judges anything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Graph } from "../src/graph.js";
import { OllamaChat } from "../src/llm.js";
import { ask } from "../src/ask/ask.js";
import { RECALL_TUNING } from "../src/ask/recall.js";
import { ASK_SYSTEM } from "../src/ask/ask.js";
import { gradeItem, type QaItem, type QaGrade } from "../src/ask/graders.js";

function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const graphName = flag("graph", "comms")!;
const qaPath = flag("qa", "docs/ask-qa-comms.json")!;
const model = flag("model"); // undefined = the chat default; the ladder passes each rung here
const ledgerPath = flag("ledger", `${process.env.HOME}/agent_to_agent_comms/claims.md`)!;
const outPath = flag("out", join("graphs", graphName, "dedup", `ask-eval-${(model ?? "default").replace(/[:/]/g, "-")}.json`))!;

const { items } = JSON.parse(readFileSync(qaPath, "utf8")) as { items: QaItem[] };

/** claims.md is the gold source for staleness: `| C3 | ... | retired |` → "retired". */
function ledgerStatus(claimId: string): string | undefined {
  try {
    const ledger = readFileSync(ledgerPath, "utf8");
    for (const line of ledger.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells[1] === claimId) return cells[3];
    }
  } catch { /* ledger unavailable → fall back to the authored expectation */ }
  return undefined;
}

const graph = Graph.open(graphName);
const chat = new OllamaChat();
const grades: QaGrade[] = [];
const transcripts: unknown[] = [];

try {
  for (const item of items) {
    process.stdout.write(`${item.id} `);
    const res = await ask(graph.store, graph.embedder, chat, item.question, { model });
    const grade = gradeItem(item, res, item.claim ? ledgerStatus(item.claim.id) : undefined);
    grades.push(grade);
    transcripts.push({ item: item.id, question: item.question, answer: res.answer, declined: res.declined, grounded: res.grounded, citations: res.citations, recall_chunks: res.recall.chunks.map((c) => c.name) });
  }
} finally {
  graph.close();
}

const answerable = grades.filter((g) => !g.floor);
const floor = grades.filter((g) => g.floor);
const rate = (xs: boolean[]): number | null => (xs.length ? xs.filter(Boolean).length / xs.length : null);

const report = {
  experiment: "R3 ask-eval",
  graph: graphName,
  model: model ?? "(chat default)",
  qa_set: qaPath,
  n: grades.length,
  recall_tuning_frozen: RECALL_TUNING,
  ask_system_prompt: ASK_SYSTEM,
  // THE SPLIT — retrieval first, answering second, never blended
  retrieval: {
    recall_at_k: rate(answerable.map((g) => g.recall_hit === true)),
  },
  answering: {
    em: rate(answerable.map((g) => g.em)),
    f1_mean: answerable.length ? answerable.reduce((a, g) => a + g.f1, 0) / answerable.length : null,
    grounded_rate: rate(answerable.map((g) => g.grounded)),
    citation_correct_rate: rate(answerable.map((g) => g.citation_correct)),
    answered_rate: rate(answerable.map((g) => g.decline_correct)),
    staleness: rate(answerable.filter((g) => g.staleness_correct !== null).map((g) => g.staleness_correct === true)),
  },
  floor_control: {
    n: floor.length,
    decline_rate: rate(floor.map((g) => g.decline_correct)),
  },
  grades,
  transcripts,
};

writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\n\nretrieval  recall@k ${report.retrieval.recall_at_k}`);
console.log(`answering  em ${report.answering.em}  f1 ${report.answering.f1_mean?.toFixed(3)}  grounded ${report.answering.grounded_rate}  citations-correct ${report.answering.citation_correct_rate}  answered ${report.answering.answered_rate}  staleness ${report.answering.staleness}`);
console.log(`floor      declined ${report.floor_control.decline_rate} of ${report.floor_control.n}`);
console.log(`wrote ${outPath}`);
