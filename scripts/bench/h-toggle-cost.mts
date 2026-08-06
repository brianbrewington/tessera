// The 'h' toggle adds provenance to the visible set. Provenance has NO layout until slice 4, so the
// completeness test fails and the viewer falls back to a FULL settle over every node. What does that cost?
import { seedPositions, settle, type LayoutNode, type LayoutEdge } from "../../src/layout/settle.js";
const N = Number(process.argv[2] ?? 4975), M = Number(process.argv[3] ?? 8246);
const ids = Array.from({length:N},(_,i)=>`n${i}`);
const seeds = seedPositions(ids);
const nodes: LayoutNode[] = ids.map(id=>({id,...seeds.get(id)!,vx:0,vy:0}));
const edges: LayoutEdge[] = Array.from({length:M},(_,k)=>({a:k%N,b:(k*7919+3)%N})).filter(e=>e.a!==e.b);
const t=performance.now(); settle(nodes,edges);
console.log(`full settle over ${N} nodes / ${M} edges: ${((performance.now()-t)/1000).toFixed(1)}s of FROZEN main thread`);
