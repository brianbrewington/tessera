// tessera paths / common — weighted intersection queries over a named graph (src/graph/paths.ts).
//   npx tsx scripts/cli.ts paths  <graph> <A> <B> [--hops 3] [--topk 5]
//   npx tsx scripts/cli.ts common <graph> <A> <B> [C ...] [--hops 2] [--topk 12]
//
// "paths": the strongest weighted chains connecting two personas (bottleneck of edge conductance).
// "common": the shared intermediate nodes that bind a SET, ranked rare-bridge-first.
// Read-only: builds the adjacency from the stored edges; no embedder work (StubEmbedder, no network).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function dbPath(arg: string): string {
  return arg.endsWith(".db") || arg.includes("/") ? arg : join(HERE, "..", "graphs", arg, "graph.db");
}
function openStore(graphArg: string): GraphStore {
  const db = dbPath(graphArg);
  if (!existsSync(db)) {
    console.error(`no graph db at ${db}`);
    process.exit(1);
  }
  return new GraphStore({ path: db, embedder: new StubEmbedder(768) });
}
const label = (n: { name: string | null; text: string } | null): string => (n ? n.name ?? n.text : "?");
function numFlag(args: string[], name: string, dflt: number): number {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}

const isProvenance = (n: { type: string; subtype: string | null }): boolean =>
  n.type === "SOURCE" || n.subtype === "document" || n.subtype === "chunk";

// Resolve a name-or-id to a node id: exact id > exact name (case-insensitive) > unique substring.
// Provenance nodes (a SOURCE sharing a persona's name) are never intersection targets — they carry no
// connective edges — so a real entity is preferred over a provenance twin. `wantType` forces a type.
// Still ambiguous or missing → print candidates and exit (never guess which persona was meant).
function resolve(store: GraphStore, q: string, wantType?: string): string {
  if (store.getNode(q)) return q;
  const pool = store.allNodes().filter((n) => !wantType || n.type === wantType.toUpperCase());
  const ql = q.toLowerCase();
  const exact = pool.filter((n) => (n.name ?? n.text).toLowerCase() === ql);
  let hits = exact.length ? exact : pool.filter((n) => (n.name ?? n.text).toLowerCase().includes(ql));
  const entities = hits.filter((n) => !isProvenance(n));
  if (entities.length) hits = entities; // prefer a real entity over its provenance twin
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) {
    console.error(`no node matching "${q}"${wantType ? ` of type ${wantType}` : ""}`);
    process.exit(1);
  }
  console.error(`"${q}" is ambiguous — narrow it (or pass --type):\n` + hits.slice(0, 12).map((n) => `  ${n.name ?? n.text}  (${n.type})`).join("\n"));
  process.exit(1);
}
function strFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// positional args = everything that isn't a --flag or a flag's numeric value
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) { i++; continue; } // skip flag + its value
    out.push(args[i]!);
  }
  return out;
}

export function pathsCli(args: string[]): void {
  const [graph, a, b] = positionals(args);
  if (!graph || !a || !b) {
    console.error("usage: paths <graph> <A> <B> [--hops 3] [--topk 5]");
    process.exit(1);
  }
  const hops = numFlag(args, "--hops", 3);
  const topk = numFlag(args, "--topk", 5);
  const wantType = strFlag(args, "--type");
  const store = openStore(graph);
  try {
    const ia = resolve(store, a, wantType), ib = resolve(store, b, wantType);
    const na = label(store.getNode(ia)), nb = label(store.getNode(ib));
    const paths = store.pathsBetween(ia, ib, { maxHops: hops, topK: topk });
    if (!paths.length) {
      console.log(`no connection within ${hops} hop(s) between ${na} and ${nb}`);
      return;
    }
    console.log(`${paths.length} strongest path(s)  ${na}  ⇄  ${nb}   (affinity ${store.affinity(ia, ib).toFixed(2)})\n`);
    for (const p of paths) {
      const chain = p.path.map(label).join("  →  ");
      const hub = p.maxIntermediateDegree ? `, via deg≤${p.maxIntermediateDegree}` : "";
      console.log(`  [strength ${p.strength}, ${p.hops} hop(s)${hub}]  ${chain}`);
    }
  } finally {
    store.close();
  }
}

export function commonCli(args: string[]): void {
  const [graph, ...names] = positionals(args);
  if (!graph || names.length < 2) {
    console.error("usage: common <graph> <A> <B> [C ...] [--hops 2] [--topk 12]");
    process.exit(1);
  }
  const hops = numFlag(args, "--hops", 2);
  const topk = numFlag(args, "--topk", 12);
  const wantType = strFlag(args, "--type");
  const store = openStore(graph);
  try {
    const ids = names.map((n) => resolve(store, n, wantType));
    const connectors = store.connectorsOf(ids, { maxHops: hops });
    if (!connectors.length) {
      console.log(`no shared connectors within ${hops} hop(s) among ${names.join(", ")}`);
      return;
    }
    console.log(`shared connectors binding ${names.join(", ")}  (rare-bridge-first)\n`);
    console.log(`  ${"score".padEnd(7)}${"bridges".padEnd(9)}${"deg".padEnd(6)}node`);
    for (const c of connectors.slice(0, topk)) {
      const nm = `${label(c.node)}  (${c.node?.type ?? "?"})`;
      console.log(`  ${c.bridgeScore.toFixed(3).padEnd(7)}${`${c.seedsReached}/${ids.length}`.padEnd(9)}${String(c.degree).padEnd(6)}${nm}`);
    }
  } finally {
    store.close();
  }
}
