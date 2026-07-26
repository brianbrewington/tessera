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
  extract(text: string): Promise<ExtractResult>;
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
- reason: a concise explanation that EXPLICITLY NAMES BOTH ENDPOINTS. This is the single most important rule — edge reasons are the primary retrieval signal.
  GOOD: "Charnel Cloete picks grapes seasonally at Klipgat Farm near De Doorns"; "Klipgat Farm grows Cabernet and Chardonnay for a mid-tier wine brand sold mostly in Johannesburg".
  BAD (NEVER produce): "related concept", "uses this", "connected", "is part of", "associated with".
- Every important entity should connect to at least 2 others when the text supports it. Decompose N-ary relationships into binary pairs. Relations are undirected unless the text is clearly directional.

Third person; name subjects explicitly (never "this document" / "the persona"). Output the JSON object only.`;

/** First balanced {...} object in a string (brace-counting, string-aware) — tolerant of chatty models. */
export function firstJsonObject(text: string): string | null {
  const i = text.indexOf("{");
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return null;
}

/** Parse + validate an extraction reply. Never throws — reports `parsed:false` on unparseable output so a
 *  silent parse failure is distinguishable from a genuinely empty chunk. */
export function parseExtraction(raw: string): ExtractResult {
  const js = firstJsonObject(raw);
  if (!js) return { extraction: { entities: [], relations: [] }, parsed: false };
  let obj: unknown;
  try { obj = JSON.parse(js); } catch { return { extraction: { entities: [], relations: [] }, parsed: false }; }
  const p = Extraction.safeParse(obj);
  if (!p.success) return { extraction: { entities: [], relations: [] }, parsed: false };
  // Keep only relations whose endpoints were actually extracted (drop hallucinated dangling edges).
  const names = new Set(p.data.entities.map((e) => e.name));
  return {
    extraction: {
      entities: p.data.entities,
      relations: p.data.relations.filter((r) => names.has(r.source) && names.has(r.target)),
    },
    parsed: true,
  };
}

export class LlmExtractor implements Extractor {
  constructor(private chat: Chat, private opts: { temperature?: number } = {}) {}
  async extract(text: string): Promise<ExtractResult> {
    const raw = await this.chat.complete(EXTRACTION_SYSTEM, text, { temperature: this.opts.temperature ?? 0.4 });
    return parseExtraction(raw);
  }
}
