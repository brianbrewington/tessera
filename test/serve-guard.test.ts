// The request guard (design §7.2). This is the security core of slice 3, and its rules are MEASURED, not
// derived — two "obvious" rules were each written into the design and each would have broken the app:
//   "reject missing Origin"           -> rejects our own EventSource (a same-origin GET sends none)
//   "require same-origin everywhere"  -> blocks the initial page load (a typed URL sends `none`)
// Both tests below encode the observed browser behaviour, so a future "hardening" that breaks the app fails
// here instead of in a user's tab.
import { describe, it, expect } from "vitest";
import { guard, allowedHosts, isMutating } from "../src/serve/guard.js";

const PORT = 7777;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const g = (i: Partial<Parameters<typeof guard>[0]>) =>
  guard({ method: "GET", host: `127.0.0.1:${PORT}`, origin: undefined, secFetchSite: undefined, kind: "api", ...i }, PORT, ORIGIN);

describe("Host — the only thing that stops DNS rebinding", () => {
  it("accepts the loopback forms a browser legitimately sends", () => {
    for (const h of allowedHosts(PORT)) expect(g({ host: h }).ok).toBe(true);
    expect(g({ host: `LOCALHOST:${PORT}` }).ok).toBe(true); // case-insensitive
  });

  it("REJECTS a rebound host on every route, including the page itself", () => {
    // The attack: evil.com rebinds DNS to 127.0.0.1. The browser treats it as same-origin with evil.com, so
    // it sends no Origin and triggers no preflight — binding to loopback does not help. Only Host does.
    for (const kind of ["navigation", "api"] as const) {
      const v = g({ host: `evil.com:${PORT}`, kind, secFetchSite: kind === "navigation" ? "none" : "same-origin" });
      expect(v.ok).toBe(false);
      expect(v.status).toBe(403);
      expect(v.reason).toMatch(/Host/);
    }
  });

  it("rejects a missing Host, and the right port on the wrong interface", () => {
    expect(g({ host: undefined }).ok).toBe(false);
    expect(g({ host: `192.168.1.5:${PORT}` }).ok).toBe(false);
    expect(g({ host: `127.0.0.1:${PORT + 1}` }).ok).toBe(false); // a different server's port
  });
});

describe("Origin — compared when present, NEVER required", () => {
  it("accepts our own origin and rejects a foreign one", () => {
    expect(g({ origin: ORIGIN, secFetchSite: "same-origin" }).ok).toBe(true);
    const v = g({ origin: "https://evil.example", secFetchSite: "same-origin" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/foreign Origin/);
  });

  it("ACCEPTS an absent Origin on /events — the bug that would have broken our own client", () => {
    // Measured: the page's own EventSource sends Sec-Fetch-Site: same-origin and NO Origin. A rule that
    // required Origin would reject the SSE stream the drop target depends on.
    expect(g({ origin: undefined, secFetchSite: "same-origin", kind: "api" }).ok).toBe(true);
  });

  it("rejects an opaque `null` Origin (sandboxed iframe, or a file:// page posting at us)", () => {
    expect(g({ origin: "null", secFetchSite: "cross-site" }).ok).toBe(false);
  });
});

describe("Sec-Fetch-Site — per route, because navigation and API differ", () => {
  it("ACCEPTS `none` on navigation — the bug that would have blocked the page load", () => {
    // Measured: typing the URL or opening a bookmark sends Sec-Fetch-Site: none.
    expect(g({ kind: "navigation", secFetchSite: "none" }).ok).toBe(true);
    expect(g({ kind: "navigation", secFetchSite: "same-origin" }).ok).toBe(true);
  });

  it("rejects a cross-site navigation (a link from another page)", () => {
    expect(g({ kind: "navigation", secFetchSite: "cross-site" }).ok).toBe(false);
    expect(g({ kind: "navigation", secFetchSite: "same-site" }).ok).toBe(false);
  });

  it("requires same-origin on API routes", () => {
    expect(g({ kind: "api", secFetchSite: "same-origin" }).ok).toBe(true);
    expect(g({ kind: "api", secFetchSite: "cross-site" }).ok).toBe(false);
    expect(g({ kind: "api", secFetchSite: "none" }).ok).toBe(false); // a typed URL is not an API client
  });

  it("lets a non-browser client through — a DELIBERATE, stated gap", () => {
    // curl sends no Sec-Fetch-* at all. Blocking it would be theatre: a local process can forge any header
    // and can also just open the SQLite file. The threat model is hostile web PAGES (design F-4).
    expect(g({ kind: "api", secFetchSite: undefined, origin: undefined }).ok).toBe(true);
  });
});

describe("isMutating", () => {
  it("classifies the methods that need an Origin from a browser", () => {
    expect(isMutating("GET")).toBe(false);
    expect(isMutating("head")).toBe(false);
    expect(isMutating("POST")).toBe(true);
    expect(isMutating("put")).toBe(true);
  });
});
