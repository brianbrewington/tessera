// Session-log ingest: a conversation becomes a stream of turns, each an extractable unit.
//
// Deliberately NOT a new node type. `SESSION` and `AGENT` are declared in the schema and written nowhere,
// and the SESSION round's disposition is that adding two more writerless types to a ledger already carrying
// eleven makes the ledger worse. So a session is a `SOURCE` with subtype "session" and a turn is a `SOURCE`
// with subtype "turn", which means turns ride the existing dirty/clean extraction machinery unchanged: same
// claim, same poison guard, same `tessera report` and `GET /status`.
//
// This is also the kill test recorded in docs/backlog.md: ingest a real session through the ordinary path
// and see whether any consumer needs it to be anything else. If a plain SOURCE suffices, the SESSION
// unification reduces to a pipeline-reuse claim provable the day a dream exists, at zero schema cost.
import type { Graph } from "../graph.js";
import type { Meta } from "../schema.js";
import { readSession, type ReadSessionOptions } from "./session-adapter.js";
import { sessionIdentity, turnIdentity } from "../extract/identity.js";
import { PROMPT_VERSION } from "../extract/extractor.js";

/** Namespace for the identity key, so another runtime's logs cannot collide with these. */
export const SESSION_NS = "claude-code";

export interface SessionIngestResult {
  key: string;
  title: string;
  path: string;
  turns: number;
  /** Turns now owing extraction. */
  queued: number;
  /** Turns already extracted under the current prompt — the append-only property, visible. */
  reused: number;
  turnIds: string[];
  skipped: Record<string, number>;
}

export async function ingestSession(
  graph: Graph,
  path: string,
  opts: ReadSessionOptions & { promptVersion?: string } = {},
): Promise<SessionIngestResult> {
  const promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  const read = readSession(path, opts);
  const meta: Meta = { actor: "ingest", cause: `ingest-session ${read.key}` };

  // The SESSION node is STREAM-addressed: its identity is the runtime's sessionId, never a hash of its
  // content. A live log grows while you work, so a content hash would make it a different document on every
  // read, minting a fresh source and duplicating every turn beneath it. See identity.ts.
  const sVec = await graph.embedder.embed(read.title);
  const session = await graph.store.putNode(
    {
      type: "SOURCE", subtype: "session", origin: "ingest",
      text: sessionIdentity(SESSION_NS, read.key),
      name: read.title,
      description: `Conversation ${read.key}${read.cwd ? ` in ${read.cwd}` : ""}`,
      provenance: { path: read.path, key: read.key, cwd: read.cwd, gitBranch: read.gitBranch, ns: SESSION_NS },
    },
    meta, sVec,
  );

  const turnIds: string[] = [];
  let reused = 0;
  for (const turn of read.turns) {
    // TURN identity is the runtime's record uuid, so re-reading a grown log makes every existing turn an
    // identity hit that reinforces and only new turns append. That is the whole append-only story, and it
    // holds even if every scrap of bookkeeping is lost.
    const tVec = await graph.embedder.embed(turn.text.slice(0, 6000));
    const node = await graph.store.putNode(
      {
        type: "SOURCE", subtype: "turn", origin: "ingest",
        text: turnIdentity(SESSION_NS, read.key, turn.id),
        name: `${turn.speaker}, turn ${turn.index + 1}`,
        // VERBATIM. Brian's standing principle is that his words are kept exactly, dated, and attributable,
        // so he can return later and confirm he did say a thing. Never prefixed, never reformatted.
        description: turn.text,
        // Speaker and timestamp live here, which is the binding constraint from the SESSION round. Attribution
        // as NODES (a PERSON for the human, an AGENT for the model) waits: AGENT is a deferred type and its
        // identity scheme is an open question, so deciding it now would be deciding in the abstract.
        provenance: {
          path: read.path, key: read.key, index: turn.index,
          speaker: turn.speaker, role: turn.role, ts: turn.ts,
        },
      },
      // effectiveAt dates the node at the moment it was SAID, not the moment it was ingested. Without this a
      // whole conversation would carry one timestamp and "when did he say that" becomes unanswerable.
      turn.ts ? { ...meta, effectiveAt: Date.parse(turn.ts) || undefined } : meta,
      tVec,
    );
    await graph.store.putEdge(
      {
        from: node.id, to: session.id, kind: "ORIGINATED_FROM",
        reason: `turn ${turn.index + 1} is part of ${read.title}`, origin: "ingest",
      },
      meta,
    );
    turnIds.push(node.id);
    if (graph.store.isExtracted(node.id, promptVersion)) reused++;
  }

  return {
    key: read.key, title: read.title, path: read.path,
    turns: read.turns.length, queued: read.turns.length - reused, reused,
    turnIds, skipped: read.skipped,
  };
}
