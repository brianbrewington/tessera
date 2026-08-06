// Cohesion where the SEED is load-bearing: a component with no edge into the anchored field (rule c).
import { GraphStore } from "/home/brian-brewington/code/tessera/src/store/graphStore.js";
import { StubEmbedder } from "/home/brian-brewington/code/tessera/src/embedder.js";
import { layoutPass } from "/home/brian-brewington/code/tessera/src/layout/pass.js";
import { placeComponent } from "/home/brian-brewington/code/tessera/src/layout/incremental.js";

const meta = { actor: "t", cause: "t" };
const HI = (t: string) => `alpha beta gamma delta ${t}`;
const LO = (t: string) => `omega psi chi ${t}`;
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0)/(xs.length||1);

async function build(size: number, mode: "cohesive"|"scatter") {
  const s = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
  const add = async (tx: string, nm: string) => (await s.putNode({type:"CONCEPT",origin:"ingest",text:tx,name:nm,description:nm}, meta)).id;
  const link = async (a: string, b: string) => { await s.putEdge({from:a,to:b,kind:"RELATED",reason:`${a}-${b}`,origin:"ingest"}, meta); };
  const anchor: string[] = [];
  for (let i=0;i<10;i++) anchor.push(await add(HI(`anchor${i}`), `anchor${i}`));
  for (let i=1;i<anchor.length;i++) await link(anchor[i-1]!, anchor[i]!);
  await layoutPass(s, meta);
  const L0 = s.getLayout();

  // a DISCONNECTED component: chained to each other, no edge into the anchored field, LO vocabulary
  const comp: string[] = [];
  for (let i=0;i<size;i++) comp.push(await add(LO(`stranded${i}`), `stranded${i}`));
  for (let i=1;i<comp.length;i++) await link(comp[i-1]!, comp[i]!);

  if (mode === "scatter") {
    // the defect the ladder exists to prevent: each member seeded independently, then relaxed
    const anchPts = anchor.map(id=>L0.get(id)!);
    const seeds = comp.map((id,i)=>({ nodeId:id, ...placeComponent(anchPts[i%anchPts.length]!, 1)[0]! }));
    s.putLayoutBatch(seeds, meta);
  } else {
    await layoutPass(s, meta);
  }
  const L = s.getLayout();
  const intra: number[] = [];
  for (let i=0;i<comp.length;i++) for (let j=i+1;j<comp.length;j++) {
    const a=L.get(comp[i]!)!, b=L.get(comp[j]!)!; intra.push(Math.hypot(a.x-b.x,a.y-b.y));
  }
  const inter: number[] = [];
  for (const c of comp) for (const a of anchor) { const p=L.get(c)!, q=L.get(a)!; inter.push(Math.hypot(p.x-q.x,p.y-q.y)); }
  s.close();
  return { ratio: mean(intra)/mean(inter) };
}

for (const size of [4, 12, 28]) {
  const g = await build(size, "cohesive"), b = await build(size, "scatter");
  console.log(`size ${String(size).padStart(2)}  cohesive intra/inter ${g.ratio.toFixed(2)}   scattered ${b.ratio.toFixed(2)}   separation ${(b.ratio/g.ratio).toFixed(2)}x`);
}
