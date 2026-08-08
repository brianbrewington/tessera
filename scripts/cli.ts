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
import { ingestChunks } from "../src/ingest/ingest.js";
import { extractPending, FAILING_ATTEMPTS } from "../src/ingest/extract-pending.js";
import { PROMPT_VERSION } from "../src/extract/extractor.js";
import { collectDocs, readDoc, isSupported } from "../src/ingest/adapters.js";
import { docContentHash, sourceIdentity } from "../src/extract/identity.js";
import { exportViewer } from "./export-viewer.js";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { layoutPass } from "../src/layout/pass.js";
import { prominencePass } from "../src/graph/prominence-pass.js";
import { contentKey } from "../src/scenes/scene.js";
import { acquireIngestLock } from "../src/serve/lock.js";
import { report, printScorecard } from "./ingest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const graphDir = (name: string): string => join(HERE, "..", "graphs", name);

function usage(): never {
  console.log("usage:\n  tessera graph create <name> | graph list\n  tessera ingest <name> <path...>  (files or dirs; recursive)  [--dry-run] [--reextract] [--no-recursive]\n  tessera extract <name> [--retry-failed]   (the LLM half — run after ingest)\n  tessera view <name>\n  tessera scenes import <name> <scenes.json>\n  tessera serve <name> [--port 7777]\n  tessera report <name>\n  tessera connect <name> [--commit] [--floor 0.75] [--k 6] [--cap 50]\n  tessera paths <name> <A> <B> [--hops 3] [--topk 5]\n  tessera common <name> <A> <B> [C ...] [--hops 2] [--topk 12]");
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
              const hash = docContentHash(readDoc(f).doc.text);
              const prior = g?.store.getIngestedSource(hash) ?? null;
              if (reextract || !prior) cls = "new";
              else {
                // Chunks exist, but do they OWE extraction? Since the split, `status` only means "chunks
                // written", so keying the plan on it alone would report a document as unchanged while every
                // one of its chunks is still waiting for the extractor — a dry run that hides the work.
                const owed = g ? g.store.dirtyChunks(PROMPT_VERSION, { ids: g.store.chunkIdsForSource(sourceIdentity(hash)) }).length : 0;
                cls = owed > 0 ? "owed" : "skip";
              }
            } catch { cls = "ERR"; err++; }
            if (cls === "new") nw++; else if (cls === "skip") sk++; else if (cls === "owed") rt++;
            console.log(`  ${cls.padEnd(5)} ${f}`);
          }
          console.log(`\nplan: ${nw} new, ${rt} already chunked but awaiting extraction, ${sk} unchanged, ${err} unreadable, ${badInputs} bad input(s) — ${docs.length} file(s). (dry-run — no writes)`);
        } finally { g?.close(); }
        if (badInputs > 0) process.exitCode = 1;
        break;
      }

      // The OTHER half of the advisory lock (design §9). It was only ever taken by `serve`, so the mutual
      // exclusion was documented and not implemented: a CLI ingest and a served drop could interleave
      // transactions against one SQLite writer.
      let releaseLock: () => void;
      try {
        releaseLock = acquireIngestLock(graphDir(name), `cli ingest ${name}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      const graph = Graph.open(name);
      try {
        let chunkedDocs = 0, skipped = 0, failed = 0, chunks = 0, queued = 0;
        for (const f of docs) {
          try {
            // CHUNK ONLY. Extraction is `tessera extract`, so this loop never calls the LLM and the advisory
            // lock is held for a bounded, predictable time rather than across a multi-hour extraction.
            const r = await ingestChunks(graph, f, { rechunk: reextract, extractorModel });
            chunks += r.chunks; queued += r.queued;
            if (r.skipped) { skipped++; console.log(`skip     "${r.title}" (already chunked, ${r.chunks} chunk(s), ${r.queued} still owed)`); continue; }
            chunkedDocs++;
            const owed = r.queued === r.chunks ? "" : `  (${r.reused} already extracted)`;
            const img = r.media ? `, ${r.media} image(s) manifested` : "";
            console.log(`chunked  "${r.title}": ${r.chunks} chunk(s), ${r.queued} queued for extraction${img}${owed}`);
            // Never a silent drop: an image the adapter refused is named with its reason.
            for (const s of r.skippedParts) console.error(`  not taken: ${s.name} — ${s.reason}`);
          } catch (e) {
            failed++;
            console.error(`FAILED   ${f}: ${e instanceof Error ? e.message : e}`);
          }
        }
        // One layout pass for the whole run: newcomers relax against the frozen existing map, and every
        // pre-existing node keeps its exact position (design §3.3, F-2). Cheap — O(|new|·|existing|).
        const lay = await layoutPass(graph.store, { actor: "cli", cause: `ingest ${name}` });
        console.log(`\n--- ${docs.length} file(s): ${chunkedDocs} chunked, ${skipped} unchanged, ${failed} failed, ${badInputs} bad input(s)  ·  ${chunks} chunk(s) ---`);
        if (lay.mode !== "noop") console.log(`layout: ${lay.mode} — ${lay.laidOut} new node(s) in ${lay.components} component(s) (graph ${lay.byRule.graph}, semantic ${lay.byRule.semantic}, map ${lay.byRule.map})`);
        const owed = graph.store.dirtyCounts(PROMPT_VERSION).dirty;
        if (owed > 0) console.log(`\n${owed} chunk(s) await extraction — run:  tessera extract ${name}`);
        if (failed > 0 || badInputs > 0) process.exitCode = 1; // surface partial failure / bad inputs to the shell, but finish the run
      } finally {
        graph.close();
        releaseLock();
      }
      break;
    }
    case "extract": {
      // The slow half of ingest, as its own resumable step. Reads chunk text from the STORE, so a chunk whose
      // source file has been deleted is still reachable — which is the only way graphs/big's two orphaned
      // chunks can ever be finished.
      const flags = new Set(args.filter((a) => a.startsWith("--")));
      const retryFailed = flags.has("--retry-failed");
      const [name] = args.filter((a) => !a.startsWith("--"));
      if (!name) usage();
      if (!existsSync(join(graphDir(name), "graph.db"))) { console.error(`no graph db for '${name}' — ingest something first`); process.exit(1); }

      const extractorModel = process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b";
      const graph = Graph.open(name);
      try {
        if (retryFailed) {
          const cleared = graph.store.clearExtractionFailures();
          console.log(`cleared attempt counts on ${cleared} chunk(s)`);
        }
        const before = graph.store.dirtyCounts(PROMPT_VERSION);
        if (before.dirty === 0) { console.log(`nothing to extract — all ${before.chunks} chunk(s) are current`); break; }
        console.log(`${before.dirty} chunk(s) owed (${before.never} never extracted, ${before.stale} under an older prompt)`);

        const extractor = new LlmExtractor(new OllamaChat(extractorModel), { temperature: 0.4 });
        // NO advisory lock around extraction, deliberately. The lock is a coarse one-writer-at-a-time guard
        // for whole ingests; extraction is already protected at a finer grain by the per-chunk claim (two
        // extractors cannot take one chunk) and by the store's BEGIN IMMEDIATE transactions (SQLite
        // serializes the actual writes). Taking it here would only reintroduce the thing this batch removed:
        // a long hold that makes LOCK_STALE_MS reachable and blocks a drop for the length of a batch.
        const r = await extractPending(graph, extractor, {
          onChunk: (done, total) => process.stdout.write(`\r  extracting ${done}/${total}...`),
        });
        process.stdout.write("\r\x1b[K");
        console.log(`extracted ${r.extracted}/${r.considered} chunk(s)  ·  +${r.entities} entities, +${r.edges} edges`);
        if (r.parseFailures || r.errors) console.log(`  (! ${r.parseFailures} unparseable, ${r.errors} error(s) — see tessera report ${name})`);
        if (r.skippedClaimed) console.log(`  (${r.skippedClaimed} chunk(s) claimed by another extractor — rerun to pick them up)`);

        if (r.extracted > 0) {
          const release = acquireIngestLock(graphDir(name), `cli extract passes ${name}`);
          try {
            const lay = await layoutPass(graph.store, { actor: "cli", cause: `extract ${name}` });
            prominencePass(graph.store, { actor: "cli", cause: `extract ${name}` });
            if (lay.mode !== "noop") console.log(`layout: ${lay.mode} — ${lay.laidOut} new node(s)`);
          } finally { release(); }
        }
        const after = graph.store.dirtyCounts(PROMPT_VERSION);
        if (after.dirty > 0) {
          console.log(`\n${after.dirty} chunk(s) still owed${after.failing ? `, ${after.failing} failing after ${FAILING_ATTEMPTS}+ attempts (tessera extract ${name} --retry-failed)` : ""}`);
          process.exitCode = 1;
        }
      } finally { graph.close(); }
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
      // A map exported while chunks are still owed is honest only if it says so. Otherwise "the graph looks
      // thin" is indistinguishable from "extraction has not run yet", which is the failure mode the whole
      // dirty-chunk model exists to remove.
      {
        const s = new GraphStore({ path: db, embedder: new StubEmbedder(768) });
        try {
          const d = s.dirtyCounts(PROMPT_VERSION);
          if (d.dirty > 0) console.log(`\nnote: ${d.dirty} of ${d.chunks} chunk(s) are not yet extracted — this map is incomplete.\n      run:  tessera extract ${name}`);
        } finally { s.close(); }
      }
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
    case "serve": {
      // Slice 3: the drop target. Loopback only, measured header guard, single-flight ingest.
      const name = args[0] ?? usage();
      const portArg = args.indexOf("--port");
      const port = portArg >= 0 ? Number(args[portArg + 1]) : 7777;
      if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`bad --port ${args[portArg + 1]}`); process.exit(1); }
      const gdir = graphDir(name);
      const db = join(gdir, "graph.db");
      if (!existsSync(db)) { console.error(`no graph db at ${db} — create/ingest it first`); process.exit(1); }
      const { serveCli } = await import("./serve.js");
      await serveCli({ name, port, graphDir: gdir, db });
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
