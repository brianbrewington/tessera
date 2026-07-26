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
  let text = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
  let title = basename(source).replace(/\.[^.]+$/, "");
  // md: strip YAML frontmatter, prefer the first H1 as title.
  const fm = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (fm) text = text.slice(fm[0].length);
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1?.[1]) title = h1[1].trim();
  // persona docs: prefer the PROFILE: name as title AND as the document subject (drives subject-aware extraction
  // so the persona links to what's said about them — "his father" etc. — instead of floating unconnected).
  const prof = text.match(/^PROFILE:\s*(.+)$/m);
  const subject = prof?.[1]?.trim();
  if (subject) title = subject;
  return { source, title, text: text.trim(), subject };
}
