/**
 * E11 — write-time known-node injection vs read-side resolution.
 * Protocol: docs/dedup-experiment-protocol.md §E11 with its three pre-run amendments (0054/0056/0057).
 * Approved as decision D3. Every rule below was frozen before this file ran.
 *
 * THREE ARMS over one frozen chunk set (the comms conversation — the measured duplication worst case),
 * processed IN SEQUENCE so each injection arm conditions on ITS OWN growing graph, which is the real
 * dynamics including any self-reinforcement:
 *   A — no injection (production behaviour).
 *   B — deterministic reuse-only: offer ONLY known names whose strip-form appears in THIS chunk's
 *       strip-text. Parse-time normalization; no judgment travels into the prompt.
 *   C — full injection: offer the arm's strongest known names regardless of match.
 *
 * All arms use the quote-requiring extraction prompt (E10's Arm S): metric 2 is DEFINED by the quote gate.
 * All arms store RAW SURFACE FORMS beside canonical assertions in the sidecar — the reversibility that
 * 0056's amendment leans on is this column.
 *
 * Extraction products flow through the PRODUCTION mapper into a real GraphStore per arm, so merge
 * semantics are production's (identity = type+norm(name); reinforce on re-mention), not a reimplementation.
 */
import Database from "better-sqlite3";
import { writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../../src/store/graphStore.js";
import { StubEmbedder } from "../../src/embedder.js";
import { OllamaChat } from "../../src/llm.js";
import { mapExtraction } from "../../src/ingest/mapper.js";
import { entityIdentity } from "../../src/extract/identity.js";
import { Extraction } from "../../src/extract/extractor.js";
import { ARM_S_PROMPT, parseWithQuotes } from "./e10-span-extraction.js";
import { verifyQuote, type QuoteVerdict } from "../../src/ask/quotes.js";
import { stripName } from "./lexical.js";

const MODEL = "qwen2.5:14b";
const TEMP = 0.4;
const C_OFFER_CAP = 80;

// --- the frozen core hard-negative set (0052/0057): any merge of one of these DISQUALIFIES the arm -------
// Each pair: the same surface (or near-surface) means two DIFFERENT things in this corpus. Scored by
// checking whether the two mention contexts landed on one node.
export const CORE_COLLISIONS = [
  { surface: "E3", a: "tessera's verifier experiment E3", b: "any non-tessera E3 usage", type_hint: "concept" },
  { surface: "claude-code", a: "the channel handle/agent", b: "Claude Code the product", type_hint: "person|technology|product" },
  { surface: "span", a: "span-containment the metric", b: "a text span / the word", type_hint: "concept" },
  { surface: "C4", a: "ledger claim C4", b: "any other C4", type_hint: "concept" },
  { surface: "historian", a: "the historian seat/process", b: "a historian person-type mis-extraction", type_hint: "technology|person" },
  { surface: "guard", a: "the corner-cutting guard system", b: "generic guarding/verb usage", type_hint: "technology|concept" },
] as const;

interface ChunkRec { id: string; msg: string; label: string; text: string }
interface EntityRec { raw: string; type: string; canonical: string; nodeId: string | null; offered: boolean }
interface RelRec { source: string; target: string; reason: string; quote: string; verdict: QuoteVerdict; mentionsOffered: boolean }
interface ChunkResult { chunk: string; offered: string[]; entities: EntityRec[]; relations: RelRec[]; parse_failed: boolean }

function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function injectionBlock(names: string[], mode: "B" | "C"): string {
  if (!names.length) return "";
  const rule = mode === "B"
    ? "This graph already contains the entities listed below, and this chunk mentions them. When you extract one of them, reuse EXACTLY the listed spelling as its name."
    : "This graph already contains the entities listed below. If something this chunk mentions IS one of them, reuse EXACTLY the listed spelling as its name; if it is a different thing, use the chunk's own wording.";
  return `\n\n## KNOWN ENTITIES\n${rule}\n${names.map((n) => `- ${n}`).join("\n")}`;
}

async function runArm(
  arm: "A" | "B" | "C" | "A2",
  chunks: ChunkRec[],
  chat: OllamaChat,
  onProgress: (done: number) => void,
): Promise<{ results: ChunkResult[]; store: GraphStore }> {
  const store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(768) });
  const embedder = new StubEmbedder(768);
  const results: ChunkResult[] = [];
  const knownByMsg = new Map<string, Map<string, string>>(); // production: `known` spans a doc's chunks
  let done = 0;

  for (const chunk of chunks) {
    // the arm's CURRENT entity population — grown by its own previous chunks (the real dynamics)
    const extant = store.allNodes().filter((n) => n.subtype !== "chunk" && n.subtype !== "document");
    let offered: string[] = [];
    if (arm === "A" || arm === "A2") { /* no offers */ }
    else if (arm === "B") {
      const stripText = stripName(chunk.text);
      offered = extant.map((n) => n.name ?? n.text).filter((nm) => { const s = stripName(nm); return s.length >= 4 && stripText.includes(s); });
    } else if (arm === "C") {
      offered = [...extant].sort((x, y) => y.strength - x.strength).slice(0, C_OFFER_CAP).map((n) => n.name ?? n.text);
    }
    offered = [...new Set(offered)];

    const system = ARM_S_PROMPT + (arm === "A" || arm === "A2" ? "" : injectionBlock(offered, arm as "B" | "C"));
    let raw = "";
    try { raw = await chat.complete(system, chunk.text, { temperature: TEMP, model: MODEL }); }
    catch { results.push({ chunk: chunk.label, offered, entities: [], relations: [], parse_failed: true }); onProgress(++done); continue; }
    const parsed = parseWithQuotes(raw);
    if (!parsed) { results.push({ chunk: chunk.label, offered, entities: [], relations: [], parse_failed: true }); onProgress(++done); continue; }

    // through the PRODUCTION mapper, with the per-document known map production uses
    if (!knownByMsg.has(chunk.msg)) knownByMsg.set(chunk.msg, new Map());
    const known = knownByMsg.get(chunk.msg)!;
    const ex = Extraction.parse({ entities: parsed.entities, relations: parsed.relations.map(({ quote: _q, ...r }) => r) });
    // the mapper wires APPEARED_IN to a real chunk node — create it the way production ingest does
    const chunkNode = await store.putNode(
      { type: "SOURCE", subtype: "chunk", origin: "ingest", text: `e11-chunk\t${arm}\t${chunk.id}`, name: chunk.label, description: chunk.text },
      { actor: "e11", cause: `arm ${arm}` },
    );
    await mapExtraction(store, embedder, { actor: "e11", cause: `arm ${arm}` }, ex, known, { id: chunkNode.id, label: chunk.label });

    const offeredStrip = new Set(offered.map(stripName));
    const entities: EntityRec[] = parsed.entities.map((e) => {
      const identity = entityIdentity(e.type, e.name);
      // Recover the node id by the stored IDENTITY TEXT, not by re-hashing: the store hashes
      // normalizeText(identity) with a private normalizer, and replicating it here would be exactly the
      // instrument-drift class this experiment line keeps paying for (a mismatch returns null for every
      // entity, and metric 4 silently reports "no merges detected" — fail-toward-green).
      const nodeId = (store as unknown as { db: Database.Database }).db
        .prepare("SELECT id FROM nodes WHERE text = ?")
        .get(identity) as { id: string } | undefined;
      return { raw: e.name, type: e.type, canonical: identity, nodeId: nodeId?.id ?? null, offered: offeredStrip.has(stripName(e.name)) };
    });
    const relations: RelRec[] = parsed.relations.map((r) => ({
      source: r.source, target: r.target, reason: r.reason, quote: r.quote ?? "",
      verdict: verifyQuote(r.quote, chunk.text),
      mentionsOffered: offeredStrip.has(stripName(r.source)) || offeredStrip.has(stripName(r.target)),
    }));
    results.push({ chunk: chunk.label, offered, entities, relations, parse_failed: false });
    onProgress(++done);
  }
  return { results, store };
}

// --- metrics ---------------------------------------------------------------------------------------------
function fragmentation(store: GraphStore) {
  const ents = store.allNodes().filter((n) => n.subtype !== "chunk" && n.subtype !== "document");
  const byStrip = new Map<string, Set<string>>();
  for (const e of ents) { const k = stripName(e.name ?? e.text); if (!k) continue; if (!byStrip.has(k)) byStrip.set(k, new Set()); byStrip.get(k)!.add(e.id); }
  const stripGroups = [...byStrip.values()].filter((s) => s.size > 1).length;
  let containment = 0;
  const names = ents.map((e) => stripName(e.name ?? e.text)).filter((s) => s.length >= 3);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (names[i] !== names[j] && (names[i]!.includes(names[j]!) || names[j]!.includes(names[i]!))) containment++;
  }
  const fam = (tok: string) => new Set(ents.filter((e) => stripName(e.name ?? e.text).includes(tok)).map((e) => e.id)).size;
  return { entities: ents.length, strip_dup_groups: stripGroups, containment_pairs: containment,
           families: { tessera: fam("tessera"), claudecode: fam("claudecode"), consensus: fam("consensus"), span: fam("span") } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = flag("dir", "graphs/comms/dedup")!;
  const src = flag("db", "graphs/comms/graph.db")!;
  const arms = (flag("arms", "A,B,C")!).split(",") as ("A" | "B" | "C" | "A2")[];
  const limit = Number(flag("chunks", "0")); // 0 = all

  const cdb = new Database(src, { readonly: true, fileMustExist: true });
  let chunks = (cdb.prepare(`SELECT id, COALESCE(name,'') AS label, description AS text FROM nodes WHERE subtype='chunk' AND description IS NOT NULL ORDER BY name`).all() as { id: string; label: string; text: string }[])
    .map((c) => ({ ...c, msg: /of (\S+)/.exec(c.label)?.[1] ?? c.label }))
    .sort((a, b) => a.msg.localeCompare(b.msg) || a.label.localeCompare(b.label));
  if (limit) chunks = chunks.slice(0, limit);
  console.log(`frozen chunk set: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.msg)).size} messages`);

  const chat = new OllamaChat();
  // MERGE into an existing sidecar rather than clobbering it. This patch was written once before and DIED
  // unapplied when a self-matching pkill killed its own shell mid-command — the unpatched harness then ran
  // arm A2 and destroyed the A/B/C per-chunk records, in the experiment whose registered requirement was
  // raw-evidence preservation. Verify presence with grep before trusting a subset run; that is now part of
  // the runbook, because "I applied the patch" and "the patch is in the file" proved to be different claims.
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(readFileSync(join(dir, "e11-injection.json"), "utf8")); } catch { /* first run */ }
  const out: Record<string, unknown> = {
    experiment: "E11", protocol: "docs/dedup-experiment-protocol.md §E11 (+0054/0056/0057 amendments)",
    model: MODEL, chunk_count: chunks.length, core_collisions: CORE_COLLISIONS,
    arm_prompt_base: "E10 ARM_S_PROMPT", arms: (existing.arms ?? {}) as Record<string, unknown>,
  };
  const outPath = join(dir, "e11-injection.json");

  for (const arm of arms) {
    process.stdout.write(`\n=== ARM ${arm} === `);
    const t0 = Date.now();
    const { results, store } = await runArm(arm, chunks, chat, (d) => process.stdout.write(d % 10 === 0 ? `${d} ` : ""));
    const frag = fragmentation(store);
    const rels = results.flatMap((r) => r.relations);
    const offeredRels = rels.filter((r) => r.mentionsOffered);
    const unsupportedMention = offeredRels.length ? offeredRels.filter((r) => r.verdict !== "verified").length / offeredRels.length : null;
    (out.arms as Record<string, unknown>)[arm] = {
      wall_min: Math.round((Date.now() - t0) / 60000 * 10) / 10,
      parse_failures: results.filter((r) => r.parse_failed).length,
      fragmentation: frag,
      relations: rels.length,
      quote_verified_rate: rels.length ? rels.filter((r) => r.verdict === "verified").length / rels.length : null,
      unsupported_mention_rate: unsupportedMention,
      per_chunk: results, // raw-beside-derived: every raw surface form is in here
    };
    console.log(`\n  frag ${JSON.stringify(frag)}  rels ${rels.length}  unsupported-mention ${unsupportedMention}`);
    // atomic per-arm persist (composer-seat 0069 #3): a mid-arm kill must not leave half-written JSON
    writeFileSync(`${outPath}.tmp`, JSON.stringify(out, null, 1));
    renameSync(`${outPath}.tmp`, outPath);
    store.close();
  }
  console.log(`\nwrote ${outPath} — metrics 3 (suppression) and 4 (false-merge) are computed by e11-score.ts against this sidecar`);
}
