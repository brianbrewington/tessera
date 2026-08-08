// Ingest adapters — read a source file into raw text + a title, behind one interface. Tracer bullet ships
// txt + md only; PDF/docx/.odp(.pptx)/image are backlog, each a new impl behind this same `readDoc` seam.
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { basename, extname, resolve, join } from "node:path";

export interface Doc {
  source: string; // stable id (the path)
  title: string;
  text: string;
  subject?: string; // the PERSON this document is about (personas) — drives subject-aware extraction; else undefined
}

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

export function readDoc(path: string): Doc {
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
  return { source, title, text: text.trim(), subject };
}
