import { describe, it, expect } from "vitest";
import { resolveEntities, stripName, type ResolveMember } from "../src/resolve/view.js";

const m = (id: string, name: string, subtype = "concept", strength = 1): ResolveMember => ({ id, name, subtype, strength });

describe("Layer 1 — deterministic resolution", () => {
  it("groups names that differ only in case and punctuation", () => {
    const r = resolveEntities([m("1", "contentHash"), m("2", "content_hash"), m("3", "Content Hash"), m("4", "other")]);
    expect(r.stats.resolved).toBe(1);
    expect(r.canonicalOf.get("2")).toBe(r.canonicalOf.get("3"));
    expect(r.canonicalOf.has("4")).toBe(false);
  });

  it("HOLDS OUT any group touching person, place or event", () => {
    // The guard. Measured on the real corpus: 27 groups would union across these subtypes — `Mother`
    // [person, concept], `Connector` [..., person]. Those are exactly the subtypes the experiment protocol
    // refused to label, because a genuine sense-split is plausible. Unioning them silently would be a
    // judgment call dressed as arithmetic.
    const r = resolveEntities([m("1", "Mother", "person"), m("2", "mother", "concept")]);
    expect(r.stats.resolved).toBe(0);
    expect(r.stats.heldOut).toBe(1);
    expect(r.canonicalOf.size).toBe(0);          // nothing resolved, so nothing mapped
    expect(r.groups[0]!.heldOut).toBe(true);
    expect(r.groups[0]!.reason).toContain("person");
  });

  it("still SURFACES the held-out group rather than hiding it", () => {
    // Held out must not mean invisible: these are the pairs most in need of human judgment.
    const r = resolveEntities([m("1", "Gate 2", "place"), m("2", "gate 2", "other")]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.members).toHaveLength(2);
  });

  it("picks a canonical DETERMINISTICALLY — a wandering choice would move the map for no reason", () => {
    const a = resolveEntities([m("x", "serve", "code", 3), m("y", "Serve", "product", 9)]);
    const b = resolveEntities([m("y", "Serve", "product", 9), m("x", "serve", "code", 3)]);
    expect(a.groups[0]!.canonical.id).toBe("y");           // highest strength
    expect(b.groups[0]!.canonical.id).toBe(a.groups[0]!.canonical.id); // order-independent
  });

  it("breaks strength ties without coin-flipping", () => {
    const a = resolveEntities([m("p", "cli", "code", 5), m("q", "C.L.I.", "other", 5)]);
    const b = resolveEntities([m("q", "C.L.I.", "other", 5), m("p", "cli", "code", 5)]);
    expect(a.groups[0]!.canonical.id).toBe(b.groups[0]!.canonical.id);
  });

  it("never groups a name that strips to nothing", () => {
    const r = resolveEntities([m("1", "—"), m("2", "..."), m("3", "!!!")]);
    expect(r.stats.resolved).toBe(0);
    expect(r.groups).toHaveLength(0);
  });

  it("leaves singletons alone", () => {
    const r = resolveEntities([m("1", "alpha"), m("2", "beta")]);
    expect(r.groups).toHaveLength(0);
    expect(r.stats.collapsedTo).toBe(2);
  });

  it("stripName is the whole grouping rule, stated once", () => {
    expect(stripName("  Content_Hash!! ")).toBe("contenthash");
    expect(stripName("content hash")).toBe("contenthash");
    expect(stripName("---")).toBe("");
  });
});
