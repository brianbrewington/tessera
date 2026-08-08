// The teeth behind PROMPT_VERSION (backlog B13).
//
// The chunk memo keys on chunk CONTENT, so a graph ingested under an old prompt keeps its stale
// extractions forever unless someone remembers `--reextract`. Nobody remembers. PROMPT_VERSION salts
// the memo so a prompt change re-dirties every chunk — but a hand-maintained constant only works if
// changing the prompt without bumping it is impossible to miss.
//
// So this test pins a fingerprint of the prompt text. Edit EXTRACTION_SYSTEM or subjectClause and this
// goes red, telling you to make a decision rather than silently freezing every existing graph on the
// old output. The fingerprint is NOT the version: deriving the version from the prompt hash would let
// a cosmetic typo fix silently re-pay the LLM for a whole corpus the next time `serve` drains.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { EXTRACTION_SYSTEM, subjectClause, PROMPT_VERSION } from "../src/extract/extractor.js";

/** Everything that goes into the system prompt, including the persona branch. */
function promptFingerprint(): string {
  return createHash("sha256")
    .update(EXTRACTION_SYSTEM + subjectClause("Pinned Subject"))
    .digest("hex")
    .slice(0, 16);
}

describe("PROMPT_VERSION guards the extraction memo", () => {
  it("the prompt text has not changed without a deliberate version bump", () => {
    // If this fails you changed the extraction prompt. That is fine — decide what it means:
    //   • output would change  → bump PROMPT_VERSION, update this literal. Every graph goes dirty and
    //                            `tessera extract <graph>` re-extracts at your pace, on purpose.
    //   • cosmetic only        → leave PROMPT_VERSION alone, update this literal only.
    // What you must not do is change the prompt and leave both alone.
    expect(promptFingerprint()).toBe("ac6436a937a35945");
  });

  it("PROMPT_VERSION is a non-empty scalar the memo can key on", () => {
    expect(PROMPT_VERSION).toBeTypeOf("string");
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it("the fingerprint covers subjectClause, not just EXTRACTION_SYSTEM", () => {
    // Guards against the fingerprint being computed over the base prompt alone, which would let the
    // persona branch (the subject-aware extraction that fixed KI-1) drift unpinned.
    const withSubject = createHash("sha256").update(EXTRACTION_SYSTEM + subjectClause("A")).digest("hex");
    const withoutSubject = createHash("sha256").update(EXTRACTION_SYSTEM + subjectClause()).digest("hex");
    expect(withSubject).not.toBe(withoutSubject);
  });
});
