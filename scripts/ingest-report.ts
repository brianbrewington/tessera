// Ingest scorecard — turn "this graph feels noisy" into numbers you can drive down (plan I1). Read-only over a
// BUILT graph: entities/doc + type histogram, top hubs by degree, % of RELATED reasons that name both endpoints
// (the retrieval signal), banned-phrase count, buzzword-hub count (NEGATIVE_CONSTRAINTS leaks), orphan rate.
//   npx tsx scripts/ingest-report.ts <graphname|path/to/graph.db>
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

export const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const HERE = dirname(fileURLToPath(import.meta.url));

// Provenance nodes are the ingest spine, not extracted content — excluded from "entity" metrics.
const isProvenance = (subtype: string | null): boolean => subtype === "document" || subtype === "chunk";

// The extractor's NEGATIVE_CONSTRAINTS list — anything here that became an entity is a leak the human should see.
const BUZZWORDS = new Set(
  ["strategy", "innovation", "synergy", "growth", "impact", "journey", "excellence", "success", "passion",
    "life", "time", "future", "world", "people", "work", "community", "project", "team", "thing", "system", "process"],
);
// The extractor prompt's explicit BAD edge reasons (kept EXACTLY in sync with EXTRACTION_SYSTEM). Matched on
// word boundaries so "connected" flags "the two are connected" but not "disconnected"/"interconnected".
const BANNED_PHRASES = ["related concept", "uses this", "connected", "is part of", "associated with"];
const BANNED_RE = new RegExp(`\\b(?:${BANNED_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

// An endpoint counts as "named" in a reason if the reason contains the full name (contiguous) OR a DISTINCTIVE
// whole-word token of it — distinctive = a token of this endpoint that the OTHER endpoint does not share. This
// kills two failure modes: substring collisions ("farm" in "farmworkers") via whole-word matching, and shared
// family tokens ("the Cloete family" naming neither Charnel Cloete nor Maria Cloete) via the distinctive filter.
export function namesEndpoint(reasonWords: Set<string>, reasonLower: string, name: string, otherTokens: Set<string>): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (reasonLower.includes(n)) return true; // exact contiguous name (also the only path for short <3-char tokens)
  return tokenize(n).some((t) => t.length >= 3 && !otherTokens.has(t) && reasonWords.has(t));
}

export interface Scorecard {
  docs: number; chunks: number; edges: number; entities: number;
  entitiesPerDoc: number; appearancesPerChunk: number;
  typeHistogram: [string, number][]; // "TYPE/subtype" -> count, desc
  topHubs: { name: string; type: string; degree: number; strength: number }[];
  relatedReasons: number; deAnchoredReasons: number; deAnchoredPct: number; reasonsPerEdge: number; // per ASSERTION
  bannedPhraseReasons: { reason: string }[];
  buzzwordHubs: { name: string; type: string }[];
  orphanEntities: number; orphanPct: number; // entities with no RELATED edge
  mergedPersons: { name: string; sources: number; strength: number }[]; // PERSON nodes spanning >1 source doc (merge audit)
}

export function report(dbPath: string): Scorecard {
  if (!existsSync(dbPath)) throw new Error(`no graph db at ${dbPath}`); // never let GraphStore fabricate one
  const store = new GraphStore({ path: dbPath, embedder: new StubEmbedder(768) });
  try {
    const nodes = store.allNodes();
    const edges = store.allEdges();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    const docs = nodes.filter((n) => n.subtype === "document").length;
    const chunks = nodes.filter((n) => n.subtype === "chunk").length;
    const entities = nodes.filter((n) => !isProvenance(n.subtype ?? null));
    const appearedIn = edges.filter((e) => e.kind === "APPEARED_IN").length;

    const typeCounts = new Map<string, number>();
    for (const n of entities) {
      const k = `${n.type}/${n.subtype ?? "-"}`;
      typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
    }

    // RELATED degree per node (the semantic connectivity — provenance edges don't make a "hub").
    const related = edges.filter((e) => e.kind === "RELATED");
    const degree = new Map<string, number>();
    for (const e of related) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    // A node with no first-class name can't be "named" in a reason (its identity string would spuriously match
    // tokens like "person"); use "" so it never counts. Hubs still get a display fallback separately.
    const nameOf = (id: string): string => nodeById.get(id)?.name ?? "";
    const topHubs = entities
      .map((n) => ({ name: n.name ?? n.text.slice(0, 40), type: `${n.type}/${n.subtype ?? "-"}`, degree: degree.get(n.id) ?? 0, strength: n.strength }))
      .sort((a, b) => b.degree - a.degree || b.strength - a.strength)
      .slice(0, 15);

    // Score EVERY assertion reason (an edge can carry several — its facets). Denominator = total reasons, so the
    // metric is independent of ingest order. The rule (Option A): a reason carries the RELATIONSHIP, not its
    // endpoints. "De-anchored" = names NEITHER endpoint, so the embedding clusters on the KIND of link, not the
    // two nodes. Banned phrases (vagueness) are orthogonal — a reason should be de-anchored AND specific.
    let relatedReasons = 0, deAnchoredReasons = 0;
    const bannedPhraseReasons: { reason: string }[] = [];
    for (const e of related) {
      const aName = nameOf(e.from), bName = nameOf(e.to);
      const aTokens = new Set(tokenize(aName)), bTokens = new Set(tokenize(bName));
      for (const raw of store.edgeReasons(e.id)) {
        relatedReasons++;
        const lower = raw.toLowerCase();
        const words = new Set(tokenize(raw));
        if (!namesEndpoint(words, lower, aName, bTokens) && !namesEndpoint(words, lower, bName, aTokens)) deAnchoredReasons++;
        if (BANNED_RE.test(lower)) bannedPhraseReasons.push({ reason: raw });
      }
    }

    const buzzwordHubs = entities
      .filter((n) => BUZZWORDS.has((n.name ?? "").trim().toLowerCase()))
      .map((n) => ({ name: n.name ?? n.text, type: `${n.type}/${n.subtype ?? "-"}` }));

    const orphanEntities = entities.filter((n) => (degree.get(n.id) ?? 0) === 0).length;
    const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

    // PERSON-merge audit (v1): PERSON identity is type+name (no source qualifier), so a same-named person from
    // two docs is ONE node — intended for a real recurring person, but a genuine same-name-different-person
    // collision merges silently. Surface every PERSON whose APPEARED_IN chunks trace to MORE THAN ONE source
    // document (ranked by span, then strength) so a human can eyeball whether a merge was right.
    const chunkSource = new Map<string, string>(); // chunk id -> its source-document id
    for (const e of edges) if (e.kind === "ORIGINATED_FROM") chunkSource.set(e.from, e.to);
    const personSources = new Map<string, Set<string>>();
    for (const e of edges) {
      if (e.kind !== "APPEARED_IN" || nodeById.get(e.from)?.type !== "PERSON") continue;
      const src = chunkSource.get(e.to);
      if (!src) continue;
      let set = personSources.get(e.from);
      if (!set) personSources.set(e.from, (set = new Set()));
      set.add(src);
    }
    const mergedPersons = [...personSources.entries()]
      .filter(([, srcs]) => srcs.size > 1)
      .map(([id, srcs]) => ({ name: nodeById.get(id)?.name ?? id, sources: srcs.size, strength: nodeById.get(id)?.strength ?? 0 }))
      .sort((a, b) => b.sources - a.sources || b.strength - a.strength);

    return {
      docs, chunks, edges: edges.length, entities: entities.length,
      entitiesPerDoc: docs === 0 ? 0 : Math.round((entities.length / docs) * 10) / 10,
      appearancesPerChunk: chunks === 0 ? 0 : Math.round((appearedIn / chunks) * 10) / 10,
      typeHistogram: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]),
      topHubs,
      relatedReasons, deAnchoredReasons, deAnchoredPct: pct(deAnchoredReasons, relatedReasons),
      reasonsPerEdge: related.length === 0 ? 0 : Math.round((relatedReasons / related.length) * 100) / 100,
      bannedPhraseReasons,
      buzzwordHubs,
      orphanEntities, orphanPct: pct(orphanEntities, entities.length),
      mergedPersons,
    };
  } finally {
    store.close();
  }
}

export function printScorecard(sc: Scorecard): void {
  const p = (s: string): void => console.log(s);
  p("=== tessera ingest scorecard ===");
  p(`corpus: ${sc.docs} doc(s), ${sc.chunks} chunk(s) -> ${sc.entities} entities, ${sc.edges} edges (all kinds)`);
  p(`entities/doc: ${sc.entitiesPerDoc}  (rubric target ~5-15 for a persona)   appearances/chunk: ${sc.appearancesPerChunk}`);
  p("");
  p("entity types:");
  for (const [k, n] of sc.typeHistogram) p(`  ${n.toString().padStart(4)}  ${k}`);
  p("");
  p("top hubs (by RELATED degree):");
  for (const h of sc.topHubs) p(`  deg ${h.degree.toString().padStart(3)}  x${h.strength}  ${h.name}  [${h.type}]`);
  p("");
  p(`de-anchored reasons (name NEITHER endpoint): ${sc.deAnchoredReasons}/${sc.relatedReasons}  (${sc.deAnchoredPct}%)  — higher is better`);
  p(`reasons per edge: ${sc.reasonsPerEdge}  — facet richness (>1 = edges carry multiple relationships)`);
  p(`banned-phrase reasons: ${sc.bannedPhraseReasons.length}  — target 0 (vague; orthogonal to de-anchoring)`);
  for (const b of sc.bannedPhraseReasons.slice(0, 5)) p(`    ! "${b.reason.slice(0, 90)}"`);
  p(`buzzword hubs (NEGATIVE_CONSTRAINTS leaks): ${sc.buzzwordHubs.length}  — target 0`);
  for (const b of sc.buzzwordHubs.slice(0, 10)) p(`    ! ${b.name}  [${b.type}]`);
  p(`orphan entities (no RELATED edge): ${sc.orphanEntities}  (${sc.orphanPct}%)  — high = fragmentation`);
  p(`PERSON-merge audit (nodes spanning >1 source doc): ${sc.mergedPersons.length}  — eyeball for wrong same-name merges`);
  for (const m of sc.mergedPersons.slice(0, 10)) p(`    ~ ${m.name}  (${m.sources} sources, x${m.strength})`);
}

// Resolve a bare graph name to graphs/<name>/graph.db; otherwise treat the arg as a direct path.
function resolveDb(arg: string): string {
  if (arg.endsWith(".db") || arg.includes("/")) return arg;
  return join(HERE, "..", "graphs", arg, "graph.db");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: ingest-report <graphname|path/to/graph.db>"); process.exit(1); }
  const db = resolveDb(arg);
  if (!existsSync(db)) { console.error(`no graph db at ${db}`); process.exit(1); }
  printScorecard(report(db));
}
