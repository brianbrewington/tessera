// D4 stage 1a (channel 0079/0081/0087): parse-time junk filter. The rule targets syntax SHAPES —
// relative-path prefixes and template placeholders — never "contains a slash": in this corpus
// path-bearing names (control/PAUSE, attachments/…, frontend/server.py) are first-class entities,
// and a separator rule would delete the ledger from its own graph (grok-seat, 0087).
// Reject cases are seeded from the E11 confirmatory sidecar's ACTUAL extractor junk, not invented.
import { describe, it, expect } from "vitest";
import { isJunkSurface } from "../src/extract/junkfilter.js";
import { parseExtraction } from "../src/extract/extractor.js";

describe("isJunkSurface — reject shapes (all observed in e11-injection.json arm A)", () => {
  it("rejects relative-path prefixes", () => {
    expect(isJunkSurface("../PROTOCOL.md")).toBe(true);
    expect(isJunkSurface("./notes.md")).toBe(true);
    expect(isJunkSurface("../../src/store.ts")).toBe(true);
  });
  it("rejects template placeholders (angle-bracket segments)", () => {
    expect(isJunkSurface("messages/0002-<your-handle>.md")).toBe(true);
    expect(isJunkSurface("chars: <n>")).toBe(true);
    expect(isJunkSurface("NNNN-<reviewer>-review.md")).toBe(true);
  });
  it("rejects markdown heading leftovers", () => {
    expect(isJunkSurface("# Decision queue")).toBe(true);
    expect(isJunkSurface("## RELATIONS")).toBe(true);
  });
});

describe("isJunkSurface — keep cases (0087: if these fail, the separator rule is the bug)", () => {
  it("keeps bare doc names", () => {
    expect(isJunkSurface("claims.md")).toBe(false);
    expect(isJunkSurface("PROTOCOL.md")).toBe(false);
    expect(isJunkSurface("historian.log")).toBe(false);
  });
  it("keeps real paths that ORIGINATED_FROM needs", () => {
    expect(isJunkSurface("attachments/0041-grok-review.md")).toBe(false);
    expect(isJunkSurface("docs/correlation_analysis.md")).toBe(false);
    expect(isJunkSurface("control/PAUSE")).toBe(false);
    expect(isJunkSurface("~/agent_to_agent_comms/historian.log")).toBe(false);
    expect(isJunkSurface("frontend/server.py")).toBe(false);
  });
  it("keeps slash-bearing non-paths and ordinary names", () => {
    expect(isJunkSurface("C1/C9")).toBe(false);
    expect(isJunkSurface("/api/decide")).toBe(false);
    expect(isJunkSurface("EM/F1")).toBe(false);
    expect(isJunkSurface("tessera serve")).toBe(false);
  });
  it("keeps legitimate angle-bracket surfaces (Grok/Composer review: generics, math, emails)", () => {
    expect(isJunkSurface("Promise<string>")).toBe(false);
    expect(isJunkSurface("Vec<String>")).toBe(false);
    expect(isJunkSurface("Map<K, V>")).toBe(false);
    expect(isJunkSurface("a<b>c")).toBe(false);
    expect(isJunkSurface("x < y > z")).toBe(false);
    expect(isJunkSurface("Ada Lovelace <ada@example.com>")).toBe(false);
    expect(isJunkSurface("<Component>")).toBe(false);
  });
  it("still rejects placeholder shapes after the tightening", () => {
    expect(isJunkSurface("messages/0002-<your-handle>.md")).toBe(true);
    expect(isJunkSurface("chars: <n>")).toBe(true);
    expect(isJunkSurface("<n>")).toBe(true);
  });
  it("rejects embedded traversal segments (Composer review)", () => {
    expect(isJunkSurface("src/../PROTOCOL.md")).toBe(true);
    expect(isJunkSurface("foo/./bar.md")).toBe(true);
  });
});

describe("parseExtraction applies the filter", () => {
  it("drops junk entities AND the relations that reference them", () => {
    const raw = JSON.stringify({
      entities: [
        { name: "tessera", type: "PROJECT", description: "the graph tool" },
        { name: "../PROTOCOL.md", type: "FILE", description: "junk relative path" },
        { name: "chars: <n>", type: "OTHER", description: "junk template" },
      ],
      relations: [
        { source: "tessera", target: "../PROTOCOL.md", reason: "documents the channel contract" },
      ],
    });
    const r = parseExtraction(raw);
    expect(r.parsed).toBe(true);
    expect(r.extraction.entities.map((e) => e.name)).toEqual(["tessera"]);
    expect(r.extraction.relations).toEqual([]); // endpoint died with the junk entity
  });
  it("keeps first-class doc entities end to end", () => {
    const raw = JSON.stringify({
      entities: [
        { name: "claims.md", type: "FILE", description: "the ledger" },
        { name: "control/PAUSE", type: "FILE", description: "floor-control file" },
      ],
      relations: [
        { source: "claims.md", target: "control/PAUSE", reason: "both govern channel state" },
      ],
    });
    const r = parseExtraction(raw);
    expect(r.extraction.entities).toHaveLength(2);
    expect(r.extraction.relations).toHaveLength(1);
  });
});
