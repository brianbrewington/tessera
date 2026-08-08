// Ingest adapters — read a source file into raw text + a title, behind one interface. Tracer bullet ships
// txt + md only; PDF/docx/.odp(.pptx)/image are backlog, each a new impl behind this same `readDoc` seam.
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, extname, resolve, join } from "node:path";

export interface Doc {
  source: string; // stable id (the path)
  title: string;
  text: string;
  subject?: string; // the PERSON this document is about (personas) — drives subject-aware extraction; else undefined
}

/**
 * A thing a document CONTAINS, enumerated at read time.
 *
 * The frame here is "enumerable parts", not "recursive ingestion". A container's contents are a tree known
 * when you parse it, so an adapter should list what it found and let the caller decide what each part is
 * worth. That is bounded by construction: an image has no parts to return.
 *
 * Only the two kinds with a real producer today. A `document` kind (for an attachment inside an email, or a
 * spreadsheet inside a slide deck) belongs here when something actually emits one, not before: this repo is
 * already carrying 11 declared-but-unwritten node types and 3 unwritten edge kinds, and a review just billed
 * us for treating a declared seam as progress.
 */
export type DocPart =
  | {
      kind: "text";
      name: string;
      text: string;
      /** Ordering plus whatever the source knows: page, speaker, timestamp. */
      meta?: Record<string, unknown>;
    }
  | {
      kind: "media";
      name: string;
      bytes: Buffer;
      mime: string;
      meta?: Record<string, unknown>;
    };

export interface ReadResult {
  doc: Doc;
  parts: DocPart[];
  /** Parts found and deliberately not returned, with the reason. Never drop something silently. */
  skipped: { name: string; reason: string }[];
}

/** Below this, an image is a spacer, a bullet, or a tracking pixel. */
export const MIN_MEDIA_BYTES = 2048;
/** Above this we record the reference and refuse the bytes rather than bloating the database. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
/** Per document. A 300-page scan can carry hundreds; the cap is what stops one file dominating a graph. */
export const MAX_MEDIA_PER_DOC = 50;

const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".tif": "image/tiff",
  ".tiff": "image/tiff", ".avif": "image/avif",
};

/**
 * persona docs: the subject is the PROFILE: name — but ONLY when it's the document's FIRST non-blank line (a
 * persona header). A "PROFILE:" line quoted deep in a report or transcript must NOT steer extraction
 * person-ward, and a `\s*` that spans newlines must not grab the next line. Drives subject-aware
 * extraction (KI-1).
 *
 * Exported because store-driven extraction has to recover the subject WITHOUT the file, for graphs ingested
 * before the subject was persisted on the SOURCE node. It reads the same header out of chunk zero, so the two
 * paths must agree by construction rather than by two copies of one regex staying in sync.
 */
export function subjectFromText(text: string): string | undefined {
  const firstLine = text.replace(/^\s+/, "").split("\n", 1)[0] ?? "";
  return firstLine.match(/^PROFILE:[ \t]*(.+)$/)?.[1]?.trim() || undefined;
}

const SUPPORTED = new Set([".txt", ".md", ".markdown", ".text"]);

export function isSupported(path: string): boolean {
  return SUPPORTED.has(extname(path).toLowerCase());
}

// Directories not descended into during a corpus walk (VCS / dependency / tool dirs) — and any dotdir.
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);

// Expand a list of files/directories into the sorted, deduped set of supported docs to ingest. Recursive by
// default; skips hidden and well-known non-content dirs; follows symlinks with a realpath cycle-guard (a
// symlinked duplicate resolves to one entry, and identity is content-addressed so it would dedup regardless).
// Deterministic order (sorted realpaths) so a corpus run is reproducible.
export function collectDocs(paths: string[], opts: { recursive?: boolean } = {}): string[] {
  const recursive = opts.recursive !== false;
  const seenDirs = new Set<string>();
  const out = new Set<string>();
  const walkDir = (dir: string): void => {
    if (seenDirs.has(dir)) return; // symlink cycle / re-entry guard (dir is a realpath)
    seenDirs.add(dir);
    for (const entry of readdirSync(dir).sort()) {
      const child = join(dir, entry);
      let real: string;
      try { real = realpathSync(child); } catch { continue; } // dangling symlink etc.
      let st;
      try { st = statSync(real); } catch { continue; }
      if (st.isDirectory()) {
        if (recursive && !entry.startsWith(".") && !SKIP_DIRS.has(entry)) walkDir(real);
      } else if (isSupported(child) && !entry.startsWith(".")) {
        out.add(real); // skip dotfiles during a walk (e.g. macOS `._foo.md` junk); an explicit path still works
      }
    }
  };
  for (const p of paths) {
    let real: string;
    try { real = realpathSync(p); } catch { continue; } // missing path: silently drop here; caller reports the gap
    let st;
    try { st = statSync(real); } catch { continue; }
    if (st.isDirectory()) walkDir(real);
    else if (isSupported(p)) out.add(real);
  }
  return [...out].sort();
}

/**
 * Local images a markdown document references: `![alt](relative/path.png)`.
 *
 * The first real producer of media parts, chosen because it needs no new parsing dependency and exercises the
 * whole path today, while PDF and docx remain unbuilt. Remote URLs and data: URIs are refused: this manifests
 * what is ON DISK next to the document, and fetching over the network at ingest time is a different decision
 * with different consequences.
 */
function markdownMedia(text: string, docPath: string): { parts: DocPart[]; skipped: { name: string; reason: string }[] } {
  const parts: DocPart[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  const dir = dirname(resolve(docPath));
  // ![alt](target) with an optional "title"; target stops at whitespace or the closing paren.
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) { skipped.push({ name: ref, reason: "not a local file" }); continue; }
    const abs = resolve(dir, decodeURIComponent(ref));
    if (seen.has(abs)) continue; // the same image referenced twice in one document is one part
    seen.add(abs);
    const mime = MEDIA_MIME[extname(abs).toLowerCase()];
    if (!mime) { skipped.push({ name: ref, reason: "unrecognised image type" }); continue; }
    if (parts.length >= MAX_MEDIA_PER_DOC) { skipped.push({ name: ref, reason: `over the ${MAX_MEDIA_PER_DOC}-image cap` }); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(abs); } catch { skipped.push({ name: ref, reason: "could not be read" }); continue; }
    if (bytes.byteLength < MIN_MEDIA_BYTES) { skipped.push({ name: ref, reason: `under ${MIN_MEDIA_BYTES} bytes` }); continue; }
    if (bytes.byteLength > MAX_MEDIA_BYTES) { skipped.push({ name: ref, reason: `over ${MAX_MEDIA_BYTES} bytes` }); continue; }
    parts.push({ kind: "media", name: basename(abs), bytes, mime, meta: { ref, path: abs } });
  }
  return { parts, skipped };
}

export function readDoc(path: string): ReadResult {
  // Canonicalize the path so `doc.md`, `./doc.md`, and an absolute path all yield ONE source identity
  // (else a re-ingest under a differently-spelled path duplicates the SOURCE, its chunks, and its people).
  const source = resolve(path);
  // Normalize at the boundary: NFC + newline canonicalization once, so SOURCE identity (hash of doc.text),
  // CHUNK identity (hash of chunk text split from doc.text), and the stored body all agree — two docs that
  // differ only in Unicode composition dedup completely, not just at the SOURCE level (Codex review).
  let text = readFileSync(source, "utf8").replace(/\r\n/g, "\n").normalize("NFC");
  let title = basename(source).replace(/\.[^.]+$/, "");
  // md: strip YAML frontmatter, prefer the first H1 as title.
  const fm = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (fm) text = text.slice(fm[0].length);
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1?.[1]) title = h1[1].trim();
  const subject = subjectFromText(text);
  if (subject) title = subject;
  const media = markdownMedia(text, source);
  return { doc: { source, title, text: text.trim(), subject }, parts: media.parts, skipped: media.skipped };
}
