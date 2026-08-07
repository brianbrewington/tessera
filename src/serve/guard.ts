// The request guard (design §7.2). MEASURED in Chrome and Firefox, which agreed on every field — not
// derived, because two "obvious" rules were each written and each would have broken the app:
//
//   observed:  GET /        (typed URL)      Origin absent   Sec-Fetch-Site: none
//              GET /events  (EventSource)    Origin absent   Sec-Fetch-Site: same-origin
//              POST /ingest (fetch)          Origin present  Sec-Fetch-Site: same-origin
//              curl / any non-browser        Origin absent   Sec-Fetch-Site absent
//
//   rule 1 that broke:  "reject a missing Origin" — rejects our own EventSource, which sends none.
//   rule 2 that broke:  "require Sec-Fetch-Site: same-origin everywhere" — blocks the initial page load,
//                       because a typed URL sends `none`.
//
// DO NOT MODIFY THIS FILE WITHOUT RE-RUNNING scripts/bench/header-probe.mjs IN BOTH ENGINES.
//
// Threat model (design F-4): hostile WEB PAGES, not local processes. A local process can forge any header
// and can also just open the SQLite file, so pretending otherwise would be theatre.

export type RouteKind = "navigation" | "api";

export interface GuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  kind: RouteKind;
}

export interface GuardVerdict {
  ok: boolean;
  status?: number;
  reason?: string;
}

/** Hosts a loopback server may legitimately be addressed as, for a given port. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

const OK: GuardVerdict = { ok: true };
const deny = (status: number, reason: string): GuardVerdict => ({ ok: false, status, reason });

/**
 * The only check that stops DNS rebinding is `Host`. Binding to 127.0.0.1 does NOT: a page on evil.com whose
 * DNS is rebound to loopback is same-origin in the browser's eyes, sends no Origin, and triggers no
 * preflight — so without a Host check `GET /` would hand it the entire personal knowledge graph.
 */
export function guard(input: GuardInput, port: number, expectedOrigin: string | readonly string[]): GuardVerdict {
  const hosts = allowedHosts(port);
  if (!input.host || !hosts.includes(input.host.toLowerCase())) {
    return deny(403, `bad Host header ${JSON.stringify(input.host ?? null)} — expected one of ${hosts.join(", ")}`);
  }

  // Origin: strict compare WHEN PRESENT. Never required — the page's own EventSource sends none.
  const acceptable = typeof expectedOrigin === "string" ? [expectedOrigin] : expectedOrigin;
  if (input.origin !== undefined && input.origin !== "null" && !acceptable.includes(input.origin)) {
    return deny(403, `foreign Origin ${input.origin}`);
  }
  if (input.origin === "null") {
    // an opaque origin (sandboxed iframe, or a file:// page posting at us) is never our own page
    return deny(403, "opaque Origin");
  }

  if (input.kind === "navigation") {
    // A typed URL / bookmark sends Sec-Fetch-Site: none. Requiring same-origin here blocks the page load.
    if (input.secFetchSite !== undefined && !["none", "same-origin"].includes(input.secFetchSite)) {
      return deny(403, `navigation from ${input.secFetchSite}`);
    }
    return OK;
  }

  // API routes: the page's own fetch and EventSource both send same-origin, so require it. A non-browser
  // client sends no Sec-Fetch-* at all and is allowed through — see the threat model above. This is a
  // deliberate, stated gap, not an oversight.
  if (input.secFetchSite !== undefined && input.secFetchSite !== "same-origin") {
    return deny(403, `cross-site request to an API route (Sec-Fetch-Site: ${input.secFetchSite})`);
  }
  return OK;
}

/** Mutating methods need an Origin when the client is a browser; GET/HEAD legitimately have none. */
export function isMutating(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
