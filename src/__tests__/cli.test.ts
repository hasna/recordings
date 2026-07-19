import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createInstallerEnvironment,
  resolveInstallBunExecutable,
} from "../lib/bun-runtime.js";
import {
  assertExpectedReleaseHostname,
  assertReleaseOnlyOptions,
  parseLaunchTimeout,
  prepareReleaseInstallInputs,
} from "../lib/release-install-policy.js";
import { createHash } from "node:crypto";

const tempDirs: string[] = [];
const cliEntry = join(process.cwd(), "src", "cli", "index.ts");

function isolatedCliEnv(home: string, overrides: Record<string, string> = {}) {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HASNA_RECORDINGS_STORAGE_MODE: "local",
    RECORDINGS_STORAGE_MODE: "local",
    HASNA_RECORDINGS_API_URL: "",
    HASNA_RECORDINGS_API_KEY: "",
    RECORDINGS_API_URL: "",
    RECORDINGS_API_KEY: "",
    HASNA_RECORDINGS_DB_PATH: join(home, "recordings.db"),
    RECORDINGS_AUDIO_DIR: join(home, "audio"),
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("recordings CLI", () => {
  test("command failures print a clean ERROR line instead of a stack trace", async () => {
    const home = join(tmpdir(), `open-recordings-cli-err-${Date.now()}`);
    tempDirs.push(home);

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "transcribe", "/nonexistent/audio.wav", "--no-enhance"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENAI_API_KEY: "sk-test-invalid",
          RECORDINGS_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain("ERROR:");
    expect(combined).not.toContain("at async");
    expect(combined).not.toContain("Bun v");
  });

  test("--help omits retired client-side storage commands", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--help"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("events");
    expect(stdout).toContain("agents");
    expect(stdout).toContain("feedback");
    expect(stdout).toContain("webhooks");
    // The client-side Postgres DSN sync command is gone.
    expect(stdout).not.toContain("cloud");
    expect(stdout).not.toContain("storage");
  });

  test("agents lists via the local store (no DSN) as JSON", async () => {
    const home = join(tmpdir(), `open-recordings-cli-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });

    const proc = Bun.spawn(
      [process.execPath, cliEntry, "--json", "agents"],
      {
        cwd: home,
        env: isolatedCliEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // Fresh local store => empty agent list, proving local routing works with no API env.
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("project register returns a canonical local Store id", async () => {
    const home = join(tmpdir(), `open-recordings-cli-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const proc = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--json",
        "project",
        "register",
        "--name",
        "Desktop App",
        "--path",
        "recordings-app://projects/desktop",
      ],
      {
        cwd: home,
        env: isolatedCliEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const project = JSON.parse(stdout) as { id: string; name: string; path: string };
    expect(project.id).toHaveLength(36);
    expect(project).toMatchObject({ name: "Desktop App", path: "recordings-app://projects/desktop" });
  });

  test("--json app status reports package installer paths", async () => {
    const home = join(tmpdir(), `open-recordings-cli-app-status-${Date.now()}`);
    tempDirs.push(home);
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "app", "status"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const status = JSON.parse(stdout) as {
      package_root: string;
      installer_available: boolean;
      native_sources_available: boolean;
      installed_app_path: string;
      legacy_install_paths: string[];
      app_code_hash: string | null;
      ad_hoc_signed: boolean;
      signing_identifier: string | null;
      team_identifier: string | null;
      designated_requirement: string | null;
      signature_authorities: string[];
      microphone_permission: string;
      accessibility_permission: string;
      log_path: string;
    };
    expect(status.package_root).toBe(process.cwd());
    expect(status.installer_available).toBe(true);
    expect(status.native_sources_available).toBe(true);
    expect(status.installed_app_path).toBe(join(home, "Applications", "Recordings.app"));
    expect(status.legacy_install_paths).toEqual([]);
    expect(typeof status.ad_hoc_signed).toBe("boolean");
    expect(status.app_code_hash === null || typeof status.app_code_hash === "string").toBe(true);
    expect(typeof status.microphone_permission).toBe("string");
    expect(typeof status.accessibility_permission).toBe("string");
    expect(status.log_path).toContain(".hasna/recordings/Recordings.log");
    expect(status.signing_identifier).toBeNull();
    expect(status.team_identifier).toBeNull();
    expect(status.designated_requirement).toBeNull();
    expect(status.signature_authorities).toEqual([]);
  });

  test("app install requires finalized artifact, manifest, Team ID, and launch controls", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "app", "install", "--help"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--artifact");
    expect(stdout).toContain("--manifest");
    expect(stdout).toContain("--envelope");
    expect(stdout).toContain("--expected-team-id");
    expect(stdout).toContain("--manifest-sha256");
    expect(stdout).toContain("--expected-source-sha");
    expect(stdout).toContain("--expected-version");
    expect(stdout).toContain("--expected-hostname");
    expect(stdout).toContain("--artifact-policy");
    expect(stdout).toContain("--approved-target");
    expect(stdout).toContain("--approved-target-identity-kind");
    expect(stdout).toContain("--approved-target-identity-sha256");
    expect(stdout).toContain("--acknowledge-local-signing-and-permissions");
    expect(stdout).toContain("--expected-old-identity-sha256");
    expect(stdout).toContain("--expected-new-identity-sha256");
    expect(stdout).toContain("--allow-signing-identity-migration");
    expect(stdout).toContain("--launch");
    expect(stdout).not.toContain("--app-source");
    expect(stdout).not.toContain("--mode");
  });

  test("release install authenticates and snapshots exact manifest provenance before mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "open-recordings-release-policy-"));
    tempDirs.push(root);
    const sourceSha = "b".repeat(40);
    const manifest = {
      schema_version: 4,
      artifact_type: "recordings-macos-app",
      bundle_id: "com.hasna.recordings",
      bundle_version: "0.2.13",
      bundle_build_version: "213",
      git_sha: sourceSha,
      team_id: "EXAMPLE123",
      architectures: ["arm64", "x86_64"],
      minimum_macos: "14.0",
      binding: { bundle_tree_sha256: "c".repeat(64) },
      signing: {
        team_id: "EXAMPLE123",
        helper_team_id: "EXAMPLE123",
        designated_requirement_sha256: "d".repeat(64),
      },
      archive: { sha256: "e".repeat(64) },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const envelope = {
      payload: {
        purpose: "update",
        version: manifest.bundle_version,
        build: manifest.bundle_build_version,
        source_commit: sourceSha,
        manifest_sha256: manifestSha256,
        manifest_byte_count: manifestBytes.byteLength,
        artifact_sha256: manifest.archive.sha256,
        candidate_tree_sha256: manifest.binding.bundle_tree_sha256,
        signing_team_identifier: "EXAMPLE123",
      },
      signature: Buffer.alloc(64, 7).toString("base64"),
    };
    const envelopeBytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    const manifestPath = join(root, "release.manifest.json");
    const envelopePath = join(root, "release.envelope.json");
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(envelopePath, envelopeBytes);

    const prepared = prepareReleaseInstallInputs({
      artifactPath: join(root, "Recordings.zip"),
      manifestPath,
      envelopePath,
      manifestSha256,
      expectedSourceSha: sourceSha,
      expectedVersion: "0.2.13",
      expectedTeamId: "EXAMPLE123",
      snapshotRoot: root,
    });

    expect(prepared.manifestPath).not.toBe(manifestPath);
    expect(prepared.envelopePath).not.toBe(envelopePath);
    expect(readFileSync(prepared.manifestPath)).toEqual(manifestBytes);
    expect(readFileSync(prepared.envelopePath)).toEqual(envelopeBytes);
    prepared.cleanup();
    expect(existsSync(prepared.manifestPath)).toBeFalse();
  });

  test("release install rejects every operator constraint mismatch before snapshot creation", () => {
    const root = mkdtempSync(join(tmpdir(), "open-recordings-release-policy-reject-"));
    tempDirs.push(root);
    const sourceSha = "b".repeat(40);
    const manifest = {
      schema_version: 4,
      artifact_type: "recordings-macos-app",
      bundle_id: "com.hasna.recordings",
      bundle_version: "0.2.13",
      bundle_build_version: "213",
      git_sha: sourceSha,
      team_id: "EXAMPLE123",
      architectures: ["arm64", "x86_64"],
      minimum_macos: "14.0",
      binding: { bundle_tree_sha256: "c".repeat(64) },
      signing: {
        team_id: "EXAMPLE123",
        helper_team_id: "EXAMPLE123",
        designated_requirement_sha256: "d".repeat(64),
      },
      archive: { sha256: "e".repeat(64) },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const envelopePath = join(root, "release.envelope.json");
    const manifestPath = join(root, "release.manifest.json");
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(envelopePath, JSON.stringify({
      payload: {
        purpose: "update",
        version: manifest.bundle_version,
        build: manifest.bundle_build_version,
        source_commit: sourceSha,
        manifest_sha256: manifestSha256,
        manifest_byte_count: manifestBytes.byteLength,
        artifact_sha256: manifest.archive.sha256,
        candidate_tree_sha256: manifest.binding.bundle_tree_sha256,
        signing_team_identifier: "EXAMPLE123",
      },
      signature: Buffer.alloc(64, 7).toString("base64"),
    }));
    const base = {
      artifactPath: join(root, "Recordings.zip"),
      manifestPath,
      envelopePath,
      manifestSha256,
      expectedSourceSha: sourceSha,
      expectedVersion: "0.2.13",
      expectedTeamId: "EXAMPLE123",
      snapshotRoot: root,
    };

    expect(() => prepareReleaseInstallInputs({ ...base, manifestSha256: "A".repeat(64) }))
      .toThrow("manifest SHA-256 must be 64 lowercase hexadecimal characters");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedSourceSha: "B".repeat(40) }))
      .toThrow("source SHA must be 40 lowercase hexadecimal characters");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedVersion: "v0.2.13" }))
      .toThrow("release version is invalid");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedTeamId: "example123" }))
      .toThrow("Team ID must be 10 uppercase alphanumeric characters");
    expect(() => prepareReleaseInstallInputs({ ...base, manifestSha256: "f".repeat(64) }))
      .toThrow("manifest does not match the operator-approved SHA-256");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedSourceSha: "a".repeat(40) }))
      .toThrow("manifest source SHA does not match the operator-approved source");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedVersion: "0.2.14" }))
      .toThrow("manifest version does not match the operator-approved version");
    expect(() => prepareReleaseInstallInputs({ ...base, expectedTeamId: "EXAMPLE124" }))
      .toThrow("manifest Team ID does not match the operator-approved Team ID");

    const mismatchedEnvelope = JSON.parse(readFileSync(envelopePath, "utf8"));
    mismatchedEnvelope.payload.source_commit = "a".repeat(40);
    writeFileSync(envelopePath, JSON.stringify(mismatchedEnvelope));
    expect(() => prepareReleaseInstallInputs(base))
      .toThrow("release envelope does not match the operator-approved provenance");

    const manifestLink = join(root, "manifest-link.json");
    symlinkSync(manifestPath, manifestLink);
    expect(() => prepareReleaseInstallInputs({ ...base, manifestPath: manifestLink })).toThrow();
    expect(readdirSync(root).filter((name) => name.startsWith("recordings-release-install."))).toEqual([]);
  });

  test("release install rejects local-only and unsupported launch controls", () => {
    expect(() => assertReleaseOnlyOptions({
      approvedTarget: "station06",
      approvedTargetIdentitySha256: "none",
    })).toThrow("release installs require --approved-target fleet");
    expect(() => assertReleaseOnlyOptions({
      approvedTarget: "fleet",
      approvedTargetIdentitySha256: "a".repeat(64),
    })).toThrow("release installs reject local-only target identity controls");
    expect(() => assertReleaseOnlyOptions({
      approvedTarget: "fleet",
      approvedTargetIdentitySha256: "none",
      allowSigningIdentityMigration: true,
    })).toThrow("release installs reject local-only signing migration controls");
    expect(() => assertReleaseOnlyOptions({
      approvedTarget: "fleet",
      approvedTargetIdentitySha256: "none",
      launch: true,
    })).toThrow("release --launch is unsupported");
    expect(() => assertReleaseOnlyOptions({
      approvedTarget: "fleet",
      approvedTargetIdentitySha256: "none",
      launchTimeout: "10",
    })).toThrow("release --launch-timeout is unsupported");
  });

  test("release hostname and local launch timeout policy are exact and bounded", () => {
    expect(() => assertExpectedReleaseHostname("station02", "station02")).not.toThrow();
    expect(() => assertExpectedReleaseHostname("station02", "station03"))
      .toThrow("does not match the expected hostname");
    expect(() => assertExpectedReleaseHostname("station02.local", "station02.local"))
      .toThrow("expected hostname is invalid");
    expect(parseLaunchTimeout(undefined)).toBe("10");
    expect(parseLaunchTimeout("120")).toBe("120");
    expect(() => parseLaunchTimeout("0")).toThrow("between 1 and 120 seconds");
    expect(() => parseLaunchTimeout("1.5")).toThrow("between 1 and 120 seconds");
  });

  test("app install rejects non-macOS before inspecting artifact paths", async () => {
    if (process.platform === "darwin") return;
    const proc = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "app",
        "install",
        "--artifact",
        "/definitely/missing/Recordings.zip",
        "--manifest",
        "/definitely/missing/Recordings.manifest.json",
        "--expected-team-id",
        "EXAMPLE123",
        "--manifest-sha256",
        "a".repeat(64),
        "--expected-source-sha",
        "b".repeat(40),
        "--expected-version",
        "0.2.13",
      ],
      { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("only supported on macOS");
    expect(stderr).not.toContain("missing from package");
  });

  test("app install pins bash and forwards only a validated Bun executable", () => {
    const cli = readFileSync("src/cli/index.ts", "utf8");
    const installer = readFileSync("scripts/install_macos_app.sh", "utf8");
    const installAction = cli.slice(
      cli.indexOf('.command("install")'),
      cli.indexOf('appCommand\n  .command("status")'),
    );
    expect(cli).toContain('spawnSync("/bin/bash", installerArgs');
    expect(cli).toContain("resolveInstallBunExecutable(process.env)");
    expect(cli).toContain("createInstallerEnvironment(process.env, bunExecutable)");
    expect(installAction).toContain("getMacOSInstallerPath()");
    expect(installAction).not.toContain("getMacOSAppStatus()");
    expect(cli).toContain('spawnSync("/usr/bin/codesign"');
    expect(cli).toContain('spawnSync("/usr/bin/sqlite3"');
    expect(cli).not.toContain('key.startsWith("RECORDINGS_TEST_INSTALL_")');
    expect(cli).not.toContain('spawnSync("bash", installerArgs');
    expect(installer.startsWith("#!/bin/bash\n")).toBeTrue();
    expect(cli.indexOf('process.platform !== "darwin"')).toBeLessThan(
      cli.indexOf("resolveInstallBunExecutable(process.env)"),
    );
  });

  test("installer environment removes Bash startup injection and test overrides", () => {
    const sanitized = createInstallerEnvironment(
      {
        HOME: "/safe/home",
        PATH: "/hostile/path",
        BASH_ENV: "/hostile/bash-env",
        ENV: "/hostile/env",
        SHELLOPTS: "xtrace",
        BASHOPTS: "extdebug",
        CDPATH: "/hostile/cdpath",
        GLOBIGNORE: "*",
        BUN_OPTIONS: "--preload=/hostile/bun-preload.ts",
        NODE_OPTIONS: "--require=/hostile/node-preload.cjs",
        LD_PRELOAD: "/hostile/runtime.so",
        DYLD_INSERT_LIBRARIES: "/hostile/runtime.dylib",
        "BASH_FUNC_codesign%%": "() { printf hostile; }",
        RECORDINGS_TEST_INSTALL_CODESIGN_EXECUTABLE: "/hostile/codesign",
        RECORDINGS_API_URL: "http://127.0.0.1:9999",
        LC_ALL: "fr_FR.UTF-8",
        LANG: "de_DE.UTF-8",
        TZ: "America/Los_Angeles",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "EXAMPLE123",
        RECORDINGS_LOCK_STALE_SECONDS: "45",
      },
      "/trusted/bun",
    );

    expect(sanitized).toEqual({
      HOME: "/safe/home",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC0",
      RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "EXAMPLE123",
      RECORDINGS_LOCK_STALE_SECONDS: "45",
      RECORDINGS_BUN_EXECUTABLE: "/trusted/bun",
    });
  });

  test("installer environment pins PATH instead of forwarding caller command resolution", () => {
    const sanitized = createInstallerEnvironment(
      {
        HOME: "/safe/home",
        PATH: "/tmp/attacker-bin:/opt/unreviewed/bin",
      },
      "/trusted/bun",
    );

    expect(sanitized.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(sanitized.PATH).not.toContain("attacker-bin");
  });

  test("installer environment cannot execute ambient Bun or Node preload controls", () => {
    const root = mkdtempSync(join(tmpdir(), "open-recordings-installer-preload-"));
    tempDirs.push(root);
    const marker = join(root, "hostile-preload-ran");
    const preload = join(root, "hostile-preload.ts");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "hostile");\n`,
    );

    const environment = createInstallerEnvironment(
      {
        HOME: root,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        BUN_OPTIONS: `--preload=${preload}`,
        NODE_OPTIONS: `--require=${preload}`,
      },
      process.execPath,
    );
    const result = Bun.spawnSync(
      [
        "/bin/bash",
        "-c",
        '"$RECORDINGS_BUN_EXECUTABLE" -e \'process.stdout.write("ok")\'',
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("ok");
    expect(existsSync(marker)).toBeFalse();
  });

  test("compiled app install rejects itself as Bun and ignores a hostile PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "open-recordings-compiled-bun-"));
    tempDirs.push(root);
    const compiledCli = join(root, "recordings");
    const compile = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--reject-unresolved",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
        cliEntry,
        "--outfile",
        compiledCli,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const hostileBin = join(root, "hostile-bin");
    const hostileMarker = join(root, "hostile-bun-ran");
    mkdirSync(hostileBin);
    writeFileSync(
      join(hostileBin, "bun"),
      `#!/bin/bash\nprintf hostile > ${JSON.stringify(hostileMarker)}\nexit 91\n`,
    );
    chmodSync(join(hostileBin, "bun"), 0o755);

    const installArgs = [
      "app",
      "install",
      "--artifact",
      join(root, "missing-Recordings.zip"),
      "--manifest",
      join(root, "missing-Recordings.manifest.json"),
      "--expected-team-id",
      "EXAMPLE123",
      "--manifest-sha256",
      "a".repeat(64),
      "--expected-source-sha",
      "b".repeat(40),
      "--expected-version",
      "0.2.13",
    ];
    const baseEnvironment = (home: string) => {
      const environment = {
        ...process.env,
        HOME: home,
        PATH: `${hostileBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      };
      delete environment.RECORDINGS_BUN_EXECUTABLE;
      return environment;
    };
    const runInstall = (environment: Record<string, string | undefined>) =>
      Bun.spawnSync([compiledCli, ...installArgs], {
        cwd: process.cwd(),
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });

    const selfHome = join(root, "self-home");
    mkdirSync(selfHome);
    const selfResult = runInstall({
      ...baseEnvironment(selfHome),
      RECORDINGS_BUN_EXECUTABLE: compiledCli,
    });
    expect(selfResult.exitCode).not.toBe(0);
    expect(selfResult.stderr.toString()).toContain("only supported on macOS");
    expect(existsSync(hostileMarker)).toBeFalse();

    expect(() =>
      resolveInstallBunExecutable(
        { RECORDINGS_BUN_EXECUTABLE: compiledCli },
        compiledCli,
      ),
    ).toThrow("not a validated general Bun interpreter");
    expect(
      resolveInstallBunExecutable(
        { RECORDINGS_BUN_EXECUTABLE: process.execPath },
        compiledCli,
      ),
    ).toBe(realpathSync(process.execPath));
    expect(() => resolveInstallBunExecutable(baseEnvironment(selfHome), compiledCli)).toThrow(
      "not a general Bun interpreter",
    );
    expect(existsSync(hostileMarker)).toBeFalse();
  });

  test("app status inspects the canonical app and reports legacy duplicates", async () => {
    const home = join(tmpdir(), `open-recordings-cli-app-layout-${Date.now()}`);
    tempDirs.push(home);
    const canonical = join(home, "Applications", "Recordings.app");
    const hiddenLegacy = join(home, ".hasna", "recordings", "Recordings.app");
    const rollbackLegacy = join(home, "Applications", "Recordings.app.rollback-pre-test");
    mkdirSync(join(canonical, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(canonical, "Contents", "MacOS", "Recordings"), "fixture");
    mkdirSync(hiddenLegacy, { recursive: true });
    mkdirSync(rollbackLegacy, { recursive: true });

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "app", "status"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const status = JSON.parse(stdout) as {
      installed_app_path: string;
      installed: boolean;
      executable: boolean;
      legacy_install_paths: string[];
      microphone_permission: string;
      accessibility_permission: string;
    };
    expect(status.installed_app_path).toBe(canonical);
    expect(status.installed).toBe(true);
    expect(status.executable).toBe(true);
    expect(status.legacy_install_paths).toContain(hiddenLegacy);
    expect(status.legacy_install_paths).toContain(rollbackLegacy);
    expect(status.microphone_permission).toBe("ambiguous_multiple_installations");
    expect(status.accessibility_permission).toBe("ambiguous_multiple_installations");
  });

  test("app status never treats a CDHash substring as permission identity proof", () => {
    const cli = readFileSync("src/cli/index.ts", "utf8");
    const permissionReader = cli.slice(
      cli.indexOf("function getTccPermission"),
      cli.indexOf("function tccAuthValueLabel"),
    );

    expect(permissionReader).not.toContain("currentCodeHash");
    expect(permissionReader).not.toContain("csreqHex");
    expect(permissionReader).toContain("_identity_unverified");
  });

  test("app status is compact by default and verbose on request", async () => {
    const compactProc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "app", "status"],
      { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" }
    );
    const [compactStdout, compactStderr, compactExit] = await Promise.all([
      new Response(compactProc.stdout).text(),
      new Response(compactProc.stderr).text(),
      compactProc.exited,
    ]);
    expect(compactExit).toBe(0);
    expect(compactStderr).toBe("");
    expect(compactStdout).toContain("Recordings.app");
    expect(compactStdout).toContain("Use --verbose");
    expect(compactStdout).not.toContain(`Package: ${process.cwd()}`);

    const verboseProc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "app", "status", "--verbose"],
      { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" }
    );
    const [verboseStdout, verboseStderr, verboseExit] = await Promise.all([
      new Response(verboseProc.stdout).text(),
      new Response(verboseProc.stderr).text(),
      verboseProc.exited,
    ]);
    expect(verboseExit).toBe(0);
    expect(verboseStderr).toBe("");
    expect(verboseStdout).toContain(`Package: ${process.cwd()}`);
    expect(verboseStdout).toContain("Executable path:");
  });

  test("--json app permissions emits permission diagnostics", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "app", "permissions"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const permissions = JSON.parse(stdout) as {
      bundle_id: string;
      microphone: string;
      accessibility: string;
      app_code_hash: string | null;
      ad_hoc_signed: boolean;
      log_path: string;
    };
    expect(permissions.bundle_id).toBe("com.hasna.recordings");
    expect(typeof permissions.microphone).toBe("string");
    expect(typeof permissions.accessibility).toBe("string");
    expect(typeof permissions.ad_hoc_signed).toBe("boolean");
    expect(permissions.app_code_hash === null || typeof permissions.app_code_hash === "string").toBe(true);
    expect(permissions.log_path).toContain(".hasna/recordings/Recordings.log");
  });

  test("app help advertises permission request command", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "app", "--help"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("request-permissions");
  });

  test("--json check emits machine-readable dependency status", async () => {
    const home = join(tmpdir(), `open-recordings-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "--json", "check"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          OPENAI_API_KEY: "test-openai-key",
          RECORDINGS_ENHANCEMENT_KEY: "test-enhancement-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const report = JSON.parse(stdout) as {
      recording: { available: boolean; tool: string | null; message: string };
      openai_api_key_configured: boolean;
      enhancement_api_key_configured: boolean;
      enhancement_model: string;
      realtime_session_model: string;
      realtime_transcription_model: string;
      config_warnings: string[];
    };
    expect(typeof report.recording.available).toBe("boolean");
    expect(report.openai_api_key_configured).toBe(true);
    expect(report.enhancement_api_key_configured).toBe(true);
    expect(report.enhancement_model).toBe("gpt-4o");
    expect(report.realtime_session_model).toBe("gpt-realtime");
    expect(report.realtime_transcription_model).toBe("gpt-realtime-whisper");
    expect(Array.isArray(report.config_warnings)).toBe(true);
  });

  test("--json transcribe emits only one JSON payload on stdout", async () => {
    const home = join(tmpdir(), `open-recordings-cli-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    writeFileSync(audioPath, "fake wav bytes");

    const apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "mock transcript", language: "en" });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const proc = Bun.spawn(
        [process.execPath, cliEntry, "--json", "transcribe", audioPath, "--no-enhance"],
        {
          cwd: home,
          env: isolatedCliEnv(home, {
            OPENAI_API_KEY: "sk-test-key",
            RECORDINGS_ENHANCEMENT_KEY: "",
            OPENAI_BASE_URL: `http://127.0.0.1:${apiServer.port}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("Transcribing");
      expect(stdout).not.toContain("Transcription:");
      expect(stdout.trim().startsWith("{")).toBe(true);

      const recording = JSON.parse(stdout) as {
        raw_text: string;
        processing_mode: string;
        model_used: string;
      };
      expect(recording.raw_text).toBe("mock transcript");
      expect(recording.processing_mode).toBe("raw");
      expect(recording.model_used).toBe("gpt-4o-transcribe");
    } finally {
      apiServer.stop(true);
    }
  });

  test("--json transcribe always post-processes and emits safe metadata", async () => {
    const home = join(tmpdir(), `open-recordings-cli-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    writeFileSync(audioPath, "fake wav bytes");

    const apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "hello world", language: "en" });
        }
        if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
          return Response.json({
            choices: [{ message: { content: "Hello, world." } }],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          cliEntry,
          "--json",
          "transcribe",
          audioPath,
          "--prompt",
          "Hasna",
          "--transcriber-prompt",
          "Fix punctuation only",
          "--post-processing",
          "always",
        ],
        {
          cwd: home,
          env: isolatedCliEnv(home, {
            OPENAI_API_KEY: "sk-test-key",
            RECORDINGS_ENHANCEMENT_KEY: "",
            OPENAI_BASE_URL: `http://127.0.0.1:${apiServer.port}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const recording = JSON.parse(stdout) as {
        raw_text: string;
        processed_text: string;
        processing_mode: string;
        metadata: {
          transcription_prompt: { configured: boolean; source: string };
          transcriber_prompt: { configured: boolean; source: string };
          post_processing: { mode: string; applied: boolean; model: string };
        };
      };
      expect(recording.raw_text).toBe("hello world");
      expect(recording.processed_text).toBe("Hello, world.");
      expect(recording.processing_mode).toBe("enhanced");
      expect(recording.metadata.transcription_prompt).toEqual({
        configured: true,
        source: "request",
      });
      expect(recording.metadata.transcriber_prompt).toEqual({
        configured: true,
        source: "request",
      });
      expect(recording.metadata.post_processing.mode).toBe("always");
      expect(recording.metadata.post_processing.applied).toBe(true);
      expect(JSON.stringify(recording.metadata)).not.toContain("Fix punctuation only");
    } finally {
      apiServer.stop(true);
    }
  });

  test("--json save-text persists degraded-sync text without an unsafe project id", async () => {
    const home = join(tmpdir(), `open-recordings-cli-save-text-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const audioPath = join(home, "sample.wav");
    const textPath = join(home, "transcript.txt");
    const transcript = "hello from realtime\nwith \"quotes\" and multiple lines";
    writeFileSync(textPath, transcript);

    const proc = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--json",
        "save-text",
        "--text-file",
        textPath,
        "--audio-path",
        audioPath,
        "--source",
        "realtime_fast_path",
        "--model-used",
        "gpt-realtime-whisper",
        "--post-processing",
        "off",
        "--language",
        "en",
        "--duration-ms",
        "1200",
      ],
      {
        cwd: home,
        env: isolatedCliEnv(home, {
          OPENAI_API_KEY: "",
          RECORDINGS_ENHANCEMENT_KEY: "",
          HASNA_MACHINE_ID: "station-test",
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const recording = JSON.parse(stdout) as {
      audio_path: string;
      raw_text: string;
      processing_mode: string;
      model_used: string;
      duration_ms: number;
      language: string;
      machine_id: string;
      metadata: {
        transcription_source: string;
        realtime: { fast_path: boolean; model: string; bounded_fallback: boolean };
        post_processing: { mode: string; applied: boolean };
      };
    };
    expect(recording.audio_path).toBe(audioPath);
    expect(recording.raw_text).toBe(transcript);
    expect(recording.processing_mode).toBe("raw");
    expect(recording.model_used).toBe("gpt-realtime-whisper");
    expect(recording.duration_ms).toBe(1200);
    expect(recording.language).toBe("en");
    expect(recording.machine_id).toBe("station-test");
    expect(recording.metadata.transcription_source).toBe("realtime_fast_path");
    expect(recording.metadata.realtime).toEqual({
      fast_path: true,
      model: "gpt-realtime-whisper",
      bounded_fallback: false,
    });
    expect(recording.metadata.post_processing.mode).toBe("off");
    expect(recording.metadata.post_processing.applied).toBe(false);
  });

  test("explicit empty --recording-id is validated instead of treated as absent", async () => {
    const home = join(tmpdir(), `open-recordings-cli-empty-recording-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });

    const proc = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--json",
        "save-text",
        "must not persist",
        "--post-processing",
        "off",
        "--recording-id",
        "",
      ],
      {
        cwd: home,
        env: isolatedCliEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("recording id must not be empty");

    const transcribe = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--json",
        "transcribe",
        "/nonexistent/must-not-be-read.wav",
        "--recording-id",
        "",
      ],
      {
        cwd: home,
        env: isolatedCliEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [transcribeStdout, transcribeStderr, transcribeExitCode] = await Promise.all([
      new Response(transcribe.stdout).text(),
      new Response(transcribe.stderr).text(),
      transcribe.exited,
    ]);
    expect(transcribeExitCode).toBe(1);
    expect(`${transcribeStdout}\n${transcribeStderr}`).toContain(
      "recording id must not be empty"
    );
    expect(`${transcribeStdout}\n${transcribeStderr}`).not.toContain(
      "must-not-be-read.wav"
    );
  });

  test("list is compact by default while JSON and detail preserve full text", async () => {
    const home = join(tmpdir(), `open-recordings-cli-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const longText = `First compact transcript ${"middle words ".repeat(30)}hidden-tail-token`;
    const hostileModel = `model\nInjected\u001b[31mred\u001b]0;esc-title\u0007\u009b32mgreen\u009d0;c1-title\u009c${"😀".repeat(100)}${"x".repeat(120)}`;
    const env = isolatedCliEnv(home, {
      OPENAI_API_KEY: "",
      RECORDINGS_ENHANCEMENT_KEY: "",
    });

    const saveProc = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--json",
        "save-text",
        longText,
        "--post-processing",
        "off",
        "--model-used",
        hostileModel,
        "--tags",
        "safe\nInjected\u001b[31m,second,third,fourth,fifth",
      ],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [saveStdout, saveStderr, saveExit] = await Promise.all([
      new Response(saveProc.stdout).text(),
      new Response(saveProc.stderr).text(),
      saveProc.exited,
    ]);
    expect(saveExit).toBe(0);
    expect(saveStderr).toBe("");
    const saved = JSON.parse(saveStdout) as { id: string; raw_text: string };
    expect(saved.raw_text).toBe(longText);

    const listProc = Bun.spawn(
      [process.execPath, cliEntry, "list", "-n", "1"],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [listStdout, listStderr, listExit] = await Promise.all([
      new Response(listProc.stdout).text(),
      new Response(listProc.stderr).text(),
      listProc.exited,
    ]);
    expect(listExit).toBe(0);
    expect(listStderr).toBe("");
    expect(listStdout).toContain("recordings: showing 1 of 1");
    expect(listStdout).toContain(saved.id.slice(0, 8));
    expect(listStdout).toContain("Details: recordings show <id> or inspect <id>");
    expect(listStdout).toContain("safe Injected, second, third, +2");
    expect(listStdout).not.toContain("safe\nInjected");
    expect(listStdout).not.toContain("\u001b");
    expect(listStdout).not.toContain("[31m");
    expect(listStdout).not.toContain("hidden-tail-token");

    const verboseProc = Bun.spawn(
      [process.execPath, cliEntry, "list", "-n", "1", "--verbose"],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [verboseStdout, verboseStderr, verboseExit] = await Promise.all([
      new Response(verboseProc.stdout).text(),
      new Response(verboseProc.stderr).text(),
      verboseProc.exited,
    ]);
    expect(verboseExit).toBe(0);
    expect(verboseStderr).toBe("");
    expect(verboseStdout).toContain("model: model Injectedredgreen");
    expect(verboseStdout).not.toContain("\u001b");
    expect(verboseStdout).not.toContain("\u009b");
    expect(verboseStdout).not.toContain("[31m");
    expect(verboseStdout).not.toContain("32m");
    expect(verboseStdout).not.toContain("esc-title");
    expect(verboseStdout).not.toContain("c1-title");
    expect(verboseStdout).not.toContain("�");
    expect(verboseStdout).not.toContain("x".repeat(80));

    const statsProc = Bun.spawn(
      [process.execPath, cliEntry, "stats"],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [statsStdout, statsStderr, statsExit] = await Promise.all([
      new Response(statsProc.stdout).text(),
      new Response(statsProc.stderr).text(),
      statsProc.exited,
    ]);
    expect(statsExit).toBe(0);
    expect(statsStderr).toBe("");
    expect(statsStdout).toContain("model Injectedredgreen");
    expect(statsStdout).not.toContain("\u001b");
    expect(statsStdout).not.toContain("\u009b");
    expect(statsStdout).not.toContain("esc-title");
    expect(statsStdout).not.toContain("c1-title");
    expect(statsStdout).not.toContain("�");
    expect(statsStdout).not.toContain("x".repeat(80));

    const jsonProc = Bun.spawn(
      [process.execPath, cliEntry, "--json", "list", "-n", "1"],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [jsonStdout, jsonStderr, jsonExit] = await Promise.all([
      new Response(jsonProc.stdout).text(),
      new Response(jsonProc.stderr).text(),
      jsonProc.exited,
    ]);
    expect(jsonExit).toBe(0);
    expect(jsonStderr).toBe("");
    const listed = JSON.parse(jsonStdout) as Array<{ raw_text: string }>;
    expect(listed[0]!.raw_text).toBe(longText);

    const inspectProc = Bun.spawn(
      [process.execPath, cliEntry, "inspect", saved.id.slice(0, 8)],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [inspectStdout, inspectStderr, inspectExit] = await Promise.all([
      new Response(inspectProc.stdout).text(),
      new Response(inspectProc.stderr).text(),
      inspectProc.exited,
    ]);
    expect(inspectExit).toBe(0);
    expect(inspectStderr).toBe("");
    expect(inspectStdout).toContain("hidden-tail-token");
  });

  test("list prints cursor hints and caps oversized human limits", async () => {
    const home = join(tmpdir(), `open-recordings-cli-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    const env = isolatedCliEnv(home, {
      OPENAI_API_KEY: "",
      RECORDINGS_ENHANCEMENT_KEY: "",
    });

    for (const text of ["one", "two"]) {
      const proc = Bun.spawn(
        [process.execPath, cliEntry, "save-text", text, "--post-processing", "off"],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" }
      );
      expect(await proc.exited).toBe(0);
    }

    const proc = Bun.spawn(
      [process.execPath, cliEntry, "list", "-n", "100"],
      { cwd: home, env, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("recordings: showing 2 of 2");
    expect(stdout).toContain("limit 50");
    expect(stdout).toContain("Limit capped at 50");
  });

  test("mcp installer configures stdio args for Codex and Gemini", async () => {
    const home = join(tmpdir(), `open-recordings-cli-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(home);
    const codexDir = join(home, ".codex");
    const geminiDir = join(home, ".gemini");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(geminiDir, { recursive: true });
    const codexConfig = join(codexDir, "config.toml");
    const geminiConfig = join(geminiDir, "settings.json");
    writeFileSync(codexConfig, "");
    writeFileSync(geminiConfig, "{}");

    const proc = Bun.spawn(
      [process.execPath, "src/cli/index.ts", "mcp", "--codex", "--gemini"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Codex");
    expect(stdout).toContain("Gemini");
    expect(readFileSync(codexConfig, "utf-8")).toContain('args = ["--stdio"]');

    const gemini = JSON.parse(readFileSync(geminiConfig, "utf-8")) as {
      mcpServers: { recordings: { command: string; args: string[] } };
    };
    expect(gemini.mcpServers.recordings.args).toEqual(["--stdio"]);
  });
});
