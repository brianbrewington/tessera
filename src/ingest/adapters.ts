// Ingest adapters — read a source file into raw text + a title, behind one interface. Tracer bullet ships
// txt + md only; PDF/docx/.odp(.pptx)/image are backlog, each a new impl behind this same `readDoc` seam.
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

export interface Doc {
  source: string; // stable id (the path)
  title: string;
  text: string;
  subject?: string; // the PERSON this document is about (personas) — drives subject-aware extraction; else undefined
}

const SUPPORTED = new Set([".txt", ".md", ".markdown", ".text"]);

export function isSupported(path: string): boolean {
  return SUPPORTED.has(extname(path).toLowerCase());
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
  // persona docs: the subject is the PROFILE: name — but ONLY when it's the document's FIRST non-blank line (a
  // persona header). A `PROFILE:` line quoted deep in a report/transcript must NOT steer extraction person-ward,
  // and a `\s*` that spans newlines must not grab the next line. Drives subject-aware extraction (KI-1).
  const firstLine = text.replace(/^\s+/, "").split("\n", 1)[0] ?? "";
  const subject = firstLine.match(/^PROFILE:[ \t]*(.+)$/)?.[1]?.trim() || undefined;
  if (subject) title = subject;
  return { source, title, text: text.trim(), subject };
}
