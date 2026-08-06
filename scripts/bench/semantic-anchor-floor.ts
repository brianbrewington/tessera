// Independently reproduce round 5's claim: with floor 0.60, does rule (c) ever fire?
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
const db = new Database("graphs/big/graph.db", { readonly: true });
sqliteVec.load(db);
const isProv = (t: string, s: string|null) => t === "SOURCE" && (s === "chunk" || s === "document");
const all = db.prepare("select id,type,subtype from nodes order by rowid").all() as any[];
const vis = all.filter(n => !isProv(n.type, n.subtype)).map(n => n.id);
const visSet = new Set(vis);
const vedges = (db.prepare("select from_id,to_id from edges").all() as any[]).filter(e => visSet.has(e.from_id) && visSet.has(e.to_id));
const adj = new Map<string, Set<string>>(vis.map(i => [i, new Set<string>()]));
for (const e of vedges) { adj.get(e.from_id)!.add(e.to_id); adj.get(e.to_id)!.add(e.from_id); }

// embeddings straight out of the vec0 shadow table (sqlite-vec extension not needed to read blobs)
const emb = new Map<string, Float32Array>();
for (const r of db.prepare("select node_id, embedding from vec_node_quarantine").all() as any[]) {
  const b = r.embedding as Buffer;
  emb.set(r.node_id, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
}
const cos = (a: Float32Array, b: Float32Array) => { let d=0,na=0,nb=0; for (let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return d/(Math.sqrt(na)*Math.sqrt(nb)); };

// doc-exclusive entity sets, per document
const appear = db.prepare("select from_id,to_id from edges where kind='APPEARED_IN'").all() as any[];
const chunkOf = new Map<string,string[]>();
for (const e of appear) { if(!chunkOf.has(e.from_id)) chunkOf.set(e.from_id,[]); chunkOf.get(e.from_id)!.push(e.to_id); }
const docOf = new Map((db.prepare("select from_id,to_id from edges where kind='ORIGINATED_FROM'").all() as any[]).map((e:any)=>[e.from_id,e.to_id]));
const docs = (db.prepare("select id from nodes where type='SOURCE' and subtype='document' order by rowid").all() as any[]).map(d=>d.id);

let aMiss = 0; const rows: any[] = [];
for (const doc of docs) {
  const N = vis.filter(id => { const cs = chunkOf.get(id) ?? []; return cs.length>0 && cs.every(c => docOf.get(c)===doc); });
  if (!N.length) continue;
  const Nset = new Set(N), A = vis.filter(i => !Nset.has(i));
  const seen = new Set<string>();
  for (const start of N) {
    if (seen.has(start)) continue;
    const C: string[] = []; const st=[start];
    while (st.length) { const c=st.pop()!; if(seen.has(c))continue; seen.add(c); C.push(c);
      for (const m of adj.get(c)!) if (Nset.has(m) && !seen.has(m)) st.push(m); }
    const hasAnchor = C.some(c => [...adj.get(c)!].some(m => !Nset.has(m)));
    if (hasAnchor) continue;                       // rule (a) fires
    aMiss++;
    let best = -1;
    for (const c of C.slice().sort((x,y)=>adj.get(y)!.size-adj.get(x)!.size).slice(0,3)) {
      const ec = emb.get(c); if (!ec) continue;
      for (const a of A) { const ea = emb.get(a); if (!ea) continue; const s = cos(ec, ea); if (s > best) best = s; }
    }
    rows.push({ size: C.length, bestToA: best });
  }
}
console.log(`(a)-miss components: ${aMiss}`);
for (const r of rows) console.log(`  size ${String(r.size).padStart(3)}  best cosine to A = ${r.bestToA.toFixed(3)}`);
for (const floor of [0.60, 0.70, 0.75, 0.80]) {
  const b = rows.filter(r => r.bestToA >= floor).length;
  console.log(`floor ${floor.toFixed(2)} -> rule (b) fires ${b}, rule (c) fires ${rows.length-b}`);
}
