// Identity policy (ingest-layer, per docs/ingest-model.md). The store dedups on content_hash(text); the
// mapper constructs `text` as the identity string so the store stays domain-agnostic. Hubs merge by
// type+name (the trope signal); PERSON is source-qualified so distinct same-named people stay distinct;
// SOURCE is path-keyed; CHUNK is source+text-keyed (so re-ingesting a doc reinforces its chunks).
import { createHash } from "node:crypto";
import type { EntityType } from "./extractor.js";

export function sourceKey(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}
const norm = (s: string): string => s.trim().toLowerCase();
const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** identity string (node.text) for an extracted entity. */
export function entityIdentity(type: EntityType, name: string, source: string): string {
  return type === "PERSON"
    ? `person\t${norm(name)}\t${sourceKey(source)}`
    : `${type.toLowerCase()}\t${norm(name)}`;
}
export function sourceIdentity(path: string): string {
  return `source\t${path}`;
}
export function chunkIdentity(source: string, rawText: string): string {
  return `chunk\t${sourceKey(source)}\t${sha16(rawText)}`;
}

/** Canonical undirected endpoint order (kills A->B / B->A double edges for undirected kinds). */
export function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
