// The advisory ingest lock (design §9). Two reviewers found it one-sided — only `serve` took it, so the
// mutual exclusion was documented and not implemented — and check-then-create rather than atomic.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireIngestLock, lockPath, LockHeld, LOCK_STALE_MS } from "../src/serve/lock.js";

const dirs: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), "tessera-lock-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("acquireIngestLock", () => {
  it("excludes a second holder and releases cleanly", () => {
    const d = mk();
    const release = acquireIngestLock(d, "first");
    expect(existsSync(lockPath(d))).toBe(true);
    expect(() => acquireIngestLock(d, "second")).toThrow(LockHeld);
    release();
    expect(existsSync(lockPath(d))).toBe(false);
    expect(() => acquireIngestLock(d, "third")).not.toThrow(); // reusable after release
  });

  it("names the holder so the message is actionable", () => {
    const d = mk();
    acquireIngestLock(d, "serve drop notes.md");
    try {
      acquireIngestLock(d, "cli ingest");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/serve drop notes\.md/);
      expect((e as Error).message).toMatch(new RegExp(String(process.pid)));
    }
  });

  it("release is idempotent — calling it twice cannot free someone else's lock", () => {
    const d = mk();
    const release = acquireIngestLock(d, "a");
    release();
    const other = acquireIngestLock(d, "b");
    release(); // stale handle, must be a no-op
    expect(existsSync(lockPath(d))).toBe(true); // b still holds it
    other();
  });

  it("reclaims a lock whose holder process is GONE — a crash must not block for six hours", () => {
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 999_999, at: Date.now(), what: "crashed" }));
    expect(() => acquireIngestLock(d, "next")).not.toThrow();
  });

  it("reclaims an ancient lock even if the pid happens to be alive", () => {
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000, what: "old" }));
    expect(() => acquireIngestLock(d, "next")).not.toThrow();
  });

  it("does NOT reclaim a fresh lock held by a live process", () => {
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, at: Date.now(), what: "live" }));
    expect(() => acquireIngestLock(d, "next")).toThrow(LockHeld);
  });

  it("treats a torn/unreadable lock file as HELD, never as free", () => {
    // Two writers on one graph is worse than a stuck lock, so a corrupt file must not be read as "available".
    const d = mk();
    writeFileSync(lockPath(d), "{not json");
    expect(() => acquireIngestLock(d, "next")).toThrow(LockHeld);
  });
});

describe("atomicity under a REAL race (mutation-testing found this untested)", () => {
  it("eight CONCURRENT processes contend; exactly ONE wins", async () => {
    // A single-threaded test cannot tell openSync(path,'wx') from existsSync-then-write — both look
    // identical in one process — so reverting to check-then-create left every other lock test green.
    //
    // First attempt at this test was also wrong: execFileSync BLOCKS, so Promise.all over it ran the probes
    // sequentially, each previous holder was already dead, and the dead-holder reclaim correctly let all
    // eight win. spawn() is what actually races them.
    const { spawn } = await import("node:child_process");
    const { writeFileSync: wf } = await import("node:fs");
    const d = mk();
    const probe = join(d, "probe.mjs");
    wf(
      probe,
      `import { acquireIngestLock } from "${join(process.cwd(), "src/serve/lock.ts").replace(/\\/g, "/")}";
       try { acquireIngestLock(${JSON.stringify(d)}, "racer " + process.pid); console.log("WON"); }
       catch { console.log("lost"); }
       await new Promise(r => setTimeout(r, 1500));`, // hold it, so the losers really are contending
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<string>((resolve) => {
          const c = spawn("npx", ["tsx", probe], { cwd: process.cwd() });
          let out = "";
          c.stdout.on("data", (b) => (out += b.toString()));
          c.on("close", () => resolve(out));
          c.on("error", () => resolve("lost"));
        }),
      ),
    );
    const winners = results.filter((r) => r.includes("WON")).length;
    expect(winners).toBe(1);
  }, 180_000);

  it("uses an ATOMIC create — asserted in the source, because the race cannot be reliably lost", () => {
    // Honest label: a tripwire, not a behavioural test. Mutation-testing shows that reverting to
    // existsSync-then-write leaves even the 8-process race green — process startup jitter means the
    // microsecond window between check and write is almost never hit. So the concurrent test proves the
    // lock EXCLUDES, but cannot prove it does so atomically.
    //
    // Some races are not reliably testable. Saying so beats a test that passes for the wrong reason: the
    // guarantee here rests on `wx` being correct by construction, and this catches its silent removal.
    const src = readFileSync(join(process.cwd(), "src/serve/lock.ts"), "utf8");
    expect(src).toMatch(/openSync\(p, "wx"\)/);
    expect(src).not.toMatch(/if \(existsSync\(p\)\)[\s\S]{0,80}openSync\(p, "w"\)/);
  });
});
