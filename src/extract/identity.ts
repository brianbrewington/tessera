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
 * THE SECOND IDENTITY REGIME. Read this before "unifying" it with the one above.
 *
 * A document IS its content, so its identity is a hash of its text. A SESSION is a STREAM, and a stream is
 * not its content: a live log grows while you work, so re-hashing it after every turn makes it "new content"
 * forever. Under the document rule, re-ingesting a continuing conversation would mint a fresh source, fresh
 * chunks and duplicate entities on every single read.
 *
 * So a session is addressed by its external stable id, and its TURNS are the content-addressed units within
 * it, keyed by the record uuid the runtime already assigns. Correctness comes from per-turn identity alone:
 * re-reading a grown log makes every existing turn an identity hit that reinforces, and only new turns
 * append. Any high-water mark is an optimisation, so losing it degrades to a full re-read rather than to
 * duplication.
 *
 * The cost, stated so nobody has to rediscover it: there are now two regimes in one ingest. That is correct
 * for the two objects and must stay visible, because collapsing sessions into the document rule reintroduces
 * exactly the duplication bug this exists to prevent.
 *
 * Note the generalisation, not yet built: `chunkIdentity` qualifies by the SOURCE's content hash, so growing
 * ANY document changes every chunk key. Sessions are only where this surfaced first. A running notes file and
 * a journal have the same shape, and the fix is this one applied to sections instead of turns.
 */
export function sessionIdentity(ns: string, sessionKey: string): string {
  return `session\t${norm(ns)}\t${sessionKey.trim()}`;
}

/** TURN identity — stable across re-reads of a growing log, because the runtime assigned the uuid. */
export function turnIdentity(ns: string, sessionKey: string, turnId: string): string {
  return `turn\t${norm(ns)}\t${sessionKey.trim()}\t${turnId.trim()}`;
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
