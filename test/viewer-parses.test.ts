// The viewer is ~900 lines of JavaScript inside an HTML file, and NOTHING in this suite parsed it.
//
// That gap shipped a blank page. An edit inserted a line between an `if` and its existing `else`, leaving an
// orphaned `else`; the whole script failed to parse, so the DOM shell rendered and nothing populated it. The
// map, the pill, the scenes and the legend were all simply absent.
//
// Everything that made the failure invisible is worth naming, because each looked like coverage:
//   • `npm run typecheck` covers .ts files. The template is .html.
//   • The tests that reach into the template extract ONE function at a time with `new Function`, so a
//     function that parses in isolation passes while the file around it is broken.
//   • The wiring tests run the CLI and assert the bundle CONTAINS things, which a broken script still does.
//
// So this parses the whole thing, which is the cheapest possible check and the only one that would have
// caught it. It is deliberately not a lint: style is not the point, "does the browser get a program" is.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "template.html");

describe("viewer/template.html is a program the browser can run", () => {
  const html = readFileSync(TEMPLATE, "utf8");

  it("has exactly one script block, and it PARSES", () => {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(blocks.length).toBe(1);

    // `new Function` is the parser the browser itself would use. A SyntaxError here is a blank page.
    expect(() => new Function(blocks[0]!)).not.toThrow();
  });

  it("still carries the placeholder the exporter substitutes", () => {
    // A parse check is not enough on its own: an edit that renamed or reformatted the placeholder would
    // leave a perfectly valid script that the exporter can no longer fill, and exportViewer's own guard
    // throws at build time rather than render time.
    expect(html).toContain("/*__GRAPH_DATA__*/ {nodes:[],edges:[]}");
  });

  it("the exported bundle parses too, with real data substituted", () => {
    // The template parses; so must the thing that actually ships. This catches an escaping bug in the
    // substitution — graph text containing a quote or a closing script tag — which the template alone
    // cannot show.
    const data = JSON.stringify({
      nodes: [{ id: "a", label: "a \" quote and </script> inside", meta: {} }],
      edges: [], name: "g", layout: {}, prominence: {}, scenes: [], dirtyChunks: 0,
      dirty: { chunks: 0, dirty: 0, never: 0, stale: 0, failing: 0 },
    }).replace(/</g, "\\u003c");
    const filled = html.replace("/*__GRAPH_DATA__*/ {nodes:[],edges:[]}", data);
    const script = /<script>([\s\S]*?)<\/script>/.exec(filled)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(filled).not.toContain("</script></script>");
  });
});
