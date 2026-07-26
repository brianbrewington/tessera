// Extraction — turn a chunk of text into typed ENTITIES and RELATIONS, using the battle-tested
// prompt design from docs/history (LightRAG entity+relation + the UNIVERSAL schema + NEGATIVE_CONSTRAINTS
// + the CRITICAL EDGE RULE: an edge reason must name BOTH endpoints). Output is JSON (easier to parse in
// TS than LightRAG's delimiter format) validated by Zod. The `Extractor` interface is the seam so ingest
// can be tested with a canned extraction and the real LLM extractor swaps in for live runs.
import { z } from "zod";
import type { Chat } from "../llm.js";

export const EntityType = z.enum([
  "PERSON", "ORGANIZATION", "PLACE", "PROJECT", "TECHNOLOGY", "CODE", "FILE",
  "CONCEPT", "EVENT", "PRODUCT", "LESSON", "WISDOM", "MEMORY", "OTHER",
]);
export type EntityType = z.infer<typeof EntityType>;

export const Entity = z.object({
  name: z.string().min(1),
  type: EntityType.catch("OTHER"),
  description: z.string().default(""),
});
export const Relation = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  reason: z.string().min(1),
});
export const Extraction = z.object({
  entities: z.array(Entity).default([]),
  relations: z.array(Relation).default([]),
});
export type Extraction = z.infer<typeof Extraction>;

export interface ExtractResult {
  extraction: Extraction;
  parsed: boolean; // false = the model's reply couldn't be parsed (distinct from a genuinely empty chunk)
}

export interface Extractor {
  extract(text: string, opts?: { subject?: string }): Promise<ExtractResult>;
}

/** Extra instructions when the document has a known primary subject (a persona). Makes the subject the hub of
 *  its own document: it's extracted as an entity, connected to what the text says about it, and people known
 *  only by relation to it are named "<Subject>'s <Relation>" AND linked back — so nothing floats unconnected. */
export function subjectClause(subject?: string): string {
  if (!subject || !subject.trim()) return "";
  const s = subject.trim();
  return `

## SUBJECT OF THIS DOCUMENT
The primary subject is the PERSON "${s}". Passages speak about them in the first person (I, me, my) and the
third (their name; he/she/they). Resolve all of these to "${s}". Then:
- Extract "${s}" itself as a PERSON entity whenever the passage is about them, so relations to them have BOTH endpoints.
- Connect "${s}" to the specific things the passage says about them — their people, places, projects, work, events.
- A person known ONLY by relation to "${s}" (a father, a sister, an unnamed neighbour): name them "${s}'s <Relation>"
  (e.g. "${s}'s Father") — NEVER a bare role like "Father" — AND emit a relation to "${s}" whose reason is the
  specific bond ("is the father of", "is a sibling of", "mentored").`;
}

// Ported from docs/history/memory-agent/system-design.md:327-396 (LightRAG) + graphrag-integration-
// playbook.md:183-261 (portable node+edge) + ideas-ledger.md:76-82 (NEGATIVE_CONSTRAINTS / UNIVERSAL).
export const EXTRACTION_SYSTEM = `You are a Knowledge Graph Specialist extracting a clean, retrieval-oriented knowledge graph from a document (which may be a persona, a chat transcript, code, a wiki page, an email thread, or a book chapter).

Output ONLY a JSON object — no markdown fence, no prose:
{"entities":[{"name":"","type":"","description":""}],"relations":[{"source":"","target":"","reason":""}]}

## ENTITIES
- name: the SPECIFIC proper name or precise concept, Title-Cased, kept WHOLE. Never split a multi-word name ("De Doorns", "Klipgat Farm" are ONE entity each). Use consistent naming across the whole extraction.
- type: exactly one of PERSON, ORGANIZATION, PLACE, PROJECT, TECHNOLOGY, CODE, FILE, CONCEPT, EVENT, PRODUCT, LESSON, WISDOM, MEMORY, OTHER.
- description: a self-contained, retrieval-ready sentence — what it is AND why it matters here. For WISDOM/LESSON/MEMORY, name who it is attributed to when the text says so.
- Capture SPECIFIC named things even if mentioned only ONCE (a place, a product, a person, a dated event).

## DO NOT EXTRACT (these pollute the graph — drop them)
- Buzzwords / abstractions: Strategy, Innovation, Synergy, Growth, Impact, Journey, Excellence, Success, Passion.
- Bare existentials: Life, Time, Future, World, People, Work, Community.
- Empty shells: Project, Team, Thing, System, Process — UNLESS qualified into a specific named instance.
- Generic common nouns and passing mentions (e.g. "grapes", "farm", "phone", "light"). If it is not a specific, name-or-adjective-qualified thing, drop it.
- Keep to roughly the 8-20 most graph-worthy entities. Prefer specific over generic.

## RELATIONS
- source, target: entity names exactly as extracted above.
- reason: the SPECIFIC nature of the relationship — the action, role, or fact that links the two — as a standalone phrase. This is the single most important rule. Do NOT restate the source/target names in the reason: the graph already records WHICH two are linked, so repeating their names adds no information and anchors retrieval to those two nodes instead of the KIND of relationship. Name a THIRD party or concrete detail only when it is essential.
  GOOD (specific — and note, NO endpoint names): "picks grapes seasonally as hired harvest labour"; "grows Cabernet and Chardonnay for a mid-tier wine brand sold mostly in Johannesburg".
  BAD (NEVER produce — vague, no real relationship): "related concept", "uses this", "connected", "is part of", "associated with".
- Two entities may share MORE THAN ONE relationship — emit each distinct one as its OWN relation (e.g. two people can be kin AND share a pursuit; a person can both work at and live near a place). Decompose N-ary relationships into binary pairs. Every important entity should connect to at least 2 others when the text supports it. Relations are undirected unless the text is clearly directional.

In descriptions, use third person and name subjects explicitly (never "this document" / "the persona"). Output the JSON object only.`;

const norm = (s: string): string => s.trim().toLowerCase();

/** Each balanced {...} group in a string (brace-counting, string-aware), left to right — tolerant of chatty
 *  models that wrap the payload in prose or emit a decoy object first (e.g. "I found {2} groups: {...}"). */
export function* jsonObjectCandidates(text: string): Generator<string> {
  let i = text.indexOf("{");
  while (i >= 0) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) return; // unbalanced tail — nothing more to yield
    yield text.slice(i, end + 1);
    i = text.indexOf("{", end + 1);
  }
}

/** First balanced {...} object in a string — tolerant of chatty models. */
export function firstJsonObject(text: string): string | null {
  return jsonObjectCandidates(text).next().value ?? null;
}

/** Keep the schema-valid elements of an array, dropping the bad ones (one malformed row must not void all). */
function salvage<S extends z.ZodTypeAny>(arr: unknown, schema: S): z.infer<S>[] {
  return Array.isArray(arr) ? arr.flatMap((x) => { const r = schema.safeParse(x); return r.success ? [r.data] : []; }) : [];
}

/** Parse + validate an extraction reply. Never throws. `parsed:false` ONLY when no candidate is parseable JSON
 *  (distinct from a valid-but-empty chunk). A reply that IS valid JSON but has some malformed entities/relations
 *  is `parsed:true` with the bad rows dropped — one bad element never discards the good ones. */
export function parseExtraction(raw: string): ExtractResult {
  // Prefer the first candidate SHAPED like an extraction (has an entities/relations array) over an earlier
  // decoy object a chatty model may have emitted (e.g. "I found {"count":2}: {...real...}"); fall back to the
  // first parseable object if none is payload-shaped.
  let obj: Record<string, unknown> | null = null;
  let fallback: Record<string, unknown> | null = null;
  for (const cand of jsonObjectCandidates(raw)) {
    let o: unknown;
    try { o = JSON.parse(cand); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    fallback ??= rec;
    if (Array.isArray(rec.entities) || Array.isArray(rec.relations)) { obj = rec; break; }
  }
  obj ??= fallback;
  if (!obj) return { extraction: { entities: [], relations: [] }, parsed: false };
  const entities = salvage(obj.entities, Entity);
  // Keep only relations whose endpoints were actually extracted (drop hallucinated dangling edges). Match on
  // normalized names so a relation citing "de doorns" survives against entity "De Doorns" (the mapper norms too).
  const names = new Set(entities.map((e) => norm(e.name)));
  const relations = salvage(obj.relations, Relation).filter((r) => names.has(norm(r.source)) && names.has(norm(r.target)));
  return { extraction: { entities, relations }, parsed: true };
}

export class LlmExtractor implements Extractor {
  constructor(private chat: Chat, private opts: { temperature?: number } = {}) {}
  async extract(text: string, opts: { subject?: string } = {}): Promise<ExtractResult> {
    const system = EXTRACTION_SYSTEM + subjectClause(opts.subject);
    const raw = await this.chat.complete(system, text, { temperature: this.opts.temperature ?? 0.4 });
    return parseExtraction(raw);
  }
}
