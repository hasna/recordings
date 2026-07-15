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
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createApp(path: string, marker: string): void {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "Recordings"), marker);
  chmodSync(join(path, "Contents", "MacOS", "Recordings"), 0o755);
  writeFileSync(
    join(path, "Contents", "Info.plist"),
    "<?xml version=\"1.0\"?><plist><dict><key>CFBundleIdentifier</key><string>com.hasna.recordings</string></dict></plist>\n",
  );
}

function createInstallerFixture(): {
  root: string;
  home: string;
  bin: string;
  markerDirectory: string;
} {
  const root = temporaryDirectory("recordings-installer-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const markerDirectory = join(root, "markers");
  const installer = join(root, "scripts", "install_macos_app.sh");
  const nativeDirectory = join(root, "src", "native", "Recordings");

  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(markerDirectory, { recursive: true });
  mkdirSync(nativeDirectory, { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "install_macos_app.sh"), installer);
  chmodSync(installer, 0o755);

  writeExecutable(
    join(nativeDirectory, "build.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
app=".build/\${1:-release}/Recordings.app"
mkdir -p "$app/Contents/MacOS"
printf candidate > "$app/Contents/MacOS/Recordings"
chmod +x "$app/Contents/MacOS/Recordings"
printf '<plist><dict><key>CFBundleIdentifier</key><string>com.hasna.recordings</string></dict></plist>\\n' > "$app/Contents/Info.plist"
`,
  );

  writeExecutable(join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(join(bin, "swift"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    join(bin, "codesign"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MARKER_DIRECTORY/codesign.log"
if [[ "$*" == *"-d -r-"* ]]; then
  requirement_label=CANONICAL
  [[ "$*" == *"/.hasna/recordings/Recordings.app"* ]] && requirement_label=LEGACY
  printf 'designated => identifier "com.hasna.recordings" and certificate leaf = "%s"\\n' "$requirement_label" >&2
  exit 0
fi
if [ "\${FAIL_CANONICAL_VERIFY:-0}" = 1 ] &&
   [[ "$*" == *"--verify"* ]] &&
   [[ "$*" == *"/Applications/Recordings.app"* ]]; then
  exit 1
fi
if [[ "$*" == *" -R "* ]] && [ "\${SIGNATURES_COMPATIBLE:-0}" != 1 ]; then
  exit 1
fi
if [[ "$*" == *" -R "* ]] &&
   [ -n "\${INCOMPATIBLE_REQUIREMENT_TOKEN:-}" ] &&
   [[ "$*" == *"$INCOMPATIBLE_REQUIREMENT_TOKEN"* ]]; then
  exit 1
fi
if [[ "$*" == *"--verbose=4"* ]]; then
  printf 'Identifier=%s\\nAuthority=Developer ID Application: Example Corp (EXAMPLE123)\\nTeamIdentifier=%s\\nCodeDirectory flags=0x10000(runtime)\\nCDHash=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n' "\${CANDIDATE_IDENTIFIER:-com.hasna.recordings}" "\${CANDIDATE_TEAM:-EXAMPLE123}" >&2
fi
exit 0
`,
  );
  writeExecutable(
    join(bin, "ditto"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-c" ]; then
  if [ "\${FAIL_LEGACY_ARCHIVE:-0}" = 1 ] &&
     [[ "$*" == *"/.hasna/recordings/Recordings.app"* ]]; then
    exit 1
  fi
  printf archive > "\${@: -1}"
else
  cp -R "$1" "$2"
fi
`,
  );
  writeExecutable(
    join(bin, "tccutil"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/tccutil.log\"\n",
  );
  writeExecutable(
    join(bin, "sqlite3"),
    "#!/usr/bin/env bash\nprintf 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n'\n",
  );
  writeExecutable(join(bin, "pgrep"), "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(join(bin, "pkill"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    join(bin, "open"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/open.log\"\nexit 0\n",
  );
  writeExecutable(
    join(bin, "ps"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pid=,command="* ]]; then
  if [ ! -e "$MARKER_DIRECTORY/open.log" ]; then
    [ -n "\${EXISTING_PID:-}" ] && printf '%s %s\\n' "$EXISTING_PID" "$EXISTING_PROCESS_PATH"
    [ -n "\${UNRELATED_PID:-}" ] && printf '%s %s\\n' "$UNRELATED_PID" "$UNRELATED_PROCESS_PATH"
  elif [ -n "\${PROCESS_PATH:-}" ]; then
    printf '99999 %s\\n' "$PROCESS_PATH"
  fi
elif [ -n "\${PROCESS_PATH:-}" ]; then
  printf '%s\\n' "$PROCESS_PATH"
fi
`,
  );
  writeExecutable(
    join(bin, "mv"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${INTERRUPT_AFTER_PREVIOUS_MOVE:-0}" = 1 ] &&
   [[ "$1" == *"/Applications/Recordings.app" ]] &&
   [[ "$2" == *"/.Recordings-previous-"* ]]; then
  /bin/mv "$@"
  kill -TERM "$PPID"
  exit 0
fi
exec /bin/mv "$@"
`,
  );
  writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    join(bin, "xcrun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/xcrun.log\"\nexit 0\n",
  );

  return { root, home, bin, markerDirectory };
}

async function runInstaller(
  fixture: ReturnType<typeof createInstallerFixture>,
  args: string[] = [],
  extraEnvironment: Record<string, string> = {},
) {
  const process = Bun.spawn(["bash", join(fixture.root, "scripts", "install_macos_app.sh"), ...args], {
    env: {
      ...Bun.env,
      HOME: fixture.home,
      PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
      MARKER_DIRECTORY: fixture.markerDirectory,
      ...extraEnvironment,
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

describe("macOS app installer identity contract", () => {
  test("rejects a signed candidate with the wrong bundle identifier", async () => {
    const fixture = createInstallerFixture();

    const result = await runInstaller(fixture, [], {
      CANDIDATE_IDENTIFIER: "com.example.not-recordings",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("bundle identifier");
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("rejects a release candidate from an unexpected Developer ID team", async () => {
    const fixture = createInstallerFixture();

    const result = await runInstaller(fixture, [], {
      CANDIDATE_TEAM: "OTHERTEAM",
      RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "EXAMPLE123",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Developer ID team");
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("rejects an incompatible signing identity without replacing the installed app", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    createApp(installedApp, "installed");

    const result = await runInstaller(fixture, [], { SIGNATURES_COMPATIBLE: "0" });

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
    expect(result.stderr).toContain("signing identity");
  });

  test("installs one compatible app at the canonical path without resetting TCC", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    createApp(installedApp, "installed");

    const result = await runInstaller(fixture, [], { SIGNATURES_COMPATIBLE: "1" });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(join(fixture.home, ".hasna", "recordings", "Recordings.app"))).toBeFalse();
    expect(existsSync(join(fixture.markerDirectory, "tccutil.log"))).toBeFalse();
    expect(readFileSync(join(fixture.markerDirectory, "xcrun.log"), "utf8")).toContain(
      "stapler validate",
    );
    const rollbackDirectory = join(fixture.home, ".hasna", "recordings", "rollbacks");
    expect(readdirSync(rollbackDirectory).some((entry) => entry.endsWith(".zip"))).toBeTrue();
    expect(readdirSync(rollbackDirectory).some((entry) => entry.endsWith(".app"))).toBeFalse();
  });

  test("requires an explicit one-time override for a signing identity migration", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    createApp(installedApp, "ad-hoc-installed");

    const result = await runInstaller(fixture, ["--allow-signing-identity-migration"], {
      SIGNATURES_COMPATIBLE: "0",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("one-time permission approval");
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
  });

  test("uses the legacy hidden app as the identity baseline during path migration", async () => {
    const fixture = createInstallerFixture();
    const legacyApp = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    createApp(legacyApp, "legacy");

    const result = await runInstaller(fixture, [], { SIGNATURES_COMPATIBLE: "0" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("signing identity");
    expect(readFileSync(join(legacyApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "legacy",
    );
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("requires migration approval when any discovered app identity is incompatible", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    const legacyApp = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    createApp(installedApp, "installed");
    createApp(legacyApp, "legacy");

    const result = await runInstaller(fixture, [], {
      INCOMPATIBLE_REQUIREMENT_TOKEN: "LEGACY",
      SIGNATURES_COMPATIBLE: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("signing identity");
    expect(existsSync(installedApp)).toBeTrue();
    expect(existsSync(legacyApp)).toBeTrue();
  });

  test("archives and removes discoverable rollback app bundles", async () => {
    const fixture = createInstallerFixture();
    const discoverableRollback = join(
      fixture.home,
      "Applications",
      "Recordings.app.rollback-pre-update",
    );
    createApp(discoverableRollback, "rollback");

    const result = await runInstaller(fixture, [], { SIGNATURES_COMPATIBLE: "1" });

    expect(result.exitCode).toBe(0);
    expect(existsSync(discoverableRollback)).toBeFalse();
    const rollbackDirectory = join(fixture.home, ".hasna", "recordings", "rollbacks");
    expect(readdirSync(rollbackDirectory).some((entry) => entry.endsWith(".zip"))).toBeTrue();
  });

  test("restores the prior app when post-copy signature verification fails", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    createApp(installedApp, "installed");

    const result = await runInstaller(fixture, [], {
      FAIL_CANONICAL_VERIFY: "1",
      SIGNATURES_COMPATIBLE: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
  });

  test("restores the prior app when installation is interrupted after moving it", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    createApp(installedApp, "installed");

    const result = await runInstaller(fixture, [], {
      INTERRUPT_AFTER_PREVIOUS_MOVE: "1",
      SIGNATURES_COMPATIBLE: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
  });

  test("launches and verifies the exact canonical executable when requested", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    const executable = join(installedApp, "Contents", "MacOS", "Recordings");

    const result = await runInstaller(fixture, ["--launch"], {
      PROCESS_PATH: executable,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(fixture.markerDirectory, "open.log"), "utf8").trim()).toBe(
      `-n ${installedApp}`,
    );
    expect(result.stdout).toContain(`Started Recordings.app from ${installedApp}`);
  });

  test("stops only the captured app PID and leaves unrelated processes alive", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    const executable = join(installedApp, "Contents", "MacOS", "Recordings");
    createApp(installedApp, "installed");
    const existingProcess = Bun.spawn(["sleep", "30"]);
    const unrelatedProcess = Bun.spawn(["sleep", "30"]);

    try {
      const result = await runInstaller(fixture, ["--launch"], {
        EXISTING_PID: String(existingProcess.pid),
        EXISTING_PROCESS_PATH: executable,
        PROCESS_PATH: executable,
        SIGNATURES_COMPATIBLE: "1",
        UNRELATED_PID: String(unrelatedProcess.pid),
        UNRELATED_PROCESS_PATH: "/opt/unrelated/Recordings",
      });

      expect(result.exitCode).toBe(0);
      expect(await existingProcess.exited).not.toBe(0);
      expect(() => process.kill(unrelatedProcess.pid, 0)).not.toThrow();
    } finally {
      unrelatedProcess.kill();
      await unrelatedProcess.exited;
    }
  });

  test("restarts the committed canonical app when legacy archival fails", async () => {
    const fixture = createInstallerFixture();
    const installedApp = join(fixture.home, "Applications", "Recordings.app");
    const legacyApp = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    const executable = join(installedApp, "Contents", "MacOS", "Recordings");
    createApp(installedApp, "installed");
    createApp(legacyApp, "legacy");
    const existingProcess = Bun.spawn(["sleep", "30"]);

    const result = await runInstaller(fixture, [], {
      EXISTING_PID: String(existingProcess.pid),
      EXISTING_PROCESS_PATH: executable,
      FAIL_LEGACY_ARCHIVE: "1",
      SIGNATURES_COMPATIBLE: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(await existingProcess.exited).not.toBe(0);
    expect(readFileSync(join(installedApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(readFileSync(join(fixture.markerDirectory, "open.log"), "utf8").trim()).toBe(
      `-n ${installedApp}`,
    );
  });
});

describe("macOS release signing contract", () => {
  function createBuildFixture(): {
    root: string;
    buildDirectory: string;
    bin: string;
    markerDirectory: string;
  } {
    const root = temporaryDirectory("recordings-build-");
    const buildDirectory = join(root, "src", "native", "Recordings");
    const bin = join(root, "bin");
    const markerDirectory = join(root, "markers");
    mkdirSync(join(buildDirectory, "RecordingsLib"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(markerDirectory, { recursive: true });
    cpSync(
      join(repositoryRoot, "src", "native", "Recordings", "build.sh"),
      join(buildDirectory, "build.sh"),
    );
    chmodSync(join(buildDirectory, "build.sh"), 0o755);
    writeFileSync(join(buildDirectory, "RecordingsLib", "Info.plist"), "<plist><dict/></plist>\n");
    writeFileSync(
      join(buildDirectory, "RecordingsLib", "Recordings.entitlements"),
      "<plist><dict/></plist>\n",
    );
    writeExecutable(
      join(root, "scripts", "build_companion_cli.sh"),
      "#!/usr/bin/env bash\nmkdir -p \"$(dirname \"$1\")\"\nprintf companion > \"$1\"\nchmod +x \"$1\"\n",
    );
    writeExecutable(
      join(bin, "swift"),
      `#!/usr/bin/env bash
set -euo pipefail
mode=release
while [ "$#" -gt 0 ]; do
  if [ "$1" = -c ]; then mode="$2"; shift 2; else shift; fi
done
mkdir -p ".build/$mode"
printf binary > ".build/$mode/App"
chmod +x ".build/$mode/App"
`,
    );
    writeExecutable(
      join(bin, "codesign"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/codesign.log\"\nexit 0\n",
    );
    writeExecutable(
      join(bin, "ditto"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-c" ]; then
  printf archive > "\${@: -1}"
else
  cp -R "$1" "$2"
fi
`,
    );
    writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(
      join(bin, "xcrun"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/xcrun.log\"\nexit 0\n",
    );
    return { root, buildDirectory, bin, markerDirectory };
  }

  async function runBuild(
    fixture: ReturnType<typeof createBuildFixture>,
    mode: "debug" | "release",
    extraEnvironment: Record<string, string> = {},
  ) {
    const process = Bun.spawn(["bash", join(fixture.buildDirectory, "build.sh"), mode], {
      cwd: fixture.buildDirectory,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markerDirectory,
        ...extraEnvironment,
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

  test("fails a release build closed when no stable signing identity is configured", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture, "release");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("RECORDINGS_CODESIGN_IDENTITY");
  });

  test("fails a release build closed when notarization credentials are unavailable", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture, "release", {
      RECORDINGS_CODESIGN_IDENTITY: "Developer ID Application: Example Corp (EXAMPLE123)",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("RECORDINGS_NOTARY_KEYCHAIN_PROFILE");
  });

  test("uses hardened runtime and a timestamp for configured release signing", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture, "release", {
      RECORDINGS_CODESIGN_IDENTITY: "Developer ID Application: Example Corp (EXAMPLE123)",
      RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "recordings-notary",
    });

    expect(result.exitCode).toBe(0);
    const signingInvocation = readFileSync(join(fixture.markerDirectory, "codesign.log"), "utf8");
    expect(signingInvocation).toContain("--options runtime");
    expect(signingInvocation).toContain("--timestamp");
    expect(signingInvocation).not.toContain("--sign -");
    const signingLines = signingInvocation.trim().split("\n");
    expect(signingLines[0]).toContain("Contents/Helpers/recordings");
    expect(signingLines.some((line) => line.endsWith("Recordings.app"))).toBeTrue();
    const notarizationInvocation = readFileSync(join(fixture.markerDirectory, "xcrun.log"), "utf8");
    expect(notarizationInvocation).toContain("notarytool submit");
    expect(notarizationInvocation).toContain("stapler staple");
  });
});
