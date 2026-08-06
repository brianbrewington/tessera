// Cohesion where the SEED is load-bearing: a component with no edge into the anchored field (rule c).
import { GraphStore } from "../../src/store/graphStore.js";
import { StubEmbedder } from "../../src/embedder.js";
import { layoutPass } from "../../src/layout/pass.js";
import { placeComponent, settleIncremental, type AnchoredPoint } from "../../src/layout/incremental.js";
import type { LayoutNode } from "../../src/layout/settle.js";

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
    // The defect the ladder exists to prevent: each member seeded at its OWN nearest-anchor position.
    // Both arms then run the IDENTICAL relax, so the only difference is seed policy.
    const anchored: AnchoredPoint[] = anchor.map(id => ({ id, x: L0.get(id)!.x, y: L0.get(id)!.y }));
    const anchPts = anchor.map(id=>L0.get(id)!);
    const newcomers: LayoutNode[] = comp.map((id,i) => {
      const seed = placeComponent(anchPts[i%anchPts.length]!, 1)[0]!;
      return { id, x: seed.x, y: seed.y, vx: 0, vy: 0 };
    });
    const idx = new Map(comp.map((id,i)=>[id,i]));
    const incEdges = comp.slice(1).map((id,i)=>({ a: idx.get(comp[i]!)!, b: idx.get(id)! }));
    settleIncremental(anchored, newcomers, incEdges);
    s.putLayoutBatch(newcomers.map(n=>({nodeId:n.id,x:n.x,y:n.y})), meta);
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
