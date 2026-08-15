# Tutorials

Self-contained teaching artifacts. Each is a single HTML file with no network dependencies: open it with a
browser, or `xdg-open` it, and everything runs locally.

The house rule for these: **compute on the real graph, not on illustrative data.** A tutorial that projects
Gaussian blobs teaches the mechanism; one that projects nodes you recognise lets you check the answer against
what you already know, which is the only way to tell whether you understood it or just followed it.

| file | what it teaches | data |
|---|---|---|
| `attention-is-a-graph.html` | Transformer attention as a literal weighted graph: scaled dot-product attention computed live over corpus-derived token embeddings, heads and layers and the causal mask, attention-as-budget, surprisal as the shared currency with novelty, and a playable version of Shannon's 1951 guessing game scored against a trigram model of the corpus. | 12-token demo sentence with PPMI co-occurrence embeddings (±4 window, 16-d); 6 passages and a trigram model from the same 318 chunks / 69,827 tokens. |
| `flattening-768-dimensions.html` | Dimensionality reduction for graph layout: what a projection is, PCA by power iteration, the crowding problem, t-SNE (implemented and run live in the page), what t-SNE does *not* preserve, UMAP and successors, and neighbourhood preservation as the way to measure what survived. | 260 entity nodes sampled from `testgraph`, stratified by degree, with their real stored `nomic-embed-text` vectors. |

## Regenerating the data

`scripts/dedup/tutorial-data.ts` reads the graph read-only, samples nodes, computes PCA by power iteration
with deflation, and writes the JSON that gets inlined into the page:

```bash
npx tsx scripts/dedup/tutorial-data.ts        # -> /tmp/tutorial-data.json      (projection tutorial)
npx tsx scripts/dedup/tutorial2-data.ts       # -> /tmp/tutorial2-{data,emb}.json (attention tutorial)
```

The page embeds that JSON inline (search for `const DATA =`), so the HTML file is standalone once built.

## Findings that came out of building it

Worth recording, because a teaching artifact that measures real data produces real results:

- **PC1 + PC2 explain 8.3%** of the variance in the 768-d embeddings; thirty components reach 52.5%. Two
  dimensions cannot carry this space, and that is a property of the data rather than a failure of the method.
- **Neighbourhood preservation at k=10**, measured over all 260 nodes: chance 3.9%, two arbitrary dimensions
  8.7%, PCA 15.2%, t-SNE 42.1%, and **the current force layout 6.8%** — barely above chance, and worse than
  picking two dimensions at random.

That last number is the load-bearing one. The force layout optimises graph edges and never consults the
embeddings, so 6.8% is not a criticism of it; it is a measurement of how little the two structures overlap.
The graph's link structure and the embedding geometry are close to independent sources of information about
the same nodes, which means a layout built on one of them leaves the other entirely on the floor. That is the
quantitative case for feeding embedding-kNN springs into the existing force layout (see `backlog.md`).


## A note on building the second one

Two instrument failures were caught while writing `attention-is-a-graph.html`, both of the kind that pass a
naive check:

1. **Stacked layers collapsed to uniform attention.** Feeding each layer's output straight into the next
   shrank and rotated the vectors until every dot product was nearly equal; by layer 3 every weight was
   exactly 1/12. Rows still summed to 1, so the standard "is this a valid distribution" check passed while
   the demo taught something false. The fix was to add a residual stream and normalisation — components real
   transformers have and this demo had omitted, so correctness and faithfulness improved together.
2. **A single-line `//` comment swallowed the code after it.** `proj()` builds its matrix on one line; an
   inline note commented out `M.push(r); }`.

Both were caught by executing the page's own functions headless and asserting properties — rows sum to 1, the
causal mask is respected, and mean deviation from uniform stays above a floor at every layer. That check is
cheap and belongs with any future interactive tutorial here.
