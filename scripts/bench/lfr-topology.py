#!/usr/bin/env python3
"""Generate an LFR benchmark topology and emit JSON for the tessera synthetic importer.

LFR (Lancichinetti-Fortunato-Radicchi) is the standard benchmark for community-structure work: it produces
power-law DEGREE and power-law COMMUNITY SIZES with a tunable mixing parameter, plus ground-truth community
labels. That combination is what makes prominence-ranked tiling testable — a flat-degree graph gives no
principled basis for choosing the top N, and no ground truth to check a tiling against.

Requires networkx (a venv is fine; the repo itself stays dependency-free).
Usage: lfr-topology.py <n> <mu> <out.json>
"""
import json, sys
import networkx as nx

n = int(sys.argv[1]) if len(sys.argv) > 1 else 3870
mu = float(sys.argv[2]) if len(sys.argv) > 2 else 0.15
out = sys.argv[3] if len(sys.argv) > 3 else "lfr.json"

G = nx.LFR_benchmark_graph(
    n=n,
    tau1=2.5,          # degree exponent — 2-3 is the empirical range for link graphs
    tau2=1.5,          # community-size exponent
    mu=mu,             # fraction of a node's edges that leave its community
    average_degree=10,
    min_community=30,
    seed=42,
    max_iters=5000,
)
G.remove_edges_from(nx.selfloop_edges(G))

comm_of = {}
for i, node in enumerate(G.nodes()):
    members = frozenset(G.nodes[node]["community"])
    comm_of[node] = members
uniq = {c: i for i, c in enumerate(sorted(set(comm_of.values()), key=lambda s: (-len(s), min(s))))}

degs = sorted((d for _, d in G.degree()), reverse=True)
print(f"LFR: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(uniq)} communities", file=sys.stderr)
print(f"  degree  max {degs[0]}  p99 {degs[len(degs)//100]}  median {degs[len(degs)//2]}  min {degs[-1]}"
      f"  max/median {degs[0]/max(1,degs[len(degs)//2]):.1f}x", file=sys.stderr)
sizes = sorted((len(c) for c in uniq), reverse=True)
print(f"  community sizes  max {sizes[0]}  median {sizes[len(sizes)//2]}  min {sizes[-1]}", file=sys.stderr)

json.dump({
    "n": G.number_of_nodes(),
    "mu": mu,
    "communities": len(uniq),
    "nodes": [{"id": int(v), "community": uniq[comm_of[v]], "degree": G.degree(v)} for v in G.nodes()],
    "edges": [[int(a), int(b)] for a, b in G.edges()],
}, open(out, "w"))
print(f"wrote {out}", file=sys.stderr)
