#!/usr/bin/env bash
# Emit the tutorials landing page. Generated rather than hand-written so it always lists what is actually
# on disk. Visual identity deliberately matches ~/public_html (warm paper, brown accent, serif body) so the
# tutorials read as part of the same site rather than as a bolt-on.
set -euo pipefail
DIR="${1:?dest dir}"
cat <<'HTML'
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tutorials — tessera</title><style>
:root{--bg:#fbfaf8;--fg:#1f1d1a;--dim:#6b6862;--line:#e4e0d8;--card:#fff;--accent:#7a4b1e;--chip:#f2eee7}
@media(prefers-color-scheme:dark){:root{--bg:#15141a;--fg:#e9e7e2;--dim:#9a958c;--line:#302e37;
      --card:#1d1c22;--accent:#d9a066;--chip:#26252c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.68 ui-serif,Georgia,"Iowan Old Style",Palatino,serif}
header{border-bottom:1px solid var(--line);padding:14px 0;margin-bottom:34px;font-family:ui-sans-serif,system-ui,sans-serif}
header .in,main,footer .in{max-width:760px;margin:0 auto;padding:0 22px}
header a{color:var(--dim);text-decoration:none;font-size:14px;margin-right:18px}
header a:hover{color:var(--accent)}
h1{font-size:31px;line-height:1.22;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:16px;margin:0 0 30px;font-style:italic}
a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 16px}
.card h2{font-size:20px;margin:0 0 6px;border:0;padding:0}
.card h2 a{text-decoration:none}
.card p{margin:0 0 8px;font-size:15px}
.meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dim)}
.aside{background:var(--chip);border-radius:8px;padding:14px 17px;margin:26px 0;font-size:15px}
.aside b:first-child{color:var(--accent)}
footer{margin-top:64px;padding:22px 0 50px;border-top:1px solid var(--line);color:var(--dim);
  font-size:13.5px;font-family:ui-sans-serif,system-ui,sans-serif}
</style></head><body>
<header><div class="in"><a href="/">~brian-brewington</a><a href="/tutorials/">tutorials</a></div></header>
<main>
<h1>tessera tutorials</h1>
<p class="sub">Interactive, self-contained, and computed on the real graph rather than on illustrative data.</p>

<div class="card">
  <h2><a href="flattening-768-dimensions.html">Flattening 768 Dimensions</a></h2>
  <p>What a projection is and what it costs. PCA by power iteration, the crowding problem, t-SNE implemented
  and run live in the page, what t-SNE does <em>not</em> preserve, UMAP and successors, and neighbourhood
  preservation as the way to measure what survived. Closes with what the perception literature knows about
  opacity, edge bundling and semantic zoom — and how little of it has been evaluated.</p>
  <p class="meta">260 real nodes · live t-SNE · PC1+PC2 explain 8.3%</p>
</div>

<div class="card">
  <h2><a href="attention-is-a-graph.html">Attention Is a Graph</a></h2>
  <p>Transformer attention as a literal weighted graph over tokens, computed live on embeddings built from
  the corpus itself. Heads, layers, the causal mask. Then attention as a <em>budget</em>, surprisal as the
  currency shared with novelty and layout, and a playable version of Shannon's 1951 guessing game scored
  against a trigram model of the same corpus.</p>
  <p class="meta">live self-attention · 69,827 tokens · playable</p>
</div>

<div class="aside">
  <b>Source of truth.</b> These are copied out of <code>~/code/tessera/docs/tutorials/</code> by
  <code>scripts/publish-tutorials.sh</code>. Edit them there, never here — a served copy that drifts from the
  repo is worse than no served copy, because you end up reading a stale page and trusting it.
</div>
</main>
<footer><div class="in">Generated from the tessera repo. Everything runs locally; no network calls.</div></footer>
</body></html>
HTML
