// Identity policy (ingest-layer, per docs/corpus-ingest-design.md). The store dedups on
// content_hash(text); the mapper constructs `text` as the identity string so the store stays
// domain-agnostic. Identity is CONTENT-ADDRESSED — file path never appears (so identical content dedups
// across machines / rolled-up / networked mounts). Hubs merge by type+name; PERSON is NOT source-qualified
// (a real person in two docs is ONE node — same-name collisions are the dedup/disambiguation layer's job,
// which path-qualification used to fight); SOURCE is its document's content hash; CHUNK is qualified by the
// SOURCE's content hash (path-free, but not pure-content: keeps the same boilerplate chunk in two different
// docs distinct, so subject-aware extraction runs once per doc rather than being silently memo-skipped).
import { createHash } from "node:crypto";
import type { EntityType } from "./extractor.js";

const norm = (s: string): string => s.trim().toLowerCase();
const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const sha32 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Content hash of a whole document's text — the path-free anchor for SOURCE and CHUNK identity. */
export function docContentHash(text: string): string {
  return sha32(text.normalize("NFC"));
}

/** identity string (node.text) for an extracted entity — type+name, no source/path qualifier. */
export function entityIdentity(type: EntityType, name: string): string {
  return `${type.toLowerCase()}\t${norm(name)}`;
}
/** SOURCE identity — the document IS its content (identical content across machines dedups to one source). */
export function sourceIdentity(contentHash: string): string {
  return `source\t${contentHash}`;
}
/** CHUNK identity — qualified by the SOURCE's content hash (NOT its path). */
export function chunkIdentity(sourceContentHash: string, rawText: string): string {
  return `chunk\t${sourceContentHash}\t${sha16(rawText)}`;
}

/**
 * MEDIA identity — the hash of the BYTES, and never of anything a model said about them.
 *
 * Two consequences, both deliberate. The same logo embedded in forty documents is ONE node with forty
 * parents, which is honest provenance ("this exact image appears in these forty places") and, when
 * captioning eventually exists, one call instead of forty. And identity exists BEFORE any model runs, so it
 * cannot drift: keying on a caption would make identity depend on nondeterministic output, and the same
 * image would mint a new node on every re-read, taking the memo and the manifest down with it.
 *
 * Not source-qualified, unlike CHUNK. A chunk is qualified by its document so subject-aware extraction runs
 * once per doc; that reason does not transfer to an image, and the cost of duplicating would be real work.
 */
export function mediaIdentity(bytes: Uint8Array): string {
  return `media\t${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}

/** Canonical undirected endpoint order (kills A->B / B->A double edges for undirected kinds). */
export function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
