/**
 * E7 — the merge/edge proposal ladder. Brian's experiment, and the probe the ingest overhaul is built on.
 *
 * THE QUESTION, in his words: given node name, inferred type, and source context for both ends, ask a model
 * "are these the same thing?" — and, when the answer is no, "are they related, and if so how?" Run that across
 * models of different strength and ground it by running Claude Haiku on the same items.
 *
 * WHY THE SECOND QUESTION IS NOT A CONSOLATION PRIZE. E3 asked same/NONE only, so every "no" was discarded.
 * Measured on E6's candidates, the structural-mining population is overwhelmingly related-but-distinct
 * (HYPOTHESIS/EVIDENCE, sqlite-vec/WAL, SUPPORTS/REFUTES), which means the edge question has more to grade
 * here than the merge question does. It also supplies a falsifier E3 lacked: a model that answers "not same"
 * to everything must then produce a relation for every pair, and a model that is merely refusing will produce
 * empty or vacuous ones.
 *
 * WHAT E3 GOT WRONG AND THIS DOES NOT. E3's system prompt said "Most of the time the correct answer is NONE.
 * Prefer NONE whenever you are not sure." That is a conservatism knob, set arbitrarily by me, and hit-recall
 * and null-abstention trade off directly along it — which is why E3's verdict says nothing about whether the
 * models can do this. The prompt below is deliberately BALANCED: the same/not-same rule is stated in both
 * directions in one breath, and no preference is expressed for either answer.
 *
 * AND I MADE THE SAME MISTAKE AGAIN IN QUESTION 2, which a cross-agent review (Grok 4.6, 2026-08-16) caught
 * before the scored run. The first draft balanced Q1 and then asked Q2 as "are they related? If they are,
 * name the relation" — offering the affirmative branch in prose and the negative branch only as a token in
 * the JSON template. That is E3's knob pointed the other way. The pilot's headline (both arms invented a
 * relation for nearly every random floor pair) is therefore NOT clean evidence of model yes-bias: it is
 * confounded with my own leading question. Q2 now names both outcomes in one breath, exactly as Q1 does, and
 * `test/dedup-e7-harness.test.ts` asserts the both-branches phrasing for BOTH questions.
 *
 * The wording went through one more pass. My first repair gave the negative branch the vivid clause ("some
 * are simply two unconnected things that happen to appear in the same corpus") and the positive branch three
 * words, which is a mild tilt back toward NONE — safe in direction, since it fails models rather than passing
 * them, but still not balanced. Q2 now mirrors Q1's structure exactly: one definitional sentence per branch,
 * one instruction sentence per branch, equal specificity.
 *
 * TWO CONTROLS, because a bare accuracy number on unlabeled pairs means nothing:
 *   CEILING — strip-identical pairs whose raw names differ (contentHash/content_hash, GraphStore/Graph Store).
 *             Layer 1 resolves these for free. A model that cannot call these "same" is not usable at all.
 *   FLOOR   — random pairs with ZERO structural signal and no lexical relation of any kind. E3's decoy
 *             discipline: a "same" here is a grab, and this is the one false-positive rate that needs no
 *             labels and no human. (An earlier version of this comment also claimed "different source
 *             documents". That filter was never implemented, and a comment promising a control the code does
 *             not apply is worse than no comment. The shared-chunk exclusion covers the case it was reaching
 *             for, since a pair sharing a document almost always shares a chunk.)
 *
 * NO COSINES ARE SHOWN TO ANY MODEL (geometry in the prompt is geometry deciding), NO CONFIDENCE FIELD EXISTS
 * IN THE SCHEMA (every metric is a choice rate, never a self-reported score), and PARSE FAILURES GET THEIR OWN
 * COUNTER rather than being folded into "no". All three are standing rules from the protocol.
 *
 * ARMS ARE KEPT COMPARABLE. Ollama can force JSON with `format: "json"` and the Claude CLI cannot, so forcing
 * it on one side would confound model strength with decoding mode. Nothing is forced anywhere; parsing is
 * robust and failures are counted.
 *
 * Read-only over graph.db. Writes JSON sidecars only. Never touches the fixture.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stripName as strip, stratumOf } from "./lexical.js";

// ---------------------------------------------------------------------------------------------------------
// the frozen prompt. Written into every sidecar before the first call, exactly as E4's arm prompts were.
// ---------------------------------------------------------------------------------------------------------
export const SYSTEM_PROMPT =
  "You compare pairs of entities that an automated pipeline extracted from a corpus of documents. " +
  "Reply with a single JSON object and no other text.";

/**
 * Bumped v1 → v2 when question 2 was rebalanced. The pilot on disk records `e7-v1` against the OLD wording,
 * so leaving this string alone would have put two materially different prompts under one version and made a
 * future reader conclude the pilot and the scored run used the same prompt. The frozen-prompt discipline is
 * the audit trail; a stale version string corrupts it more quietly than a bad number does. Caught by the
 * Fable adjudication (2026-08-16) after two cross-agent reviews missed it.
 */
export const PROMPT_VERSION = "e7-v2";

/**
 * BOTH Q2 WORDINGS ARE KEPT, and that is deliberate rather than sentimental.
 *
 * v1 is the leading form a cross-agent review caught: the affirmative branch got a prose instruction and the
 * negative branch got only a token in the JSON template. It is retained so the wording can be measured as a
 * VARIABLE instead of merely apologised for. Holding the trial set frozen and varying only this string is the
 * one experiment that can separate "models over-relate" from "I asked a leading question", and the pilot's
 * headline is uninterpretable until it runs.
 */
export const Q2_WORDINGS = {
  "e7-v1": `2. If they are not the same thing, are they related? If they are, name the relation as a short
   UPPER_SNAKE_CASE type and say which direction it runs.`,
  "e7-v2": `2. If they are not the same thing, are they related? A pair is related when there is a real connection
   between the two things themselves. A pair is not related when nothing connects them beyond appearing in
   the same corpus. If they are related, name the relation as a short UPPER_SNAKE_CASE type and say which
   direction it runs. If they are not related, answer NONE.`,
} as const;
export type Wording = keyof typeof Q2_WORDINGS;

export function renderUser(a: Side, b: Side, wording: Wording = PROMPT_VERSION as Wording): string {
  return `Two entities were extracted from a corpus of documents.

ENTITY A
  name: ${a.name}
  inferred type: ${a.subtype}
  description: ${a.description ?? "(none)"}
  source context: ${a.context ? JSON.stringify(a.context) : "(none)"}

ENTITY B
  name: ${b.name}
  inferred type: ${b.subtype}
  description: ${b.description ?? "(none)"}
  source context: ${b.context ? JSON.stringify(b.context) : "(none)"}

Answer two questions.

1. Are A and B the same thing? Two names for one underlying entity are the same thing. Two distinct things
   that are closely related are not the same thing.

${Q2_WORDINGS[wording]}

Reply with exactly this JSON object and nothing else:
{"same": true or false, "same_reason": "one sentence", "relation": "UPPER_SNAKE_CASE type, or NONE", "direction": "A_TO_B or B_TO_A or NONE", "relation_reason": "one sentence, or empty string"}`;
}

// ---------------------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------------------
export interface Side {
  id: string;
  name: string;
  subtype: string;
  description: string | null;
  context: string | null;
}
export interface Trial {
  trial: number;
  /** which population this came from — never averaged across */
  stratum: "ceiling" | "containment" | "token" | "disjoint" | "floor";
  /** true when the shuffle put the candidate's `b` first, so A/B position bias is checkable */
  swapped: boolean;
  a: Side;
  b: Side;
  signals: { chunks: number; neighbours: number; related: boolean };
}
export interface Answer {
  same: boolean | null;
  same_reason: string;
  relation: string;
  direction: string;
  relation_reason: string;
}
export interface Response {
  trial: number;
  ms: number;
  raw: string;
  parsed: Answer | null;
  parse_error?: string;
}

// ---------------------------------------------------------------------------------------------------------
// deterministic sampling — mulberry32, seed recorded in the sidecar (the protocol requires the seed)
// ---------------------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * Fisher-Yates over a COPY, from a caller-supplied stream.
 *
 * Throws when the pool cannot fill the request. It used to return the short pool silently, and that is a
 * fail-toward-green defect rather than a nicety: the ≥2 structural bar left FOUR usable containment pairs on
 * this fixture, and a silent short draw would have produced a completed-looking run whose headline stratum
 * was n=4. A stratum that cannot be filled is a design problem, and it must stop the run.
 */
function sample<T>(items: readonly T[], n: number, rand: () => number, label: string): T[] {
  if (items.length < n) throw new Error(`stratum '${label}': pool has ${items.length}, need ${n}`);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

/** Stable pair key. Sorted so a pair has no inherent order, and NUL-joined so an id containing the
 *  separator cannot forge a collision (uuids are safe today; the assembler should not depend on that). */
const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// ---------------------------------------------------------------------------------------------------------
// trial construction
// ---------------------------------------------------------------------------------------------------------
export interface BuildOpts {
  dbPath: string;
  dir: string;
  seed: number;
  /** per-stratum counts, in trial order */
  counts: { ceiling: number; containment: number; token: number; disjoint: number; floor: number };
  /** chars of originating chunk text shown per side */
  contextChars: number;
}

export function buildTrials(opts: BuildOpts): { trials: Trial[]; meta: Record<string, unknown> } {
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT id, COALESCE(name, text) AS name, COALESCE(subtype,'other') AS subtype, description
         FROM nodes WHERE COALESCE(subtype,'other') NOT IN ('chunk','document')
        ORDER BY id`,
    )
    .all() as { id: string; name: string; subtype: string; description: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // originating chunk text per entity — the first APPEARED_IN chunk, the Connector's chunkText mechanics and
  // E5's Arm-Y rule. One chunk per side, identically for both sides, so the arms differ by model alone.
  const firstChunk = new Map<string, string>();
  const app = db
    .prepare(
      `SELECT e.from_id AS ent, n.description AS txt
         FROM edges e JOIN nodes n ON n.id = e.to_id
        WHERE e.kind='APPEARED_IN' AND n.subtype='chunk'
        ORDER BY e.from_id, e.to_id`,
    )
    .all() as { ent: string; txt: string | null }[];
  for (const { ent, txt } of app) if (txt && !firstChunk.has(ent)) firstChunk.set(ent, txt);

  const side = (id: string): Side => {
    const r = byId.get(id)!;
    const ctx = firstChunk.get(id);
    return {
      id,
      name: r.name,
      subtype: r.subtype,
      description: r.description,
      context: ctx ? ctx.slice(0, opts.contextChars) : null,
    };
  };

  // --- candidate strata, from E6 -------------------------------------------------------------------------
  const candPath = join(opts.dir, "e6-candidates.json");
  if (!existsSync(candPath)) throw new Error(`missing ${candPath} — run e6-structural-candidates.ts first`);
  const { candidates } = JSON.parse(readFileSync(candPath, "utf8")) as {
    candidates: {
      a: string; b: string; stratum: string; chunks: number; neighbours: number; related: boolean;
    }[];
  };
  /**
   * THE STRUCTURAL BAR, stated accurately after a cross-agent review corrected me.
   *
   * `disjoint` pairs carry no lexical signal at all, so structure is the ONLY thing separating them from the
   * floor control — one shared chunk is barely a signal, and the bar stays at 2.
   *
   * For `containment` and `token` the bar is a NO-OP and saying otherwise was misleading: every pair in
   * e6-candidates.json already has at least one chunk or one neighbour, because that is the only way into
   * E6's map. So these two strata take E6's entire pool. That is the honest description, and it is still the
   * right choice — holding them to 2 was measured to leave FOUR usable containment pairs on this fixture,
   * which would have gutted the one stratum where the duplicate residue lives. A bar that empties the
   * population it was meant to sample is the wrong bar; a bar that admits everything should be called one.
   */
  const bar = (c: { stratum: string; chunks: number; neighbours: number; related: boolean }): boolean =>
    // A pair joined by an actual RELATED edge has structure by definition, whatever the channel counts say.
    // Without this clause, E6's newly-minted edge-only pairs were mined and then dropped before reaching any
    // model — present in the candidate file, absent from every stratum. (Composer 2.5, 2026-08-16.)
    c.related ||
    // Summed rather than per-channel: one shared chunk AND one shared neighbour is two independent pieces of
    // evidence, and the old form excluded it from `disjoint` while admitting a pair with two shared chunks
    // and nothing else. Amends the bar registered earlier the same day; nothing scored has run against it.
    (c.stratum === "disjoint" ? c.chunks + c.neighbours >= 2 : c.chunks + c.neighbours >= 1);
  // Sorted before any sampling: the JSON array arrives in E6's Map-insertion order, which follows SQLite's
  // unordered row order. Without this, the same seed draws a different trial set after a vacuum or a re-mine.
  const withStructure = candidates
    .filter(bar)
    .sort((p, q) => (pairKey(p.a, p.b) < pairKey(q.a, q.b) ? -1 : 1));

  // --- ceiling control: strip-identical pairs whose RAW names differ -------------------------------------
  // Pure type jitter (byte-identical names, different subtype) is excluded: `AGENT`/`AGENT` is the recorded
  // counterexample where Brian judged byte-identical names NOT the same thing, so it is not a ceiling.
  const byStrip = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = strip(r.name);
    if (!k) continue;
    if (!byStrip.has(k)) byStrip.set(k, []);
    byStrip.get(k)!.push(r);
  }
  const ceilingPairs: { a: string; b: string }[] = [];
  for (const [, members] of byStrip) {
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        if (members[i]!.name !== members[j]!.name) ceilingPairs.push({ a: members[i]!.id, b: members[j]!.id });
  }
  ceilingPairs.sort((p, q) => (pairKey(p.a, p.b) < pairKey(q.a, q.b) ? -1 : 1));

  /**
   * INDEPENDENT RNG STREAM PER STRATUM.
   *
   * One shared stream looked fine and was not. The floor pool is built by rejection sampling, so it consumes
   * a data-dependent number of draws — change the graph, the E6 output, or SQLite's row order and every
   * stratum sampled after it shifts, including the A/B swap coin. The recorded seed would then name a trial
   * set that cannot be rebuilt. Each stratum gets its own stream derived from the seed, so a change in one
   * cannot move another. Caught by cross-agent review (Grok 4.6, 2026-08-16) before the scored run.
   */
  const streamFor = (label: string): (() => number) => {
    let h = opts.seed >>> 0;
    for (const ch of label) h = (Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0);
    return rng(h);
  };

  // --- floor control: pairs with NO structural signal and NO lexical relation ----------------------------
  // The lexical test is `stratumOf(...) === "disjoint"`, the SAME rule E6 stratifies by. An earlier version
  // hand-rolled a weaker test (strip-inequality plus token overlap) that let `x`/`vx` and `id`/`to_id`
  // through — containment near-misses landing in the control that is supposed to contain none.
  const hasSignal = new Set(candidates.map((c) => pairKey(c.a, c.b)));
  // "floor:mine", not "floor": `draw("floor", ...)` shuffles this pool with streamFor("floor"), so sharing
  // the label would restart the identical sequence and shuffle the pool with the very numbers that built it.
  // Stream reuse inside the fix meant to eliminate stream reuse. Caught by the Fable adjudication.
  const floorRand = streamFor("floor:mine");
  const floorPairs: { a: string; b: string }[] = [];
  const floorSeen = new Set<string>();
  for (let guard = 0; guard < 500_000 && floorPairs.length < opts.counts.floor * 4; guard++) {
    const x = rows[Math.floor(floorRand() * rows.length)]!;
    const y = rows[Math.floor(floorRand() * rows.length)]!;
    if (x.id === y.id) continue;
    const k = pairKey(x.id, y.id);
    if (hasSignal.has(k) || floorSeen.has(k)) continue;   // uniqued: the same pair must not be two trials
    if (stratumOf(x.name, y.name) !== "disjoint") continue;
    floorSeen.add(k);
    floorPairs.push({ a: x.id, b: y.id });
  }

  const trials: Trial[] = [];
  const push = (
    stratum: Trial["stratum"],
    swapRand: () => number,
    p: { a: string; b: string; chunks?: number; neighbours?: number; related?: boolean },
  ) => {
    const swapped = swapRand() < 0.5; // A/B position is randomised so position bias is measurable
    const [x, y] = swapped ? [p.b, p.a] : [p.a, p.b];
    trials.push({
      trial: trials.length,
      stratum,
      swapped,
      a: side(x),
      b: side(y),
      signals: { chunks: p.chunks ?? 0, neighbours: p.neighbours ?? 0, related: p.related ?? false },
    });
  };

  const draw = (
    stratum: Trial["stratum"],
    pool: { a: string; b: string; chunks?: number; neighbours?: number; related?: boolean }[],
    n: number,
  ) => {
    const swapRand = streamFor(`${stratum}:swap`);
    for (const p of sample(pool, n, streamFor(stratum), stratum)) push(stratum, swapRand, p);
  };

  draw("ceiling", ceilingPairs, opts.counts.ceiling);
  draw("containment", withStructure.filter((c) => c.stratum === "containment"), opts.counts.containment);
  draw("token", withStructure.filter((c) => c.stratum === "token"), opts.counts.token);
  draw("disjoint", withStructure.filter((c) => c.stratum === "disjoint"), opts.counts.disjoint);
  draw("floor", floorPairs, opts.counts.floor);

  return {
    trials,
    meta: {
      seed: opts.seed,
      counts: opts.counts,
      context_chars: opts.contextChars,
      pools: {
        ceiling: ceilingPairs.length,
        containment: withStructure.filter((c) => c.stratum === "containment").length,
        token: withStructure.filter((c) => c.stratum === "token").length,
        disjoint: withStructure.filter((c) => c.stratum === "disjoint").length,
        floor: floorPairs.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// parsing — tolerant of fences and prose, but a failure is a FAILURE and is counted as one
// ---------------------------------------------------------------------------------------------------------
export function parseAnswer(raw: string): { parsed: Answer | null; error?: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { parsed: null, error: "no JSON object found" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    return { parsed: null, error: `JSON.parse: ${(e as Error).message}` };
  }
  const same =
    typeof obj.same === "boolean" ? obj.same
    : typeof obj.same === "string" ? /^(true|yes)$/i.test(obj.same.trim()) ? true : /^(false|no)$/i.test(obj.same.trim()) ? false : null
    : null;
  if (same === null) return { parsed: null, error: `unusable "same": ${JSON.stringify(obj.same)}` };
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  return {
    parsed: {
      same,
      same_reason: str(obj.same_reason),
      relation: str(obj.relation).trim().toUpperCase() || "NONE",
      direction: str(obj.direction).trim().toUpperCase() || "NONE",
      relation_reason: str(obj.relation_reason),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------------------------------------
export interface Arm {
  name: string;
  kind: "ollama" | "claude-cli";
  model: string;
}

async function askOllama(model: string, system: string, user: string, host: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 300_000);
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
        options: { temperature: 0 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const j = (await res.json()) as { message?: { content?: string } };
    return j.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

/**
 * Claude via the CLI rather than the API. There is no ANTHROPIC_API_KEY on this box and the house rule is
 * secrets by indirection / tokenless where possible, so this rides Brian's existing login. The flags matter:
 * --system-prompt REPLACES Claude Code's own, and --setting-sources '' plus --allowed-tools '' strip CLAUDE.md,
 * the teammate stack, and every tool — otherwise this would be a Claude Code session answering, not the model.
 */
function askClaudeCli(model: string, system: string, user: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "claude",
      [
        "-p",
        "--model", model,
        "--system-prompt", system,
        "--setting-sources", "",
        "--allowed-tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--max-turns", "1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("claude cli timeout")); }, 300_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude cli exit ${code}: ${err.slice(0, 400)}`));
      else resolve(out);
    });
    p.stdin.end(user);
  });
}

export async function runArm(
  arm: Arm,
  trials: readonly Trial[],
  opts: { host: string; concurrency: number; wording?: Wording; onProgress?: (done: number, total: number) => void },
): Promise<Response[]> {
  const out = new Array<Response>(trials.length);
  let cursor = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= trials.length) return;
      const t = trials[i]!;
      const user = renderUser(t.a, t.b, opts.wording ?? (PROMPT_VERSION as Wording));
      const t0 = Date.now();
      let raw = "", failure: string | undefined;
      try {
        raw = arm.kind === "ollama"
          ? await askOllama(arm.model, SYSTEM_PROMPT, user, opts.host)
          : await askClaudeCli(arm.model, SYSTEM_PROMPT, user);
      } catch (e) {
        failure = `transport: ${(e as Error).message}`;
      }
      const { parsed, error } = failure ? { parsed: null, error: failure } : parseAnswer(raw);
      out[i] = { trial: t.trial, ms: Date.now() - t0, raw: raw.slice(0, 4000), parsed, ...(error ? { parse_error: error } : {}) };
      opts.onProgress?.(++done, trials.length);
    }
  };
  // Local models are GPU-bound, so concurrency 1 there; the CLI arm is network-bound and parallelises.
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// scoring — every number is a choice rate, per stratum, never averaged across strata
// ---------------------------------------------------------------------------------------------------------
export function score(trials: readonly Trial[], responses: readonly Response[]) {
  const byTrial = new Map(responses.map((r) => [r.trial, r]));
  const strata: Trial["stratum"][] = ["ceiling", "containment", "token", "disjoint", "floor"];
  const per: Record<string, unknown> = {};
  for (const st of strata) {
    const ts = trials.filter((t) => t.stratum === st);
    if (!ts.length) continue;
    const rs = ts.map((t) => byTrial.get(t.trial)).filter(Boolean) as Response[];
    const ok = rs.filter((r) => r.parsed);
    const sameN = ok.filter((r) => r.parsed!.same).length;
    const notSame = ok.filter((r) => !r.parsed!.same);
    // A relation answer counts as SUBSTANTIVE only if it names a type other than NONE. This is what catches a
    // model that is merely refusing to merge: it must then say what the pair IS, and a refuser cannot.
    const withRel = notSame.filter((r) => r.parsed!.relation && r.parsed!.relation !== "NONE");
    per[st] = {
      n: ts.length,
      parsed: ok.length,
      // Against ts.length, not rs.length: a trial with NO response at all (a transport death that never
      // produced a Response row) is an unusable answer exactly like an unparseable one. Counting against the
      // responses we happen to hold would make a crashed arm look cleaner than a merely sloppy one, and it
      // would break the invariant n === parsed + parse_failures.
      parse_failures: ts.length - ok.length,
      same_rate: ok.length ? sameN / ok.length : null,
      not_same: notSame.length,
      relation_rate: notSame.length ? withRel.length / notSame.length : null,
      distinct_relations: [...new Set(withRel.map((r) => r.parsed!.relation))].length,
      median_ms: median(rs.map((r) => r.ms)),
    };
  }
  // position bias: does the model's "same" rate move when A and B are swapped? A real effect voids a run.
  const ok = trials.map((t) => ({ t, r: byTrial.get(t.trial) })).filter((x) => x.r?.parsed);
  const sw = ok.filter((x) => x.t.swapped), un = ok.filter((x) => !x.t.swapped);
  const rate = (xs: typeof ok) => (xs.length ? xs.filter((x) => x.r!.parsed!.same).length / xs.length : null);
  return {
    per_stratum: per,
    position_check: { swapped_n: sw.length, swapped_same_rate: rate(sw), unswapped_n: un.length, unswapped_same_rate: rate(un) },
    overall: {
      n: trials.length,
      parse_failures: trials.length - ok.length,
      median_ms: median(trials.map((t) => byTrial.get(t.trial)?.ms ?? 0)),
    },
  };
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * The registered bars, IN CODE. They used to live only in the protocol markdown, and a bar that exists only
 * in prose is a bar nobody applies at 2am.
 *
 * THE EDGE BAR IS A SEPARATION, and that is the correction that matters. A one-sided "floor relation-rate
 * ≤ 20%" is passed perfectly by a model that answers {"same": false, "relation": "NONE"} to every single
 * trial: it invents no edges on random pairs because it invents no edges at all, and the scorecard reads
 * "does not hallucinate relations". That is the exact fail-toward-green shape this whole harness exists to
 * avoid, and it was caught by cross-agent review (Grok 4.6, 2026-08-16) rather than by me. The edge grade
 * therefore requires the model to SEPARATE the structured population from the random one.
 */
export const BARS = {
  /** above this, the instrument cannot read the model and no other number from it means anything */
  max_parse_failure_rate: 0.05,
  /** E3's decoy discipline, unchanged */
  max_floor_same_rate: 0.02,
  /** agreement with Layer 1 on pairs Layer 1 resolves for free */
  min_ceiling_same_rate: 0.9,
  /** invents relations for random pairs */
  max_floor_relation_rate: 0.2,
  /** must tell the structured population apart from the random one */
  min_relation_separation: 0.3,
} as const;

export interface Grade {
  gradeable: boolean;
  merge_proposer: boolean;
  edge_proposer: boolean;
  reasons: string[];
}

export function grade(s: ReturnType<typeof score>): Grade {
  const reasons: string[] = [];
  const st = (k: string) => s.per_stratum[k] as { same_rate: number | null; relation_rate: number | null } | undefined;
  const num = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);

  const failRate = s.overall.n ? s.overall.parse_failures / s.overall.n : 1;
  const gradeable = failRate <= BARS.max_parse_failure_rate;
  if (!gradeable) reasons.push(`parse-failure rate ${failRate.toFixed(3)} > ${BARS.max_parse_failure_rate}`);

  const ceiling = num(st("ceiling")?.same_rate);
  const floorSame = num(st("floor")?.same_rate);
  const floorRel = num(st("floor")?.relation_rate);
  const disjointRel = num(st("disjoint")?.relation_rate);

  let merge = gradeable;
  if (ceiling === null || ceiling < BARS.min_ceiling_same_rate) {
    merge = false;
    reasons.push(`ceiling same-rate ${ceiling ?? "n/a"} < ${BARS.min_ceiling_same_rate}`);
  }
  if (floorSame === null || floorSame > BARS.max_floor_same_rate) {
    merge = false;
    reasons.push(`floor same-rate ${floorSame ?? "n/a"} > ${BARS.max_floor_same_rate}`);
  }

  let edge = gradeable;
  if (floorRel === null || floorRel > BARS.max_floor_relation_rate) {
    edge = false;
    reasons.push(`floor relation-rate ${floorRel ?? "n/a"} > ${BARS.max_floor_relation_rate}`);
  }
  // The refuser trap. Both rates can be 0 and the model still fails, because it separated nothing.
  const separation = disjointRel !== null && floorRel !== null ? disjointRel - floorRel : null;
  if (separation === null || separation < BARS.min_relation_separation) {
    edge = false;
    reasons.push(`relation separation (disjoint − floor) ${separation?.toFixed(3) ?? "n/a"} < ${BARS.min_relation_separation}`);
  }

  return { gradeable, merge_proposer: merge && gradeable, edge_proposer: edge && gradeable, reasons };
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------
const ARMS: Record<string, Arm> = {
  "gemma3:12b": { name: "gemma3:12b", kind: "ollama", model: "gemma3:12b" },
  "qwen2.5:14b": { name: "qwen2.5:14b", kind: "ollama", model: "qwen2.5:14b" },
  "phi4": { name: "phi4", kind: "ollama", model: "phi4:latest" },
  "mistral-small": { name: "mistral-small", kind: "ollama", model: "mistral-small:latest" },
  "qwen3-coder:30b": { name: "qwen3-coder:30b", kind: "ollama", model: "qwen3-coder:30b" },
  "qwen3:32b": { name: "qwen3:32b", kind: "ollama", model: "qwen3:32b" },
  "llama3.3:70b": { name: "llama3.3:70b", kind: "ollama", model: "llama3.3:70b" },
  "haiku": { name: "haiku", kind: "claude-cli", model: "claude-haiku-4-5" },
};

function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = flag("dir", "graphs/testgraph/dedup")!;
  const dbPath = flag("db", "graphs/testgraph/graph.db")!;
  const seed = Number(flag("seed", "20260816"));
  const pilot = process.argv.includes("--pilot");
  const armNames = (flag("arms", pilot ? "gemma3:12b,haiku" : Object.keys(ARMS).join(","))!).split(",");
  const contextChars = Number(flag("context-chars", "700"));
  const counts = pilot
    ? { ceiling: 4, containment: 4, token: 4, disjoint: 4, floor: 4 }
    : { ceiling: 30, containment: 50, token: 50, disjoint: 50, floor: 30 };

  const { trials, meta } = buildTrials({ dbPath, dir, seed, counts, contextChars });
  console.log(`built ${trials.length} trials  ${JSON.stringify(meta.pools)}`);

  const out: Record<string, unknown> = {
    experiment: pilot ? "E7-PILOT (not scored)" : "E7",
    prompt_version: PROMPT_VERSION,
    system_prompt: SYSTEM_PROMPT,
    user_prompt_example: renderUser(trials[0]!.a, trials[0]!.b),
    no_confidence_field: true,
    cosines_shown_to_model: false,
    json_forced_by_decoder: false,
    ...meta,
    trials: trials.map((t) => ({
      trial: t.trial, stratum: t.stratum, swapped: t.swapped, signals: t.signals,
      a: { id: t.a.id, name: t.a.name, subtype: t.a.subtype },
      b: { id: t.b.id, name: t.b.name, subtype: t.b.subtype },
    })),
    arms: {} as Record<string, unknown>,
  };
  const outPath = join(dir, pilot ? `e7-pilot-${PROMPT_VERSION}.json` : `e7-ladder-${PROMPT_VERSION}.json`);

  for (const an of armNames) {
    const arm = ARMS[an];
    if (!arm) { console.error(`unknown arm '${an}' — known: ${Object.keys(ARMS).join(", ")}`); process.exit(2); }
    process.stdout.write(`\n${arm.name}: `);
    const t0 = Date.now();
    const responses = await runArm(arm, trials, {
      host: flag("host", "http://127.0.0.1:11434")!,
      concurrency: arm.kind === "ollama" ? 1 : 4,
      onProgress: (d, n) => process.stdout.write(d % 10 === 0 || d === n ? `${d}/${n} ` : ""),
    });
    const s = score(trials, responses);
    (out.arms as Record<string, unknown>)[arm.name] = { model: arm.model, kind: arm.kind, wall_s: Math.round((Date.now() - t0) / 1000), score: s, responses };
    console.log(`\n  ${JSON.stringify(s.per_stratum)}`);
    console.log(`  parse failures ${s.overall.parse_failures}/${s.overall.n}   median ${s.overall.median_ms}ms`);
    writeFileSync(outPath, JSON.stringify(out, null, 1)); // written after every arm so a crash keeps the rest
  }
  console.log(`\nwrote ${outPath}`);
}
