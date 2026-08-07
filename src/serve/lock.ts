// Advisory ingest lock, shared by `tessera serve` and `tessera ingest` (design §9).
//
// It was one-sided: only serve took it, and CLI ingest never checked, so the design's mutual exclusion was
// documented and not implemented. Serve also held it for the WHOLE session rather than only while ingesting,
// which blocked CLI ingest even when idle — stricter than the design and still not reciprocal.
//
// Acquisition is atomic: `wx` fails if the file exists, so two processes cannot both win a check-then-create
// race the way existsSync + writeFileSync could.
import { openSync, closeSync, writeSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export const lockPath = (graphDir: string): string => join(graphDir, ".ingest.lock");

export interface LockInfo {
  pid: number;
  at: number;
  what: string;
  /** Unique per ACQUISITION. (pid, at) is not enough: two acquisitions in one process within the same
   *  millisecond are identical, so a stale handle could free a live lock it did not own. Caught by the
   *  idempotence test, which started failing the moment ownership checking was introduced. */
  token: string;
}

function readLock(p: string): LockInfo | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as LockInfo; } catch { return null; }
}

/** True when the recorded pid is gone — a crashed holder should not block for six hours. */
function holderDead(info: LockInfo): boolean {
  if (!Number.isInteger(info.pid) || info.pid <= 0) return true;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch (e) {
    // EPERM means the pid EXISTS but belongs to another uid — very much alive. A bare catch read that as
    // "dead" and stole the live lock, verified against pid 1. Reachable whenever serve and ingest run as
    // different users on one graph dir (a one-time `sudo tessera serve`, a systemd unit, a shared box).
    return (e as NodeJS.ErrnoException).code !== "EPERM";
  }
}

export class LockHeld extends Error {
  constructor(readonly info: LockInfo, path: string) {
    super(`another tessera process is writing this graph (pid ${info.pid}, ${info.what}) — ${path}`);
    this.name = "LockHeld";
  }
}

/**
 * Acquire, or throw LockHeld. Returns a release function that is safe to call twice.
 *
 * Two properties that a previous version got wrong, both found by executing probes rather than reading:
 *
 * 1. RECLAIM IS ATOMIC. Deciding "this lock is stale" from a snapshot and then calling rmSync deletes
 *    whatever is at the path WHEN IT RUNS — not the file that was judged stale. Two processes starting
 *    against the same dead-holder lock could each read the stale info, and the second could delete the
 *    first's fresh lock and take one of its own. Both would then hold it, which is the exact failure this
 *    module exists to prevent. Reclaim now renames first: rename is atomic, so exactly one racer wins, and
 *    the loser's rename fails.
 * 2. RELEASE CHECKS OWNERSHIP. Unconditional rmSync deleted locks belonging to other processes — verified.
 *    Release now re-reads and unlinks only its own.
 */
export function acquireIngestLock(graphDir: string, what: string): () => void {
  const p = lockPath(graphDir);
  const mine: LockInfo = { pid: process.pid, at: Date.now(), what, token: randomUUID() };

  const release = (): void => {
    // Only unlink if it is still OURS. A stale handle must never free someone else's lock.
    const cur = readLock(p);
    if (cur && cur.token === mine.token) rmSync(p, { force: true });
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(p, "wx"); // atomic create-if-absent
      writeSync(fd, JSON.stringify(mine));
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // e.g. ENOSPC after the file was created: do not leave an empty lock behind to wedge the graph
        if (fd !== undefined) rmSync(p, { force: true });
        throw e;
      }
      if (!reclaimStale(p, graphDir)) throw new LockHeld(readLock(p) ?? { pid: -1, at: 0, what: "unknown", token: "" }, p);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new LockHeld({ pid: -1, at: 0, what: "contended", token: "" }, p);
}

/** Guard file serialising RECLAIM itself. Short-lived; its own staleness covers a crash mid-reclaim. */
export const reclaimGuardPath = (graphDir: string): string => `${lockPath(graphDir)}.reclaim`;
const RECLAIM_GUARD_STALE_MS = 30_000;

/**
 * Try to remove a lock that is provably abandoned. Returns true if the caller should retry.
 *
 * WHY A GUARD FILE, AND NOT JUST rename(): rename is atomic, but it acts on whatever is at the path WHEN IT
 * RUNS — it is not bound to the snapshot that justified it. (The rename mechanism itself is GONE; only this
 * rationale survives. Do not reintroduce it.) A reviewer demonstrated the hole by execution:
 * if a rival completes its ENTIRE reclaim-and-acquire inside your read→rename gap, your rename succeeds on
 * the rival's fresh, LIVE lock and you both proceed. Two processes held the lock for ~5 seconds. That is the
 * exact defect the rename was introduced to fix, reproduced one layer up — the third time in this file that a
 * fix for a race contained a race.
 *
 * The guard makes the whole judge-and-reclaim sequence exclusive rather than only its final step. A racer who
 * cannot take the guard reports "held" — a spurious LockHeld is the correct failure direction here, since two
 * writers on one graph is the outcome being prevented.
 */
function reclaimStale(p: string, graphDir: string): boolean {
  const guard = reclaimGuardPath(graphDir);
  let guardFd: number | undefined;
  try {
    guardFd = openSync(guard, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Someone else is mid-reclaim, or crashed while reclaiming. Only the latter may be cleared.
    let guardAge = 0;
    try {
      guardAge = Date.now() - statSync(guard).mtimeMs;
    } catch {
      return true; // vanished — retry the acquire
    }
    if (guardAge <= RECLAIM_GUARD_STALE_MS) return false; // a live reclaim is in progress: treat as held
    // MITIGATION, NOT A FIX. Re-stat and delete only if the guard is the same one we judged. This narrows
    // the window in which we delete a guard that someone else created between our stat and our unlink; it
    // does not close it, and a reviewer demonstrated a 3.8-SECOND concurrent hold through exactly this path.
    // See docs/backlog.md — "the lock needs an OS-level primitive": every layer of this design that clears a
    // stale X with unlink regenerates the same check-then-delete race one level up, and this is the fourth
    // instance. The terminating fix is a kernel lock bound to process lifetime, not another guard.
    try {
      if (Date.now() - statSync(guard).mtimeMs <= RECLAIM_GUARD_STALE_MS) return false; // someone re-created it
    } catch {
      return true; // vanished — the path is free
    }
    rmSync(guard, { force: true });
    return true; // retry; the next attempt takes the guard cleanly
  }

  try {
    const info = readLock(p);
    let stale: boolean;
    if (info === null) {
      // Unreadable or empty — reachable by a crash between create and write, so it must NOT wedge forever.
      // Fall back to the file's own mtime: stale-if-old, never free-on-sight.
      try {
        stale = Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS;
      } catch {
        return true; // vanished under us — the path is free, retry
      }
    } else {
      stale = holderDead(info) || Date.now() - info.at > LOCK_STALE_MS;
    }
    if (!stale) return false;
    // Safe from the LOCK-level race, because we hold the guard. NOT safe from the guard-level race above —
    // see the mitigation note and docs/backlog.md.
    rmSync(p, { force: true });
    return true;
  } finally {
    if (guardFd !== undefined) closeSync(guardFd);
    rmSync(guard, { force: true });
  }
}
