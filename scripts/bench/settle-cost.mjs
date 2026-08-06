// Verbatim port of settle() from viewer/template.html (lines 240-254), with synthetic
// nodes/edges at the same edge:node ratio as graphs/big (1316/598 = 2.2).
function bench(n) {
  const NODES = Array.from({length:n},(_,i)=>({x:Math.cos(i)*220+(i%7-3)*30,y:Math.sin(i)*220+(i%5-2)*30,vx:0,vy:0}));
  const EDGES = [];
  for (let k=0;k<Math.round(n*1.07);k++) EDGES.push({a:NODES[k%n],b:NODES[(k*7+3)%n]});
  const t0=performance.now();
  const kRep=5200,kSpring=0.045,rest=90,grav=0.012;
  for(const nd of NODES){nd.vx=0;nd.vy=0;}
  for(let it=0;it<500;it++){
    const alpha=Math.max(0.03,Math.pow(0.992,it));
    for(let i=0;i<NODES.length;i++){const a=NODES[i];
      for(let j=i+1;j<NODES.length;j++){const b=NODES[j];
        let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy||0.01,d=Math.sqrt(d2);
        const f=kRep/d2,fx=f*dx/d,fy=f*dy/d;a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
      a.vx-=a.x*grav;a.vy-=a.y*grav;}
    for(const e of EDGES){let dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.hypot(dx,dy)||0.01;
      const f=kSpring*(d-rest),fx=f*dx/d,fy=f*dy/d;e.a.vx+=fx;e.a.vy+=fy;e.b.vx-=fx;e.b.vy-=fy;}
    for(const nd of NODES){nd.x+=nd.vx*alpha;nd.y+=nd.vy*alpha;nd.vx*=0.82;nd.vy*=0.82;}
  }
  return performance.now()-t0;
}
for (const n of [387, 598, 1000, 2000, 4000]) console.log(String(n).padStart(5), (bench(n)/1000).toFixed(2)+'s');
