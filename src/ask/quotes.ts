/**
 * Verbatim-quote verification — the mechanical half of the cite-or-decline contract.
 *
 * Born in E10 (span-grounded extraction) and promoted to src/ because `ask` (R2) applies the same rule at
 * ANSWER time: a claim in an answer must quote a retrieved chunk verbatim, and the quote is verified
 * mechanically before the answer is shown. One verifier, two call sites — extraction-time and answer-time —
 * so the two gates cannot drift apart.
 *
 * Normalization is whitespace and case ONLY (a registered E10 decision: punctuation stripping over-matches,
 * and over-matching is how a confabulation gate stops gating). `near_miss` (edit distance ≤ 5) is a
 * diagnostic category, never a survival.
 */

/** Whitespace and case only. */
export const normQuote = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

export type QuoteVerdict = "verified" | "near_miss" | "unmatched" | "missing";

/** Bounded Levenshtein: true iff distance ≤ maxDist. Early-exits when a whole row exceeds the bound. */
export function withinEditDistance(a: string, b: string, maxDist: number): boolean {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > maxDist) return false;
    prev = cur;
  }
  return prev[b.length]! <= maxDist;
}

/**
 * Verdict for one quote against one text. The near-miss scan only runs after the substring test fails,
 * which the registered rules expect to be the minority path.
 */
export function verifyQuote(quote: string | undefined, text: string): QuoteVerdict {
  if (!quote || !quote.trim()) return "missing";
  const q = normQuote(quote);
  const c = normQuote(text);
  if (q.length < 3) return "missing"; // a one-character "quote" grounds nothing
  if (c.includes(q)) return "verified";
  const MAX = 5;
  for (let w = Math.max(3, q.length - MAX); w <= q.length + MAX; w++) {
    for (let i = 0; i + w <= c.length; i += Math.max(1, Math.floor(w / 4))) {
      if (withinEditDistance(q, c.slice(i, i + w), MAX)) return "near_miss";
    }
    if (w > c.length) break;
  }
  return "unmatched";
}
