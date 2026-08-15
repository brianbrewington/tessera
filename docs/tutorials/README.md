# Tutorials

Self-contained teaching artifacts. Each is a single HTML file with no network dependencies: open it with a
browser, or `xdg-open` it, and everything runs locally.

The house rule for these: **compute on the real graph, not on illustrative data.** A tutorial that projects
Gaussian blobs teaches the mechanism; one that projects nodes you recognise lets you check the answer against
what you already know, which is the only way to tell whether you understood it or just followed it.

| file | what it teaches | data |
|---|---|---|
| `flattening-768-dimensions.html` | Dimensionality reduction for graph layout: what a projection is, PCA by power iteration, the crowding problem, t-SNE (implemented and run live in the page), what t-SNE does *not* preserve, UMAP and successors, and neighbourhood preservation as the way to measure what survived. | 260 entity nodes sampled from `testgraph`, stratified by degree, with their real stored `nomic-embed-text` vectors. |

## Regenerating the data

`scripts/dedup/tutorial-data.ts` reads the graph read-only, samples nodes, computes PCA by power iteration
with deflation, and writes the JSON that gets inlined into the page:

```bash
npx tsx scripts/dedup/tutorial-data.ts        # -> /tmp/tutorial-data.json
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
