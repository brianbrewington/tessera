// Chunker — split a document into self-contained units before extraction. SIMPLE for the tracer bullet:
// pack paragraphs (blank-line boundaries) up to ~maxChars, never cutting a paragraph. Short docs = one chunk.
//
// TUNING IS DEFERRED (see docs/backlog.md "chunker tuning"): chunk size + overlap are a JOINT function of
// the extraction model — a bigger model takes bigger chunks (more cross-entity relations captured per call,
// less overlap-driven duplicate-node load), which is why a bigger model paid off on the Mac. No overlap yet.
export interface Chunk {
  index: number;
  text: string;
}

export function chunk(text: string, maxChars = 1500): Chunk[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: Chunk[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.trim()) chunks.push({ index: chunks.length, text: buf.trim() });
    buf = "";
  };
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxChars) flush();
    buf += (buf ? "\n\n" : "") + p;
    if (buf.length >= maxChars) flush();
  }
  flush();
  // Fallback for a single-paragraph doc with no blank lines. An EMPTY/whitespace-only doc yields NO chunks
  // (never a junk empty-text chunk that would embed("") and mint a contentless CHUNK node).
  if (chunks.length) return chunks;
  const whole = text.trim();
  return whole ? [{ index: 0, text: whole }] : [];
}
