/**
 * E0 scoring — join the blind audit answers to the withheld key and bound contamination per set.
 * Protocol: docs/dedup-experiment-protocol.md, section E0. The decision rules were frozen before the audit.
 *
 * Contamination means "this set is not what the protocol claimed it was":
 *   - a P (positive) set is contaminated by every pair the human calls NOT-same
 *   - an N (negative) set is contaminated by every pair the human calls SAME
 * The N sets are audited alongside the P sets deliberately: a judge who answers "same" to everything is
 * caught by N-random, and this run's N-random result is exactly that check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as {
  audit_key: { qid: string; set: string }[];
};
const answers = (JSON.parse(readFileSync(join(dir, "audit-answers.json"), "utf8")) as { answers: Record<string, string> }).answers;

/**
 * Wilson score interval. Registered in the protocol as the way contamination is reported, and it is the
 * right choice here precisely BECAUSE the samples are small: a naive point estimate of 0/10 reads as "0%
 * contamination, proven", which is a claim n=10 cannot support. Wilson makes the uncertainty visible instead
 * of hiding it behind a zero.
 */
function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

const POSITIVE = new Set(["P-jitter", "P-variant"]);
const bySet = new Map<string, { n: number; bad: number; unsure: number; badQids: string[] }>();
for (const { qid, set } of labels.audit_key) {
  const a = answers[qid];
  if (!bySet.has(set)) bySet.set(set, { n: 0, bad: 0, unsure: 0, badQids: [] });
  const rec = bySet.get(set)!;
  if (a === undefined) continue;
  // An "unsure" is NOT a clean judgment and must not sit in the contamination denominator as though it
  // were. Counting it in `n` while never counting it in `bad` silently reports it as evidence the set is
  // clean. Found by the analogy_maker instance's note (docs/notes/, 2026-08-08 §5b): an "I can't call this"
  // is a property of the rater at that moment, and 30 verdicts of which 18 are unsure is not 30 verdicts.
  // It happens to change nothing here because Brian returned zero unsures, which is exactly why it would
  // have survived to bite a later run.
  if (a === "unsure") { rec.unsure++; continue; }
  rec.n++;
  const contaminated = POSITIVE.has(set) ? a === "not-same" : a === "same";
  if (contaminated) { rec.bad++; rec.badQids.push(qid); }
}

const out: Record<string, unknown> = {};
console.log("set".padEnd(11), "n".padEnd(4), "contaminated".padEnd(14), "rate".padEnd(8), "95% CI".padEnd(18), "registered rule");
for (const [set, r] of bySet) {
  const w = wilson(r.bad, r.n);
  const rule = POSITIVE.has(set) ? "usable iff upper bound <= 10%" : set === "N-hard" ? "replace iff contamination > 10%" : "sanity check on the judge";
  console.log(
    set.padEnd(11), String(r.n).padEnd(4), `${r.bad}${r.unsure ? ` (+${r.unsure} unsure)` : ""}`.padEnd(14),
    `${(100 * r.bad / r.n).toFixed(1)}%`.padEnd(8),
    `[${(100 * w.lo).toFixed(1)}%, ${(100 * w.hi).toFixed(1)}%]`.padEnd(18), rule,
  );
  out[set] = { n: r.n, contaminated: r.bad, unsure: r.unsure, rate: r.bad / r.n, ci95: w, contaminated_qids: r.badQids };
}

// The pre-registered rule is stated on the UPPER BOUND, so evaluate it on the upper bound and report when
// the sample cannot reach it. At n=15 even a flawless result has a Wilson upper bound near 20%, so a "<=10%
// upper bound" verdict is arithmetically unreachable at the registered sample size. That is a flaw in the
// pre-registration, not a property of the data, and it has to be said out loud rather than quietly swapped
// for the point estimate.
const minNFor10pct = ((): number => {
  for (let n = 1; n <= 5000; n++) if (wilson(0, n).hi <= 0.10) return n;
  return -1;
})();
console.log(`\nsmallest n at which a FLAWLESS audit could clear a 10% upper bound: ${minNFor10pct} pairs per set`);

writeFileSync(join(dir, "e0-contamination.json"), JSON.stringify({
  experiment: "E0 (scored)", protocol: "docs/dedup-experiment-protocol.md",
  per_set: out,
  rule_reachability: { rule: "P-set contamination upper bound <= 10%", min_n_for_zero_error_pass: minNFor10pct },
}, null, 1));
