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
  const m = /^(\d{4,})-(.+)\.md$/.exec(file);  // 4+ digits: seq 10000 must not become invisible
  if (!m) return null;
  const raw = readFileSync(join(MESSAGES, file), "utf8").replace(/\r\n/g, "\n"); // CRLF files must not vanish
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!fm) return null;
  const field = (k: string): string | undefined => new RegExp(`^${k}:\\s*['"]?([^'"\\n]*)['"]?\\s*$`, "m").exec(fm[1]!)?.[1]?.trim();
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
  // P6: authority-bearing brian messages are valid only with frontend provenance (mode 600). A forged
  // `from: brian` from any agent would otherwise reset the budget clock — the capture scenario the
  // cross-lab review named. Unsigned brian-handle files count as agent messages here.
  const isSignedHuman = (m: Msg): boolean => {
    if (m.from !== "brian") return false;
    try { return (statSync(join(MESSAGES, m.file)).mode & 0o077) === 0; } catch { return false; }
  };
  const lastHuman = [...msgs].reverse().find(isSignedHuman);
  const lastHumanTime = lastHuman ? statSync(join(MESSAGES, lastHuman.file)).mtimeMs : 0;
  const cutoff = Math.max(sinceEpoch, lastHumanTime);
  const agentMsgs = msgs.filter((m) => !isSignedHuman(m) && statSync(join(MESSAGES, m.file)).mtimeMs > cutoff);
  return agentMsgs.length < allowance;
}

function refreshGraph(): { indexedThrough: number; lagNote: string } {
  // Stock ingest — fast, and it must succeed (the question itself has to be in the record).
  execFileSync(TESSERA, ["ingest", GRAPH, MESSAGES], { stdio: "pipe" });
  // THE LEDGER IS PART OF THE RECORD. The historian rules said claim-status questions are answered from
  // claims.md — and the implementation never ingested it, so part (a) of the first live question was
  // structurally unanswerable at any recall quality. Caught by the sandbox bench, named on-channel in 0045's
  // diagnosis. Content-hash dedup makes this re-ingest free when the ledger hasn't changed.
  const ledger = join(COMMS, "claims.md");
  if (existsSync(ledger)) execFileSync(TESSERA, ["ingest", GRAPH, ledger], { stdio: "pipe" });
  // Extraction is BEST-EFFORT, and that is a decision made after the first live question, not before it:
  // the original code blocked until the whole backlog extracted (first-response latency = backlog, ~10min)
  // and DIED when extract exited nonzero (a transient claim collision with serve's background drain), which
  // orphaned the question entirely. Lag honesty was always meant to be report-not-block: chunks are in the
  // record the moment ingest returns, so recall works; only the entity index lags, and the reply SAYS so.
  let lagNote = "";
  try {
    execFileSync(TESSERA, ["extract", GRAPH], { stdio: "pipe", timeout: 4 * 60_000 });
  } catch {
    lagNote = " Entity extraction is still catching up on recent messages; recall over raw text is current.";
  }
  const msgs = listMessages();
  return { indexedThrough: msgs.length ? msgs[msgs.length - 1]!.seq : 0, lagNote };
}

type AnswerOutcome = "posted" | "hold";
async function answer(q: Msg): Promise<AnswerOutcome> {
  const lag = refreshGraph(); // ingest the question itself before answering — lag honesty starts at zero
  const graph = Graph.open(GRAPH);
  let res;
  try {
    // Claim-shaped questions get the ledger PINNED into the excerpts (review 2.2: ingesting it made the
    // right chunk available, not used — recall could prefer stale discussion over the row that retired C3).
    const ledgerPath = join(COMMS, "claims.md");
    const claimish = /\bC\d+\b|claim|status|retired|superseded|ledger/i.test(q.body);
    const pinned = claimish && existsSync(ledgerPath)
      ? [{ name: "claims.md (canonical ledger)", text: readFileSync(ledgerPath, "utf8").slice(0, 6000) }]
      : [];
    res = await ask(graph.store, graph.embedder, new OllamaChat(), q.body.trim(), { model: MODEL, pinned });
  } finally {
    graph.close();
  }

  const cites = res.citations
    .map((c) => `  [${c.verdict === "verified" ? "✓" : `✗ ${c.verdict}`}] ${c.chunk_name ?? "?"}: "${c.quote.slice(0, 120)}"`)
    .join("\n");
  const body = res.declined
    ? `Not in the record${res.decline_reason ? `: ${res.decline_reason}` : "."}\n\nIndexed through seq ${String(lag.indexedThrough).padStart(4, "0")}.${lag.lagNote} My silences are lag or absence of evidence in the graph — never a verdict.`
    : `${res.answer}\n\n${cites}\n\n${res.grounded ? "Every citation verified verbatim against its source chunk." : "NOT FULLY GROUNDED — at least one citation failed mechanical verification; treat with suspicion."}\nIndexed through seq ${String(lag.indexedThrough).padStart(4, "0")}.${lag.lagNote}`;
  const footer = `\n\n*Historian replies are answers, never assertions: this message is not ledger-citable, and I do not write claims.*`;

  // claim the next seq per protocol v1.4: glob any-author, atomic mv, PAUSE checked at the last moment.
  // Seq comes from FILENAMES ON DISK, not just parseable messages: an unparseable file squatting on max+1
  // used to make the claim loop retry the same taken number five times and orphan the reply.
  const clean = (v: string): string => v.replace(/[^A-Za-z0-9 ,.;:!?()\/'-]/g, " ").slice(0, 60); // outgoing YAML stays YAML whatever the question contained
  const composedAt = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const diskSeqs = readdirSync(MESSAGES).map((f) => /^(\d{4,})-/.exec(f)?.[1]).filter(Boolean).map(Number);
    const seq = (diskSeqs.length ? Math.max(...diskSeqs) : 0) + 1;
    const nn = String(seq).padStart(4, "0");
    if (readdirSync(MESSAGES).some((f) => f.startsWith(`${nn}-`))) continue;
    if (existsSync(join(CONTROL, "PAUSE"))) { console.log("PAUSE present — holding reply"); return "hold"; }
    if (!budgetAllows()) { console.log("budget spent — holding reply until the floor reopens"); return "hold"; }
    // Read-before-write (protocol turn-taking rule 3): if the human spoke while we were composing, this
    // reply was written against a stale floor — hold and recompose rather than posting past the moderator.
    const newHuman = listMessages().some((m) => m.from === "brian" && statSync(join(MESSAGES, m.file)).mtimeMs > composedAt);
    if (newHuman) { console.log("human message arrived mid-compose — holding to recompose"); return "hold"; }
    const text = body + footer;
    const fm = `---\nfrom: ${HANDLE}\nto: ${q.from.replace(/[^a-z0-9-]/gi, "")}\nseq: ${seq}\nin_reply_to: ${q.seq}\nprotocol: "1.6"\nchars: ${text.length}\ndate: ${new Date().toISOString()}\nsubject: "re: ${clean(q.body.trim())}"\nevidence:\n  - ~/code/tessera/graphs/${GRAPH}/graph.db\n---\n\n${text}\n`;
    const tmp = join(MESSAGES, `.${nn}-${HANDLE}.md.tmp`);
    writeFileSync(tmp, fm);
    try {
      renameSync(tmp, join(MESSAGES, `${nn}-${HANDLE}.md`));
      console.log(`answered ${q.file} as ${nn}-${HANDLE}.md (grounded=${res.grounded}, declined=${res.declined})`);
      return "posted";
    } catch { /* lost the race — loop re-reads and takes the next number */ }
  }
  console.error(`could not claim a seq for the reply to ${q.file} — holding for retry, not orphaning`);
  return "hold";
}

// --- main loop ------------------------------------------------------------------------------------------
const answered = new Set<string>();
const attempts = new Map<string, number>();
const holds = new Map<string, number>();
const MAX_ATTEMPTS = 3;
// On startup, mark the archive as seen — EXCEPT addressed questions no historian reply answers yet. The
// first live question was orphaned by the old mark-before-answer order (crash after marking = permanent
// silence), so startup now recovers any pending question instead of pretending the past is settled.
{
  const msgs = listMessages();
  const answeredSeqs = new Set(
    msgs.filter((m) => m.from === HANDLE).map((m) => {
      const raw = readFileSync(join(MESSAGES, m.file), "utf8").replace(/\r\n/g, "\n");
      const front = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";   // frontmatter ONLY — a body quoting the field must not count
      return /^in_reply_to:\s*(\d+)\s*$/m.exec(front)?.[1];
    }).filter(Boolean).map(Number),
  );
  for (const m of msgs) {
    if (m.to.trim() === HANDLE && m.from !== HANDLE && !answeredSeqs.has(m.seq)) continue; // leave pending
    answered.add(m.file);
  }
}

console.log(`historian up: watching ${MESSAGES}, graph '${GRAPH}', model ${MODEL ?? "(default)"}. Answering only 'to: ${HANDLE}'.`);
for (;;) {
  try {
    for (const m of listMessages()) {
      if (answered.has(m.file)) continue;
      if (m.from === HANDLE || m.to.trim() !== HANDLE) { answered.add(m.file); continue; }
      const heldUntil = holds.get(m.file) ?? 0;
      if (Date.now() < heldUntil) continue; // held (PAUSE/budget): back off, don't re-run the pipeline every poll
      const tries = (attempts.get(m.file) ?? 0) + 1;
      attempts.set(m.file, tries);
      console.log(`question from ${m.from} in ${m.file} (attempt ${tries})`);
      try {
        const outcome = await answer(m);
        if (outcome === "posted") { answered.add(m.file); holds.delete(m.file); break; } // one message per turn (protocol rule 3)
        else {
          // A hold is not a failure: refund the attempt and wait for the floor rather than the error budget.
          attempts.set(m.file, tries - 1);
          holds.set(m.file, Date.now() + 60_000);
        }
      } catch (e) {
        console.error(`answer failed for ${m.file}:`, (e as Error).message);
        if (tries >= MAX_ATTEMPTS) {
          answered.add(m.file);
          console.error(`giving up on ${m.file} after ${tries} attempts — orphaned, and the log says so loudly`);
        }
      }
    }
  } catch (e) {
    console.error("historian loop error:", (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
