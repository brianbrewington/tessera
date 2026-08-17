// D4 stage 1a — parse-time junk filter (channel 0079, amended 0081/0087; approved 0085).
//
// Rejects entity SURFACES whose syntax shape marks them as extractor junk, at zero model cost.
// The rule is deliberately narrow: it targets SHAPES, never "contains a path separator" — in a
// corpus about software and a message channel, path-bearing names (control/PAUSE, docs/….md,
// frontend/server.py) are first-class entities with real edges, and a slash rule was measured to
// kill 29 legitimate surfaces in the E11 arm-A extraction vs 4 true junk hits (0087's catch).
//
// Rejected shapes, each observed in the confirmatory sidecar:
//   1. Relative-path prefixes (../PROTOCOL.md, ./notes.md) — the same document under an unstable
//      path spelling; the canonical surface is the bare doc name or a stable full path.
//   2. Template placeholders (messages/0002-<your-handle>.md, chars: <n>) — schema text from the
//      protocol docs, not a referent. Any angle-bracket segment marks the surface as a template.
//   3. Markdown heading leftovers (# Decision queue) — structure minted as an entity.

// Cross-agent review round (Grok 4.6 + Composer 2.5, both independently): the first TEMPLATE regex
// (any <...> segment) was the top-ranked defect — it rejected generics (Promise<string>), math
// (a<b>c), and "Name <email>". A placeholder differs from those in two ways, both required here:
// the < is NOT glued to a preceding identifier (generics are), and the content is a bare lowercase
// slug (emails and "< y >" are not). Residual accepted: "#include <vector>" still rejects — a code
// line, not an entity name.
const REL_PREFIX = /^\.\.?[\\/]/;
const REL_EMBEDDED = /\/\.\.?\//; // src/../PROTOCOL.md — no legitimate name carries a traversal segment
const TEMPLATE = /(^|[\s\-/:.])<[a-z][a-z0-9_-]*>/;
const HEADING = /^#{1,6}\s/;

/** True when a surface's syntax shape marks it as extractor junk (see module doc for the classes). */
export function isJunkSurface(name: string): boolean {
  const s = name.trim();
  return REL_PREFIX.test(s) || REL_EMBEDDED.test(s) || TEMPLATE.test(s) || HEADING.test(s);
}
