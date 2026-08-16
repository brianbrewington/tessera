// The four strata are the axis every E6/E7 number is reported along, so a silent change here would
// silently change what those numbers mean. Each case below is a real pair from `graphs/testgraph`.
import { describe, it, expect } from "vitest";
import { stratumOf, stripName, nameTokens } from "../scripts/dedup/lexical.js";

describe("lexical strata", () => {
  it("agrees with Layer 1 on what `identical` means", () => {
    // stripName IS Layer 1's grouping key. If these two ever disagree, E6 would hand the ladder pairs that a
    // GROUP BY already resolves for free — the exact contamination the protocol retracted a result over.
    expect(stratumOf("contentHash", "content_hash")).toBe("identical");
    expect(stratumOf("GraphStore", "Graph Store")).toBe("identical");
    expect(stripName("Dream-Walker")).toBe(stripName("dream walker"));
  });

  it("classifies the residue the protocol names by example", () => {
    // "Brian vs Brian Brewington" is the protocol's own illustration of what survives Layer 1.
    expect(stratumOf("Brian", "Brian Brewington")).toBe("containment");
    expect(stratumOf("Extractor", "LlmExtractor")).toBe("containment");
  });

  it("splits camelCase, or the token stratum would be empty on this corpus", () => {
    // Roughly half of testgraph's entity names are identifiers. Without the camelCase split `getLayout` is a
    // single opaque token and `putLayout` is another, so a pair that obviously shares "layout" would fall
    // through to `disjoint` and be scored against the wrong population.
    expect(nameTokens("getLayout")).toEqual(new Set(["get", "layout"]));
    expect(stratumOf("getLayout", "putLayout")).toBe("token");
  });

  it("drops single characters, so `x`/`vx` is not a token match", () => {
    // x/vx and y/vy are real testgraph pairs and are NOT the same thing. A one-character token would make
    // them look lexically related and put them in the wrong stratum.
    expect(nameTokens("x")).toEqual(new Set());
    expect(stratumOf("x", "vx")).toBe("containment"); // by containment of the stripped form, not by token
    expect(stratumOf("alpha", "beta")).toBe("disjoint");
  });

  it("calls the never-measured population `disjoint`", () => {
    expect(stratumOf("HYPOTHESIS", "EVIDENCE")).toBe("disjoint");
    expect(stratumOf("sqlite-vec", "WAL")).toBe("disjoint");
  });

  it("is symmetric, because a pair has no inherent order", () => {
    const pairs: [string, string][] = [
      ["Brian", "Brian Brewington"],
      ["getLayout", "putLayout"],
      ["contentHash", "content_hash"],
      ["HYPOTHESIS", "EVIDENCE"],
    ];
    for (const [a, b] of pairs) expect(stratumOf(a, b)).toBe(stratumOf(b, a));
  });

  it("does not treat an empty stripped name as identical to anything", () => {
    // `---` strips to "", and "" === "" would union every punctuation-only name into one group.
    expect(stratumOf("---", "///")).toBe("disjoint");
    expect(stratumOf("---", "Brian")).toBe("disjoint");
  });
});
