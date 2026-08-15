// Every element the viewer's script reaches for must actually exist in the viewer's markup.
//
// WHY THIS EXISTS. Twice now a change has blanked the entire page while the whole suite stayed green:
// once an orphaned `else`, and once by removing the #altrail markup while leaving the code that built it.
// The second is the instructive one. `$('altrail')` returned null, `rail.appendChild` threw during INITIAL
// SCRIPT EXECUTION, and a throw there aborts the module — so every later definition, draw() included, never
// runs and the canvas stays empty. Nothing about that is visible to a parser: the file is syntactically
// perfect. viewer-parses.test.ts checks the script PARSES; this checks its DOM assumptions HOLD.
//
// A null-check at the call site would have been the wrong fix. It would have silently kept a dead feature
// alive. The rule this encodes is: removing markup means removing everything that reaches for it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TPL = readFileSync(new URL("../viewer/template.html", import.meta.url), "utf8");
// Comments are stripped before scanning. The first run of this test failed on `altrail` — matched inside the
// very comment written to explain why altrail was removed. A checker that cannot tell prose from code will
// keep finding the ids that documentation mentions, which trains you to ignore it.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")            // block comments
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))     // comment-only lines, where the prose lives
    .join("\n");

const script = stripComments(TPL.slice(TPL.indexOf("<script>"), TPL.lastIndexOf("</script>")));
const markup = TPL.slice(0, TPL.indexOf("<script>"));

/** ids present in the static markup */
const staticIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
/** ids the script creates at runtime, so a lookup for them is legitimate */
const createdIds = new Set([...script.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!));

describe("the viewer's DOM assumptions", () => {
  it("every $('id') / getElementById('id') target exists in the markup or is created by the script", () => {
    const looked = new Set<string>();
    for (const m of script.matchAll(/\$\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) looked.add(m[1]!);
    for (const m of script.matchAll(/getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) looked.add(m[1]!);

    expect(looked.size).toBeGreaterThan(10); // the extractor itself must not silently find nothing

    const missing = [...looked].filter((id) => !staticIds.has(id) && !createdIds.has(id));
    // Named explicitly rather than as a count, so a failure says which element went missing.
    expect(missing).toEqual([]);
  });

  it("querySelector targets that name an id also resolve", () => {
    const missing: string[] = [];
    for (const m of script.matchAll(/querySelector(?:All)?\(\s*['"]#([\w-]+)/g)) {
      const id = m[1]!;
      if (!staticIds.has(id) && !createdIds.has(id)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it("the extractor actually sees the markup and the script (guards against a silent pass)", () => {
    // An instrument that finds nothing reports no failures. Pin both halves so a refactor that moves the
    // <script> tag cannot turn this test into a no-op that still passes.
    expect(staticIds.has("c")).toBe(true);         // the canvas
    expect(staticIds.has("panel")).toBe(true);
    expect(script.length).toBeGreaterThan(20000);
    expect(markup.length).toBeGreaterThan(1000);
  });
});
