// Ingest — markdown adapter (spec §5). Reads .md notes into the graph as proposed
// CONCEPT nodes (not auto-wired; the Connector links them). Strips YAML frontmatter and
// any prior `suggested-connections` block (connect.py's output) so we don't ingest stale
// edges as text.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { GraphStore } from "../store/graphStore.js";
import type { Meta } from "../schema.js";

export interface Note {
  path: string;
  title: string;
  noteType: string | null;
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const SUGGESTED = /<!--\s*suggested-connections:start\s*-->[\s\S]*?<!--\s*suggested-connections:end\s*-->/g;

export function parseNote(path: string, raw: string): Note {
  let body = raw;
  let noteType: string | null = null;
  const fm = raw.match(FRONTMATTER);
  if (fm) {
    body = raw.slice(fm[0].length);
    const t = fm[1]?.match(/^type:\s*(.+)$/m);
    if (t?.[1]) noteType = t[1].trim();
  }
  body = body.replace(SUGGESTED, "").trim();
  const h = body.match(/^#\s+(.+)$/m);
  const title = h?.[1]?.trim() ?? basename(path).replace(/\.md$/, "");
  return { path, title, noteType, body };
}

export function readNotes(dir: string): Note[] {
  const out: Note[] = [];
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue; // skip .obsidian and friends
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".md")) {
        const n = parseNote(p, readFileSync(p, "utf8"));
        if (n.body.length > 0) out.push(n);
      }
    }
  };
  walk(dir);
  return out;
}

export async function ingestNotes(store: GraphStore, notes: Note[], meta: Meta): Promise<string[]> {
  const ids: string[] = [];
  for (const n of notes) {
    const { id } = await store.putNode(
      {
        type: "CONCEPT",
        origin: "ingest",
        text: n.body,
        metadata: { title: n.title, path: n.path, noteType: n.noteType },
      },
      meta,
    );
    ids.push(id);
  }
  return ids;
}
