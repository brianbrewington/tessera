// E7's parser and scorer are the INSTRUMENT, and a broken instrument fails toward a clean-looking result.
// The specific hazard here: if a garbled reply silently parsed as {same: false}, a model that emits nothing
// usable would score as a flawless refuser — spotless on the floor control, zero merges, "safe". These tests
// exist to make that failure loud. E3's protocol says it directly: parse failures get their own counter and
// are never folded into "no".
import { describe, it, expect } from "vitest";
import { parseAnswer, score, grade, renderUser, SYSTEM_PROMPT, type Trial, type Response } from "../scripts/dedup/e7-merge-proposals.js";

const side = (name: string) => ({ id: name, name, subtype: "concept", description: "d", context: "c" });
const trial = (n: number, stratum: Trial["stratum"], swapped = false): Trial => ({
  trial: n, stratum, swapped, a: side(`a${n}`), b: side(`b${n}`),
  signals: { chunks: 1, neighbours: 0, related: false },
});
const reply = (t: number, parsedJson: string): Response => ({ trial: t, ms: 1, raw: parsedJson, ...parseAnswer(parsedJson) });

describe("E7 parseAnswer", () => {
  it("reads the schema the prompt asks for", () => {
    const { parsed } = parseAnswer('{"same": false, "same_reason": "r", "relation": "part_of", "direction": "A_TO_B", "relation_reason": "x"}');
    expect(parsed).toMatchObject({ same: false, relation: "PART_OF", direction: "A_TO_B" });
  });

  it("survives the fenced-JSON habit without special-casing any one model", () => {
    // Haiku fenced its reply in ```json on the very first probe; local models do it intermittently. Tolerating
    // the fence keeps the arms comparable, which is the point of not forcing JSON at the decoder either.
    const { parsed } = parseAnswer('```json\n{"same": true, "same_reason": "same thing"}\n```');
    expect(parsed?.same).toBe(true);
  });

  it("accepts prose around the object, since nothing forces JSON on any arm", () => {
    const { parsed } = parseAnswer('Sure. {"same": true} Hope that helps.');
    expect(parsed?.same).toBe(true);
  });

  it("accepts a stringified boolean but NOT an ambiguous one", () => {
    expect(parseAnswer('{"same": "true"}').parsed?.same).toBe(true);
    expect(parseAnswer('{"same": "no"}').parsed?.same).toBe(false);
    expect(parseAnswer('{"same": "maybe"}').parsed).toBeNull();   // must not become a silent false
    expect(parseAnswer('{"same": "maybe"}').error).toMatch(/same/);
  });

  it("FAILS LOUDLY rather than defaulting to not-same", () => {
    // The mutation this pins: `same: obj.same === true` would make every one of these a clean {same:false},
    // and a model producing pure noise would look perfectly conservative.
    for (const bad of ["", "I cannot answer that.", "{", '{"same": null}', '{"verdict": "same"}', "{not json}"]) {
      const r = parseAnswer(bad);
      expect(r.parsed, `expected a parse failure for ${JSON.stringify(bad)}`).toBeNull();
      expect(r.error).toBeTruthy();
    }
  });

  it("normalises a missing relation to NONE rather than empty string", () => {
    // The scorer distinguishes "named a relation" from "did not"; an empty string and the literal "NONE" must
    // land on the same side of that line or relation_rate becomes model-punctuation-dependent.
    expect(parseAnswer('{"same": false}').parsed?.relation).toBe("NONE");
    expect(parseAnswer('{"same": false, "relation": ""}').parsed?.relation).toBe("NONE");
    expect(parseAnswer('{"same": false, "relation": " depends_on "}').parsed?.relation).toBe("DEPENDS_ON");
  });
});

describe("E7 score", () => {
  it("counts parse failures separately and keeps them OUT of the rate denominator", () => {
    // The one parsed answer says "same", so the rate must be 1.0. If parse failures were folded into the
    // denominator it would read 0.5 — a model whose replies are half unusable would look half as merge-happy
    // as it is. An earlier version of this test used a not-same answer, where both formulas give 0, and it
    // waved the mutation straight through.
    const trials = [trial(0, "floor"), trial(1, "floor")];
    const s = score(trials, [reply(0, '{"same": true}'), reply(1, "garbage")]);
    const floor = s.per_stratum.floor as { n: number; parsed: number; parse_failures: number; same_rate: number };
    expect(floor.n).toBe(2);
    expect(floor.parsed).toBe(1);
    expect(floor.parse_failures).toBe(1);
    expect(floor.same_rate).toBe(1);   // 1/1 over PARSED answers, not 1/2 over attempts
  });

  it("never averages across strata", () => {
    // A single blended accuracy would hide the only comparison that matters: ceiling vs floor.
    const trials = [trial(0, "ceiling"), trial(1, "floor")];
    const s = score(trials, [reply(0, '{"same": true}'), reply(1, '{"same": false}')]);
    expect((s.per_stratum.ceiling as { same_rate: number }).same_rate).toBe(1);
    expect((s.per_stratum.floor as { same_rate: number }).same_rate).toBe(0);
    expect(s.per_stratum).not.toHaveProperty("overall");
  });

  it("only credits a relation when the model actually names one", () => {
    // This is the falsifier for a model that refuses everything: it must still say what the pair IS.
    const trials = [trial(0, "disjoint"), trial(1, "disjoint"), trial(2, "disjoint")];
    const s = score(trials, [
      reply(0, '{"same": false, "relation": "DEPENDS_ON"}'),
      reply(1, '{"same": false, "relation": "NONE"}'),
      reply(2, '{"same": false}'),
    ]);
    const d = s.per_stratum.disjoint as { not_same: number; relation_rate: number; distinct_relations: number };
    expect(d.not_same).toBe(3);
    expect(d.relation_rate).toBeCloseTo(1 / 3);
    expect(d.distinct_relations).toBe(1);
  });

  it("does not count relations from pairs the model called the same", () => {
    // relation_rate is a rate over NOT-SAME answers only. The mix matters: a same-answer that names a relation
    // sits alongside a not-same answer that names none, so the honest rate is 0. Counting the same-answer's
    // relation would report 1.0 and let a merge-happy model borrow credit for the second question it never
    // actually answered. A single same-answer trial cannot catch this — the rate is null either way.
    const trials = [trial(0, "disjoint"), trial(1, "disjoint")];
    const s = score(trials, [
      reply(0, '{"same": true, "relation": "PART_OF"}'),
      reply(1, '{"same": false, "relation": "NONE"}'),
    ]);
    const d = s.per_stratum.disjoint as { not_same: number; relation_rate: number; distinct_relations: number };
    expect(d.not_same).toBe(1);
    expect(d.relation_rate).toBe(0);
    expect(d.distinct_relations).toBe(0);
  });

  it("reports the swapped/unswapped same-rate split so position bias is checkable", () => {
    // E3's registered control voids a run if the model favours one position. That control only exists if the
    // A/B order was randomised AND the split is reported.
    const trials = [trial(0, "token", true), trial(1, "token", false)];
    const s = score(trials, [reply(0, '{"same": true}'), reply(1, '{"same": false}')]);
    expect(s.position_check.swapped_same_rate).toBe(1);
    expect(s.position_check.unswapped_same_rate).toBe(0);
  });
});

describe("E7 prompt hygiene", () => {
  const user = renderUser(
    { id: "1", name: "GraphStore", subtype: "technology", description: "the store", context: "chunk text" },
    { id: "2", name: "Graph Store", subtype: "product", description: "the store", context: "chunk text" },
  );

  it("carries exactly what Brian specified: name, inferred type, and source context for both ends", () => {
    for (const needle of ["GraphStore", "Graph Store", "technology", "product", "chunk text"]) {
      expect(user).toContain(needle);
    }
    expect(user).toContain("inferred type:");
    expect(user).toContain("source context:");
  });

  it("asks the second question, which E3 never did", () => {
    expect(user).toMatch(/are they related/i);
    expect(user).toContain("relation");
    expect(user).toContain("direction");
  });

  it("does NOT repeat E3's conservatism knob", () => {
    // E3's verdict is uninterpretable because its prompt said "Prefer NONE whenever you are not sure."
    // hit-recall and null-abstention trade off directly along that knob. Nothing here may express a
    // preference for either answer, and no confidence field may exist in the schema.
    const all = `${SYSTEM_PROMPT}\n${user}`.toLowerCase();
    for (const banned of ["prefer none", "when in doubt", "if you are not sure", "if unsure", "err on the side", "most of the time", "confidence", "certainty"]) {
      expect(all, `prompt must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it("shows the model no geometry", () => {
    // Standing rule from the protocol: showing cosines to the model is geometry deciding, and it invalidates
    // the run. The prompt is built from names, types, descriptions and chunk text only.
    const all = `${SYSTEM_PROMPT}\n${user}`.toLowerCase();
    for (const banned of ["cosine", "similarity", "embedding", "distance", "score"]) {
      expect(all, `prompt must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it("states the same/not-same rule in both directions in one breath", () => {
    // The balance is the fix for E3. Both halves must be present, or the prompt is a nudge again.
    expect(user).toMatch(/are the same thing/i);
    expect(user).toMatch(/are not the same thing/i);
  });

  it("states the related/not-related rule in both directions too", () => {
    // THE REGRESSION THIS FILE EXISTED TO CATCH AND DID NOT. Q1 was balanced and Q2 was not: the affirmative
    // branch got a prose instruction and the negative branch got only a token in the JSON template. That is
    // E3's conservatism knob pointed the other way, and it confounded the pilot's floor relation-rate with
    // my own wording. The banned-phrase test above could never have caught it — a structural asymmetry
    // contains no banned phrase, which is precisely why one reviewer cleared the prompt. Assert the shape,
    // not just the fingerprint.
    expect(user).toMatch(/is related when/i);
    expect(user).toMatch(/is not related when/i);
    expect(user).toMatch(/if they are related/i);
    expect(user).toMatch(/if they are not related/i);
    expect(user).toMatch(/answer NONE/);
  });

  it("gives each branch of each question comparable weight", () => {
    // A softer guard on the same axis. Not a style rule: an asymmetry in how much prose each branch gets is
    // a demand characteristic, and my first repair of Q2 still gave the negative branch the vivid clause and
    // the positive branch three words. Definitional sentences should be within a sentence of each other in
    // length, per question.
    const defs = (q: RegExp) => (user.match(q) ?? []).map((s) => s.trim().replace(/\s+/g, " ").length);
    const same = defs(/[^.]*\bare the same thing\.|[^.]*\bare not the same thing\./g);
    const rel = defs(/[^.]*\bis related when[^.]*\.|[^.]*\bis not related when[^.]*\./g);
    for (const lengths of [same, rel]) {
      expect(lengths.length, "both branches must be present to compare").toBe(2);
      const ratio = Math.max(...lengths) / Math.min(...lengths);
      expect(ratio, "one branch is worded far more heavily than the other").toBeLessThan(2);
    }
  });
});

describe("E7 grade — the registered bars, in code", () => {
  // Helper: build a run where each stratum answers a fixed way.
  const run = (spec: Partial<Record<Trial["stratum"], string>>, n = 10) => {
    const trials: Trial[] = [];
    const responses: Response[] = [];
    for (const [stratum, json] of Object.entries(spec)) {
      for (let i = 0; i < n; i++) {
        const t = trial(trials.length, stratum as Trial["stratum"]);
        trials.push(t);
        responses.push({ trial: t.trial, ms: 1, raw: json!, ...parseAnswer(json!) });
      }
    }
    return grade(score(trials, responses));
  };

  const GOOD = {
    ceiling: '{"same": true}',
    floor: '{"same": false, "relation": "NONE"}',
    disjoint: '{"same": false, "relation": "DEPENDS_ON"}',
  };

  it("passes a model that separates the populations on both questions", () => {
    const g = run(GOOD);
    expect(g.gradeable).toBe(true);
    expect(g.merge_proposer).toBe(true);
    expect(g.edge_proposer).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  it("FAILS the universal refuser on the edge grade", () => {
    // THE finding that motivated putting the bars in code. A model answering
    // {"same": false, "relation": "NONE"} to every trial has floor same-rate 0 and floor relation-rate 0 —
    // it passes every one-sided bar and the scorecard reads "does not hallucinate relations". It is a
    // NONE-printer. The edge grade is a SEPARATION for exactly this reason.
    const g = run({ ceiling: '{"same": false, "relation": "NONE"}', ...{ floor: '{"same": false, "relation": "NONE"}', disjoint: '{"same": false, "relation": "NONE"}' } });
    expect(g.gradeable).toBe(true);          // its JSON parses fine; it is not a broken model
    expect(g.merge_proposer).toBe(false);    // caught by the ceiling bar
    expect(g.edge_proposer).toBe(false);     // caught ONLY by the separation bar
    expect(g.reasons.join(" ")).toMatch(/separation/);
    expect(g.reasons.join(" ")).not.toMatch(/floor relation-rate .* >/);  // its floor rate is spotless
  });

  it("FAILS the merge-happy model on the floor bar", () => {
    const g = run({ ...GOOD, floor: '{"same": true}' });
    expect(g.merge_proposer).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/floor same-rate/);
  });

  it("FAILS the relation-inventor even though it separates nothing", () => {
    // Names a relation for random pairs at the same rate as for structured ones.
    const g = run({ ...GOOD, floor: '{"same": false, "relation": "RELATES_TO"}' });
    expect(g.edge_proposer).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/floor relation-rate/);
  });

  it("refuses to grade a model the instrument cannot read", () => {
    // Above the parse-failure bar nothing else is meaningful, so no grade is issued in either direction —
    // rather than reporting a flattering rate over the handful of replies that happened to parse.
    const g = run({ ceiling: "total garbage", floor: "total garbage", disjoint: "total garbage" });
    expect(g.gradeable).toBe(false);
    expect(g.merge_proposer).toBe(false);
    expect(g.edge_proposer).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/parse-failure rate/);
  });

  it("does not hand out a pass when a control stratum is missing entirely", () => {
    // A run with no floor control cannot clear a bar defined on the floor. Absent must not read as passing.
    const g = run({ ceiling: '{"same": true}', disjoint: '{"same": false, "relation": "DEPENDS_ON"}' });
    expect(g.merge_proposer).toBe(false);
    expect(g.edge_proposer).toBe(false);
  });
});
