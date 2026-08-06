# scripts/bench — the measurement harnesses behind the design numbers

Every number asserted in `docs/durable-map-state-design.md` and
`docs/viewer-state-and-serve-outline.md` comes from one of these. They are checked in because a design
decision anchored to a local run nobody else can reproduce is an assertion, not a measurement — a round-3
reviewer flagged exactly that gap.

Each script is standalone and read-only with respect to the repo. Run from the repo root.

| script | answers | asserted in |
|---|---|---|
| `settle-cost.mjs` | What does the viewer's O(n²) settle cost at N nodes? | design §3.5, outline §2 |
| `ingest-latency.mts` | What does a chunk actually cost, and what fraction is extraction? | design §7.4, D9 |
| `header-probe.mjs` | What headers does a real browser send to a local server? | design §7.2 |
| `seed-fallback-rate.ts` | How often does centroid seeding actually fire? | design §3.3.1 |

## Running them

```bash
# Layout cost — a verbatim port of viewer/template.html settle(), timed at several sizes.
node scripts/bench/settle-cost.mjs

# Ingest latency — needs Ollama up. Args: <doc> [maxChunks]. Run it twice; the first
# chunk pays ~15s of cold model load and the steady-state number is the second run's.
NODE_PATH="$PWD/node_modules" npx tsx scripts/bench/ingest-latency.mts docs/corpus/immune-system-as-adversarial-attention.md 11

# Header probe — start it, open http://127.0.0.1:7777 in a browser, then read /report.
# Re-run this in BOTH Chrome and Firefox before changing design §7.2. That rule is
# measured, not derived, and two "obvious" alternatives to it each broke the app.
node scripts/bench/header-probe.mjs
curl -s http://127.0.0.1:7777/report | python3 -m json.tool

# Seed fallback rate — how often does "centroid of anchored neighbours" have anything
# to work with? Reports a half-split proxy and the faithful last-document proxy.
NODE_PATH="$PWD/node_modules" npx tsx scripts/bench/seed-fallback-rate.ts
```

## Results of record (2026-08-05/06, `graphs/big`, this workstation)

- **Settle:** 0.26 s @ 387 visible nodes · 1.50 s @ 1,000 · 6.00 s @ 2,000 · 23.6 s @ 4,000. Quadratic;
  edge:node ratio barely matters.
- **Ingest:** 9.9 s/chunk warm (extraction **97%**, all embeddings 3%), range 5.5–20.6 s tracking output
  size; ~15 s extra once for cold model load.
- **Headers:** Chrome and Firefox agreed on every field — navigation sends `Sec-Fetch-Site: none` and no
  `Origin`; the page's own `EventSource` sends `same-origin` and **no `Origin`**; `fetch` POST sends both;
  non-browser clients send no `Sec-Fetch-*` at all.
- **Seed fallback:** the graph-anchor rule alone falls through to the ring for **89.7%** of newcomers
  (half-split) and **92.9%** (last-document, the real drop case). This is why design §3.3 has a ladder
  instead of one rule.

Re-run and update this table when the corpus, the models, or the machine changes. The `seed-fallback-rate`
number in particular is corpus-dependent and is an acceptance target in design §10, not a constant.
