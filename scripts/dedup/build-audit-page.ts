/**
 * Build the blind audit page for E0 — the protocol's only human labelling step.
 *
 * Why a page and not a terminal prompt: the judgment is "are these the same thing?", and it needs both
 * descriptions side by side, readable, without the shell wrapping them into mush. 40 pairs, keyboard-driven,
 * about 15 minutes.
 *
 * BLIND is load-bearing, not a nicety. The page shows two names and two descriptions and nothing else — no
 * set label, no cosine, no "these were flagged as duplicates". The whole point of E0 is to measure how
 * contaminated the free label sets are, and a judge who can see which set a pair came from is measuring the
 * protocol's own guess instead of the truth. The key stays in labels.json.
 *
 * Single self-contained file, no network, matching the viewer's discipline. Answers are held in
 * localStorage as you go (so a phone call does not cost you the run) and exported as JSON at the end.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Brief = { id: string; name: string; subtype: string; description: string };
const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const sample = JSON.parse(readFileSync(join(dir, "audit-sample.json"), "utf8")) as {
  pairs: { qid: string; a: Brief; b: Brief }[];
};

const data = JSON.stringify(sample.pairs).replace(/</g, "\\u003c"); // so a description containing '</script>' cannot break out

const html = `<!doctype html><html><head><meta charset="utf-8"><title>tessera — dedup audit (E0)</title><style>
:root{--bg:#0d111a;--surface:#121620;--line:#232a38;--text:#dfe4ee;--dim:#8b95a8;--accent:#7aa2f7;--yes:#7ec699;--no:#f7768e;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:system-ui,-apple-system,Segoe UI,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
  display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:28px 18px}
#top{width:100%;max-width:900px;display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
h1{font-size:15px;font-weight:500;letter-spacing:.02em;margin:0}
#count{font-family:var(--mono);font-size:12px;color:var(--dim)}
#bar{width:100%;max-width:900px;height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin-bottom:22px}
#fill{height:100%;width:0;background:var(--accent);transition:width .2s}
#q{width:100%;max-width:900px;font-size:13px;color:var(--dim);margin-bottom:14px;text-align:center}
#pair{width:100%;max-width:900px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:15px 17px;min-height:150px}
.nm{font-size:16px;font-weight:600;margin-bottom:3px;word-break:break-word}
.st{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:11px}
.ds{font-size:13.5px;line-height:1.6;color:#c3cad8;white-space:pre-wrap}
#btns{display:flex;gap:12px;margin-top:24px}
button{font-family:var(--sans);font-size:14px;padding:11px 26px;border-radius:9px;cursor:pointer;
  background:var(--surface);border:1px solid var(--line);color:var(--text)}
button:hover{border-color:var(--accent)}
#same{border-color:rgba(126,198,153,.5)}#same:hover{background:rgba(126,198,153,.13)}
#diff{border-color:rgba(247,118,142,.5)}#diff:hover{background:rgba(247,118,142,.13)}
#skip{color:var(--dim)}
#hint{margin-top:15px;font-family:var(--mono);font-size:11px;color:var(--dim)}
#done{display:none;width:100%;max-width:900px;text-align:center}
#out{width:100%;height:230px;margin-top:16px;background:var(--surface);border:1px solid var(--line);
  border-radius:9px;color:var(--text);font-family:var(--mono);font-size:11px;padding:11px}
</style></head><body>
<div id="top"><h1>Are these the same thing, extracted twice?</h1><div id="count"></div></div>
<div id="bar"><div id="fill"></div></div>
<div id="q">No set labels, no similarity scores — the judgment has to be yours, or it measures the protocol's guess instead of the truth.</div>
<div id="pair"></div>
<div id="btns"><button id="same">same &nbsp;<b>S</b></button><button id="diff">not the same &nbsp;<b>D</b></button><button id="skip">unsure &nbsp;<b>U</b></button></div>
<div id="hint">S / D / U &nbsp;·&nbsp; B goes back &nbsp;·&nbsp; progress is saved as you go</div>
<div id="done"><h1 style="font-size:18px;margin-bottom:8px">Done — 40 of 40</h1>
  <div style="color:var(--dim);font-size:13px">Save this as <code>graphs/testgraph/dedup/audit-answers.json</code>, or just paste it back into the session.</div>
  <textarea id="out" readonly></textarea></div>
<script>
const PAIRS = ${data};
const KEY = 'tessera-dedup-audit-v1';
let ans = JSON.parse(localStorage.getItem(KEY) || '{}');
let i = PAIRS.findIndex(p => !(p.qid in ans)); if (i < 0) i = PAIRS.length;
const $ = id => document.getElementById(id);
// Escape on the way into the DOM. These names and descriptions are MODEL-WRITTEN text about a codebase, so
// they are full of angle brackets and ampersands (a generic type, an "and" in code). Interpolating them raw
// into innerHTML would silently swallow half a description inside a bogus tag, and the judgment being made
// here depends on reading the description completely.
// NOTE: no backticks in this comment, deliberately. It lives inside a template literal, so one would end it.
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const card = n => '<div class="card"><div class="nm">' + esc(n.name) + '</div><div class="st">' + esc(n.subtype) + '</div><div class="ds">' + esc(n.description) + '</div></div>';
function render(){
  const n = Object.keys(ans).length;
  $('fill').style.width = (100 * n / PAIRS.length) + '%';
  $('count').textContent = n + ' / ' + PAIRS.length;
  if (i >= PAIRS.length){
    $('pair').style.display = $('btns').style.display = $('hint').style.display = $('q').style.display = 'none';
    $('done').style.display = 'block';
    $('out').value = JSON.stringify({ answered_at_local: new Date().toISOString(), answers: ans }, null, 1);
    $('out').select();
    return;
  }
  const p = PAIRS[i];
  $('pair').innerHTML = card(p.a) + card(p.b);
}
function answer(v){ if (i >= PAIRS.length) return; ans[PAIRS[i].qid] = v; localStorage.setItem(KEY, JSON.stringify(ans)); i++; render(); }
function back(){ if (i > 0){ i--; delete ans[PAIRS[i].qid]; localStorage.setItem(KEY, JSON.stringify(ans)); render(); } }
$('same').onclick = () => answer('same'); $('diff').onclick = () => answer('not-same'); $('skip').onclick = () => answer('unsure');
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 's') answer('same'); else if (k === 'd') answer('not-same'); else if (k === 'u') answer('unsure'); else if (k === 'b') back();
});
render();
</script></body></html>`;

const out = join(dir, "audit.html");
writeFileSync(out, html);
console.log(`${sample.pairs.length} pairs -> ${out}`);
console.log(`open it with:  xdg-open ${out}`);