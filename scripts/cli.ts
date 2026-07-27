// tessera CLI — the tracer's one-or-two basic things:
//   npx tsx scripts/cli.ts graph create <name>
//   npx tsx scripts/cli.ts graph list
//   npx tsx scripts/cli.ts ingest <name> <file.md|.txt> [...more]
//   npx tsx scripts/cli.ts view <name>
// Env: TESSERA_EXTRACT_MODEL (default qwen2.5:14b), TESSERA_EMBED_MODEL (default nomic-embed-text).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { Graph } from "../src/graph.js";
import { OllamaChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { collectDocs, readDoc, isSupported } from "../src/ingest/adapters.js";
import { docContentHash } from "../src/extract/identity.js";
import { exportViewer } from "./export-viewer.js";
import { report, printScorecard } from "./ingest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const graphDir = (name: string): string => join(HERE, "..", "graphs", name);

function usage(): never {
  console.log("usage:\n  tessera graph create <name> | graph list\n  tessera ingest <name> <path...>  (files or dirs; recursive)  [--dry-run] [--reextract] [--no-recursive]\n  tessera view <name>\n  tessera report <name>\n  tessera connect <name> [--commit] [--floor 0.75] [--k 6] [--cap 50]\n  tessera paths <name> <A> <B> [--hops 3] [--topk 5]\n  tessera common <name> <A> <B> [C ...] [--hops 2] [--topk 12]");
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
      // Corpus ingest: paths may be files OR directories (recursive by default). Incremental + content-dedup'd —
      // an unchanged doc is skipped file-level (zero writes). One bad file never aborts the run. --dry-run prints
      // the plan and writes nothing; --reextract bypasses the chunk memo; --no-recursive stays out of subdirs.
      const flags = new Set(args.filter((a) => a.startsWith("--")));
      const reextract = flags.has("--reextract");
      const dryRun = flags.has("--dry-run");
      const recursive = !flags.has("--no-recursive");
      const [name, ...inputs] = args.filter((a) => !a.startsWith("--"));
      if (!name || inputs.length === 0) usage();

      // Validate EXPLICIT inputs loudly — a path the user TYPED that's missing or unsupported must not vanish
      // silently (directory-walk skips stay quiet; a named input resolving to nothing is a reported error).
      let badInputs = 0;
      for (const p of inputs) {
        if (!existsSync(p)) { console.error(`  not found: ${p}`); badInputs++; }
        else if (statSync(p).isFile() && !isSupported(p)) { console.error(`  unsupported (skipped): ${p}`); badInputs++; }
      }

      const docs = collectDocs(inputs, { recursive });
      if (docs.length === 0) {
        console.error("no supported (.md/.txt) files found in the given path(s)");
        process.exit(1);
      }
      const extractorModel = process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b";

      if (dryRun) {
        // Never CREATE a graph in a dry run: consult the manifest only if the graph already exists; survive a
        // per-file read error rather than aborting the whole plan; honor --reextract (would re-run, so "new").
        const g = existsSync(join(graphDir(name), "graph.db")) ? Graph.open(name) : null;
        try {
          let nw = 0, rt = 0, sk = 0, err = 0;
          for (const f of docs) {
            let cls: string;
            try {
              const prior = g?.store.getIngestedSource(docContentHash(readDoc(f).text)) ?? null;
              cls = reextract || !prior ? "new" : prior.status === "complete" ? "skip" : "retry";
            } catch { cls = "ERR"; err++; }
            if (cls === "new") nw++; else if (cls === "skip") sk++; else if (cls === "retry") rt++;
            console.log(`  ${cls.padEnd(5)} ${f}`);
          }
          console.log(`\nplan: ${nw} new, ${rt} retry (prior partial), ${sk} unchanged, ${err} unreadable, ${badInputs} bad input(s) — ${docs.length} file(s). (dry-run — no writes)`);
        } finally { g?.close(); }
        if (badInputs > 0) process.exitCode = 1;
        break;
      }

      const graph = Graph.open(name);
      try {
        const extractor = new LlmExtractor(new OllamaChat(extractorModel), { temperature: 0.4 });
        let ingested = 0, skipped = 0, partial = 0, failed = 0, entities = 0, edges = 0;
        for (const f of docs) {
          try {
            const r = await ingestFile(graph, extractor, f, { reextract, extractorModel });
            if (r.skipped) { skipped++; console.log(`skip     "${r.title}" (unchanged, ${r.chunks} chunk(s))`); continue; }
            ingested++; entities += r.entities; edges += r.edges;
            if (r.parseFailures > 0) partial++;
            const warn = r.parseFailures || r.emptyChunks ? `  (! ${r.parseFailures} parse-fail, ${r.emptyChunks} empty)` : "";
            const memo = r.reused ? `  (${r.reused} chunk(s) reused)` : "";
            console.log(`ingested "${r.title}": ${r.chunks} chunk(s) -> ${r.entities} entities, ${r.edges} edges${warn}${memo}`);
          } catch (e) {
            failed++;
            console.error(`FAILED   ${f}: ${e instanceof Error ? e.message : e}`);
          }
        }
        console.log(`\n--- ${docs.length} file(s): ${ingested} ingested (${partial} partial), ${skipped} unchanged, ${failed} failed, ${badInputs} bad input(s)  ·  +${entities} entities, +${edges} edges ---`);
        if (failed > 0 || badInputs > 0) process.exitCode = 1; // surface partial failure / bad inputs to the shell, but finish the run
      } finally {
        graph.close();
      }
      break;
    }
    case "view": {
      const name = args[0] ?? usage();
      const out = join(graphDir(name), "view.html");
      const n = exportViewer(join(graphDir(name), "graph.db"), out, name);
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
    case "connect": {
      // The hardened cross-document Connector (§3.3). Delegates to scripts/connect.ts, which owns the
      // dry-run/commit split, the diverse-family verifier+checker, and the sidecar.
      if (!args[0]) usage();
      const { connectCli } = await import("./connect.js");
      await connectCli(args);
      break;
    }
    case "paths": {
      // Weighted intersection: the strongest chains connecting two personas (§ intersection queries).
      if (!args[0]) usage();
      const { pathsCli } = await import("./intersect.js");
      pathsCli(args);
      break;
    }
    case "common": {
      // The shared intermediate nodes that bind a set of personas, ranked rare-bridge-first.
      if (!args[0]) usage();
      const { commonCli } = await import("./intersect.js");
      commonCli(args);
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
