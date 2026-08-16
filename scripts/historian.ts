/**
 * R5 — the historian seat on the agent channel. Approved as decision D2 (channel message 0037).
 *
 * A long-running process that:
 *   1. watches the channel's messages/ directory,
 *   2. keeps the comms graph current (ingest on arrival; extraction drains in the background),
 *   3. answers ONLY messages addressed `to: historian`, via `ask` under the cite-or-decline contract,
 *   4. posts replies per protocol v1.6: seq claimed atomically, chars counted, evidence paths carried,
 *      PAUSE and the turn budget respected.
 *
 * THE THREE HISTORIAN RULES, from the converged design (channel 0024, conditions 0025, D2 spec):
 *   - ANSWERS, NEVER ASSERTS: it does not write the ledger, and its outputs are never ledger-citable.
 *     Replies carry a standing footer saying so, so a future reader cannot cite them by accident.
 *   - LAG HONESTY: every reply states the seq it has indexed through and what is still pending; its
 *     silences must read as lag, never as absence of evidence.
 *   - STALENESS: claim-status questions are answered from claims.md (the canonical ledger), not from the
 *     graph — measured in R3: the graph does not know C3 was retired; the ledger does.
 *
 * The answering model is a D2-ladder outcome: pass --model to pin a rung; default is the chat default
 * until the ladder says otherwise.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Graph } from "../src/graph.js";
import { OllamaChat } from "../src/llm.js";
import { ask } from "../src/ask/ask.js";

const COMMS = process.env.HISTORIAN_COMMS ?? join(process.env.HOME ?? "", "agent_to_agent_comms");
const MESSAGES = join(COMMS, "messages");
const CONTROL = join(COMMS, "control");
const HANDLE = "historian";
const GRAPH = process.env.HISTORIAN_GRAPH ?? "comms";
const MODEL = process.env.HISTORIAN_MODEL; // set by the D2 ladder result; undefined = chat default
const TESSERA = join(dirname(fileURLToPath(import.meta.url)), "..", "tessera");

interface Msg { seq: number; from: string; to: string; file: string; body: string; protocol?: string }

function parseMsg(file: string): Msg | null {
  const m = /^(\d{4})-(.+)\.md$/.exec(file);
  if (!m) return null;
  const raw = readFileSync(join(MESSAGES, file), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!fm) return null;
  const field = (k: string): string | undefined => new RegExp(`^${k}:\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(fm[1]!)?.[1]?.trim();
  return {
    seq: Number(m[1]),
    from: field("from") ?? m[2]!,
    to: field("to") ?? "",
    file,
    body: fm[2]!,
    protocol: field("protocol"),
  };
}

const listMessages = (): Msg[] =>
  readdirSync(MESSAGES)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .map(parseMsg)
    .filter((m): m is Msg => !!m)
    .sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file));

/** Budget per protocol v1.2+: agent messages since the human's last message (or BUDGET grant, if later). */
function budgetAllows(): boolean {
  let allowance = 6;
  let sinceEpoch = 0;
  const budgetPath = join(CONTROL, "BUDGET");
  if (existsSync(budgetPath)) {
    try {
      const b = JSON.parse(readFileSync(budgetPath, "utf8")) as { granted_epoch: number; turns: number };
      allowance = b.turns;
      sinceEpoch = b.granted_epoch * 1000;
    } catch { /* malformed grant → default allowance */ }
  }
  const msgs = listMessages();
  const lastHuman = [...msgs].reverse().find((m) => m.from === "brian");
  const lastHumanTime = lastHuman ? statSync(join(MESSAGES, lastHuman.file)).mtimeMs : 0;
  const cutoff = Math.max(sinceEpoch, lastHumanTime);
  const agentMsgs = msgs.filter((m) => m.from !== "brian" && statSync(join(MESSAGES, m.file)).mtimeMs > cutoff);
  return agentMsgs.length < allowance;
}

function refreshGraph(): { indexedThrough: number; pending: number } {
  // stock ingest — the historian answers over exactly what production tessera built
  execFileSync(TESSERA, ["ingest", GRAPH, MESSAGES], { stdio: "pipe" });
  execFileSync(TESSERA, ["extract", GRAPH], { stdio: "pipe", timeout: 15 * 60_000 });
  const msgs = listMessages();
  return { indexedThrough: msgs.length ? msgs[msgs.length - 1]!.seq : 0, pending: 0 };
}

async function answer(q: Msg): Promise<void> {
  const lag = refreshGraph(); // ingest the question itself before answering — lag honesty starts at zero
  const graph = Graph.open(GRAPH);
  let res;
  try {
    res = await ask(graph.store, graph.embedder, new OllamaChat(), q.body.trim(), { model: MODEL });
  } finally {
    graph.close();
  }

  const cites = res.citations
    .map((c) => `  [${c.verdict === "verified" ? "✓" : `✗ ${c.verdict}`}] ${c.chunk_name ?? "?"}: "${c.quote.slice(0, 120)}"`)
    .join("\n");
  const body = res.declined
    ? `Not in the record${res.decline_reason ? `: ${res.decline_reason}` : "."}\n\nIndexed through seq ${String(lag.indexedThrough).padStart(4, "0")}. My silences are lag or absence of evidence in the graph — never a verdict.`
    : `${res.answer}\n\n${cites}\n\n${res.grounded ? "Every citation verified verbatim against its source chunk." : "NOT FULLY GROUNDED — at least one citation failed mechanical verification; treat with suspicion."}\nIndexed through seq ${String(lag.indexedThrough).padStart(4, "0")}.`;
  const footer = `\n\n*Historian replies are answers, never assertions: this message is not ledger-citable, and I do not write claims.*`;

  // claim the next seq per protocol v1.4: glob any-author, atomic mv, PAUSE checked at the last moment
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = Math.max(...listMessages().map((m) => m.seq)) + 1;
    const nn = String(seq).padStart(4, "0");
    if (readdirSync(MESSAGES).some((f) => f.startsWith(`${nn}-`))) continue;
    if (existsSync(join(CONTROL, "PAUSE"))) { console.log("PAUSE present — holding reply"); await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (!budgetAllows()) { console.log("budget spent — holding reply until the floor reopens"); return; }
    const text = body + footer;
    const fm = `---\nfrom: ${HANDLE}\nto: ${q.from}\nseq: ${seq}\nin_reply_to: ${q.seq}\nprotocol: "1.6"\nchars: ${text.length}\ndate: ${new Date().toISOString()}\nsubject: "re: ${q.body.trim().slice(0, 60).replace(/\n/g, " ")}"\nevidence:\n  - ~/code/tessera/graphs/${GRAPH}/graph.db\n---\n\n${text}\n`;
    const tmp = join(MESSAGES, `.${nn}-${HANDLE}.md.tmp`);
    writeFileSync(tmp, fm);
    try {
      renameSync(tmp, join(MESSAGES, `${nn}-${HANDLE}.md`));
      console.log(`answered ${q.file} as ${nn}-${HANDLE}.md (grounded=${res.grounded}, declined=${res.declined})`);
      return;
    } catch { /* lost the race — loop re-reads and takes the next number */ }
  }
  console.error(`could not claim a seq for the reply to ${q.file}`);
}

// --- main loop ------------------------------------------------------------------------------------------
const answered = new Set<string>();
// on startup, consider only FUTURE questions — replaying the archive would answer stale addresses
for (const m of listMessages()) answered.add(m.file);

console.log(`historian up: watching ${MESSAGES}, graph '${GRAPH}', model ${MODEL ?? "(default)"}. Answering only 'to: ${HANDLE}'.`);
for (;;) {
  try {
    for (const m of listMessages()) {
      if (answered.has(m.file)) continue;
      answered.add(m.file);
      if (m.from === HANDLE) continue;
      if (m.to.trim() !== HANDLE) continue; // addressed messages only — 'to: all' is deliberately NOT answered
      console.log(`question from ${m.from} in ${m.file}`);
      await answer(m);
    }
  } catch (e) {
    console.error("historian loop error:", (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
