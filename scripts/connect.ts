// tessera connect — the hardened Connector runner (clustering-mining-sketch §3.3).
//   npx tsx scripts/connect.ts <graphname|path/to/graph.db> [--commit] [--floor 0.75] [--k 6] [--cap 50]
//
// DRY-RUN by default: writes graphs/<name>/mine/connector-proposals.json and NOTHING to the store.
// --commit lands the survivors as origin:"connector" status:"proposed" edges (never auto-durable).
//
// Model families are load-bearing (§4): the verifier PROPOSES/verifies (qwen family), a DIFFERENT
// family JUDGES the reason for vagueness (gemma/llama). Same-family is warned about, not silently run.
// Env: TESSERA_VERIFY_MODEL (default qwen2.5:14b), TESSERA_CHECK_MODEL (default gemma3:12b).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { GraphStore } from "../src/store/graphStore.js";
import { OllamaEmbedder, StubEmbedder } from "../src/embedder.js";
import { OllamaChat } from "../src/llm.js";
import { runConnector, type ConnectorRun } from "../src/connect/connector.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// graphs/<name>/graph.db, or a direct path if it looks like one.
function resolveGraphDir(arg: string): { db: string; mineDir: string } {
  if (arg.endsWith(".db") || arg.includes("/")) {
    const dir = dirname(arg);
    return { db: arg, mineDir: join(dir, "mine") };
  }
  const dir = join(HERE, "..", "graphs", arg);
  return { db: join(dir, "graph.db"), mineDir: join(dir, "mine") };
}

const family = (model: string): string => (model.toLowerCase().match(/^[a-z]+/)?.[0] ?? model);

function numFlag(args: string[], name: string, dflt: number): number {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}

export async function connectCli(args: string[]): Promise<void> {
  const graphArg = args.find((a) => !a.startsWith("--") && !/^[0-9.]+$/.test(a));
  if (!graphArg) {
    console.error("usage: connect <graphname|path/to/graph.db> [--commit] [--floor 0.75] [--k 6] [--cap 50] [--allow-same-family]");
    process.exit(1);
  }
  const commit = args.includes("--commit");
  const allowSameFamily = args.includes("--allow-same-family");
  const floor = numFlag(args, "--floor", 0.75);
  const k = numFlag(args, "--k", 6);
  const cap = Math.max(0, Math.min(numFlag(args, "--cap", 50), 50)); // §3.3 hard ceiling; floor at 0 so --cap -1 can't slice(0,-1)

  const { db, mineDir } = resolveGraphDir(graphArg);
  if (!existsSync(db)) {
    console.error(`no graph db at ${db}`);
    process.exit(1);
  }

  const verifierModel = process.env.TESSERA_VERIFY_MODEL || "qwen2.5:14b";
  const checkerModel = process.env.TESSERA_CHECK_MODEL || "gemma3:12b";
  if (family(verifierModel) === family(checkerModel) && allowSameFamily) {
    console.warn(`⚠  verifier (${verifierModel}) and checker (${checkerModel}) are the SAME family — running anyway (--allow-same-family). Diversity is load-bearing; prefer a different-family TESSERA_CHECK_MODEL.`);
  }
  // (else, same-family without the override: runConnector refuses in the core — the rule is enforced there.)

  // Dry-run needs no embedder (no writes); commit embeds each de-anchored reason on putEdge.
  const embedder = commit ? new OllamaEmbedder(768, process.env.TESSERA_EMBED_MODEL || "nomic-embed-text") : new StubEmbedder(768);
  const store = new GraphStore({ path: db, embedder });

  console.log(`=== tessera connect ${commit ? "(COMMIT)" : "(dry-run)"} ===`);
  console.log(`graph db: ${db}`);
  console.log(`floor=${floor} k=${k} cap=${cap}  verifier=${verifierModel}  checker=${checkerModel}\n`);

  let run: ConnectorRun;
  try {
    run = await runConnector(store, {
      k,
      floor,
      cap,
      commit,
      allowSameFamily,
      verifier: new OllamaChat(verifierModel),
      checker: new OllamaChat(checkerModel),
      verifierModel,
      checkerModel,
      onProgress: (m) => console.log(m),
    });
  } finally {
    store.close();
  }

  mkdirSync(mineDir, { recursive: true });
  const sidecar = join(mineDir, "connector-proposals.json");
  const out = {
    generatedAt: new Date().toISOString(),
    graph: graphArg,
    ...run,
    // Trim heavy raw model text from the persisted candidates (keep the verdict, drop the transcripts).
    candidates: run.candidates.map((c) => ({
      from: { id: c.from, name: c.fromName },
      to: { id: c.to, name: c.toName },
      cosine: Math.round(c.cosine * 1000) / 1000,
      band: c.band,
      verdict: {
        related: c.verdict.related,
        reason: c.verdict.reason,
        bannedPhrase: c.verdict.bannedPhrase,
        anchored: c.verdict.anchored,
        checkerSpecific: c.verdict.checkerSpecific,
        survived: c.verdict.survived,
      },
    })),
  };
  writeFileSync(sidecar, JSON.stringify(out, null, 2));

  const d = run.cosineDistribution;
  const scope = d.sampled ? `deterministic ${d.nodesConsidered}-of-${d.nodesWithVectors}-node sample` : "all entity pairs";
  console.log(`\n--- node-vector cosine distribution (${scope}) ---`);
  console.log(`pairs=${d.pairs}  p5=${d.p5}  p25=${d.p25}  median=${d.median}  p75=${d.p75}  p95=${d.p95}  p99=${d.p99}  max=${d.max}`);
  for (const b of d.bands) console.log(`  ${b.band}  ${b.count}`);

  console.log("\n--- counts ---");
  console.log(JSON.stringify(run.counts, null, 2));

  console.log("\n--- reject-rate by cosine band (high -> low; rate should RISE as cosine falls if geometry has any signal) ---");
  for (const b of run.rejectRateByBand) {
    console.log(`  ${b.band}  candidates=${b.candidates}  verifierNo=${b.verifierNo}  vague=${b.vaguenessRejected}  survived=${b.survived}  rejectRate=${b.rejectRate}`);
  }

  const survivors = run.candidates.filter((c) => c.verdict.survived).slice(0, 5);
  console.log(`\n--- ${run.counts.survived} survivor(s); up to 5 sample (pair -> de-anchored reason) ---`);
  for (const c of survivors) console.log(`  ${c.fromName}  ~  ${c.toName}\n     -> "${c.verdict.reason}"`);

  console.log(`\nsidecar written: ${sidecar}${commit ? "" : "  (dry-run — no store writes)"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  connectCli(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
}
