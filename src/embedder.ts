// Embedder boundary (spec §1): the Store is given an injected Embedder for the live
// path AND every write verb also accepts a pre-computed vector. All embeddings are
// unit-normalized so KNN L2 ordering tracks cosine and dedup cosine = a dot product.

export interface Embedder {
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d; // both unit-normalized
}

// Deterministic, dependency-free embedder for tests: hashes tokens into a fixed-dim
// unit vector. Same text -> same vector; different text -> (almost always) different.
export class StubEmbedder implements Embedder {
  constructor(readonly dim = 64) {}
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return normalize(v);
  }
}

// Wraps an embedder and adds deterministic gaussian noise — for the
// dedup-noisy-embedder test (forces cosine < 0.99 so content_hash must do the dedup).
export class NoisyEmbedder implements Embedder {
  private rngState: number;
  constructor(private base: Embedder, private sigma = 0.2, seed = 0x9e3779b9) {
    this.rngState = seed >>> 0;
  }
  get dim(): number {
    return this.base.dim;
  }
  private rand(): number {
    // mulberry32 — deterministic
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private gauss(): number {
    // Box-Muller
    const u = this.rand() || 1e-9;
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  async embed(text: string): Promise<Float32Array> {
    const base = await this.base.embed(text);
    const out = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) out[i] = base[i]! + this.sigma * this.gauss();
    return normalize(out);
  }
}

// Real embedder for ingest — Ollama HTTP (embeddinggemma). Wired in a later slice.
export class OllamaEmbedder implements Embedder {
  constructor(
    readonly dim = 768,
    private model = "embeddinggemma",
    private host = "http://127.0.0.1:11434",
  ) {}
  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
    const j = (await res.json()) as { embedding: number[] };
    return normalize(Float32Array.from(j.embedding));
  }
}
