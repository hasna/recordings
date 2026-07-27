import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readTccPermission,
  statTccPath,
  tccAuthValueLabel,
  tccDatabasePaths,
  tccQuerySql,
  type TccQueryResult,
} from "../lib/tcc-permission.js";
import { TCC_UNREADABLE_STATE, classifyPermissionState } from "../lib/capture-probe.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    // Restore traversal before removing: a 0o000 dir cannot be cleaned up.
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already permissive or already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recordings-tcc-test-"));
  tempDirs.push(dir);
  return dir;
}

const DARWIN = { platform: "darwin" as const };

function query(result: Partial<TccQueryResult>): () => TccQueryResult {
  return () => ({ status: 0, stdout: "", ...result });
}

describe("statTccPath", () => {
  test("a missing file is absent, not unreadable", () => {
    const dir = makeTempDir();

    expect(statTccPath(join(dir, "nope.db"))).toEqual({ kind: "absent" });
  });

  test("an existing file is present", () => {
    const dir = makeTempDir();
    const file = join(dir, "TCC.db");
    writeFileSync(file, "x");

    expect(statTccPath(file)).toEqual({ kind: "present" });
  });

  // THE BLOCKING BUG. `existsSync` returns false for ANY stat error, not just
  // ENOENT, so a path whose stat is refused was skipped as "absent" and the
  // exit-status fix was bypassed entirely. Forced here with a 0o000 parent
  // directory, which makes stat fail with EACCES rather than ENOENT.
  test("a file whose stat is REFUSED is unreadable, never absent", () => {
    const dir = makeTempDir();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const file = join(locked, "TCC.db");
    writeFileSync(file, "x");
    chmodSync(locked, 0o000);
    tempDirs.push(locked);

    const result = statTccPath(file);

    // Running as root defeats the permission bit; skip rather than assert a
    // falsehood about the environment.
    if (process.getuid?.() === 0) {
      expect(result.kind).toBe("present");
      return;
    }
    expect(result).toEqual({ kind: "unreadable" });
  });
});

describe("readTccPermission", () => {
  test("is unsupported off darwin", () => {
    expect(readTccPermission({ service: "kTCCServiceMicrophone", client: "c", home: "/h", platform: "linux" })).toBe(
      "unsupported"
    );
  });

  test("returns the labelled auth value when the query answers", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db"],
      stat: () => ({ kind: "present" }),
      runQuery: query({ status: 0, stdout: "2\n" }),
    });

    expect(state).toBe("allowed_identity_unverified");
    expect(classifyPermissionState(state)).toBe("requested");
  });

  // CASE B: open() refused, stat fine. sqlite3 exits non-zero with empty stdout.
  test("a non-zero query exit is unreadable, not never-asked", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db"],
      stat: () => ({ kind: "present" }),
      runQuery: query({ status: 1, stdout: "" }),
    });

    expect(state).toBe(TCC_UNREADABLE_STATE);
    expect(classifyPermissionState(state)).toBe("unknown");
  });

  // CASE C: stat() itself refused. This is the path the previous fix missed, and
  // the one that let the false "no TCC entry exists" line keep shipping.
  test("a refused stat is unreadable, NOT never-asked", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db"],
      stat: () => ({ kind: "unreadable" }),
      runQuery: query({ status: 0, stdout: "2\n" }),
    });

    expect(state).toBe(TCC_UNREADABLE_STATE);
    // Must be unknown. Mapping this to never_requested is what produced the
    // "no TCC entry exists" assertion on a machine that had the grant.
    expect(classifyPermissionState(state)).toBe("unknown");
    expect(classifyPermissionState(state)).not.toBe("never_requested");
  });

  test("a failure to spawn sqlite3 at all is unreadable", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db"],
      stat: () => ({ kind: "present" }),
      runQuery: () => ({ status: null, stdout: "", failedToSpawn: true }),
    });

    expect(state).toBe(TCC_UNREADABLE_STATE);
  });

  // Only this combination may claim the app never asked.
  test("not_determined requires every database reachable and empty", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db", "/fake/system/TCC.db"],
      stat: () => ({ kind: "present" }),
      runQuery: query({ status: 0, stdout: "" }),
    });

    expect(state).toBe("not_determined");
    expect(classifyPermissionState(state)).toBe("never_requested");
  });

  test("an absent database does not by itself make the answer unreadable", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db", "/fake/system/TCC.db"],
      stat: (path) => (path.includes("system") ? { kind: "absent" } : { kind: "present" }),
      runQuery: query({ status: 0, stdout: "" }),
    });

    expect(state).toBe("not_determined");
  });

  // A definite answer from any database beats an earlier refusal: the row exists.
  test("a real value from the second database wins over a refused first", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db", "/fake/system/TCC.db"],
      stat: (path) => (path.includes("user") ? { kind: "unreadable" } : { kind: "present" }),
      runQuery: query({ status: 0, stdout: "0\n" }),
    });

    expect(state).toBe("denied_identity_unverified");
    expect(classifyPermissionState(state)).toBe("requested");
  });

  test("a refused SECOND database still makes an empty first unreadable", () => {
    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: ["/fake/user/TCC.db", "/fake/system/TCC.db"],
      stat: (path) => (path.includes("system") ? { kind: "unreadable" } : { kind: "present" }),
      runQuery: query({ status: 0, stdout: "" }),
    });

    expect(state).toBe(TCC_UNREADABLE_STATE);
  });

  // End-to-end through the real statSync, with no injected stat: a 0o000 parent
  // must not be reported as "the app never asked".
  test("through the real filesystem, an unstattable path is not never-asked", () => {
    const dir = makeTempDir();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "TCC.db"), "x");
    chmodSync(locked, 0o000);
    tempDirs.push(locked);

    if (process.getuid?.() === 0) return; // root defeats the permission bit

    const state = readTccPermission({
      ...DARWIN,
      service: "kTCCServiceMicrophone",
      client: "com.hasna.recordings",
      home: "/h",
      paths: [join(locked, "TCC.db")],
      runQuery: query({ status: 0, stdout: "" }),
    });

    expect(state).toBe(TCC_UNREADABLE_STATE);
    expect(classifyPermissionState(state)).not.toBe("never_requested");
  });
});

describe("tcc query construction", () => {
  test("escapes single quotes in both the service and the client", () => {
    const sql = tccQuerySql("kTCC'Service", "com.hasna'recordings");

    expect(sql).toContain("kTCC''Service");
    expect(sql).toContain("com.hasna''recordings");
  });

  test("consults the user database before the system one", () => {
    const paths = tccDatabasePaths("/Users/example");

    // Microphone lives in the USER database, so its absence there is meaningful
    // only if that database is read first.
    expect(paths[0]).toBe("/Users/example/Library/Application Support/com.apple.TCC/TCC.db");
    expect(paths[1]).toBe("/Library/Application Support/com.apple.TCC/TCC.db");
  });

  test("labels every documented auth value and flags unexpected ones", () => {
    expect(tccAuthValueLabel("0")).toBe("denied");
    expect(tccAuthValueLabel("1")).toBe("unknown");
    expect(tccAuthValueLabel("2")).toBe("allowed");
    expect(tccAuthValueLabel("3")).toBe("limited");
    expect(tccAuthValueLabel("7")).toBe("unknown(7)");
  });
});
