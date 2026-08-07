// Advisory ingest lock, shared by `tessera serve` and `tessera ingest` (design §9).
//
// It was one-sided: only serve took it, and CLI ingest never checked, so the design's mutual exclusion was
// documented and not implemented. Serve also held it for the WHOLE session rather than only while ingesting,
// which blocked CLI ingest even when idle — stricter than the design and still not reciprocal.
//
// Acquisition is atomic: `wx` fails if the file exists, so two processes cannot both win a check-then-create
// race the way existsSync + writeFileSync could.
import { openSync, closeSync, writeSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export const lockPath = (graphDir: string): string => join(graphDir, ".ingest.lock");

export interface LockInfo { pid: number; at: number; what: string }

function readLock(p: string): LockInfo | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as LockInfo; } catch { return null; }
}

/** True when the recorded pid is gone — a crashed holder should not block for six hours. */
function holderDead(info: LockInfo): boolean {
  if (!Number.isInteger(info.pid) || info.pid <= 0) return true;
  try { process.kill(info.pid, 0); return false; } catch { return true; }
}

export class LockHeld extends Error {
  constructor(readonly info: LockInfo, path: string) {
    super(`another tessera process is writing this graph (pid ${info.pid}, ${info.what}) — ${path}`);
    this.name = "LockHeld";
  }
}

/** Acquire, or throw LockHeld. Returns a release function that is safe to call twice. */
export function acquireIngestLock(graphDir: string, what: string): () => void {
  const p = lockPath(graphDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx"); // atomic create-if-absent
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), what } satisfies LockInfo));
      closeSync(fd);
      let released = false;
      return () => { if (!released) { released = true; rmSync(p, { force: true }); } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = readLock(p);
      // Reclaim only when the holder is provably gone or the lock is ancient. An unreadable lock file is
      // treated as stale-if-old, never as free, so a torn write cannot hand two writers the same graph.
      const reclaimable = info === null
        ? !existsSync(p)
        : holderDead(info) || Date.now() - info.at > LOCK_STALE_MS;
      if (!reclaimable) throw new LockHeld(info ?? { pid: -1, at: 0, what: "unknown" }, p);
      rmSync(p, { force: true });
    }
  }
  throw new LockHeld({ pid: -1, at: 0, what: "contended" }, p);
}
