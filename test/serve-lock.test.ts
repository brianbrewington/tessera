// The advisory ingest lock (design §9). Two reviewers found it one-sided — only `serve` took it, so the
// mutual exclusion was documented and not implemented — and check-then-create rather than atomic.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireIngestLock, lockPath, reclaimGuardPath, LockHeld, LOCK_STALE_MS } from "../src/serve/lock.js";

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

  it("a stale handle cannot free a LATER lock taken by the same process in the same millisecond", () => {
    // This test broke the moment ownership checking arrived, and it was right to: the first ownership check
    // keyed on (pid, at), and two acquisitions in one process within one millisecond are identical — so a
    // stale release handle could delete the live lock. LockInfo now carries a per-acquisition token.
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

describe("RECLAIM is atomic, and release checks ownership (Fable round 2, HIGH)", () => {
  it("release does NOT delete a lock it no longer owns", () => {
    // Confirmed broken by execution before the fix: unconditional rmSync deleted whoever's lock was there.
    const d = mk();
    const releaseA = acquireIngestLock(d, "A");
    writeFileSync(lockPath(d), JSON.stringify({ pid: 424242, at: Date.now(), what: "B" }));
    releaseA();
    expect(existsSync(lockPath(d))).toBe(true); // B's lock survived
  });

  it("an unreadable ANCIENT lock is reclaimed — a crash must not wedge ingest forever", () => {
    // The previous code said "stale-if-old, never free" in a comment and implemented "held forever":
    // readLock returns null, and the reclaim test was pure existence with no age check. An empty lock file
    // is reachable by a crash between create and write, so this wedged every future ingest permanently.
    const d = mk();
    writeFileSync(lockPath(d), "");
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(lockPath(d), old, old);
    expect(() => acquireIngestLock(d, "next")).not.toThrow();
  });

  it("an unreadable FRESH lock is still held — a torn write is not an invitation", () => {
    const d = mk();
    writeFileSync(lockPath(d), "");
    expect(() => acquireIngestLock(d, "next")).toThrow(LockHeld);
  });

  it("contended reclaim: one winner (SMOKE — cannot detect the bug it was written for)", async () => {
    // HONEST LABEL. A reviewer reverted reclaim to check-then-delete and ran this exact race four times:
    // winners=1 every time. npx/tsx startup jitter is hundreds of ms; the read-overlap window is sub-ms, so
    // the schedule almost never lands inside it. My own mutation table claimed this test "caught" that
    // revert — it did not; a different test in the same file failed and I attributed the catch here.
    // It is kept as a smoke test that concurrent acquisition does not blow up. The property is guarded
    // deterministically by the reclaim-guard tests below.
    // The race the rename fixes: two processes starting against the same dead-holder lock could each read
    // the stale info, and the second could delete the FIRST's fresh lock and take one of its own — both
    // holding it. The 8-process test never caught this because it always started from an empty directory,
    // so the reclaim path was never contended.
    const { spawn } = await import("node:child_process");
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 999_999, at: Date.now(), what: "crashed holder" }));
    const probe = join(d, "probe.mjs");
    writeFileSync(
      probe,
      `import { acquireIngestLock } from "${join(process.cwd(), "src/serve/lock.ts").replace(/\\/g, "/")}";
       try { acquireIngestLock(${JSON.stringify(d)}, "racer"); console.log("WON"); } catch { console.log("lost"); }
       await new Promise(r => setTimeout(r, 4000));`,
    );
    const out = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<string>((resolve) => {
          const c = spawn("npx", ["tsx", probe], { cwd: process.cwd() });
          let o = "";
          c.stdout.on("data", (b) => (o += b.toString()));
          c.on("close", () => resolve(o));
          c.on("error", () => resolve("lost"));
        }),
      ),
    );
    expect(out.filter((r) => r.includes("WON")).length).toBe(1);
  }, 180_000);
});

describe("the CALL SITES take the lock — not just the lock module (Fable round 2, HIGH)", () => {
  it("`tessera ingest` REFUSES while the lock is held (blocked half only — see note)", async () => {
    // Renamed: the previous name promised "and proceeds once released", but the fixture directory is deleted
    // right after release, so the unblocked run never happened. Only the blocked half is asserted.
    // Nothing proved anyone invoked acquireIngestLock: deleting it from scripts/cli.ts or scripts/serve.ts
    // left every test green, silently reverting round 1's mutual-exclusion fix. This is the call-site test.
    const { execFileSync } = await import("node:child_process");
    const graphName = "__lock_callsite__";
    const dir = join(process.cwd(), "graphs", graphName);
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const { GraphStore } = await import("../src/store/graphStore.js");
    const { StubEmbedder } = await import("../src/embedder.js");
    const st = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    st.close();

    const doc = join(dir, "note.md");
    writeFileSync(doc, "# hello\n\nsome text\n");
    // NOT --dry-run: that path returns before the lock is taken, correctly, because it writes nothing.
    // (First version of this test used it and proved nothing — the CLI "succeeded" while the lock was held.)
    // A real ingest is gated by the lock BEFORE any LLM call, so the blocked case is fast and needs no Ollama.
    const run = (): { code: number; out: string } => {
      try {
        return { code: 0, out: execFileSync("npx", ["tsx", "scripts/cli.ts", "ingest", graphName, doc], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 30_000 }) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    };

    const release = acquireIngestLock(dir, "test holder");
    const blocked = run();
    release();
    rmSync(dir, { recursive: true, force: true });

    // This is the call-site proof: delete acquireIngestLock from scripts/cli.ts and this fails.
    expect(blocked.code).not.toBe(0);
    expect(blocked.out).toMatch(/another tessera process is writing this graph/);
    expect(blocked.out).toMatch(/test holder/); // and it names WHO holds it
  }, 180_000);
});

describe("RECLAIM is exclusive, deterministically (Fable round 3, HIGH)", () => {
  it("a live reclaim-in-progress makes a rival report HELD, not steal", () => {
    // The demonstrated hole: rename is atomic but is not bound to the snapshot that justified it, so a rival
    // completing its whole reclaim inside your read->rename gap left BOTH holding the lock. This is the
    // deterministic version of that race: the guard file IS the rival's in-progress reclaim, so no scheduling
    // luck is required to observe the behaviour — which is the point. Making the mechanism explicit made the
    // property testable, where the timing-based test could not be.
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 999_999, at: Date.now(), what: "dead holder" }));
    writeFileSync(reclaimGuardPath(d), ""); // a rival is mid-reclaim
    expect(() => acquireIngestLock(d, "rival")).toThrow(LockHeld);
    expect(existsSync(lockPath(d))).toBe(true); // and it did NOT delete the lock being reclaimed
  });

  it("a STALE reclaim guard (crash mid-reclaim) does not wedge reclaim forever", () => {
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 999_999, at: Date.now(), what: "dead" }));
    writeFileSync(reclaimGuardPath(d), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(reclaimGuardPath(d), old, old);
    expect(() => acquireIngestLock(d, "next")).not.toThrow();
  });

  it("the guard is always cleaned up, on both the reclaim and no-reclaim paths", () => {
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 999_999, at: Date.now(), what: "dead" }));
    const rel = acquireIngestLock(d, "winner");
    expect(existsSync(reclaimGuardPath(d))).toBe(false); // reclaimed, guard removed
    rel();
    const d2 = mk();
    writeFileSync(lockPath(d2), JSON.stringify({ pid: process.pid, at: Date.now(), what: "live" }));
    expect(() => acquireIngestLock(d2, "x")).toThrow(LockHeld); // no reclaim happened
    expect(existsSync(reclaimGuardPath(d2))).toBe(false); // and the guard still got cleaned up
  });
});

describe("BOTH call sites take the lock (Fable round 4 — only one was tested)", () => {
  it("`tessera serve`'s drop path refuses when the lock is held", async () => {
    // Round 2 named BOTH call sites; the test I wrote covered only the CLI one, so unwiring
    // scripts/serve.ts left all 244 tests green — half of round 1's original defect could silently revert,
    // in the exact place the class was named. This is the other half.
    const { createTesseraServer } = await import("../src/serve/server.js");
    const { serveDeps } = await import("../scripts/serve.js");
    const d = mk();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(d, { recursive: true });
    const { GraphStore } = await import("../src/store/graphStore.js");
    const { StubEmbedder } = await import("../src/embedder.js");
    new GraphStore({ path: join(d, "graph.db"), embedder: new StubEmbedder(768) }).close();

    const deps = serveDeps({ name: "x", port: 7911, graphDir: d, db: join(d, "graph.db") });
    const release = acquireIngestLock(d, "someone else");
    await expect(deps.ingest(join(d, "nope.md"), { title: "n.md", source: "drop:n.md" }, () => {}))
      .rejects.toThrow(/another tessera process is writing this graph/);
    release();
  }, 60_000);
});

describe("a live process owned by ANOTHER user is not 'dead' (Fable round 4)", () => {
  it("EPERM from kill(pid,0) means alive, not gone", () => {
    // kill(pid, 0) throws EPERM when the pid EXISTS but belongs to another uid. A bare catch read that as
    // dead and stole the live lock — verified against pid 1 (init), which is maximally alive. Reachable
    // whenever serve and ingest run as different users on one graph dir.
    const d = mk();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 1, at: Date.now(), what: "init (another uid)", token: "t" }));
    let threwEperm = false;
    try { process.kill(1, 0); } catch (e) { threwEperm = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (!threwEperm) return; // running as root: kill(1,0) succeeds and the case is unreachable here
    expect(() => acquireIngestLock(d, "thief")).toThrow(LockHeld);
    expect(existsSync(lockPath(d))).toBe(true); // the live process's lock survived
  });
});
