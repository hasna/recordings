import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstallerEnvironment,
  resolveInstallBunExecutable,
  validateBunExecutable,
} from "../lib/bun-runtime.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("validateBunExecutable", () => {
  test("rejects relative, missing, directory, and non-executable paths", () => {
    const directory = join(tmpdir(), `recordings-bun-validation-${process.pid}-${Date.now()}`);
    const file = join(directory, "not-executable");
    temporaryPaths.push(directory);
    mkdirSync(directory);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o600);

    expect(validateBunExecutable("bun")).toEqual({ reason: "path is not absolute" });
    expect(validateBunExecutable(join(directory, "missing"))).toEqual({
      reason: "path is missing, inaccessible, or not executable",
    });
    expect(validateBunExecutable(directory)).toEqual({
      reason: "resolved path is not a regular file",
    });
    expect(validateBunExecutable(file)).toEqual({
      reason: "path is missing, inaccessible, or not executable",
    });
  });

  test("rejects an executable that does not behave as Bun", () => {
    expect(validateBunExecutable("/bin/sh")).toEqual({
      reason: "behavioral Bun -e probe failed",
    });
  });

  test("accepts the active Bun interpreter and reports its version", () => {
    const result = validateBunExecutable(process.execPath);

    expect(result).toEqual({
      executable: process.execPath,
      version: Bun.version,
    });
  });
});

describe("resolveInstallBunExecutable", () => {
  test("uses a validated explicit executable before the active executable", () => {
    expect(resolveInstallBunExecutable(
      { RECORDINGS_BUN_EXECUTABLE: process.execPath },
      "/does/not/exist",
    )).toBe(process.execPath);
  });

  test("uses the active interpreter when no explicit override is present", () => {
    expect(resolveInstallBunExecutable({}, process.execPath)).toBe(process.execPath);
  });

  test("rejects invalid explicit and active executables with actionable messages", () => {
    expect(() => resolveInstallBunExecutable(
      { RECORDINGS_BUN_EXECUTABLE: "bun" },
      process.execPath,
    )).toThrow("RECORDINGS_BUN_EXECUTABLE is not a validated general Bun interpreter");
    expect(() => resolveInstallBunExecutable({}, "/does/not/exist")).toThrow(
      "active recordings executable is not a general Bun interpreter",
    );
  });
});

describe("createInstallerEnvironment", () => {
  test("allowlists installer inputs and pins locale, timezone, PATH, and Bun", () => {
    const environment = createInstallerEnvironment({
      HOME: "/Users/person",
      SSH_CONNECTION: "client server",
      RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "TEAM",
      RECORDINGS_LAUNCH_TIMEOUT_SECONDS: "8",
      RECORDINGS_LOCK_STALE_SECONDS: "9",
      RECORDINGS_MAINTENANCE_STALE_SECONDS: "10",
      RECORDINGS_READER_DRAIN_TIMEOUT_MS: "11",
      RECORDINGS_SQLITE_BUSY_TIMEOUT_MS: "12",
      BASH_ENV: "/tmp/hostile",
      NODE_OPTIONS: "--require=/tmp/hostile.js",
      PATH: "/tmp/hostile-bin",
    }, process.execPath);

    expect(environment).toEqual({
      HOME: "/Users/person",
      SSH_CONNECTION: "client server",
      RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "TEAM",
      RECORDINGS_LAUNCH_TIMEOUT_SECONDS: "8",
      RECORDINGS_LOCK_STALE_SECONDS: "9",
      RECORDINGS_MAINTENANCE_STALE_SECONDS: "10",
      RECORDINGS_READER_DRAIN_TIMEOUT_MS: "11",
      RECORDINGS_SQLITE_BUSY_TIMEOUT_MS: "12",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC0",
      RECORDINGS_BUN_EXECUTABLE: process.execPath,
    });
    expect(environment).not.toHaveProperty("BASH_ENV");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
  });

  test("does not invent absent optional variables", () => {
    expect(createInstallerEnvironment({}, process.execPath)).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC0",
      RECORDINGS_BUN_EXECUTABLE: process.execPath,
    });
  });
});
