// Measure the per-chunk cost composition of tessera ingest (outline §7 open question, gates D9).
// Uses the REAL components — same chat, embedder, extractor, chunker as `tessera ingest`.
import { readFileSync } from "node:fs";
import { OllamaChat } from "../../src/llm.js";
import { OllamaEmbedder } from "../../src/embedder.js";
import { LlmExtractor } from "../../src/extract/extractor.js";
import { chunk as splitChunks } from "../../src/ingest/chunker.js";

async function main(): Promise<void> {
  const path = process.argv[2]!;
  const maxChunks = Number(process.argv[3] ?? 4);
  const text = readFileSync(path, "utf8");
  const chunks = splitChunks(text);
  const embedder = new OllamaEmbedder(768, process.env.TESSERA_EMBED_MODEL || "nomic-embed-text");
  const extractor = new LlmExtractor(new OllamaChat(process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b"), { temperature: 0.4 });

  console.log(`doc: ${path}  ${text.length} chars -> ${chunks.length} chunks (measuring first ${Math.min(maxChunks, chunks.length)})`);
  console.log(`extract=${process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b"}  embed=${process.env.TESSERA_EMBED_MODEL || "nomic-embed-text"}\n`);

  const ms = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const r = await f(); return [r, performance.now() - t]; };
  let totChunkEmb = 0, totExtract = 0, totEntEmb = 0, totAll = 0, nEnt = 0, nRel = 0, n = 0;

  for (let i = 0; i < Math.min(maxChunks, chunks.length); i++) {
    const c = chunks[i]!;
    const t0 = performance.now();
    const [, tChunkEmb] = await ms(() => embedder.embed(c.text.slice(0, 6000)));
    const [res, tExtract] = await ms(() => extractor.extract(c.text, {}));
    const ents = res.extraction.entities, rels = res.extraction.relations;
    // per-entity embeddings, exactly as mapper.ts:32 does them (sequentially)
    const tEnt0 = performance.now();
    for (const e of ents) await embedder.embed(`${e.name.trim()}. ${e.description}`.slice(0, 2000));
    const tEntEmb = performance.now() - tEnt0;
    // per-edge-reason embeddings (graphStore.ts:312 — every putEdge in the pipeline passes no vector)
    const tRel0 = performance.now();
    for (const r of rels) await embedder.embed((r as any).description ?? "reason");
    const tRelEmb = performance.now() - tRel0;
    const tot = performance.now() - t0;
    totChunkEmb += tChunkEmb; totExtract += tExtract; totEntEmb += tEntEmb + tRelEmb; totAll += tot;
    nEnt += ents.length; nRel += rels.length; n++;
    console.log(`chunk ${i + 1}: ${(tot / 1000).toFixed(1)}s total  [embed ${(tChunkEmb / 1000).toFixed(1)}s | extract ${(tExtract / 1000).toFixed(1)}s | ${ents.length} entity-embeds ${(tEntEmb / 1000).toFixed(1)}s | ${rels.length} reason-embeds ${(tRelEmb / 1000).toFixed(1)}s]  parsed=${res.parsed}`);
  }

  const avg = totAll / n;
  console.log(`\n--- per-chunk average over ${n} chunks: ${(avg / 1000).toFixed(1)}s ---`);
  console.log(`  chunk embed   ${(totChunkEmb / n / 1000).toFixed(1)}s  (${(100 * totChunkEmb / totAll).toFixed(0)}%)`);
  console.log(`  extraction    ${(totExtract / n / 1000).toFixed(1)}s  (${(100 * totExtract / totAll).toFixed(0)}%)`);
  console.log(`  entity+reason ${(totEntEmb / n / 1000).toFixed(1)}s  (${(100 * totEntEmb / totAll).toFixed(0)}%)   avg ${(nEnt / n).toFixed(1)} entities, ${(nRel / n).toFixed(1)} relations per chunk`);
  console.log(`\nprojection: whole doc (${chunks.length} chunks) ≈ ${(avg * chunks.length / 1000 / 60).toFixed(1)} min`);
}
main().catch((e) => { console.error(e); process.exit(1); });
