import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLocalStoreReaderLease,
  withLocalStoreReaderLease,
} from "../lib/install-maintenance.js";

const repositoryRoot = resolve(import.meta.dir, "../..");
const installer = join(repositoryRoot, "scripts", "install_macos_app.sh");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function normalizedProcessStart(locale: string, pid = process.pid): string {
  try {
    const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: locale, LANG: locale, TZ: "UTC0" },
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return "";
    return result.stdout.toString().trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

function localizedProcessStartLocale(): string | null {
  let locales: ReturnType<typeof Bun.spawnSync>;
  try {
    locales = Bun.spawnSync(["/usr/bin/locale", "-a"], {
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  if (locales.exitCode !== 0) return null;
  const baseline = normalizedProcessStart("C");
  if (!baseline) return null;
  for (const locale of locales.stdout.toString().split(/\r?\n/)) {
    if (!/^(?:de|es|fr|it|ja|ko|pt|ru|zh)(?:_|\.)/i.test(locale)) continue;
    const localized = normalizedProcessStart(locale);
    if (localized && localized !== baseline) return locale;
  }
  return null;
}

const nonEnglishProcessLocale = localizedProcessStartLocale();
const testWithLocalizedProcessStart = nonEnglishProcessLocale ? test : test.skip;

function createEarlyInstallerFixture() {
  const root = temporaryDirectory("recordings-maintenance-installer-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const artifact = join(root, "Recordings.zip");
  const manifest = join(root, "Recordings.manifest.json");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(artifact, "fixture");
  writeFileSync(manifest, "{}\n");
  writeExecutable(
    join(bin, "uname"),
    "#!/usr/bin/env bash\nif [ \"${1:-}\" = -m ]; then printf 'arm64\\n'; else printf 'Darwin\\n'; fi\n",
  );
  writeExecutable(
    join(bin, "hostname"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"${FIXTURE_HOSTNAME:-station02}\"\n",
  );
  writeExecutable(
    join(bin, "stat"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -f ]; then
  format="\${2:-}"
  path="\${3:-}"
  case "$format" in
    %u) exec /usr/bin/stat -c '%u' "$path" ;;
    %Lp) exec /usr/bin/stat -c '%a' "$path" ;;
    %m) exec /usr/bin/stat -c '%Y' "$path" ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
  );
  writeExecutable(
    join(bin, "ls"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = -lde ]; then
  printf 'drwx------ fixture\\n'
  exit 0
fi
exec /usr/bin/ls "$@"
`,
  );
  // The fixture intentionally fails at the first artifact-tool call, after
  // lock + marker acquisition but before any app or state snapshot mutation.
  writeExecutable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
case "$*" in
  *" native-fs-guard-check") exit 0 ;;
  *" fsync-tree "*|*" fsync-directory "*) exec "$REAL_BUN" "$@" ;;
esac
exit 79
`,
  );
  writeExecutable(join(bin, "noop"), "#!/usr/bin/env bash\nexit 0\n");
  return {
    root,
    home,
    bin,
    artifact,
    manifest,
    lock: join(home, "Applications", ".Recordings-install-lock"),
    marker: join(home, ".hasna", ".recordings-install-maintenance"),
  };
}

function installerArguments(fixture: ReturnType<typeof createEarlyInstallerFixture>): string[] {
  return [
    "bash",
    installer,
    "--artifact",
    fixture.artifact,
    "--manifest",
    fixture.manifest,
    "--expected-team-id",
    "EXAMPLE123",
    "--manifest-sha256",
    "a".repeat(64),
    "--expected-source-sha",
    "b".repeat(40),
    "--expected-version",
    "0.2.13",
  ];
}

function installerEnvironment(
  fixture: ReturnType<typeof createEarlyInstallerFixture>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: fixture.home,
    PATH: `${fixture.bin}:/usr/bin:/bin`,
    RECORDINGS_BUN_EXECUTABLE: join(fixture.bin, "bun"),
    REAL_BUN: process.execPath,
    RECORDINGS_TEST_INSTALL_CODESIGN_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_DITTO_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_HOSTNAME_EXECUTABLE: join(fixture.bin, "hostname"),
    RECORDINGS_TEST_INSTALL_IOREG_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_LS_EXECUTABLE: join(fixture.bin, "ls"),
    RECORDINGS_TEST_INSTALL_LSOF_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_MDFIND_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_SPCTL_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_SQLITE3_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_STAT_EXECUTABLE: join(fixture.bin, "stat"),
    RECORDINGS_TEST_INSTALL_SW_VERS_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_SYSPOLICY_CHECK_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE: join(fixture.bin, "uname"),
    RECORDINGS_TEST_INSTALL_XCRUN_EXECUTABLE: join(fixture.bin, "noop"),
    RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
    ...extra,
  };
}

async function runEarlyInstaller(
  fixture: ReturnType<typeof createEarlyInstallerFixture>,
  extraArguments: string[] = [],
  extraEnvironment: Record<string, string> = {},
) {
  const child = Bun.spawn([...installerArguments(fixture), ...extraArguments], {
    env: installerEnvironment(fixture, extraEnvironment),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

describe("local Store installation maintenance gate", () => {
  test("publishes a synchronous lease before returning and blocks followers once maintenance appears", () => {
    const root = temporaryDirectory("recordings-maintenance-sync-lease-");
    const home = join(root, "home");
    const readers = join(home, ".hasna", ".recordings-store-readers");
    const marker = join(home, ".hasna", ".recordings-install-maintenance");
    const environment = { HOME: home };

    const release = acquireLocalStoreReaderLease(environment);
    expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);

    mkdirSync(marker, { mode: 0o700 });
    expect(() => acquireLocalStoreReaderLease(environment)).toThrow("installation maintenance");
    expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(1);

    release();
    release();
    expect(readdirSync(readers).filter((entry) => entry.startsWith("lease-"))).toHaveLength(0);
  });

  test("every local operation fails while the marker exists and cloud HTTP remains available", async () => {
    const root = temporaryDirectory("recordings-maintenance-store-");
    const home = join(root, "home");
    const marker = join(home, ".hasna", ".recordings-install-maintenance");
    const probe = join(root, "probe.ts");
    mkdirSync(marker, { recursive: true, mode: 0o700 });
    const storeUrl = pathToFileURL(join(repositoryRoot, "src", "store.ts")).href;
    writeFileSync(
      probe,
      `import { getStore } from ${JSON.stringify(storeUrl)};
const local = getStore({});
const operations = [
  () => local.createRecording({ raw_text: "fixture" }),
  () => local.getRecording("missing"),
  () => local.listRecordings(),
  () => local.countRecordings?.(),
  () => local.searchRecordings("fixture"),
  () => local.deleteRecording("missing"),
  () => local.getRecordingStats(),
  () => local.registerAgent("fixture"),
  () => local.getAgent("fixture"),
  () => local.listAgents(),
  () => local.heartbeatAgent("fixture"),
  () => local.setAgentFocus("fixture", null),
  () => local.registerProject("fixture", "/fixture"),
  () => local.getProject("/fixture"),
  () => local.listProjects(),
  () => local.saveFeedback({ message: "fixture" }),
];
let blocked = 0;
for (const operation of operations) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes("installation maintenance")) blocked += 1;
  }
}
globalThis.fetch = async () => new Response(JSON.stringify({ agents: [] }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const cloud = getStore({
  HASNA_RECORDINGS_STORAGE_MODE: "cloud",
  HASNA_RECORDINGS_API_URL: "https://recordings.invalid/v1",
  HASNA_RECORDINGS_API_KEY: "fixture-only",
});
const agents = await cloud.listAgents();
console.log(JSON.stringify({ blocked, cloudMode: cloud.mode, cloudCount: agents.length }));
`,
    );
    const child = Bun.spawn([process.execPath, probe], {
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ blocked: 16, cloudMode: "cloud-http", cloudCount: 0 });
  });
});

describe("installer maintenance marker", () => {
  test("rejects an expected-hostname mismatch before lock or state mutation", async () => {
    const fixture = createEarlyInstallerFixture();
    const result = await runEarlyInstaller(fixture, ["--expected-hostname", "station03"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match the expected hostname");
    expect(existsSync(fixture.lock)).toBeFalse();
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
  });

  test("releases the marker on ordinary failure after acquisition", async () => {
    const fixture = createEarlyInstallerFixture();
    const result = await runEarlyInstaller(fixture, ["--expected-hostname", "station02"]);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(fixture.marker)).toBeFalse();
    expect(existsSync(fixture.lock)).toBeFalse();
  });

  test("leaves the marker after a crash and the next lock owner safely reclaims it", async () => {
    const fixture = createEarlyInstallerFixture();
    const crashed = Bun.spawn(installerArguments(fixture), {
      env: installerEnvironment(fixture, { RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS: "30" }),
      stdout: "ignore",
      stderr: "ignore",
    });
    const owner = join(fixture.marker, "owner");
    for (let attempt = 0; attempt < 200 && !existsSync(owner); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(owner)).toBeTrue();
    crashed.kill(9);
    await crashed.exited;
    expect(existsSync(fixture.marker)).toBeTrue();

    const recovered = await runEarlyInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).not.toContain("active installation maintenance");
    expect(existsSync(fixture.marker)).toBeFalse();
    expect(existsSync(fixture.lock)).toBeFalse();
  });

  test.each(["before-rename", "after-rename"])(
    "never publishes ownerless maintenance at the %s crash boundary",
    async (boundary) => {
      const fixture = createEarlyInstallerFixture();
      const crashed = await runEarlyInstaller(fixture, [], {
        RECORDINGS_TEST_CRASH_DURING_MAINTENANCE_CLAIM: boundary,
      });
      expect(crashed.exitCode).not.toBe(0);
      if (existsSync(fixture.marker)) {
        expect(existsSync(join(fixture.marker, "owner"))).toBeTrue();
      }
      const recovered = await runEarlyInstaller(fixture);
      expect(recovered.stderr).not.toContain("incomplete ownership evidence");
      expect(existsSync(fixture.marker)).toBeFalse();
    },
  );

  test("waits for a complete reader operation before artifact verification", async () => {
    const fixture = createEarlyInstallerFixture();
    let releaseOperation!: () => void;
    const operation = withLocalStoreReaderLease(
      () => new Promise<void>((resolve) => { releaseOperation = resolve; }),
      { HOME: fixture.home },
    );
    const readers = join(fixture.home, ".hasna", ".recordings-store-readers");
    for (let attempt = 0; attempt < 200 &&
      (!existsSync(readers) || !readdirSync(readers).some((entry) => entry.startsWith("lease-")));
      attempt += 1) await Bun.sleep(10);

    const child = Bun.spawn(installerArguments(fixture), {
      env: installerEnvironment(fixture),
      stdout: "ignore",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 200 && !existsSync(fixture.marker); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(fixture.marker)).toBeTrue();
    await Bun.sleep(100);
    expect(child.exitCode).toBeNull();

    releaseOperation();
    await operation;
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(79);
    expect(stderr).not.toContain("Timed out waiting");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  testWithLocalizedProcessStart(
    "keeps a live reader lease created under a localized process environment",
    async () => {
      const fixture = createEarlyInstallerFixture();
      const probe = join(fixture.root, "localized-reader.ts");
      const moduleUrl = pathToFileURL(
        join(repositoryRoot, "src", "lib", "install-maintenance.ts"),
      ).href;
      writeFileSync(
        probe,
        `import { acquireLocalStoreReaderLease } from ${JSON.stringify(moduleUrl)};
const release = acquireLocalStoreReaderLease({ HOME: process.env.HOME });
process.on("SIGTERM", () => { release(); process.exit(0); });
process.stdout.write("ready\\n");
await new Promise(() => {});
`,
      );
      const reader = Bun.spawn([process.execPath, probe], {
        env: {
          HOME: fixture.home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LC_ALL: nonEnglishProcessLocale!,
          LANG: nonEnglishProcessLocale!,
          TZ: "America/Los_Angeles",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const readerReady = new Response(reader.stdout).text();
      const readers = join(fixture.home, ".hasna", ".recordings-store-readers");
      for (let attempt = 0; attempt < 200 &&
        (!existsSync(readers) || !readdirSync(readers).some((entry) => entry.startsWith("lease-")));
        attempt += 1) await Bun.sleep(10);
      expect(existsSync(readers)).toBeTrue();
      const lease = readdirSync(readers).find((entry) => entry.startsWith("lease-"));
      expect(lease).toBeDefined();
      const owner = readFileSync(join(readers, lease!, "owner"), "utf8").trim().split("\n");
      const cIdentity = normalizedProcessStart("C", reader.pid);
      const localizedIdentity = normalizedProcessStart(nonEnglishProcessLocale!, reader.pid);
      expect(owner).toEqual([String(reader.pid), cIdentity]);
      expect(localizedIdentity).not.toBe(cIdentity);

      const child = Bun.spawn(installerArguments(fixture), {
        env: installerEnvironment(fixture, { LC_ALL: "C", LANG: "C", TZ: "UTC0" }),
        stdout: "ignore",
        stderr: "pipe",
      });
      for (let attempt = 0; attempt < 200 && !existsSync(fixture.marker); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(fixture.marker)).toBeTrue();
      await Bun.sleep(100);
      expect(child.exitCode).toBeNull();
      expect(readdirSync(readers).some((entry) => entry.startsWith("lease-"))).toBeTrue();

      reader.kill("SIGTERM");
      const [readerExit, readerStdout, exitCode, stderr] = await Promise.all([
        reader.exited,
        readerReady,
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(readerExit, readerStdout).toBe(0);
      expect(readerStdout).toContain("ready");
      expect(exitCode, stderr).toBe(79);
      expect(stderr).not.toContain("Timed out waiting");
      expect(existsSync(fixture.marker)).toBeFalse();
    },
  );

  test("orders exclusivity before recovery and the authoritative stopped-state copy", () => {
    const source = readFileSync(installer, "utf8");
    const acquired = source.indexOf("acquire_maintenance_marker\n", source.indexOf("trap release_install_coordination"));
    const drained = source.indexOf("drain_store_reader_leases\n", acquired);
    const recovered = source.indexOf('if [ -f "$JOURNAL_PATH" ]', acquired);
    const recoveryBarrier = source.indexOf("acquire_sqlite_barrier\n", acquired);
    const initialCopy = source.indexOf('"$DITTO_EXECUTABLE" "$DATA_DIR" "$STATE_BACKUP"');
    const initialBarrier = source.lastIndexOf("acquire_sqlite_barrier\n", initialCopy);
    const prepared = source.indexOf("write_journal prepared", initialCopy);
    const stoppedApps = source.indexOf("stop_old_processes\n", prepared);
    const stoppedCopy = source.indexOf('"$DITTO_EXECUTABLE" "$DATA_DIR" "$NEXT_STATE_BACKUP"', stoppedApps);
    const stoppedBarrier = source.lastIndexOf("acquire_sqlite_barrier\n", stoppedCopy);
    const stoppedJournal = source.indexOf("write_journal processes-stopped", stoppedCopy);
    expect(acquired).toBeGreaterThan(0);
    expect(drained).toBeGreaterThan(acquired);
    expect(drained).toBeLessThan(recoveryBarrier);
    expect(recoveryBarrier).toBeGreaterThan(acquired);
    expect(recoveryBarrier).toBeLessThan(recovered);
    expect(initialBarrier).toBeGreaterThan(recovered);
    expect(initialBarrier).toBeLessThan(initialCopy);
    expect(prepared).toBeGreaterThan(initialCopy);
    expect(stoppedApps).toBeGreaterThan(prepared);
    expect(stoppedBarrier).toBeGreaterThan(stoppedApps);
    expect(stoppedBarrier).toBeLessThan(stoppedCopy);
    expect(stoppedJournal).toBeGreaterThan(stoppedCopy);
    expect(source.indexOf("stop_old_processes\n", stoppedBarrier)).toBeLessThan(stoppedCopy);
    expect(source.indexOf("stop_old_processes\n", stoppedCopy)).toBeGreaterThan(stoppedCopy);
    expect(source).toContain('RUNNING_EXECUTABLES+=("$existing_app/Contents/Helpers/recordings")');
    expect(source).toContain('"$SQLITE3_EXECUTABLE" -batch "$database_path"');
    expect(source).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(source).toContain("BEGIN EXCLUSIVE");
  });
});
