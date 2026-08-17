// D4 stage-3, deterministic half (approved 0085): classify the OLD production comms graph's
// entities with the shipped junk filter and measure the per-class fragmentation baseline the
// registered 0081 predictions are scored against. Read-only against the live db.
//
// Classes, per 0081/0082:
//   - junk-member containment pairs (the filter's pile — prediction ~15-25%, measured with a BROAD
//     path regex; the shipped narrow filter is expected to land LOWER, and that definitional gap is
//     reported, not hidden)
//   - multi-type strip groups (type-norm's pile)
//   - guarded containment pairs (token boundary + min strip length >= 3 — stage-2 E7's candidate set)
import Database from "better-sqlite3";
import { isJunkSurface } from "../../src/extract/junkfilter.js";
import { stripName } from "./lexical.js";

// Ordered token sequence (lexical.ts's nameTokens returns an unordered Set — unusable for
// contiguous-run boundary checks). Same camelCase split, but order kept and 1-char tokens too.
const orderedTokens = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const dbPath = process.argv[2] ?? "graphs/comms/graph.db";
const src = new Database(dbPath, { readonly: true });
const NON_ENTITY = ["chunk", "source", "session", "turn", "media"];
const rows = (src.prepare("SELECT text, name, strength FROM nodes WHERE instr(text, char(9)) > 0").all() as Array<{ text: string; name: string; strength: number }>)
  .filter((r) => !NON_ENTITY.includes(r.text.slice(0, r.text.indexOf("\t"))));

const entities = rows.map((r) => ({ type: r.text.slice(0, r.text.indexOf("\t")).toUpperCase(), name: r.name, strip: stripName(r.name) }));
console.log("entity nodes:", entities.length);

const junk = entities.filter((e) => isJunkSurface(e.name));
console.log("junk-filter rejects:", junk.length, JSON.stringify(junk.map((j) => j.name).slice(0, 12)));

const byStrip = new Map<string, Set<string>>();
for (const e of entities) { if (!e.strip) continue; const s = byStrip.get(e.strip) ?? new Set(); s.add(e.type); byStrip.set(e.strip, s); }
const multi = [...byStrip.entries()].filter(([, v]) => v.size > 1);
console.log("strip groups:", byStrip.size, "multi-type groups:", multi.length,
  "worst:", multi.sort((a, b) => b[1].size - a[1].size).slice(0, 5).map(([k, v]) => `${k}:${v.size}`));

// Containment pairs: raw substring-anywhere vs the stage-2 guard (token boundary + inner >= 3).
function tokenBoundary(inner: string, outerName: string): boolean {
  const toks = orderedTokens(outerName);
  for (let i = 0; i < toks.length; i++) {
    let acc = "";
    for (let j = i; j < toks.length; j++) {
      acc += toks[j];
      if (acc === inner) return true;
      if (acc.length > inner.length) break;
    }
  }
  return false;
}
const strips = [...byStrip.keys()];
const nameOfStrip = new Map<string, string>();
for (const e of entities) if (e.strip && !nameOfStrip.has(e.strip)) nameOfStrip.set(e.strip, e.name);
const junkStrips = new Set(junk.map((j) => j.strip));
let raw = 0, guarded = 0, junkMember = 0;
for (let i = 0; i < strips.length; i++) for (let j = i + 1; j < strips.length; j++) {
  const a = strips[i]!, b = strips[j]!;
  if (!(a.includes(b) || b.includes(a))) continue;
  raw++;
  if (junkStrips.has(a) || junkStrips.has(b)) junkMember++;
  const [inner, outer] = a.length < b.length ? [a, b] : [b, a];
  if (inner.length >= 3 && tokenBoundary(inner, nameOfStrip.get(outer) ?? outer)) guarded++;
}
console.log("containment pairs raw:", raw, "| junk-member:", junkMember,
  "| surviving stage-2 guard (E7 candidates):", guarded);
