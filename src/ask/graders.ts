/**
 * R3's deterministic graders. The governing rule, from the channel exchange (message 0025): grade against
 * gold structure AUTHORED WITH THE QUESTION, never against a judge's impression of the answer. The
 * embeddings_experiments RAG track abandoned LLM-as-judge when Llama-3 judge variance (~1.1 sd) swamped the
 * signal (~0.14); everything here is a string computation.
 *
 * EM/F1 are vendored from the HotpotQA-official implementations in
 * ~/code/embeddings_experiments/experiments/rescore_with_official_metrics.py (claude-code's offer, message
 * 0025) — ported line-for-line so the numbers are comparable with that repo's baselines.
 */

/** Official HotpotQA answer normalization: lowercase, strip punctuation, drop articles, collapse space. */
export function normalizeAnswer(s: string): string {
  const lower = s.toLowerCase();
  const noPunc = [...lower].filter((ch) => !`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`.includes(ch)).join("");
  const noArticles = noPunc.replace(/\b(a|an|the)\b/g, " ");
  return noArticles.split(/\s+/).filter(Boolean).join(" ");
}

export function exactMatch(prediction: string, groundTruth: string): boolean {
  return normalizeAnswer(prediction) === normalizeAnswer(groundTruth);
}

/** Token-level F1, official implementation. */
export function f1Score(prediction: string, groundTruth: string): number {
  const pred = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const truth = normalizeAnswer(groundTruth).split(" ").filter(Boolean);
  if (pred.length === 0 || truth.length === 0) return pred.length === truth.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const t of truth) counts.set(t, (counts.get(t) ?? 0) + 1);
  let numSame = 0;
  for (const t of pred) {
    const c = counts.get(t) ?? 0;
    if (c > 0) { numSame++; counts.set(t, c - 1); }
  }
  if (numSame === 0) return 0;
  const precision = numSame / pred.length;
  const recall = numSame / truth.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * One QA item: the gold structure authored WITH the question, before any model runs.
 *
 * `floor: true` marks a question the record cannot answer — the only correct behaviour is declining.
 * Registered lesson from authoring: a floor question must be VERIFIED absent (grep the corpus), because the
 * first candidate floor question ("what did scout score the archers edge?") turned out to be answerable —
 * the prediction was wrong and only the check caught it.
 */
export interface QaItem {
  id: string;
  question: string;
  floor: boolean;
  /** acceptable gold answers (any match counts); empty for floor questions */
  gold_answers: string[];
  /** message seqs (e.g. "0013") whose chunks are valid citation sources; empty for floor questions */
  gold_seqs: string[];
  /** claim id in claims.md this question touches, with the status the answer must reflect */
  claim?: { id: string; must_reflect_status: "live" | "retired" | "pending" };
}

export interface QaGrade {
  id: string;
  floor: boolean;
  /** floor: declined is the pass. answerable: not-declined is required for any credit. */
  decline_correct: boolean;
  em: boolean;
  f1: number;
  /** every citation's chunk belongs to a gold seq (vacuously false when no citations) */
  citation_correct: boolean;
  /** answer mentions the claim's current status when the item demands it (string check, claims.md is gold) */
  staleness_correct: boolean | null;
  /** did ANY gold seq's chunk surface in recall's candidate set? (retrieval, graded separately from answering) */
  recall_hit: boolean | null;
  grounded: boolean;
}

export interface AskLike {
  answer: string;
  declined: boolean;
  grounded: boolean;
  citations: { chunk_name?: string; verdict: string }[];
  recall: { chunks: { name: string }[] };
}

/** chunk names look like "chunk 2 of 0010-claude-code" — the seq is extractable by substring */
const chunkInSeqs = (chunkName: string | undefined, seqs: string[]): boolean =>
  !!chunkName && seqs.some((s) => chunkName.includes(` of ${s}-`) || chunkName.endsWith(` of ${s}`) || chunkName.includes(`${s}-`));

export function gradeItem(item: QaItem, res: AskLike, claimStatusInLedger?: string): QaGrade {
  const declineCorrect = item.floor ? res.declined : !res.declined;

  const em = !item.floor && !res.declined && item.gold_answers.some((g) => exactMatch(res.answer, g));
  const f1 = item.floor || res.declined ? 0 : Math.max(0, ...item.gold_answers.map((g) => f1Score(res.answer, g)));

  const citationCorrect =
    !item.floor && !res.declined && res.citations.length > 0 &&
    res.citations.every((c) => chunkInSeqs(c.chunk_name, item.gold_seqs));

  let stalenessCorrect: boolean | null = null;
  if (item.claim && !res.declined) {
    // the answer must carry the claim's CURRENT status word; the ledger passed in is the gold source
    const status = claimStatusInLedger ?? item.claim.must_reflect_status;
    stalenessCorrect = res.answer.toLowerCase().includes(status.toLowerCase());
  }

  const recallHit = item.floor
    ? null
    : res.recall.chunks.some((c) => chunkInSeqs(c.name, item.gold_seqs));

  return {
    id: item.id,
    floor: item.floor,
    decline_correct: declineCorrect,
    em,
    f1,
    citation_correct: citationCorrect,
    staleness_correct: stalenessCorrect,
    recall_hit: recallHit,
    grounded: res.grounded,
  };
}
