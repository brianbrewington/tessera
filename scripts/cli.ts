// tessera CLI — the tracer's one-or-two basic things:
//   npx tsx scripts/cli.ts graph create <name>
//   npx tsx scripts/cli.ts graph list
//   npx tsx scripts/cli.ts ingest <name> <file.md|.txt> [...more]
//   npx tsx scripts/cli.ts view <name>
// Env: TESSERA_EXTRACT_MODEL (default qwen2.5:14b), TESSERA_EMBED_MODEL (default nomic-embed-text).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, readFileSync } from "node:fs";
import { Graph } from "../src/graph.js";
import { OllamaChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { collectDocs, readDoc, isSupported } from "../src/ingest/adapters.js";
import { docContentHash } from "../src/extract/identity.js";
import { exportViewer } from "./export-viewer.js";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { layoutPass } from "../src/layout/pass.js";
import { prominencePass } from "../src/graph/prominence-pass.js";
import { contentKey } from "../src/scenes/scene.js";
import { report, printScorecard } from "./ingest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const graphDir = (name: string): string => join(HERE, "..", "graphs", name);

function usage(): never {
  console.log("usage:\n  tessera graph create <name> | graph list\n  tessera ingest <name> <path...>  (files or dirs; recursive)  [--dry-run] [--reextract] [--no-recursive]\n  tessera view <name>\n  tessera scenes import <name> <scenes.json>\n  tessera report <name>\n  tessera connect <name> [--commit] [--floor 0.75] [--k 6] [--cap 50]\n  tessera paths <name> <A> <B> [--hops 3] [--topk 5]\n  tessera common <name> <A> <B> [C ...] [--hops 2] [--topk 12]");
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
        // One layout pass for the whole run: newcomers relax against the frozen existing map, and every
        // pre-existing node keeps its exact position (design §3.3, F-2). Cheap — O(|new|·|existing|).
        const lay = await layoutPass(graph.store, { actor: "cli", cause: `ingest ${name}` });
        console.log(`\n--- ${docs.length} file(s): ${ingested} ingested (${partial} partial), ${skipped} unchanged, ${failed} failed, ${badInputs} bad input(s)  ·  +${entities} entities, +${edges} edges ---`);
        if (lay.mode !== "noop") console.log(`layout: ${lay.mode} — ${lay.laidOut} new node(s) in ${lay.components} component(s) (graph ${lay.byRule.graph}, semantic ${lay.byRule.semantic}, map ${lay.byRule.map})`);
        if (failed > 0 || badInputs > 0) process.exitCode = 1; // surface partial failure / bad inputs to the shell, but finish the run
      } finally {
        graph.close();
      }
      break;
    }
    case "view": {
      // Settle and persist first, then export — the bundle must carry the stored layout or the map is
      // durable in SQLite and still reshuffles in the product (design §3.5). layoutPass reads STORED
      // vectors and never embeds, so this needs no live embedder: the StubEmbedder only satisfies the ctor.
      const name = args[0] ?? usage();
      const db = join(graphDir(name), "graph.db");
      if (!existsSync(db)) { console.error(`no graph db at ${db} — create/ingest it first`); process.exit(1); }
      const store = new GraphStore({ path: db, embedder: new StubEmbedder(768) });
      try {
        const prom = prominencePass(store, { actor: "cli", cause: `view ${name}` });
        if (prom.edges > 0) {
          const skipped = prom.betweennessSkipped ? "  (betweenness skipped — graph too large, see BETWEENNESS_BUDGET)" : "";
          console.log(`prominence: ${prom.measures.join(", ")} over ${prom.edges} visible edge(s)${skipped}`);
        }
        const r = await layoutPass(store, { actor: "cli", cause: `view ${name}` });
        if (r.mode !== "noop") {
          const rules = r.mode === "incremental" ? `  (graph ${r.byRule.graph}, semantic ${r.byRule.semantic}, map ${r.byRule.map})` : "";
          console.log(`layout: ${r.mode} — ${r.laidOut} node(s) placed in ${r.components} component(s)${rules}`);
        }
      } finally {
        store.close();
      }
      const out = join(graphDir(name), "view.html");
      const n = exportViewer(db, out, name);
      console.log(`wrote ${out}  (${n} nodes) — open it in a browser`);
      break;
    }
    case "scenes": {
      // The CLI half of the one-way door (design §5). The file:// viewer downloads scenes.json; this reads
      // it into the graph. Must be run BEFORE `serve` exists — after the origin moves, the browser-side
      // scenes are unreachable and this file is the only copy.
      if (args[0] !== "import") usage();
      const [, name, file] = args;
      if (!name || !file) usage();
      const db = join(graphDir(name), "graph.db");
      if (!existsSync(db)) { console.error(`no graph db at ${db} — create/ingest it first`); process.exit(1); }
      if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
      const raw = JSON.parse(readFileSync(file, "utf8")) as { graph?: string; scenes?: unknown[] };
      if (!Array.isArray(raw.scenes)) { console.error(`${file}: not a tessera scenes export (no 'scenes' array)`); process.exit(1); }
      if (raw.graph && raw.graph !== name) {
        console.warn(`!  this export came from graph '${raw.graph}', importing into '${name}' — anchors are node ids and will mostly not resolve`);
      }
      const parsed = raw.scenes.map((x, i) => {
        const sc = x as Record<string, unknown>;
        const e = {
          name: String(sc.name ?? `scene ${i + 1}`),
          narr: (sc.narr as string | null) ?? null,
          scale: Number(sc.scale ?? 1),
          showProv: !!sc.showProv,
          focusNode: (sc.focusNode as string | null) ?? null,
          anchors: Array.isArray(sc.anchors) ? (sc.anchors as string[]) : [],
          legacyId: (sc.legacyId as string | null) ?? null,
          ordinal: Number.isFinite(sc.ordinal) ? Number(sc.ordinal) : i,
        };
        return { ...e, contentKey: contentKey(e) };
      });
      const store = new GraphStore({ path: db, embedder: new StubEmbedder(768) });
      try {
        const r = store.importScenes(parsed, { actor: "cli", cause: `scenes import ${file}` });
        console.log(`imported ${r.imported} scene(s), ${r.duplicates} already present, ${r.skipped} skipped (no resolvable anchor), ${r.droppedAnchors} anchor(s) dropped`);
        if (r.skipped > 0) process.exitCode = 1; // a lost scene is not a silent success
      } finally {
        store.close();
      }
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
