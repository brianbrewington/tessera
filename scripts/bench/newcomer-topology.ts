import Database from "better-sqlite3";
const db = new Database("graphs/big/graph.db", { readonly: true });
const isProv = (t: string, s: string | null) => t === "SOURCE" && (s === "chunk" || s === "document");
const all = db.prepare("select id, type, subtype from nodes order by rowid").all() as any[];
const vis = all.filter(n => !isProv(n.type, n.subtype)).map(n => n.id);
const visSet = new Set(vis);
const kinds = db.prepare("select kind, count(*) c from edges group by kind").all() as any[];
const visEdges = (db.prepare("select from_id,to_id,kind from edges").all() as any[]).filter(e => visSet.has(e.from_id) && visSet.has(e.to_id));
console.log("edge kinds (all):", JSON.stringify(kinds));
console.log("visible-endpoint edge kinds:", JSON.stringify([...new Set(visEdges.map(e => e.kind))]));

const appear = db.prepare("select from_id,to_id from edges where kind='APPEARED_IN'").all() as any[];
const chunkOf = new Map<string, string[]>();
for (const e of appear) { if (!chunkOf.has(e.from_id)) chunkOf.set(e.from_id, []); chunkOf.get(e.from_id)!.push(e.to_id); }
const orig = db.prepare("select from_id,to_id from edges where kind='ORIGINATED_FROM'").all() as any[];
const docOf = new Map(orig.map((e: any) => [e.from_id, e.to_id]));
const lastDoc = (db.prepare("select id from nodes where type='SOURCE' and subtype='document' order by rowid").all() as any[]).at(-1)!.id;
const N = vis.filter(id => { const cs = chunkOf.get(id) ?? []; return cs.length > 0 && cs.every(c => docOf.get(c) === lastDoc); });
const Nset = new Set(N);
const adj = new Map<string, Set<string>>(vis.map(id => [id, new Set<string>()]));
for (const e of visEdges) { adj.get(e.from_id)!.add(e.to_id); adj.get(e.to_id)!.add(e.from_id); }
const linkIntoA = N.filter(n => [...adj.get(n)!].some(m => !Nset.has(m)));
// connected components WITHIN N
const seen = new Set<string>(); let comps = 0; const sizes: number[] = [];
for (const n of N) { if (seen.has(n)) continue; comps++; let sz = 0; const st = [n];
  while (st.length) { const c = st.pop()!; if (seen.has(c)) continue; seen.add(c); sz++;
    for (const m of adj.get(c)!) if (Nset.has(m) && !seen.has(m)) st.push(m); } sizes.push(sz); }
console.log(`newcomers (last doc, exclusive): ${N.length}`);
console.log(`  linking into A: ${linkIntoA.length}`);
console.log(`  components within N: ${comps}  sizes=${JSON.stringify(sizes.sort((a,b)=>b-a))}`);
