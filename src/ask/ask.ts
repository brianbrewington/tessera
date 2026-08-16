/**
 * R2 — `tessera ask`: grounded QA over any tessera graph, under the cite-or-decline contract.
 * Approved as decision D1 (channel message 0027); design commitments in 0024, eval conditions in 0025.
 *
 * THE CONTRACT, enforced in three places rather than requested in one:
 *   1. The prompt demands every claim carry a citation: a chunk index plus a VERBATIM quote.
 *   2. The answer is parsed structurally (no confidence field — every metric downstream is a choice rate).
 *   3. Every quote is verified MECHANICALLY against the cited chunk with the same verifier E10 uses at
 *      extraction time (`src/ask/quotes.ts`). An answer's trust markers are computed, never self-reported.
 *
 * Refusal is a first-class outcome. C2 says models refuse well; C1 says they free-associate badly — so the
 * contract makes "not in the record" cheap to say and confabulation expensive to get away with.
 */
import type { GraphStore } from "../store/graphStore.js";
import type { Embedder } from "../embedder.js";
import type { Chat } from "../llm.js";
import { jsonObjectCandidates } from "../extract/extractor.js";
import { verifyQuote, type QuoteVerdict } from "./quotes.js";
import { recall, type RecallResult } from "./recall.js";

export const ASK_SYSTEM = `You answer questions strictly from the numbered EXCERPTS provided. You have no other knowledge for this task.

Rules:
- Every claim in your answer must be supported by a citation: the excerpt number and a VERBATIM quote copied
  character-for-character from that excerpt — INCLUDING markdown characters like **, backticks, and
  underscores exactly as they appear. Do not paraphrase, do not abridge with ellipses, do not skip
  parentheticals mid-quote: copy a contiguous span exactly.
- If the excerpts do not contain the answer, decline: set "declined" true and say what is missing. Declining
  when the record is silent is a correct answer. Guessing is a wrong answer.
- Answer concisely. Reply with a single JSON object and no other text:
{"answer":"...","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"..."}]}`;

export interface Citation {
  excerpt: number;
  quote: string;
  /** computed by verifyQuote against the cited excerpt — never model-reported */
  verdict: QuoteVerdict | "bad_index";
  chunk_name?: string;
}
export interface AskResult {
  question: string;
  answer: string;
  declined: boolean;
  decline_reason: string;
  citations: Citation[];
  /** all citations verified verbatim (false for a declined answer with no citations — check `declined`) */
  grounded: boolean;
  recall: RecallResult;
  parse_error?: string;
}

export function renderContext(r: RecallResult): string {
  return r.chunks
    .map((c, i) => `EXCERPT ${i + 1} (from ${c.name || "unknown"}):\n${c.text}`)
    .join("\n\n---\n\n");
}

export function parseAskReply(raw: string): { answer: string; declined: boolean; flag_miscompliance?: boolean; decline_reason: string; citations: { excerpt: number; quote: string }[] } | null {
  for (const cand of jsonObjectCandidates(raw)) {
    let o: unknown;
    try { o = JSON.parse(cand); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    if (typeof rec.answer !== "string" && typeof rec.declined !== "boolean") continue;
    const cits = Array.isArray(rec.citations) ? rec.citations : [];
    // Flag-miscompliance normalization, registered from the first R3 run: qwen2.5:14b refuses correctly but
    // writes {"answer":"declined","declined":false} — the refusal is real, the flag is broken. An answer
    // TEXT that is itself a bare refusal, with no citations, IS a decline; counting it as an answer would
    // score correct refusals as floor failures (4 of 5 did exactly this). Parser tolerance of the same kind
    // as accepting a stringified boolean — and `flag_miscompliance` is surfaced, never silently fixed.
    const answerText = typeof rec.answer === "string" ? rec.answer : "";
    const textIsRefusal = /^\s*(declined?|not in the record|cannot answer|no answer)\.?\s*$/i.test(answerText);
    const flagMiscompliance = rec.declined !== true && textIsRefusal && cits.length === 0;
    return {
      answer: answerText,
      declined: rec.declined === true || flagMiscompliance,
      flag_miscompliance: flagMiscompliance,
      decline_reason: typeof rec.decline_reason === "string" ? rec.decline_reason : "",
      citations: cits
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ excerpt: Number(c.excerpt), quote: typeof c.quote === "string" ? c.quote : "" })),
    };
  }
  return null;
}

export async function ask(
  store: GraphStore,
  embedder: Embedder,
  chat: Chat,
  question: string,
  opts: { model?: string; temperature?: number } = {},
): Promise<AskResult> {
  const r = await recall(store, embedder, question);
  const user = `${renderContext(r)}\n\nQUESTION: ${question}`;
  const raw = await chat.complete(ASK_SYSTEM, user, { temperature: opts.temperature ?? 0, model: opts.model });
  const parsed = parseAskReply(raw);
  if (!parsed) {
    return {
      question, answer: "", declined: true, decline_reason: "unparseable model reply",
      citations: [], grounded: false, recall: r, parse_error: raw.slice(0, 400),
    };
  }
  const citations: Citation[] = parsed.citations.map((c) => {
    const chunk = r.chunks[c.excerpt - 1];
    if (!chunk) return { excerpt: c.excerpt, quote: c.quote, verdict: "bad_index" as const };
    return { excerpt: c.excerpt, quote: c.quote, verdict: verifyQuote(c.quote, chunk.text), chunk_name: chunk.name };
  });
  // Grounded = a substantive answer whose every citation verifies verbatim, with at least one citation.
  // near_miss deliberately does NOT count: the registered E10 rule — a diagnostic, never a survival.
  const grounded = !parsed.declined && citations.length > 0 && citations.every((c) => c.verdict === "verified");
  return { question, ...parsed, citations, grounded, recall: r };
}
