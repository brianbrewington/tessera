// Ingest — persona adapter (companion to markdown.ts). Reads a synthetic-persona
// markdown/txt doc into the typed graph as ONE PERSON node plus shared attribute/motif
// CONCEPT hubs, wired with PERSON->concept edges, and (as a separate pass) PERSON<->PERSON
// RESONATES_WITH edges for near-duplicate personas. Everything goes through the existing
// PutNodeInput / PutEdgeInput Zod contracts and the store's dedup — nothing is bypassed.
//
// The persona doc schema this parses (exact):
//   PROFILE: <full name>
//   TYPE: <role/type>
//   AGE: <n>
//   COUNTRY: <country>
//   GENDER: <gender>
//
//   BIO:
//   <one paragraph>
//
//   ANSWERS:
//   Q: <question>
//   A: <answer>
//   ... (repeats)
//
// Graph mapping:
//   - ONE PERSON node. text = "<name> [<sourceKey>]" (the sourceKey uniquifier is required:
//     synthetic personas legitimately share names — e.g. four "Anele Sotashe" — and the
//     store dedups nodes by content_hash(text), which would silently collapse distinct
//     personas into one. metadata.name carries the clean display name; the person is
//     EMBEDDED on its bio+answers, not its name, so RESONATES_WITH compares substance.)
//   - Shared CONCEPT hubs (subtype "persona_type" | "country" | "motif") for the structured
//     fields and a few deterministically-extracted BIO/answer motifs. Because their text is
//     the bare value ("South Africa"), the store's content_hash dedup naturally merges them
//     across personas into ONE hub node that reinforces — an over-connected hub is exactly
//     the trope / marginal-collapse signal STEP 3 wants to surface.
//   - Edges PERSON->concept: RELATED for structured attributes, APPEARED_IN for motifs.
//   - RESONATES_WITH (separate connectResonance pass): PERSON<->PERSON cosine over the
//     existing embedder, canonicalized + deduped, above a threshold.
//
// The motif extractor is a documented SEAM: pass any `MotifExtractor` (e.g. an LLM-backed
// one) via options; the default is deterministic and dependency-free (no LLM required).

import { z } from "zod";
import { createHash } from "node:crypto";
import type { GraphStore } from "../store/graphStore.js";
import type { Embedder } from "../embedder.js";
import { Meta, type NodeType, type EdgeKind } from "../schema.js";

// --- Parsed doc (validated at the boundary, house style: Zod, strict) ---

export const PersonaDoc = z
  .object({
    name: z.string().min(1),
    personaType: z.string().min(1),
    age: z.number().int().nonnegative(),
    country: z.string().min(1),
    gender: z.string().min(1),
    bio: z.string().min(1),
    answers: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })),
  })
  .strict();
export type PersonaDoc = z.infer<typeof PersonaDoc>;

const FIELD = (label: string) => new RegExp(`^${label}:\\s*(.+?)\\s*$`, "m");

/** Parse a persona doc (the exact schema above). Throws (via Zod) on a malformed header. */
export function parsePersona(raw: string): PersonaDoc {
  const text = raw.replace(/\r\n/g, "\n");
  const name = text.match(FIELD("PROFILE"))?.[1];
  const personaType = text.match(FIELD("TYPE"))?.[1];
  const ageStr = text.match(/^AGE:\s*(\d+)/m)?.[1];
  const country = text.match(FIELD("COUNTRY"))?.[1];
  const gender = text.match(FIELD("GENDER"))?.[1];

  // BIO is everything between the BIO: marker and the ANSWERS: marker.
  const bio = text.match(/^BIO:\s*\n([\s\S]*?)\n\s*ANSWERS:\s*$/m)?.[1]?.trim();

  // ANSWERS: split the trailing block on blank lines, parse each Q:/A: pair.
  const answersSection = text.split(/^ANSWERS:\s*$/m)[1] ?? "";
  const answers: { q: string; a: string }[] = [];
  for (const block of answersSection.split(/\n\s*\n/)) {
    const m = block.match(/Q:\s*([\s\S]+?)\s*\nA:\s*([\s\S]+?)\s*$/);
    if (m) answers.push({ q: m[1]!.trim(), a: m[2]!.trim() });
  }

  return PersonaDoc.parse({
    name,
    personaType,
    age: ageStr !== undefined ? Number(ageStr) : undefined,
    country,
    gender,
    bio,
    answers,
  });
}

// --- Motif extraction (the pluggable seam) ---

export interface MotifExtractor {
  /** Deterministic-preferred: same text -> same motif list, ordered. */
  extract(text: string, max: number): string[];
}

// A small, standard English stopword set plus a few interview-generic fillers. Kept
// deliberately modest — the extractor is a seam; over-tuning it here is the wrong place.
const STOPWORDS = new Set(
  (
    "the a an and or but if then else of to in on at for from by with as is are was were be been being " +
    "have has had do does did will would could should can may might must not no yes into out up down over under " +
    "this that these those it its they them their there here what which who whom whose when where why how all any " +
    "some most more much many few both each other such only own same so than too very just about above below " +
    "after before again further once i me my we us our you your he him his she her hers me myself himself herself " +
    "themselves ourselves yourself thing things something someone anything nothing really think thought know knew " +
    "like get got go went come came make made take took see saw say said feel felt want wanted way ways time times " +
    "day days year years people person life still even also because still lot maybe probably around every " +
    "actually basically literally honestly seriously certainly definitely completely somewhere everything anyone"
  ).split(/\s+/),
);

/** Default extractor: frequency-ranked content keywords. No LLM, fully deterministic. */
export class KeywordMotifExtractor implements MotifExtractor {
  constructor(private minLen = 4, private minCount = 2) {}
  extract(text: string, max: number): string[] {
    const counts = new Map<string, number>();
    for (const tok of text.toLowerCase().split(/[^a-z\u00c0-\u024f']+/)) {
      const w = tok.replace(/^'+|'+$/g, "");
      // Drop contractions/possessives ("didn't", "it's", "mother's") \u2014 near-always function
      // words that make noisy hubs; the useful stem ("mother") appears un-apostrophed elsewhere.
      if (w.includes("'") || w.length < this.minLen || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, c]) => c >= this.minCount)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // count desc, then alpha — stable
      .slice(0, max)
      .map(([w]) => w);
  }
}

// --- Ingest ---

export interface PersonaIngestOptions {
  extractor?: MotifExtractor;
  maxMotifs?: number; // default 6
}

export interface PersonaIngestResult {
  personId: string;
  reinforced: boolean; // true only if an exact-duplicate persona already existed (rare)
  conceptIds: string[]; // type + country + motif hub ids (deduped/shared across personas)
  edgeCount: number; // PERSON->concept edges asserted this call
}

function sourceKey(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}

/** The text a persona is EMBEDDED on — its substance, so resonance compares content. */
function embedText(doc: PersonaDoc): string {
  return [doc.bio, ...doc.answers.map((qa) => `${qa.q} ${qa.a}`)].join("\n");
}

/**
 * Ingest ONE persona. Creates/reinforces: one PERSON node, the type + country + motif
 * CONCEPT hubs, and PERSON->concept edges. Does NOT compute resonance — run
 * connectResonance() once after a batch (mirrors the ingest/connect split in markdown.ts).
 *
 * @param source a stable per-persona identifier (e.g. the filename). Uniquifies the PERSON
 *   node's text so same-named personas never collapse; also stored in provenance.
 */
export async function ingestPersona(
  store: GraphStore,
  embedder: Embedder,
  doc: PersonaDoc,
  source: string,
  meta: Meta,
  opts: PersonaIngestOptions = {},
): Promise<PersonaIngestResult> {
  const d = PersonaDoc.parse(doc);
  const m = Meta.parse(meta);
  const extractor = opts.extractor ?? new KeywordMotifExtractor();
  const maxMotifs = opts.maxMotifs ?? 6;

  // PERSON node — embedded on its substance (bio+answers), text uniquified by source.
  const personVec = await embedder.embed(embedText(d));
  const person = await store.putNode(
    {
      type: "PERSON",
      origin: "ingest",
      text: `${d.name} [${sourceKey(source)}]`,
      provenance: { source },
      metadata: { name: d.name, type: d.personaType, age: d.age, country: d.country, gender: d.gender },
    },
    m,
    personVec,
  );

  const conceptIds: string[] = [];
  let edgeCount = 0;

  // Structured attributes -> shared CONCEPT hubs, PERSON--RELATED-->hub.
  const attrs: { subtype: string; value: string; label: string }[] = [
    { subtype: "persona_type", value: d.personaType, label: "type" },
    { subtype: "country", value: d.country, label: "country" },
  ];
  for (const a of attrs) {
    const c = await store.putNode(
      { type: "CONCEPT", subtype: a.subtype, origin: "ingest", text: a.value, metadata: { field: a.label } },
      m,
    );
    conceptIds.push(c.id);
    await store.putEdge(
      { from: person.id, to: c.id, kind: "RELATED", reason: `${a.label}: ${a.value}`, origin: "ingest" },
      m,
    );
    edgeCount++;
  }

  // Extracted motifs -> shared CONCEPT hubs, PERSON--APPEARED_IN-->hub.
  for (const motif of extractor.extract(embedText(d), maxMotifs)) {
    const c = await store.putNode(
      { type: "CONCEPT", subtype: "motif", origin: "ingest", text: motif, metadata: { field: "motif" } },
      m,
    );
    conceptIds.push(c.id);
    await store.putEdge(
      { from: person.id, to: c.id, kind: "APPEARED_IN", reason: `motif "${motif}" in ${d.name}`, origin: "ingest" },
      m,
    );
    edgeCount++;
  }

  return { personId: person.id, reinforced: person.reinforced, conceptIds, edgeCount };
}

// --- Resonance (a separate analytic pass, like connect() in connector.ts) ---

export interface ResonanceOptions {
  k?: number; // PERSON neighbors considered per person (default 12)
  threshold?: number; // min cosine for a RESONATES_WITH edge (default 0.85 — near-duplicate)
}

/**
 * Link near-duplicate personas with PERSON<->PERSON RESONATES_WITH edges, using the SAME
 * embedder cosine the store already stores per node. Pairs are canonicalized (from < to)
 * and deduped, so A~B and B~A are one undirected edge. Returns the number of edges created.
 */
export async function connectResonance(
  store: GraphStore,
  meta: Meta,
  opts: ResonanceOptions = {},
): Promise<number> {
  const k = opts.k ?? 12;
  const threshold = opts.threshold ?? 0.85;
  const m = Meta.parse(meta);
  const persons = store.allNodes().filter((n) => (n.type as NodeType) === "PERSON");
  const seen = new Set<string>();
  let created = 0;

  for (const p of persons) {
    const vec = store.vectorOf(p.id, "quarantine");
    if (!vec) continue;
    const hits = await store.querySimilar(vec, k + 1, { index: "quarantine" });
    for (const h of hits) {
      if (h.node.id === p.id || (h.node.type as NodeType) !== "PERSON" || h.cosine < threshold) continue;
      const [from, to] = p.id < h.node.id ? [p.id, h.node.id] : [h.node.id, p.id];
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await store.putEdge(
        {
          from: from!,
          to: to!,
          kind: "RESONATES_WITH" as EdgeKind,
          reason: `persona resonance (cos=${h.cosine.toFixed(2)})`,
          origin: "connector",
        },
        m,
      );
      if (r.created) created++;
    }
  }
  return created;
}
