import Database from "better-sqlite3";
const db = new Database("graphs/big/graph.db", { readonly: true });
const isProv = (t: string, s: string | null) => t === "SOURCE" && (s === "chunk" || s === "document");
const all = db.prepare("select id, type, subtype from nodes order by rowid").all() as any[];
const vis = all.filter(n => !isProv(n.type, n.subtype)).map(n => n.id);
const visSet = new Set(vis);
const edges = db.prepare("select from_id, to_id from edges").all() as any[];
const adj = new Map<string, Set<string>>();
for (const id of vis) adj.set(id, new Set());
for (const e of edges) if (visSet.has(e.from_id) && visSet.has(e.to_id)) { adj.get(e.from_id)!.add(e.to_id); adj.get(e.to_id)!.add(e.from_id); }

// Proxy A: Grok's half-split by rowid
const half = Math.floor(vis.length / 2);
const A1 = new Set(vis.slice(0, half)), N1 = vis.slice(half);
let ring1 = 0;
for (const n of N1) if (![...adj.get(n)!].some(m => A1.has(m))) ring1++;
console.log(`half-split proxy : ${ring1}/${N1.length} newcomers take the RING fallback (${(100*ring1/N1.length).toFixed(1)}%)`);

// Proxy B: more faithful — the LAST document's entities are the newcomers.
// entity -> the chunks it APPEARED_IN -> those chunks' source doc.
const appear = db.prepare("select from_id, to_id from edges where kind='APPEARED_IN'").all() as any[];
const chunkOf = new Map<string, string[]>();
for (const e of appear) { if (!chunkOf.has(e.from_id)) chunkOf.set(e.from_id, []); chunkOf.get(e.from_id)!.push(e.to_id); }
const orig = db.prepare("select from_id, to_id from edges where kind='ORIGINATED_FROM'").all() as any[];
const docOfChunk = new Map(orig.map((e: any) => [e.from_id, e.to_id]));
const docs = db.prepare("select id from nodes where type='SOURCE' and subtype='document' order by rowid").all() as any[];
const lastDoc = docs.at(-1)!.id;
const N2 = vis.filter(id => { const cs = chunkOf.get(id) ?? []; return cs.length > 0 && cs.every(c => docOfChunk.get(c) === lastDoc); });
const A2 = new Set(vis.filter(id => !N2.includes(id)));
let ring2 = 0;
for (const n of N2) if (![...adj.get(n)!].some(m => A2.has(m))) ring2++;
console.log(`last-doc proxy   : ${ring2}/${N2.length} newcomers take the RING fallback (${N2.length ? (100*ring2/N2.length).toFixed(1) : "n/a"}%)  [doc-exclusive entities]`);
