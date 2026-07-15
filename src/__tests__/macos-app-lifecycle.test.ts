import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
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

const repositoryRoot = resolve(import.meta.dir, "../..");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createApp(path: string, marker: string): void {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(path, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "Recordings"), marker);
  writeFileSync(join(path, "Contents", "Helpers", "recordings"), "companion");
  chmodSync(join(path, "Contents", "MacOS", "Recordings"), 0o755);
  chmodSync(join(path, "Contents", "Helpers", "recordings"), 0o755);
}

function createInstallerFixture() {
  const root = temporaryDirectory("recordings-installer-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const markers = join(root, "markers");
  const candidate = join(root, "candidate", "Recordings.app");
  const artifact = join(root, "Recordings-0.2.11-macos.zip");
  const manifest = join(root, "Recordings-0.2.11-macos.manifest.json");
  const installer = join(root, "scripts", "install_macos_app.sh");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(markers, { recursive: true });
  createApp(candidate, "candidate");
  writeFileSync(artifact, "finalized archive");
  writeFileSync(manifest, "{}\n");
  mkdirSync(dirname(installer), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "install_macos_app.sh"), installer);
  chmodSync(installer, 0o755);
  cpSync(join(repositoryRoot, "scripts", "macos_artifact.ts"), join(root, "scripts", "macos_artifact.ts"));

  writeExecutable(join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/bun.log"
case "$*" in
  *" verify-archive "*)
    [ "\${FAIL_ARCHIVE_VERIFY:-0}" = 1 ] && exit 1
    [[ "$*" == *"--team-id \${REQUIRED_TEAM_ID:-EXAMPLE123}"* ]] || exit 1
    ;;
  *" verify-app "*)
    [ "\${FAIL_APP_VERIFY:-0}" = 1 ] && exit 1
    [ "\${MISSING_TIMESTAMP:-0}" = 1 ] && exit 1
    ;;
esac
exit 0
`,
  );
  writeExecutable(
    join(bin, "ditto"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-x" ]; then
  destination="\${@: -1}"
  cp -R "$CANDIDATE_SOURCE" "$destination/Recordings.app"
elif [ "$1" = "-c" ]; then
  if [ "\${FAIL_ARCHIVE_COPY:-0}" = 1 ]; then exit 1; fi
  printf archive > "\${@: -1}"
else
  cp -R "$1" "$2"
fi
`,
  );
  writeExecutable(
    join(bin, "codesign"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/codesign.log"
if [[ "$*" == *"-d -r-"* ]]; then
  label=OLD
  [[ "$*" == *"/unpacked/"* ]] && label=NEW
  [[ "$*" == *"/.Recordings-install-"* ]] && label=NEW
  [[ "$*" == *"/.hasna/recordings/Recordings.app"* ]] && label=LEGACY
  printf 'designated => identifier "com.hasna.recordings" and certificate leaf = "%s"\n' "$label" >&2
  exit 0
fi
if [[ "$*" == *" -R "* ]]; then
  if [ "\${FAIL_FORWARD_REQUIREMENT:-0}" = 1 ] && [[ "$*" == *'certificate leaf = "OLD"'* ]] && [[ "$*" == *"/unpacked/"* ]]; then exit 1; fi
  if [ "\${FAIL_REVERSE_REQUIREMENT:-0}" = 1 ] && [[ "$*" == *'certificate leaf = "NEW"'* ]] && [[ "$*" != *"/unpacked/"* ]]; then exit 1; fi
fi
exit 0
`,
  );
  writeExecutable(join(bin, "xcrun"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    join(bin, "mdfind"),
    "#!/usr/bin/env bash\n[ -n \"${MDFIND_RESULT:-}\" ] && printf '%s\\n' \"$MDFIND_RESULT\"\n",
  );
  writeExecutable(
    join(bin, "open"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/open.log\"\n",
  );
  writeExecutable(
    join(bin, "ps"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "$MARKER_DIRECTORY/open.log" ]; then
  [ -n "\${EXISTING_PID:-}" ] && printf '%s %s\n' "$EXISTING_PID" "$EXISTING_PROCESS_PATH"
  [ -n "\${UNRELATED_PID:-}" ] && printf '%s %s\n' "$UNRELATED_PID" "$UNRELATED_PROCESS_PATH"
elif [ "\${LAUNCH_SUCCEEDS:-1}" = 1 ]; then
  printf '99999 %s\n' "$CANONICAL_EXECUTABLE"
fi
`,
  );

  return { root, home, bin, markers, candidate, artifact, manifest };
}

async function runInstaller(
  fixture: ReturnType<typeof createInstallerFixture>,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  const app = join(fixture.home, "Applications", "Recordings.app");
  const process = Bun.spawn(
    [
      "bash",
      join(fixture.root, "scripts", "install_macos_app.sh"),
      "--artifact",
      fixture.artifact,
      "--manifest",
      fixture.manifest,
      "--expected-team-id",
      "EXAMPLE123",
      ...args,
    ],
    {
      env: {
        ...Bun.env,
        HOME: fixture.home,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        CANDIDATE_SOURCE: fixture.candidate,
        CANONICAL_EXECUTABLE: join(app, "Contents", "MacOS", "Recordings"),
        MARKER_DIRECTORY: fixture.markers,
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("macOS finalized artifact installer", () => {
  test("has no package postinstall or target-build fallback", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const installer = readFileSync(join(repositoryRoot, "scripts", "install_macos_app.sh"), "utf8");
    expect(packageJson.scripts?.postinstall).toBeUndefined();
    expect(installer).not.toContain("swift build");
    expect(installer).not.toContain("build.sh");
    expect(installer).not.toContain("tccutil");
    expect(installer).not.toContain("quarantine");
    expect(installer).not.toContain("codesign --force");
  });

  test("rejects arbitrary app directories and target-build flags", async () => {
    const fixture = createInstallerFixture();
    const process = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "install_macos_app.sh"), "--app-source", fixture.candidate],
      { env: { ...Bun.env, PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}` }, stderr: "pipe" },
    );
    expect(await process.exited).toBe(2);
    expect(await new Response(process.stderr).text()).toContain("Unknown argument");
  });

  test("rejects archive or manifest tampering before mutating an installed app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(existsSync(join(fixture.markers, "codesign.log"))).toBeFalse();
  });

  test("rejects additional top-level archive contents", async () => {
    const fixture = createInstallerFixture();
    writeExecutable(
      join(fixture.bin, "ditto"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-x" ]; then
  destination="\${@: -1}"
  cp -R "$CANDIDATE_SOURCE" "$destination/Recordings.app"
  printf unexpected > "$destination/README.txt"
elif [ "$1" = "-c" ]; then
  printf archive > "\${@: -1}"
else
  cp -R "$1" "$2"
fi
`,
    );
    const result = await runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("only one top-level Recordings.app");
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("requires the pinned Team ID and trusted timestamp before mutation", async () => {
    const fixture = createInstallerFixture();
    const wrongTeam = await runInstaller(fixture, [], { REQUIRED_TEAM_ID: "OTHERTEAM" });
    expect(wrongTeam.exitCode).not.toBe(0);
    const missingTimestamp = await runInstaller(fixture, [], { MISSING_TIMESTAMP: "1" });
    expect(missingTimestamp.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("requires explicit migration when the forward designated requirement fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture, [], { FAIL_FORWARD_REQUIREMENT: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("mutually compatible");
  });

  test("requires explicit migration when the reverse designated requirement fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture, [], { FAIL_REVERSE_REQUIREMENT: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("mutually compatible");
  });

  test("fails before mutation for a Spotlight duplicate outside managed paths", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const external = join(fixture.root, "external", "Recordings.app");
    createApp(installed, "installed");
    createApp(external, "external");
    const result = await runInstaller(fixture, [], { MDFIND_RESULT: external });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("outside the transactional user install paths");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
  });

  test("does not stop the current app when duplicate archival fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const process = Bun.spawn(["sleep", "30"]);
    try {
      const result = await runInstaller(fixture, [], {
        EXISTING_PID: String(process.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        FAIL_ARCHIVE_COPY: "1",
      });
      expect(result.exitCode).not.toBe(0);
      expect(() => globalThis.process.kill(process.pid, 0)).not.toThrow();
      expect(existsSync(join(fixture.markers, "open.log"))).toBeFalse();
    } finally {
      process.kill();
      await process.exited;
    }
  });

  test("rolls back the app and all duplicates when canonical launch fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const duplicate = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    createApp(installed, "installed");
    createApp(duplicate, "duplicate");
    const priorProcess = Bun.spawn(["sleep", "30"]);
    try {
      const result = await runInstaller(fixture, ["--launch", "--launch-timeout", "1"], {
        EXISTING_PID: String(priorProcess.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        LAUNCH_SUCCEEDS: "0",
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "installed",
      );
      expect(readFileSync(join(duplicate, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "duplicate",
      );
      const launches = readFileSync(join(fixture.markers, "open.log"), "utf8")
        .trim()
        .split("\n");
      expect(launches.length).toBe(2);
      expect(launches[1]).toContain(installed);
    } finally {
      priorProcess.kill();
      await priorProcess.exited;
    }
  });

  test("installs one canonical app and archives duplicates without touching TCC", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const duplicate = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    createApp(installed, "installed");
    createApp(duplicate, "duplicate");
    const result = await runInstaller(fixture, ["--launch", "--launch-timeout", "3"]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    expect(existsSync(duplicate)).toBeFalse();
    expect(readdirSync(join(fixture.home, ".hasna", "recordings", "rollbacks")).length).toBe(2);
    expect(existsSync(join(fixture.markers, "tccutil.log"))).toBeFalse();
  });
});

describe("macOS signed artifact build", () => {
  function createBuildFixture() {
    const root = temporaryDirectory("recordings-build-");
    const native = join(root, "src", "native", "Recordings");
    const bin = join(root, "bin");
    const markers = join(root, "markers");
    mkdirSync(join(native, "RecordingsLib"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(markers, { recursive: true });
    cpSync(join(repositoryRoot, "src", "native", "Recordings", "build.sh"), join(native, "build.sh"));
    chmodSync(join(native, "build.sh"), 0o755);
    writeFileSync(join(native, "RecordingsLib", "Info.plist"), "<plist><dict/></plist>\n");
    writeFileSync(join(native, "RecordingsLib", "Recordings.entitlements"), "<plist><dict/></plist>\n");
    writeExecutable(
      join(root, "scripts", "build_companion_cli.sh"),
      "#!/usr/bin/env bash\nmkdir -p \"$(dirname \"$1\")\"\nprintf companion > \"$1\"\nchmod +x \"$1\"\n",
    );
    writeFileSync(join(root, "scripts", "macos_artifact.ts"), "fixture");
    writeExecutable(
      join(bin, "swift"),
      "#!/usr/bin/env bash\nmkdir -p .build/$3\nprintf app > .build/$3/App\nchmod +x .build/$3/App\n",
    );
    writeExecutable(
      join(bin, "bun"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/bun.log"
if [[ "$*" == *" finalize "* ]]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --manifest ]; then printf '{}\n' > "$2"; exit 0; fi
    shift
  done
fi
exit 0
`,
    );
    writeExecutable(
      join(bin, "codesign"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/codesign.log"
if [[ "$*" == *"--verbose=4"* ]]; then
  printf 'Authority=%s\nTeamIdentifier=%s\nCodeDirectory flags=%s\n' "\${SIGNING_AUTHORITY:-Developer ID Application: Example Corp (EXAMPLE123)}" "\${SIGNING_TEAM:-EXAMPLE123}" "\${SIGNING_FLAGS:-0x10000(runtime)}" >&2
  [ "\${MISSING_TIMESTAMP:-0}" = 1 ] || printf 'Timestamp=Jul 15, 2026 at 12:00:00\n' >&2
fi
if [[ "$*" == *"-d -r-"* ]]; then printf 'designated => identifier "com.hasna.recordings"\n' >&2; fi
exit 0
`,
    );
    writeExecutable(
      join(bin, "ditto"),
      "#!/usr/bin/env bash\nif [ \"$1\" = -c ]; then printf archive > \"${@: -1}\"; else cp -R \"$1\" \"$2\"; fi\n",
    );
    writeExecutable(join(bin, "xcrun"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(join(bin, "plistbuddy"), "#!/usr/bin/env bash\nprintf '0.2.11\\n'\n");
    return { root, native, bin, markers };
  }

  async function runBuild(fixture: ReturnType<typeof createBuildFixture>, environment = {}) {
    const process = Bun.spawn(["bash", join(fixture.native, "build.sh"), "release"], {
      cwd: fixture.native,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markers,
        PLIST_BUDDY: join(fixture.bin, "plistbuddy"),
        RECORDINGS_CODESIGN_IDENTITY: "Developer ID Application: Example Corp (EXAMPLE123)",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "EXAMPLE123",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "recordings-notary",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  async function runDebugBuild(fixture: ReturnType<typeof createBuildFixture>) {
    const process = Bun.spawn(["bash", join(fixture.native, "build.sh"), "debug"], {
      cwd: fixture.native,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markers,
        PLIST_BUDDY: join(fixture.bin, "plistbuddy"),
        RECORDINGS_CODESIGN_IDENTITY: "",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  test("debug builds ad-hoc locally without release credentials", async () => {
    const fixture = createBuildFixture();
    const result = await runDebugBuild(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("ad-hoc signed and non-distributable");
    expect(result.stdout).toContain("Built non-distributable debug app");
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).toContain("--force --sign -");
    expect(codesignLog).not.toContain("--timestamp");
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings.app"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings.app", "Contents", "Helpers", "recordings"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings-0.2.11-macos.zip"))).toBeFalse();
  });

  test("release builds reject missing signer and notary configuration", async () => {
    const fixture = createBuildFixture();
    const missingIdentity = await runBuild(fixture, { RECORDINGS_CODESIGN_IDENTITY: "" });
    expect(missingIdentity.exitCode).not.toBe(0);
    expect(missingIdentity.stderr).toContain("Release builds require RECORDINGS_CODESIGN_IDENTITY");

    const missingNotary = await runBuild(fixture, { RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "" });
    expect(missingNotary.exitCode).not.toBe(0);
    expect(missingNotary.stderr).toContain("Release builds require RECORDINGS_NOTARY_KEYCHAIN_PROFILE");
  });

  test("requires a pinned Team ID", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture, { RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("RECORDINGS_EXPECTED_TEAM_IDENTIFIER");
  });

  test("rejects wrong Team ID or missing trusted timestamp readback", async () => {
    const fixture = createBuildFixture();
    const wrongTeam = await runBuild(fixture, { SIGNING_TEAM: "OTHERTEAM" });
    expect(wrongTeam.exitCode).not.toBe(0);
    const missingTimestamp = await runBuild(fixture, { MISSING_TIMESTAMP: "1" });
    expect(missingTimestamp.exitCode).not.toBe(0);
    expect(missingTimestamp.stderr).toContain("trusted signing timestamp");
  });

  test("rejects a wrong signing authority or missing hardened runtime readback", async () => {
    const fixture = createBuildFixture();
    const wrongSigner = await runBuild(fixture, {
      SIGNING_AUTHORITY: "Apple Development: Example Corp (EXAMPLE123)",
    });
    expect(wrongSigner.exitCode).not.toBe(0);
    expect(wrongSigner.stderr).toContain("Developer ID Application");
    const missingRuntime = await runBuild(fixture, { SIGNING_FLAGS: "0x0" });
    expect(missingRuntime.exitCode).not.toBe(0);
    expect(missingRuntime.stderr).toContain("hardened runtime");
  });

  test("signs helper and app then emits finalized ZIP and manifest", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture);
    expect(result.exitCode).toBe(0);
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).toContain("--options runtime --timestamp");
    expect(codesignLog).toContain("Contents/Helpers/recordings");
    const bunLog = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(bunLog).toContain("provenance");
    expect(bunLog).toContain("finalize");
    const buildScript = readFileSync(
      join(repositoryRoot, "src", "native", "Recordings", "build.sh"),
      "utf8",
    );
    const helperSigning = buildScript.indexOf(
      'codesign "${SIGN_ARGUMENTS[@]}" "$HELPERS/recordings"',
    );
    const provenance = buildScript.indexOf('macos_artifact.ts" provenance');
    const appSigning = buildScript.indexOf("--entitlements", provenance);
    expect(helperSigning).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(helperSigning);
    expect(appSigning).toBeGreaterThan(provenance);
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.11-macos.zip"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.11-macos.manifest.json"))).toBeTrue();
  });
});
