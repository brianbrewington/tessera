// Claude Code session logs, as enumerable turns.
//
// INGESTING A SESSION IS A SELECTION PROBLEM, NOT A CONVERSION PROBLEM. Measured on this project's own logs
// (5 files, 18 MB, 3551 records), the conversational payload by bytes is: tool_result 45.7%, tool_use 23.3%,
// thinking 14.7%, image 11.1%, and text 5.2%. Stripping system reminders, actual prose is 274 KB — 1.5% of
// the raw bytes. Converted literally a session becomes ~12,000 chunks of command output and diffs, roughly 25
// hours of extraction, and a graph buried in file paths. Selected properly it is ~187 chunks and ~23 minutes.
//
// So this adapter's job is deciding what counts. Reformatting is the easy part.
//
// It preserves TURNS, with speaker and timestamp, because that is the binding constraint recorded in
// docs/backlog.md: a first ingest that flattens a transcript to prose destroys turn structure, attribution
// and the self-versus-other distinction, and forecloses the SESSION unification. Provenance becomes "Brian
// said this, on this date, in this conversation" rather than "chunk 41 of some file", and for this corpus
// attribution is most of the value.
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export interface SessionTurn {
  /** The runtime's record uuid. The identity anchor: stable across re-reads of a growing log. */
  id: string;
  /** "user" | "assistant" — who produced it. */
  role: string;
  /** Display name for the speaker; the caller supplies the human's, the model side is labelled generically. */
  speaker: string;
  text: string;
  /** ISO string from the record, kept verbatim. */
  ts: string | null;
  /** Position in the filtered stream, for ordering and display only — never for identity. */
  index: number;
}

export interface SessionRead {
  /** Stable stream key: the runtime's sessionId, falling back to the filename. */
  key: string;
  title: string;
  path: string;
  cwd: string | null;
  gitBranch: string | null;
  turns: SessionTurn[];
  /** Every record kind that was deliberately not taken, and how many. Never a silent drop. */
  skipped: Record<string, number>;
}

export function isSessionLog(path: string): boolean {
  return extname(path).toLowerCase() === ".jsonl";
}

/**
 * A system reminder is harness scaffolding injected into the user turn, not something the human said.
 * Keeping it would attribute the harness's words to Brian, which is the precise failure attribution exists to
 * prevent.
 */
function stripScaffolding(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-message>/g, "")
    .trim();
}

/** Text blocks only. Everything else is refused, and counted so the refusal is visible. */
function textOf(content: unknown, skipped: Record<string, number>): string {
  if (typeof content === "string") return stripScaffolding(content);
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") out.push(block.text);
    else if (block.type) skipped[block.type] = (skipped[block.type] ?? 0) + 1;
  }
  return stripScaffolding(out.join("\n\n"));
}

export interface ReadSessionOptions {
  /** What to call the human. The log records `userType`, never a name. */
  userName?: string;
  /** What to call the model side. Deliberately not a model id: AGENT identity is an open question. */
  assistantName?: string;
  /** Include sub-agent transcripts. Off by default: they are their own sessions, not turns of this one. */
  includeSidechains?: boolean;
}

export function readSession(path: string, opts: ReadSessionOptions = {}): SessionRead {
  const userName = opts.userName ?? "the operator";
  const assistantName = opts.assistantName ?? "the assistant";
  const raw = readFileSync(path, "utf8");
  const turns: SessionTurn[] = [];
  const skipped: Record<string, number> = {};
  let key = "";
  let cwd: string | null = null;
  let gitBranch: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { skipped.unparseable = (skipped.unparseable ?? 0) + 1; continue; }

    if (!key && typeof rec.sessionId === "string") key = rec.sessionId;
    if (cwd === null && typeof rec.cwd === "string") cwd = rec.cwd;
    if (gitBranch === null && typeof rec.gitBranch === "string") gitBranch = rec.gitBranch;

    const type = rec.type;
    if (type !== "user" && type !== "assistant") {
      // ai-title, mode, file-history-snapshot, queue-operation and friends: harness bookkeeping.
      skipped[typeof type === "string" ? type : "unknown"] = (skipped[typeof type === "string" ? type : "unknown"] ?? 0) + 1;
      continue;
    }
    if (rec.isSidechain === true && !opts.includeSidechains) {
      skipped.sidechain = (skipped.sidechain ?? 0) + 1;
      continue;
    }

    const message = (rec.message ?? {}) as { content?: unknown };
    const text = textOf(message.content, skipped);
    if (!text) { skipped.empty = (skipped.empty ?? 0) + 1; continue; }

    const id = typeof rec.uuid === "string" && rec.uuid ? rec.uuid : `idx${turns.length}`;
    turns.push({
      id,
      role: type,
      speaker: type === "user" ? userName : assistantName,
      text,
      ts: typeof rec.timestamp === "string" ? rec.timestamp : null,
      index: turns.length,
    });
  }

  if (!key) key = basename(path, extname(path));
  const first = turns.find((t) => t.role === "user");
  // A session has no title of its own that this parser can trust, so use its opening request, truncated.
  // Better than the uuid, and honest about being derived.
  const title = first ? `session: ${first.text.replace(/\s+/g, " ").slice(0, 60)}` : `session ${key.slice(0, 8)}`;
  return { key, title, path, cwd, gitBranch, turns, skipped };
}
