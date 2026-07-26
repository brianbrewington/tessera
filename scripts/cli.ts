// tessera CLI — the tracer's one-or-two basic things:
//   npx tsx scripts/cli.ts graph create <name>
//   npx tsx scripts/cli.ts graph list
//   npx tsx scripts/cli.ts ingest <name> <file.md|.txt> [...more]
//   npx tsx scripts/cli.ts view <name>
// Env: TESSERA_EXTRACT_MODEL (default qwen2.5:14b), TESSERA_EMBED_MODEL (default nomic-embed-text).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Graph } from "../src/graph.js";
import { OllamaChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { exportViewer } from "./export-viewer.js";
import { report, printScorecard } from "./ingest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const graphDir = (name: string): string => join(HERE, "..", "graphs", name);

function usage(): never {
  console.log("usage:\n  tessera graph create <name> | graph list\n  tessera ingest <name> <file.md|.txt> [...] [--reextract]\n  tessera view <name>\n  tessera report <name>");
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "graph": {
      if (args[0] === "create") { Graph.open(args[1] ?? usage()).close(); console.log(`created graph '${args[1]}'`); }
      else if (args[0] === "list") { const gs = Graph.list(); console.log(gs.length ? gs.map((g) => g.name).join("\n") : "(no graphs yet)"); }
      else usage();
      break;
    }
    case "ingest": {
      const reextract = args.includes("--reextract"); // force re-extraction of unchanged chunks (model/prompt bump)
      const [name, ...files] = args.filter((a) => a !== "--reextract");
      if (!name || files.length === 0) usage();
      const graph = Graph.open(name);
      const extractor = new LlmExtractor(new OllamaChat(process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b"), { temperature: 0.4 });
      try {
        for (const f of files) {
          const r = await ingestFile(graph, extractor, f, { reextract });
          const warn = r.parseFailures || r.emptyChunks ? `  (! ${r.parseFailures} parse-fail, ${r.emptyChunks} empty)` : "";
          const memo = r.reused ? `  (${r.reused} chunk(s) reused)` : "";
          console.log(`ingested "${r.title}": ${r.chunks} chunk(s) -> ${r.entities} entities, ${r.edges} edges${warn}${memo}`);
        }
      } finally {
        graph.close();
      }
      break;
    }
    case "view": {
      const name = args[0] ?? usage();
      const out = join(graphDir(name), "view.html");
      const n = exportViewer(join(graphDir(name), "graph.db"), out);
      console.log(`wrote ${out}  (${n} nodes) — open it in a browser`);
      break;
    }
    case "report": {
      const name = args[0] ?? usage();
      const db = join(graphDir(name), "graph.db");
      if (!existsSync(db)) { console.error(`no graph db at ${db} — create/ingest it first`); process.exit(1); }
      printScorecard(report(db));
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
