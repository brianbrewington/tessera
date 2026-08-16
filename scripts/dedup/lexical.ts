/**
 * The lexical relation between two entity names — shared by E6 (candidate mining) and E7 (the proposal
 * ladder), because a stratum that means different things in the two scripts would make their numbers
 * incomparable, which is the whole point of stratifying.
 *
 * WHY THIS IS ITS OWN MODULE: the four strata are the axis every downstream number is reported along, and
 * the protocol's hardest-won lesson is that a positive set built by a string rule cannot evaluate a string
 * feature. Keeping the string rule in one place, tested, is how that stays checkable.
 */

export type Stratum = "identical" | "containment" | "token" | "disjoint";

export const normName = (s: string): string => s.trim().toLowerCase();

/** Case- and punctuation-insensitive form. This is Layer 1's grouping key (`src/resolve/view.ts`). */
export const stripName = (s: string): string => normName(s).replace(/[^a-z0-9]/g, "");

/**
 * Tokens for the lexical stratum. Splits camelCase as well as snake/kebab/path separators, because roughly
 * half this corpus is identifiers: without the camelCase split, `getLayout` is one token, `putLayout` is
 * another, and the token stratum would be empty on exactly the population it exists to describe.
 * Single characters are dropped — `x`/`vx` sharing "x" is noise, not evidence.
 */
export const nameTokens = (s: string): Set<string> =>
  new Set(
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );

/**
 * identical   — Layer 1 already resolves this pair for free; it is never a candidate.
 * containment — one stripped name contains the other (`Brian` / `Brian Brewington`), the protocol's own
 *               example of the residue. Measured on testgraph this is where the real duplicates live, mixed
 *               with near-miss negatives (`x`/`vx`, `to_id`/`id`), which is what makes it a hard test set.
 * token       — share at least one multi-character token, neither contains the other.
 * disjoint    — no shared token at all. The population that has never been measured.
 */
export function stratumOf(a: string, b: string): Stratum {
  const sa = stripName(a), sb = stripName(b);
  if (sa && sa === sb) return "identical";
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return "containment";
  const ta = nameTokens(a), tb = nameTokens(b);
  for (const t of ta) if (tb.has(t)) return "token";
  return "disjoint";
}
