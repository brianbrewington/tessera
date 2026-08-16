// The quote verifier is E10's instrument. Its failure directions differ: over-matching lets confabulations
// survive (fail-toward-green — the dangerous one), under-matching kills true relations (fail-toward-red,
// visible in the fidelity number). Both directions are pinned here.
import { describe, it, expect } from "vitest";
import { verifyQuote, normQuote, withinEditDistance, isTemplateReason, ARM_S_PROMPT } from "../scripts/dedup/e10-span-extraction.js";
import { EXTRACTION_SYSTEM } from "../src/extract/extractor.js";

const CHUNK = `The Connector proposes cross-document links. Brian reviewed the plan on Tuesday,
and the spacing search was wrong on sparse sets.   It was fixed in round three.`;

describe("E10 verifyQuote", () => {
  it("verifies a verbatim quote", () => {
    expect(verifyQuote("The Connector proposes cross-document links.", CHUNK)).toBe("verified");
  });

  it("is insensitive to whitespace and case ONLY", () => {
    // Registered decision: newlines and double spaces collapse, case folds — nothing else.
    expect(verifyQuote("brian reviewed the plan on tuesday, and the spacing search was wrong", CHUNK)).toBe("verified");
    expect(verifyQuote("sparse sets.   It was", CHUNK)).toBe("verified");
  });

  it("does NOT match a paraphrase (the over-match direction)", () => {
    // "Brian checked the plan" is a fair paraphrase and must NOT verify: paraphrase tolerance is exactly
    // how a confabulation gate stops gating.
    expect(verifyQuote("Brian checked the plan on Tuesday", CHUNK)).toBe("unmatched");
    expect(verifyQuote("The Connector creates links between documents", CHUNK)).toBe("unmatched");
  });

  it("counts a small typo as near_miss, not verified and not unmatched", () => {
    // One-character slip: diagnostic category, NOT a survival — the registered rule is strict.
    expect(verifyQuote("The Connector proposes cross-document link.", CHUNK)).toBe("near_miss");
  });

  it("treats missing/empty/too-short quotes as their own kill category", () => {
    expect(verifyQuote(undefined, CHUNK)).toBe("missing");
    expect(verifyQuote("", CHUNK)).toBe("missing");
    expect(verifyQuote("  ", CHUNK)).toBe("missing");
    expect(verifyQuote("a", CHUNK)).toBe("missing"); // one char grounds nothing
  });

  it("does not strip punctuation (registered: stripping over-matches)", () => {
    expect(normQuote("wrong, on. sparse")).toBe("wrong, on. sparse");
    // The punctuation difference alone is within edit distance 5 → near_miss, never verified.
    expect(verifyQuote("spacing search was wrong on sparse sets It was fixed", CHUNK)).toBe("near_miss");
  });
});

describe("E10 withinEditDistance", () => {
  it("bounds correctly", () => {
    expect(withinEditDistance("abcdef", "abcdef", 0)).toBe(true);
    expect(withinEditDistance("abcdef", "abcdXf", 1)).toBe(true);
    expect(withinEditDistance("abcdef", "aXcXeX", 2)).toBe(false);
    expect(withinEditDistance("short", "muchlongerstring", 5)).toBe(false);
  });
});

describe("E10 template-reason detector", () => {
  it("bans the Mercer junk class", () => {
    for (const junk of ["related concept", "associated with", "uses this", "is part of", "improves performance in"]) {
      expect(isTemplateReason(junk), junk).toBe(true);
    }
  });
  it("passes real reasons — including ones CONTAINING banned phrases", () => {
    for (const real of [
      "picks grapes seasonally as hired harvest labour",
      "is part of the settlement's oldest irrigation cooperative", // prefix match must not fire mid-sentence
      "uses this channel to drain dirty chunks after a drop",
    ]) {
      expect(isTemplateReason(real), real).toBe(false);
    }
  });
});

describe("E10 arm construction", () => {
  it("Arm S differs from the incumbent by exactly the quote ingredient", () => {
    expect(ARM_S_PROMPT).toContain('"quote":""');
    expect(ARM_S_PROMPT).toContain("VERBATIM snippet");
    expect(ARM_S_PROMPT).toContain("DO NOT EMIT THE RELATION");
    // Both .replace() calls found their anchors — a silent no-op replace would run Arm S ≡ Arm A and the
    // experiment would "measure" a zero delta between identical prompts.
    expect(ARM_S_PROMPT).not.toBe(EXTRACTION_SYSTEM);
    const stripped = ARM_S_PROMPT
      .replace(`,"quote":""`, "")
      .replace(/- quote: a VERBATIM snippet[\s\S]*?DO NOT EMIT THE RELATION\.\n/, "");
    expect(stripped).toBe(EXTRACTION_SYSTEM);
  });
});

describe("E10 parseWithQuotes — the instrument-failure regression", () => {
  it("PRESERVES the quote field production parsing strips", async () => {
    // The first pilot reported fidelity 0.000 / all-missing because production Relation is a strict Zod
    // object and salvage() silently dropped `quote` — a parser artifact that read as "models cannot quote".
    // This is the pin: a quote written by the model must reach the verifier.
    const { parseWithQuotes } = await import("../scripts/dedup/e10-span-extraction.js");
    const raw = JSON.stringify({
      entities: [{ name: "A", type: "CONCEPT", description: "d" }, { name: "B", type: "CONCEPT", description: "d" }],
      relations: [{ source: "A", target: "B", reason: "supplies water to", quote: "A supplies water to B daily" }],
    });
    const parsed = parseWithQuotes(raw)!;
    expect(parsed.relations[0]!.quote).toBe("A supplies water to B daily");
  });

  it("still drops dangling relations and tolerates a missing quote", async () => {
    const { parseWithQuotes } = await import("../scripts/dedup/e10-span-extraction.js");
    const raw = JSON.stringify({
      entities: [{ name: "A", type: "CONCEPT", description: "d" }],
      relations: [
        { source: "A", target: "Ghost", reason: "haunts" },          // dangling → dropped
        { source: "A", target: "A", reason: "self-loop kept? no—", quote: "x" },
      ],
    });
    const parsed = parseWithQuotes(raw)!;
    expect(parsed.relations.every((r) => r.target !== "Ghost")).toBe(true);
  });
});
