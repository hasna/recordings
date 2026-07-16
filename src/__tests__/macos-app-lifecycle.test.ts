import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const bunExecutable = process.execPath;
const targetPlatformIdentity = "11111111-1111-4111-8111-111111111111";
const builderPlatformIdentity = "22222222-2222-4222-8222-222222222222";
const targetTailscaleNodeId = "n-target-station06";
const builderTailscaleNodeId = "n-builder-station05";
const targetIdentitySha256 = Bun.CryptoHasher.hash("sha256", targetPlatformIdentity, "hex");
const targetTailscaleIdentitySha256 = Bun.CryptoHasher.hash(
  "sha256",
  targetTailscaleNodeId,
  "hex",
);
const builderIdentitySha256 = Bun.CryptoHasher.hash("sha256", builderTailscaleNodeId, "hex");
const temporaryPaths: string[] = [];
setDefaultTimeout(15_000);

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

function overrideFixtureTailscaleAppCli(root: string, fallbackPath: string): void {
  const resolver = join(root, "scripts", "resolve_tailscale_cli.sh");
  const source = readFileSync(resolver, "utf8");
  const standardPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  expect(source).toContain(standardPath);
  const pathLookup = 'candidate="$(builtin type -P tailscale 2>/dev/null || true)"';
  expect(source).toContain(pathLookup);
  writeFileSync(
    resolver,
    source.replace(standardPath, fallbackPath).replace(pathLookup, 'candidate=""'),
  );
}

function createApp(path: string, marker: string): void {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(path, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "Recordings"), marker);
  writeFileSync(join(path, "Contents", "Helpers", "recordings"), "companion");
  chmodSync(join(path, "Contents", "MacOS", "Recordings"), 0o755);
  chmodSync(join(path, "Contents", "Helpers", "recordings"), 0o755);
  for (const directory of [path, join(path, "Contents"), join(path, "Contents", "MacOS"), join(path, "Contents", "Helpers")]) {
    chmodSync(directory, 0o755);
  }
}

function createInstallerFixture() {
  const root = temporaryDirectory("recordings-installer-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const markers = join(root, "markers");
  const candidate = join(root, "candidate", "Recordings.app");
  const artifact = join(root, "Recordings-0.2.12-macos.zip");
  const manifest = join(root, "Recordings-0.2.12-macos.manifest.json");
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
  cpSync(
    join(repositoryRoot, "scripts", "resolve_tailscale_cli.sh"),
    join(root, "scripts", "resolve_tailscale_cli.sh"),
  );
  writeExecutable(
    join(root, "scripts", "smoke_macos_app.sh"),
    "#!/usr/bin/env bash\n[ \"${FAIL_RUNTIME_SMOKE:-0}\" = 0 ] || exit 1\nprintf '%s\\n' \"$1\" >> \"$MARKER_DIRECTORY/runtime-smoke.log\"\n",
  );

  writeExecutable(join(bin, "uname"), "#!/usr/bin/env bash\nif [ \"${1:-}\" = -m ]; then printf 'arm64\\n'; else printf 'Darwin\\n'; fi\n");
  writeExecutable(join(bin, "hostname"), "#!/usr/bin/env bash\nprintf '%s\\n' \"${FIXTURE_HOSTNAME:-station06}\"\n");
  writeExecutable(
    join(bin, "ioreg"),
    `#!/usr/bin/env bash
printf '    "IOPlatformUUID" = "%s"\n' "\${FIXTURE_PLATFORM_IDENTITY:-${targetPlatformIdentity}}"
`,
  );
  writeExecutable(
    join(bin, "tailscale"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$0" >> "$MARKER_DIRECTORY/tailscale.log"
[ "\${FAIL_TAILSCALE_STATUS:-0}" = 0 ] || exit 1
if [ -n "\${TAILSCALE_STATUS_JSON:-}" ]; then
  printf '%s\n' "$TAILSCALE_STATUS_JSON"
else
  printf '%s\n' '{"Self":{"Online":true,"HostName":"station06","ID":"${targetTailscaleNodeId}"}}'
fi
`,
  );
  writeExecutable(join(bin, "sw_vers"), "#!/usr/bin/env bash\nprintf '26.0\\n'\n");
  writeExecutable(
    join(bin, "stat"),
    "#!/usr/bin/env bash\ncase \"${2:-}\" in '%u') id -u ;; '%m') date +%s ;; '%Lp') case \"${3:-}\" in */owner|*/.Recordings-install-transaction.json) printf '600\\n' ;; *) printf '700\\n' ;; esac ;; *) printf '700\\n' ;; esac\n",
  );
  writeExecutable(join(bin, "ls"), "#!/usr/bin/env bash\nprintf 'drwx------ fixture\\n'\n");
  writeExecutable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/bun.log"
case "$*" in
  *" journal-write "*"--phase committed"*)
    [ "\${FAIL_COMMITTED_JOURNAL:-0}" = 1 ] && exit 1
    exec "$REAL_BUN" "$@"
    ;;
  *" journal-write "*|*" journal-get "*|*" journal-recover "*|*" tree-digest "*)
    exec "$REAL_BUN" "$@"
    ;;
  *" tailscale-node-id-sha256 "*) exec "$REAL_BUN" "$@" ;;
  *" manifest-get "*"--field builder_identity_kind"*) printf '%s\n' "\${REQUIRED_BUILDER_IDENTITY_KIND:-none}"; exit 0 ;;
  *" manifest-get "*"--field minimum_macos"*) printf '26.0\n'; exit 0 ;;
  *" manifest-get "*"--field architectures"*) printf 'arm64\n'; exit 0 ;;
  *" manifest-get "*"--field identity"*) printf '%064d\n' 0 | tr '0' c; exit 0 ;;
  *" requirement-digest "*)
    if [ "\${NO_DESIGNATED_REQUIREMENT:-0}" = 1 ]; then
      [[ "$*" == *"--artifact-policy local_only"* ]] || exit 1
    fi
    if [[ "$*" == *"/unpacked/"* ]] || [[ "$*" == *"/.Recordings-install-"* ]]; then
      printf '%064d\n' 0 | tr '0' c
    else
      printf '%064d\n' 0 | tr '0' d
    fi
    exit 0
    ;;
  *" assert-transition "*|*" verify-filesystem-tree "*|*" fsync-tree "*|*" fsync-directory "*) exit 0 ;;
  *" verify-active "*) [ "\${FAIL_ACTIVE_VERIFY:-0}" = 0 ]; exit $? ;;
  *" verify-archive "*)
    [ "\${FAIL_ARCHIVE_VERIFY:-0}" = 1 ] && exit 1
    [[ "$*" == *"--team-id \${REQUIRED_TEAM_ID:-EXAMPLE123}"* ]] || exit 1
    [ -z "\${REQUIRED_ARTIFACT_POLICY:-}" ] || [[ "$*" == *"--artifact-policy $REQUIRED_ARTIFACT_POLICY"* ]] || exit 1
    [ -z "\${REQUIRED_APPROVED_TARGET:-}" ] || [[ "$*" == *"--approved-target $REQUIRED_APPROVED_TARGET"* ]] || exit 1
    [ -z "\${REQUIRED_APPROVED_TARGET_IDENTITY_KIND:-}" ] || [[ "$*" == *"--approved-target-identity-kind $REQUIRED_APPROVED_TARGET_IDENTITY_KIND"* ]] || exit 1
    [ -z "\${REQUIRED_APPROVED_TARGET_IDENTITY:-}" ] || [[ "$*" == *"--approved-target-identity-sha256 $REQUIRED_APPROVED_TARGET_IDENTITY"* ]] || exit 1
    ;;
  *" verify-app "*)
    [ "\${FAIL_APP_VERIFY:-0}" = 1 ] && exit 1
    [ "\${MISSING_TIMESTAMP:-0}" = 1 ] && exit 1
    ;;
  -e*) exec "$REAL_BUN" "$@" ;;
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
  [ "\${NO_DESIGNATED_REQUIREMENT:-0}" = 1 ] && exit 0
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
  writeExecutable(join(bin, "xcrun"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/xcrun.log\"\nexit 0\n");
  writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/spctl.log\"\nexit 0\n");
  writeExecutable(join(bin, "syspolicy_check"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/syspolicy.log\"\nexit 0\n");
  writeExecutable(
    join(bin, "df"),
    "#!/usr/bin/env bash\nif [ -n \"${AVAILABLE_KB:-}\" ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 100000 1 %s 1%% /\\n' \"$AVAILABLE_KB\"; else exec /bin/df \"$@\"; fi\n",
  );
  writeExecutable(
    join(bin, "mdfind"),
    "#!/usr/bin/env bash\n[ -n \"${MDFIND_RESULT:-}\" ] && printf '%s\\n' \"$MDFIND_RESULT\"\n",
  );
  writeExecutable(
    join(bin, "open"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/open.log"
if [ "\${SPAWN_LAUNCHED_PROCESS:-0}" = 1 ]; then
  bash -c 'exec -a "$1" sleep 30' _ "$CANONICAL_EXECUTABLE" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$MARKER_DIRECTORY/launched.pid"
  printf '%s\n' "$!" >> "$MARKER_DIRECTORY/launched-pids.log"
fi
`,
  );
  writeExecutable(
    join(bin, "ps"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-o" ] && [ "\${2:-}" = "lstart=" ]; then exec /bin/ps "$@"; fi
if [ ! -e "$MARKER_DIRECTORY/open.log" ]; then
  [ -n "\${EXISTING_PID:-}" ] && printf '%s %s\n' "$EXISTING_PID" "$EXISTING_PROCESS_PATH"
  [ -n "\${UNRELATED_PID:-}" ] && printf '%s %s\n' "$UNRELATED_PID" "$UNRELATED_PROCESS_PATH"
elif [ "\${LAUNCH_SUCCEEDS:-1}" = 1 ]; then
  if [ "\${SPAWN_LAUNCHED_PROCESS:-0}" = 1 ] && [ -f "$MARKER_DIRECTORY/launched.pid" ]; then
    launched_pid="$(sed -n '1p' "$MARKER_DIRECTORY/launched.pid")"
    if kill -0 "$launched_pid" 2>/dev/null; then printf '%s %s\n' "$launched_pid" "$CANONICAL_EXECUTABLE"; fi
  else
    printf '99999 %s\n' "$CANONICAL_EXECUTABLE"
  fi
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
  const localPolicy = args.includes("local-only") || args.includes("local_only");
  const process = Bun.spawn(
    [
      "bash",
      join(fixture.root, "scripts", "install_macos_app.sh"),
      "--artifact",
      fixture.artifact,
      "--manifest",
      fixture.manifest,
      "--manifest-sha256",
      "a".repeat(64),
      "--expected-source-sha",
      "b".repeat(40),
      "--expected-version",
      "0.2.12",
      ...(localPolicy ? [] : ["--expected-team-id", "EXAMPLE123"]),
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
        REAL_BUN: bunExecutable,
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

async function runLocalInstaller(
  fixture: ReturnType<typeof createInstallerFixture>,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  return runInstaller(
    fixture,
    [
      "--artifact-policy",
      "local-only",
      "--approved-target",
      "station06",
      "--approved-target-identity-sha256",
      targetIdentitySha256,
      "--acknowledge-local-signing-and-permissions",
      ...args,
    ],
    {
      REQUIRED_TEAM_ID: "ADHOC",
      REQUIRED_ARTIFACT_POLICY: "local_only",
      REQUIRED_APPROVED_TARGET: "station06",
      REQUIRED_APPROVED_TARGET_IDENTITY: targetIdentitySha256,
      REQUIRED_BUILDER_IDENTITY_KIND: "hardware_uuid_sha256",
      ...environment,
    },
  );
}

async function runTailscaleLocalInstaller(
  fixture: ReturnType<typeof createInstallerFixture>,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  return runInstaller(
    fixture,
    [
      "--artifact-policy",
      "local-only",
      "--approved-target",
      "station06",
      "--approved-target-identity-kind",
      "tailscale_node_id_sha256",
      "--approved-target-identity-sha256",
      targetTailscaleIdentitySha256,
      "--acknowledge-local-signing-and-permissions",
      ...args,
    ],
    {
      REQUIRED_TEAM_ID: "ADHOC",
      REQUIRED_ARTIFACT_POLICY: "local_only",
      REQUIRED_APPROVED_TARGET: "station06",
      REQUIRED_APPROVED_TARGET_IDENTITY_KIND: "tailscale_node_id_sha256",
      REQUIRED_BUILDER_IDENTITY_KIND: "tailscale_node_id_sha256",
      REQUIRED_APPROVED_TARGET_IDENTITY: targetTailscaleIdentitySha256,
      ...environment,
    },
  );
}

describe("macOS finalized artifact installer", () => {
  test("rejects non-macOS invocation before inspecting artifact paths", async () => {
    const fixture = createInstallerFixture();
    writeExecutable(join(fixture.bin, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n");
    rmSync(fixture.artifact);
    rmSync(fixture.manifest);

    const result = await runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("only supported on macOS");
    expect(result.stderr).not.toContain("does not exist");
  });

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

  test("local-only install has no silent fallback from the release policy", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], {
      REQUIRED_TEAM_ID: "ADHOC",
      REQUIRED_ARTIFACT_POLICY: "local_only",
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("release install rejects a local target identity kind before verification or mutation", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [
      "--approved-target-identity-kind",
      "tailscale_node_id_sha256",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("do not accept a local-only target identity kind");
    expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
  });

  test("local-only install requires permission acknowledgment and the exact live target", async () => {
    const missingAcknowledgment = createInstallerFixture();
    const noAck = await runInstaller(
      missingAcknowledgment,
      [
        "--artifact-policy",
        "local-only",
        "--approved-target",
        "station06",
        "--approved-target-identity-sha256",
        targetIdentitySha256,
      ],
      { REQUIRED_TEAM_ID: "ADHOC" },
    );
    expect(noAck.exitCode).toBe(2);
    expect(noAck.stderr).toContain("acknowledge-local-signing-and-permissions");
    expect(existsSync(join(missingAcknowledgment.markers, "bun.log"))).toBeFalse();

    const wrongTarget = createInstallerFixture();
    const mismatch = await runLocalInstaller(wrongTarget, [], { FIXTURE_HOSTNAME: "station05" });
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match this Mac");
    expect(existsSync(join(wrongTarget.markers, "bun.log"))).toBeFalse();

    const renamedTarget = createInstallerFixture();
    const wrongIdentity = await runLocalInstaller(renamedTarget, [], {
      FIXTURE_PLATFORM_IDENTITY: builderPlatformIdentity,
    });
    expect(wrongIdentity.exitCode).not.toBe(0);
    expect(wrongIdentity.stderr).toContain("approved machine identity");
    expect(existsSync(join(renamedTarget.markers, "bun.log"))).toBeFalse();

    const releaseFlags = createInstallerFixture();
    const invalidMigration = await runLocalInstaller(releaseFlags, [
      "--allow-signing-identity-migration",
      "--expected-old-identity-sha256",
      "a".repeat(64),
      "--expected-new-identity-sha256",
      "b".repeat(64),
    ]);
    expect(invalidMigration.exitCode).toBe(2);
    expect(invalidMigration.stderr).toContain("not valid for local-only artifacts");
    expect(existsSync(join(releaseFlags.markers, "bun.log"))).toBeFalse();

    const standaloneDigest = createInstallerFixture();
    const droppedFlag = await runLocalInstaller(standaloneDigest, [
      "--expected-old-identity-sha256",
      "a".repeat(64),
    ]);
    expect(droppedFlag.exitCode).toBe(2);
    expect(droppedFlag.stderr).toContain("not valid for local-only artifacts");

    const wrongTeam = createInstallerFixture();
    const teamMismatch = await runLocalInstaller(wrongTeam, ["--expected-team-id", "EXAMPLE123"]);
    expect(teamMismatch.exitCode).toBe(2);
    expect(teamMismatch.stderr).toContain("do not accept --expected-team-id");
  });

  test("Tailscale-bound local install verifies live Self before creating install state", async () => {
    const fixture = createInstallerFixture();
    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim()).toBe(
      join(fixture.bin, "tailscale"),
    );
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8")).toContain(
      "tailscale-node-id-sha256 --expected-hostname station06",
    );
  });

  test("Tailscale-bound local install invokes a PATH CLI whose path contains spaces", async () => {
    const fixture = createInstallerFixture();
    const spacedBin = join(fixture.root, "Tailscale CLI bin");
    mkdirSync(spacedBin, { recursive: true });
    cpSync(join(fixture.bin, "tailscale"), join(spacedBin, "tailscale"));
    chmodSync(join(spacedBin, "tailscale"), 0o755);
    rmSync(join(fixture.bin, "tailscale"));

    const result = await runTailscaleLocalInstaller(fixture, [], {
      PATH: `${spacedBin}:${fixture.bin}:${Bun.env.PATH ?? ""}`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim()).toBe(
      join(spacedBin, "tailscale"),
    );
  });

  test("Tailscale-bound local install uses the standard app CLI fallback", async () => {
    const fixture = createInstallerFixture();
    const fallback = join(fixture.root, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    cpSync(join(fixture.bin, "tailscale"), fallback);
    chmodSync(fallback, 0o755);
    rmSync(join(fixture.bin, "tailscale"));
    overrideFixtureTailscaleAppCli(fixture.root, fallback);

    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim()).toBe(fallback);
  });

  test("Tailscale-bound local install rejects a non-executable app fallback before mutation", async () => {
    const fixture = createInstallerFixture();
    const fallback = join(fixture.root, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, "not executable\n");
    chmodSync(fallback, 0o644);
    rmSync(join(fixture.bin, "tailscale"));
    overrideFixtureTailscaleAppCli(fixture.root, fallback);

    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not an executable file");
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("Tailscale-bound local install fails closed when Tailscale is missing", async () => {
    const fixture = createInstallerFixture();
    rmSync(join(fixture.bin, "tailscale"));
    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("Tailscale-bound local install fails closed when the packaged resolver is missing", async () => {
    const fixture = createInstallerFixture();
    rmSync(join(fixture.root, "scripts", "resolve_tailscale_cli.sh"));
    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Packaged Tailscale CLI resolver is missing");
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test.each([
    ["failed status", "", { FAIL_TAILSCALE_STATUS: "1" }],
    ["malformed status", "{", {}],
    ["missing Self", "{}", {}],
    ["malformed Self", '{"Self":[]}', {}],
    ["stale Self", '{"Self":{"Online":false,"HostName":"station06","ID":"n-target-station06"}}', {}],
    ["wrong Self", '{"Self":{"Online":true,"HostName":"station05","ID":"n-target-station06"}}', {}],
    ["StableID-only Self", '{"Self":{"Online":true,"HostName":"station06","StableID":"nodeid:legacy"}}', {}],
    ["missing ID", '{"Self":{"Online":true,"HostName":"station06"}}', {}],
    ["hash mismatch", '{"Self":{"Online":true,"HostName":"station06","ID":"n-other"}}', {}],
  ])("Tailscale-bound local install fails closed for %s", async (_label, statusJson, environment) => {
    const fixture = createInstallerFixture();
    const result = await runTailscaleLocalInstaller(fixture, [], {
      ...(statusJson ? { TAILSCALE_STATUS_JSON: statusJson } : {}),
      ...environment,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("installs an explicit local-only artifact transactionally without release-trust claims", async () => {
    const fixture = createInstallerFixture();
    const stateDir = join(fixture.home, ".hasna", "recordings");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "recordings.db"), "preserve-me");
    const result = await runLocalInstaller(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed local-only Recordings.app for station06");
    expect(result.stdout).toContain("may require manual reauthorization");
    expect(readFileSync(join(stateDir, "recordings.db"), "utf8")).toBe("preserve-me");
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeTrue();
    expect(existsSync(join(fixture.markers, "xcrun.log"))).toBeFalse();
    expect(existsSync(join(fixture.markers, "spctl.log"))).toBeFalse();
    expect(existsSync(join(fixture.markers, "syspolicy.log"))).toBeFalse();
    const installer = readFileSync(join(repositoryRoot, "scripts", "install_macos_app.sh"), "utf8");
    expect(installer).not.toContain("tccutil");
    expect(installer).not.toContain("quarantine");
  });

  test("accepts verified ad-hoc local apps without a textual designated requirement", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runLocalInstaller(fixture, [], { NO_DESIGNATED_REQUIREMENT: "1" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    const bunLog = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(bunLog).toContain("requirement-digest");
    expect(bunLog).toContain("--artifact-policy local_only");
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).not.toContain(" -R ");
  });

  test("rejects release apps without a textual designated requirement", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], { NO_DESIGNATED_REQUIREMENT: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Candidate app has no designated requirement");
    expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
  });

  test("rolls back app and state when local-only postactivation verification fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const stateDir = join(fixture.home, ".hasna", "recordings");
    createApp(installed, "installed");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "recordings.db"), "original-state");
    const result = await runLocalInstaller(fixture, [], { FAIL_ACTIVE_VERIFY: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(readFileSync(join(stateDir, "recordings.db"), "utf8")).toBe("original-state");
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
    expect(readFileSync(join(fixture.markers, "runtime-smoke.log"), "utf8")).toContain(installed);
    expect(readFileSync(join(fixture.markers, "syspolicy.log"), "utf8")).toContain(installed);
  });

  test("recovers a SIGKILL after candidate activation and restores app plus external state", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const stateFile = join(fixture.home, ".hasna", "recordings", "config.json");
    createApp(installed, "installed");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, "original-state\n");

    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeTrue();
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    writeFileSync(stateFile, "mutated-after-crash\n");

    const recovered = await runInstaller(fixture, [], {
      FAIL_ARCHIVE_VERIFY: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(readFileSync(stateFile, "utf8")).toBe("original-state\n");
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeFalse();
  });

  test("stops a launched uncommitted candidate before restoring the previous app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const crashed = await runInstaller(fixture, ["--launch", "--launch-timeout", "2"], {
      SPAWN_LAUNCHED_PROCESS: "1",
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-launched-before-commit",
    });
    expect(crashed.exitCode).not.toBe(0);
    const launchedPid = Number(readFileSync(join(fixture.markers, "launched.pid"), "utf8").trim());
    expect(() => process.kill(launchedPid, 0)).not.toThrow();

    const recovered = await runInstaller(fixture, [], {
      SPAWN_LAUNCHED_PROCESS: "1",
      FAIL_ARCHIVE_VERIFY: "1",
    });
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(() => process.kill(launchedPid, 0)).toThrow();
  });

  test("same-process rollback stops a launched candidate when committed journal write fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const prior = Bun.spawn(["sleep", "30"]);
    try {
      const result = await runInstaller(fixture, ["--launch", "--launch-timeout", "2"], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        SPAWN_LAUNCHED_PROCESS: "1",
        FAIL_COMMITTED_JOURNAL: "1",
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
      const pids = readFileSync(join(fixture.markers, "launched-pids.log"), "utf8")
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(2);
      expect(() => process.kill(pids[0]!, 0)).toThrow();
      expect(() => process.kill(pids[1]!, 0)).not.toThrow();
      process.kill(pids[1]!);
    } finally {
      prior.kill();
      await prior.exited;
    }
  });

  test("committed crash recovery does not launch a second canonical instance", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const prior = Bun.spawn(["sleep", "30"]);
    let launchedPid = 0;
    try {
      const crashed = await runInstaller(fixture, ["--launch", "--launch-timeout", "2"], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        SPAWN_LAUNCHED_PROCESS: "1",
        RECORDINGS_TEST_CRASH_AFTER_PHASE: "committed",
      });
      expect(crashed.exitCode).not.toBe(0);
      launchedPid = Number(readFileSync(join(fixture.markers, "launched.pid"), "utf8").trim());
      const recovered = await runInstaller(fixture, [], {
        SPAWN_LAUNCHED_PROCESS: "1",
        FAIL_ARCHIVE_VERIFY: "1",
      });
      expect(recovered.stderr).toContain("Recovering incomplete");
      expect(readFileSync(join(fixture.markers, "launched-pids.log"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(() => process.kill(launchedPid, 0)).not.toThrow();
    } finally {
      if (launchedPid) process.kill(launchedPid);
      prior.kill();
      await prior.exited;
    }
  });

  test("recovery rejects a journal redirected to a noncanonical state directory", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const victim = join(fixture.root, "victim-state");
    createApp(installed, "installed");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "keep\n");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.data_dir = victim;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });

    const recovered = await runInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("unexpected state directory");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("recovery fails closed before mutation when the state backup digest changes", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings", "config.json");
    createApp(installed, "installed");
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, "original\n");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { state_backup: string };
    writeFileSync(join(journal.state_backup, "config.json"), "corrupt\n");

    const recovered = await runInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("state backup integrity check failed");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("a crash during stopped-state refresh recovers from the immutable initial backup", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const prior = Bun.spawn(["sleep", "30"]);
    try {
      const crashed = await runInstaller(fixture, [], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        RECORDINGS_TEST_CRASH_AFTER_PHASE: "state-refresh-copied-before-journal",
      });
      expect(crashed.exitCode).not.toBe(0);
      rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });
      const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
      expect(recovered.stderr).toContain("Recovering incomplete");
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
      expect(readFileSync(join(fixture.markers, "open.log"), "utf8")).toContain(installed);
    } finally {
      prior.kill();
      await prior.exited;
    }
  });

  test("recovery fails closed before restoring a modified original app backup", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      originals: Array<{ backup: string }>;
    };
    writeFileSync(join(journal.originals[0]!.backup, "Contents", "MacOS", "Recordings"), "tampered");
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });

    const recovered = await runInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("app backup integrity check failed");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("recovery refuses a missing original app backup before removing the candidate", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      originals: Array<{ backup: string }>;
    };
    rmSync(journal.originals[0]!.backup, { recursive: true });
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });

    const recovered = await runInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("app backup is missing");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
  });

  test("recovery refuses a missing noncommitted transaction directory before mutation", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { transaction_dir: string };
    rmSync(journal.transaction_dir, { recursive: true });
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });

    const recovered = await runInstaller(fixture);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("recovery evidence is missing");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
  });

  test("recovery replays after a crash between restoring canonical and duplicate apps", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const duplicate = join(fixture.home, ".hasna", "recordings", "Recordings.app");
    createApp(installed, "installed");
    createApp(duplicate, "duplicate");
    await runInstaller(fixture, [], { RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed" });
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });

    const interrupted = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_RECOVERY_AFTER_APP_RESTORES: "1",
    });
    expect(interrupted.exitCode).not.toBe(0);
    expect(existsSync(installed)).toBeFalse();
    expect(readFileSync(join(duplicate, "Contents", "MacOS", "Recordings"), "utf8")).toBe("duplicate");

    const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(readFileSync(join(duplicate, "Contents", "MacOS", "Recordings"), "utf8")).toBe("duplicate");
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeFalse();
  });

  test("first-install SIGKILL after candidate move removes the uncommitted app on recovery", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-moved-before-journal",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");

    const recovered = await runInstaller(fixture, [], {
      FAIL_ARCHIVE_VERIFY: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(existsSync(installed)).toBeFalse();
  });

  test("candidate-moving recovery stops an externally launched uncommitted process", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-moved-before-journal",
    });
    expect(crashed.exitCode).not.toBe(0);
    const launched = Bun.spawn(
      ["bash", "-c", 'exec -a "$1" sleep 30', "_", join(installed, "Contents", "MacOS", "Recordings")],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(join(fixture.markers, "open.log"), "external launch\n");
    writeFileSync(join(fixture.markers, "launched.pid"), `${launched.pid}\n`);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), { recursive: true });
    try {
      const recovered = await runInstaller(fixture, [], {
        SPAWN_LAUNCHED_PROCESS: "1",
        FAIL_ARCHIVE_VERIFY: "1",
      });
      expect(recovered.stderr).toContain("Recovering incomplete");
      expect(() => process.kill(launched.pid, 0)).toThrow();
      expect(existsSync(installed)).toBeFalse();
    } finally {
      launched.kill();
      await launched.exited;
    }
  });

  test("active installer lock rejects a second writer before artifact mutation", async () => {
    const fixture = createInstallerFixture();
    const lock = join(fixture.home, "Applications", ".Recordings-install-lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "owner"), `${process.pid}\n\n`, { mode: 0o600 });
    const result = await runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("owns the active install lock");
    expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
  });

  test("an actual concurrent installer cannot enter verification while the first owns the lock", async () => {
    const fixture = createInstallerFixture();
    const installer = join(fixture.root, "scripts", "install_macos_app.sh");
    const first = Bun.spawn([
      "bash", installer,
      "--artifact", fixture.artifact,
      "--manifest", fixture.manifest,
      "--expected-team-id", "EXAMPLE123",
      "--manifest-sha256", "a".repeat(64),
      "--expected-source-sha", "b".repeat(40),
      "--expected-version", "0.2.12",
    ], {
      env: {
        ...Bun.env,
        HOME: fixture.home,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        CANDIDATE_SOURCE: fixture.candidate,
        CANONICAL_EXECUTABLE: join(fixture.home, "Applications", "Recordings.app", "Contents", "MacOS", "Recordings"),
        MARKER_DIRECTORY: fixture.markers,
        REAL_BUN: bunExecutable,
        RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS: "30",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const owner = join(fixture.home, "Applications", ".Recordings-install-lock", "owner");
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(owner); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(owner)).toBeTrue();
      const second = await runInstaller(fixture);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("owns the active install lock");
      expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
    } finally {
      first.kill();
      await first.exited;
    }
  });

  test("does not reclaim a recent lock with incomplete owner metadata", async () => {
    const fixture = createInstallerFixture();
    const lock = join(fixture.home, "Applications", ".Recordings-install-lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "owner"), "incomplete\n", { mode: 0o600 });
    const result = await runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("incomplete and too recent");
    expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
  });

  test("rejects a zero incomplete-lock grace", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], { RECORDINGS_LOCK_STALE_SECONDS: "0" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("at least 5 seconds");
    expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
  });

  test("rejects a dangling canonical app symlink before transition handling", async () => {
    const fixture = createInstallerFixture();
    const app = join(fixture.home, "Applications", "Recordings.app");
    mkdirSync(dirname(app), { recursive: true });
    symlinkSync(join(fixture.root, "missing.app"), app);
    const result = await runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a secure directory");
  });

  test("rejects insufficient transaction space before moving an installed app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture, [], { AVAILABLE_KB: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Insufficient free space");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
  });

  test("fsyncs state, app backups, and candidate before advancing durable phases", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture);
    expect(result.exitCode).toBe(0);
    const commands = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(commands.indexOf("fsync-tree")).toBeLessThan(commands.indexOf("journal-write"));
    const movedFsync = commands.indexOf("fsync-tree", commands.indexOf("originals-moving"));
    expect(movedFsync).toBeGreaterThan(commands.indexOf("originals-moving"));
    expect(movedFsync).toBeLessThan(commands.indexOf("originals-moved"));
    const candidateFsync = commands.lastIndexOf("fsync-tree");
    expect(candidateFsync).toBeLessThan(commands.indexOf("candidate-installed"));
  });

  test("rolls back when post-activation packaged helper verification fails", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const result = await runInstaller(fixture, [], { FAIL_ACTIVE_VERIFY: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    const commands = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(commands.indexOf("verify-active")).toBeGreaterThan(commands.indexOf("verify-app"));
  });

  test("runtime smoke rejects evidence from a process that already exited", async () => {
    const fixture = createInstallerFixture();
    const app = join(fixture.root, "smoke", "Recordings.app");
    createApp(app, "app");
    cpSync(
      join(repositoryRoot, "scripts", "smoke_macos_app.sh"),
      join(fixture.root, "scripts", "smoke_macos_app.sh"),
    );
    chmodSync(join(fixture.root, "scripts", "smoke_macos_app.sh"), 0o755);
    writeExecutable(
      join(fixture.bin, "open"),
      `#!/usr/bin/env bash
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--runtime-smoke-output" ]; then output="$2"; break; fi
  shift
done
printf '{"processIdentifier":123}\n' > "$output"
`,
    );
    writeExecutable(join(fixture.bin, "bun"), "#!/usr/bin/env bash\nprintf '123\\n'\n");
    const smoke = Bun.spawn(["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), app], {
      env: { ...Bun.env, PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      smoke.exited,
      new Response(smoke.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("reported a process that is not running");
  });

  test("runtime smoke timeout does not wait forever on a live open process", async () => {
    const fixture = createInstallerFixture();
    const app = join(fixture.root, "smoke-timeout", "Recordings.app");
    createApp(app, "app");
    cpSync(
      join(repositoryRoot, "scripts", "smoke_macos_app.sh"),
      join(fixture.root, "scripts", "smoke_macos_app.sh"),
    );
    const smokeScript = join(fixture.root, "scripts", "smoke_macos_app.sh");
    writeFileSync(
      smokeScript,
      readFileSync(smokeScript, "utf8").replace("SMOKE_MAX_ATTEMPTS=100", "SMOKE_MAX_ATTEMPTS=3"),
    );
    chmodSync(join(fixture.root, "scripts", "smoke_macos_app.sh"), 0o755);
    writeExecutable(
      join(fixture.bin, "open"),
      "#!/usr/bin/env bash\nexec /bin/sleep 30\n",
    );
    writeExecutable(join(fixture.bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(join(fixture.bin, "bun"), "#!/usr/bin/env bash\nexit 1\n");
    const smoke = Bun.spawn(["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), app], {
      env: { ...Bun.env, PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = Bun.sleep(2_000).then(() => "timeout" as const);
    const outcome = await Promise.race([smoke.exited.then((exitCode) => ({ exitCode })), timeout]);
    if (outcome === "timeout") {
      smoke.kill();
      await smoke.exited;
      throw new Error("runtime smoke waited indefinitely for the live open process");
    }
    expect(outcome.exitCode).not.toBe(0);
    expect(await new Response(smoke.stderr).text()).toContain("timed out");
  });

  test("runtime smoke binds evidence to a canonical process path despite symlink drift", async () => {
    const fixture = createInstallerFixture();
    const physicalRelease = join(fixture.root, "physical", "release");
    const driftRelease = join(fixture.root, "drift", "release");
    const releaseLink = join(fixture.root, "linked-release");
    const physicalApp = join(physicalRelease, "Recordings.app");
    createApp(physicalApp, "physical-app");
    createApp(join(driftRelease, "Recordings.app"), "drift-app");
    symlinkSync(physicalRelease, releaseLink, "dir");
    cpSync(
      join(repositoryRoot, "scripts", "smoke_macos_app.sh"),
      join(fixture.root, "scripts", "smoke_macos_app.sh"),
    );
    const smokeScript = join(fixture.root, "scripts", "smoke_macos_app.sh");
    writeFileSync(
      smokeScript,
      readFileSync(smokeScript, "utf8").replace(
        "SMOKE_TERMINATION_ATTEMPTS=50",
        "SMOKE_TERMINATION_ATTEMPTS=3",
      ),
    );
    chmodSync(join(fixture.root, "scripts", "smoke_macos_app.sh"), 0o755);
    const appLog = join(fixture.markers, "opened-apps.log");
    const lsofState = join(fixture.markers, "lsof-state");
    writeExecutable(
      join(fixture.bin, "open"),
      `#!/usr/bin/env bash
app=""
output=""
mode=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -W ]; then app="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke ]; then mode="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-output ]; then output="$2"; shift 2; continue; fi
  shift
done
printf '%s\\n' "$app" >> "$APP_LOG"
/bin/sleep 30 &
app_pid="$!"
printf '%s\\n%s\\n' "$app_pid" "$app/Contents/MacOS/Recordings" > "$LSOF_STATE"
ln -sfn "$DRIFT_TARGET" "$DRIFT_LINK"
if [ "$mode" = normal ]; then
  printf '{"mode":"normal","processIdentifier":%s,"menuBarSurfaceCount":1,"renderedStatusLabels":["Recordings","Recordings, recording","Recordings, transcribing"],"accessibilityObservationStatus":"available","accessibilityMenuBarItemCount":1,"accessibilityMenuBarLabels":["Recordings, transcribing"],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":1,"windowActivationCount":2,"retainedWindowReused":true,"applicationActivationPolicy":0,"applicationIsActive":false,"mainWindowIsVisible":true,"mainWindowCanBecomeKey":true,"mainWindowIsKey":false,"resolvedCompanionPath":null,"companionCapabilitiesPassed":false}\\n' "$app_pid" > "$output"
elif [ "$mode" = resolver ]; then
  printf '{"mode":"resolver","processIdentifier":%s,"menuBarSurfaceCount":0,"renderedStatusLabels":[],"accessibilityObservationStatus":"absent","accessibilityMenuBarItemCount":0,"accessibilityMenuBarLabels":[],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":0,"windowActivationCount":0,"retainedWindowReused":false,"applicationActivationPolicy":1,"applicationIsActive":false,"mainWindowIsVisible":false,"mainWindowCanBecomeKey":false,"mainWindowIsKey":false,"resolvedCompanionPath":"%s/Contents/Helpers/recordings","companionCapabilitiesPassed":true}\\n' "$app_pid" "$app" > "$output"
else
  printf '{"mode":"permission-helper","processIdentifier":%s,"menuBarSurfaceCount":0,"renderedStatusLabels":[],"accessibilityObservationStatus":"absent","accessibilityMenuBarItemCount":0,"accessibilityMenuBarLabels":[],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":0,"windowActivationCount":0,"retainedWindowReused":false,"applicationActivationPolicy":1,"applicationIsActive":false,"mainWindowIsVisible":false,"mainWindowCanBecomeKey":false,"mainWindowIsKey":false,"resolvedCompanionPath":null,"companionCapabilitiesPassed":false}\\n' "$app_pid" > "$output"
fi
wait "$app_pid" 2>/dev/null || true
exec /bin/sleep 30
`,
    );
    writeExecutable(
      join(fixture.bin, "lsof"),
      `#!/usr/bin/env bash
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -p ]; then pid="$2"; break; fi
  shift
done
state_pid="$(sed -n '1p' "$LSOF_STATE")"
executable="$(sed -n '2p' "$LSOF_STATE")"
if [ "$pid" = "$state_pid" ]; then printf 'p%s\\nn%s\\n' "$pid" "$executable"; fi
`,
    );
    writeExecutable(
      join(fixture.bin, "bun"),
      "#!/usr/bin/env bash\nexec \"$REAL_BUN\" \"$@\"\n",
    );
    const baseEnvironment = {
      ...Bun.env,
      PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
      REAL_BUN: bunExecutable,
      APP_LOG: appLog,
      LSOF_STATE: lsofState,
      DRIFT_LINK: releaseLink,
      DRIFT_TARGET: driftRelease,
    };
    delete baseEnvironment.SSH_CONNECTION;
    const spawnSmoke = (env: Record<string, string | undefined>) =>
      Bun.spawn(
        ["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), join(releaseLink, "Recordings.app")],
        { env, stdout: "pipe", stderr: "pipe" },
      );
    const strictSmoke = spawnSmoke(baseEnvironment);
    const [strictExitCode, strictStderr] = await Promise.all([
      strictSmoke.exited,
      new Response(strictSmoke.stderr).text(),
    ]);
    expect(strictExitCode).not.toBe(0);
    expect(strictStderr).toContain("did not make the retained window active and key");
    rmSync(releaseLink);
    symlinkSync(physicalRelease, releaseLink, "dir");
    writeFileSync(appLog, "");
    const smoke = spawnSmoke({ ...baseEnvironment, SSH_CONNECTION: "fixture-authenticated-ssh" });
    const [exitCode, stdout, stderr] = await Promise.all([
      smoke.exited,
      new Response(smoke.stdout).text(),
      new Response(smoke.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"focusEvidenceStatus":"ssh-unavailable"');
    expect(stdout).toContain('"focusEvidenceStatus":"not-applicable"');
    expect(readFileSync(appLog, "utf8").trim().split("\n")).toEqual([
      physicalApp,
      physicalApp,
      physicalApp,
    ]);
    expect(readlinkSync(releaseLink)).toBe(driftRelease);
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
    cpSync(
      join(repositoryRoot, "scripts", "resolve_tailscale_cli.sh"),
      join(root, "scripts", "resolve_tailscale_cli.sh"),
    );
    writeFileSync(join(native, "RecordingsLib", "Info.plist"), "<plist><dict/></plist>\n");
    writeFileSync(join(native, "RecordingsLib", "Recordings.entitlements"), "<plist><dict/></plist>\n");
    cpSync(
      join(repositoryRoot, "src", "native", "Recordings", "RecordingsLib", "RecordingsCLI.entitlements"),
      join(native, "RecordingsLib", "RecordingsCLI.entitlements"),
    );
    writeExecutable(
      join(root, "scripts", "build_companion_cli.sh"),
      `#!/usr/bin/env bash
mkdir -p "$(dirname "$1")"
cat > "$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ -z "\${HASNA_RECORDINGS_API_URL:-}" ] || exit 71
[ -z "\${HASNA_RECORDINGS_API_KEY:-}" ] || exit 71
[ "\${HASNA_RECORDINGS_STORAGE_MODE:-}" = local ] || exit 71
[ "\${RECORDINGS_STORAGE_MODE:-}" = local ] || exit 71
case "\${HASNA_RECORDINGS_DB_PATH:-}" in "$HOME"/*) ;; *) exit 71 ;; esac
[ "$(pwd -P)" = "$(cd "$HOME" && pwd -P)" ] || exit 71
case "\${1:-}" in
  --version) printf '0.2.12\n' ;;
  --json)
    if [ "\${2:-}" = project ] && [ "\${3:-}" = register ]; then
      [ "\${4:-}" = --name ] && [ "\${5:-}" = "Signed Helper Contract" ] || exit 64
      [ "\${6:-}" = --path ] && [ "\${7:-}" = "recordings-app://build/signed-helper-contract" ] || exit 64
      printf '{"id":"smoke-project","name":"Signed Helper Contract","path":"recordings-app://build/signed-helper-contract"}\n'
    elif [ "\${2:-}" = save-text ] && [ "\${3:-}" = "Signed helper contract" ]; then
      [ "\${4:-}" = --source ] && [ "\${5:-}" = native_build_contract ] || exit 64
      [ "\${6:-}" = --post-processing ] && [ "\${7:-}" = off ] || exit 64
      printf '{"id":"smoke-recording","raw_text":"Signed helper contract"}\n'
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
EOF
if [ "\${BREAK_SIGNED_HELPER:-0}" = 1 ]; then
  printf '#!/usr/bin/env bash\nexit 70\n' > "$1"
elif [ "\${MALFORMED_SIGNED_HELPER_OUTPUT:-0}" = 1 ]; then
  cat > "$1" <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then printf '0.2.12\n'; else printf 'Signed Helper Contract Signed helper contract\n'; fi
EOF
fi
chmod +x "$1"
`,
    );
    writeExecutable(
      join(root, "scripts", "smoke_macos_app.sh"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/ui-smoke.log\"\n",
    );
    writeFileSync(
      join(root, "scripts", "macos_artifact.ts"),
      `import { appendFileSync, writeFileSync } from "node:fs";
const args = Bun.argv.slice(2);
appendFileSync(Bun.env.MARKER_DIRECTORY + "/bun.log", args.join(" ") + "\\n");
if (args[0] === "tailscale-node-id-sha256") {
  const expectedHostname = args[args.indexOf("--expected-hostname") + 1];
  const status = await Bun.stdin.json();
  if (status?.Self?.Online !== true || status?.Self?.HostName !== expectedHostname || typeof status?.Self?.ID !== "string") process.exit(65);
  process.stdout.write(Bun.CryptoHasher.hash("sha256", status.Self.ID, "hex") + "\\n");
  process.exit(0);
}
if (args[0] === "provenance") process.exit(0);
if (args[0] === "finalize" || args[0] === "finalize-local") {
  const manifestIndex = args.indexOf("--manifest");
  if (manifestIndex < 0 || !args[manifestIndex + 1]) process.exit(64);
  writeFileSync(args[manifestIndex + 1], "{}\\n");
  process.exit(0);
}
process.exit(64);
`,
    );
    writeExecutable(
      join(bin, "swift"),
      "#!/usr/bin/env bash\nmkdir -p .build/$3\nprintf app > .build/$3/App\nchmod +x .build/$3/App\n",
    );
    writeExecutable(join(bin, "hostname"), "#!/usr/bin/env bash\nprintf '%s\\n' \"${BUILD_FIXTURE_HOSTNAME:-station05}\"\n");
    writeExecutable(
      join(bin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$0" >> "$MARKER_DIRECTORY/tailscale.log"
[ "\${FAIL_BUILDER_TAILSCALE_STATUS:-0}" = 0 ] || exit 1
if [ -n "\${BUILDER_TAILSCALE_STATUS_JSON:-}" ]; then
  printf '%s\n' "$BUILDER_TAILSCALE_STATUS_JSON"
else
  printf '%s\n' '{"Self":{"Online":true,"HostName":"station05","ID":"${builderTailscaleNodeId}"}}'
fi
`,
    );
    writeExecutable(
      join(bin, "ioreg"),
      `#!/usr/bin/env bash
printf '    "IOPlatformUUID" = "%s"\n' "\${BUILD_PLATFORM_IDENTITY:-${builderPlatformIdentity}}"
`,
    );
    writeExecutable(
      join(bin, "codesign"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/codesign.log"
if [[ "$*" == *"--entitlements :-"* ]]; then
  if [ "\${EXTRA_HELPER_ENTITLEMENT:-0}" = 1 ]; then
    printf '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>\n'
  else
    cat "$EXPECTED_HELPER_ENTITLEMENTS"
  fi
elif [[ "$*" == *"--verbose=4"* ]]; then
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
    writeExecutable(
      join(bin, "xcrun"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/xcrun.log"
if [[ "$*" == *"notarytool submit"* ]]; then
  if [ "\${NOTARY_SUBMIT_REJECTED:-0}" = 1 ]; then
    printf '{"id":"11111111-1111-4111-8111-111111111111","status":"Invalid"}\n'
  else
    printf '{"id":"11111111-1111-4111-8111-111111111111","status":"Accepted"}\n'
  fi
elif [[ "$*" == *"notarytool log"* ]]; then
  if [ "\${NOTARY_LOG_ISSUES:-0}" = 1 ]; then
    printf '{"jobId":"11111111-1111-4111-8111-111111111111","status":"Accepted","issues":[{"severity":"warning"}]}\n'
  else
    printf '{"jobId":"11111111-1111-4111-8111-111111111111","status":"Accepted","issues":null}\n'
  fi
fi
exit 0
`,
    );
    writeExecutable(join(bin, "spctl"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(
      join(bin, "syspolicy_check"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MARKER_DIRECTORY/syspolicy.log\"\nexit 0\n",
    );
    writeExecutable(join(bin, "plistbuddy"), "#!/usr/bin/env bash\nprintf '0.2.12\\n'\n");
    writeExecutable(
      join(bin, "plutil"),
      `#!/usr/bin/env bash
set -euo pipefail
input="\${@: -1}"
if [ "\${REVERSE_ENTITLEMENT_ORDER:-0}" = 1 ]; then
  printf '{"com.apple.security.cs.allow-unsigned-executable-memory":true,"com.apple.security.cs.allow-jit":true}\n'
elif grep -q 'disable-library-validation' "$input"; then
  printf '{"com.apple.security.cs.allow-jit":true,"com.apple.security.cs.allow-unsigned-executable-memory":true,"com.apple.security.cs.disable-library-validation":true}\n'
else
  printf '{"com.apple.security.cs.allow-jit":true,"com.apple.security.cs.allow-unsigned-executable-memory":true}\n'
fi
`,
    );
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
        PLUTIL: join(fixture.bin, "plutil"),
        BUN_EXECUTABLE: bunExecutable,
        EXPECTED_HELPER_ENTITLEMENTS: join(fixture.native, "RecordingsLib", "RecordingsCLI.entitlements"),
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

  async function runDebugBuild(fixture: ReturnType<typeof createBuildFixture>, environment = {}) {
    const process = Bun.spawn(["bash", join(fixture.native, "build.sh"), "debug"], {
      cwd: fixture.native,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markers,
        PLIST_BUDDY: join(fixture.bin, "plistbuddy"),
        PLUTIL: join(fixture.bin, "plutil"),
        BUN_EXECUTABLE: bunExecutable,
        EXPECTED_HELPER_ENTITLEMENTS: join(fixture.native, "RecordingsLib", "RecordingsCLI.entitlements"),
        RECORDINGS_CODESIGN_IDENTITY: "",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "",
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

  async function runLocalBuild(fixture: ReturnType<typeof createBuildFixture>, environment = {}) {
    const process = Bun.spawn(["bash", join(fixture.native, "build.sh"), "local"], {
      cwd: fixture.native,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markers,
        PLIST_BUDDY: join(fixture.bin, "plistbuddy"),
        PLUTIL: join(fixture.bin, "plutil"),
        BUN_EXECUTABLE: bunExecutable,
        EXPECTED_HELPER_ENTITLEMENTS: join(fixture.native, "RecordingsLib", "RecordingsCLI.entitlements"),
        RECORDINGS_CODESIGN_IDENTITY: "",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "",
        RECORDINGS_LOCAL_APPROVED_TARGET: "station06",
        RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND: "tailscale_node_id_sha256",
        RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256: targetTailscaleIdentitySha256,
        SIGNING_FLAGS: "0x10002(adhoc,runtime)",
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

  test("debug builds ad-hoc locally without release credentials", async () => {
    const fixture = createBuildFixture();
    const result = await runDebugBuild(fixture, {
      SIGNING_FLAGS: "0x10002(adhoc,runtime)",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("ad-hoc signed and non-distributable");
    expect(result.stdout).toContain("Built non-distributable debug app");
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).toContain("--force --sign -");
    expect(codesignLog).toContain("--options runtime");
    expect(codesignLog).toContain("--entitlements RecordingsLib/RecordingsCLI.entitlements");
    expect(codesignLog).not.toContain("--timestamp");
    expect(readFileSync(join(fixture.markers, "ui-smoke.log"), "utf8")).toContain("Recordings.app");
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings.app"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings.app", "Contents", "Helpers", "recordings"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "debug", "Recordings-0.2.12-macos.zip"))).toBeFalse();
  });

  test("local-only build is explicit, target-bound, ad-hoc, and non-notarized", async () => {
    const fixture = createBuildFixture();
    const result = await runLocalBuild(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("ad-hoc signed, non-notarized, and restricted to station06");
    expect(result.stdout).toContain("Built immutable local-only app artifact");
    expect(result.stdout).toContain("not notarized and is approved only for station06");
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).toContain("--force --sign -");
    expect(codesignLog).not.toContain("--timestamp");
    const bunLog = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(bunLog).toContain("provenance");
    expect(bunLog).toContain("--artifact-policy local_only");
    expect(bunLog).toContain("--approved-target station06");
    expect(bunLog).toContain("--approved-target-identity-kind tailscale_node_id_sha256");
    expect(bunLog).toContain(`--approved-target-identity-sha256 ${targetTailscaleIdentitySha256}`);
    expect(bunLog).toContain("--builder-identity-kind tailscale_node_id_sha256");
    expect(bunLog).toContain(`--builder-identity-sha256 ${builderIdentitySha256}`);
    expect(bunLog).toContain("finalize-local");
    expect(existsSync(join(fixture.markers, "xcrun.log"))).toBeFalse();
    expect(existsSync(join(fixture.markers, "syspolicy.log"))).toBeFalse();
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.12-macos-station06-local-only.zip"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.12-macos-station06-local-only.manifest.json"))).toBeTrue();
  });

  test("local-only build uses the standard Tailscale app CLI fallback", async () => {
    const fixture = createBuildFixture();
    const fallback = join(fixture.root, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    cpSync(join(fixture.bin, "tailscale"), fallback);
    chmodSync(fallback, 0o755);
    rmSync(join(fixture.bin, "tailscale"));
    overrideFixtureTailscaleAppCli(fixture.root, fallback);

    const result = await runLocalBuild(fixture);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Built immutable local-only app artifact");
    expect(readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim()).toBe(fallback);
  });

  test("local-only build fails closed when no executable Tailscale CLI exists", async () => {
    const fixture = createBuildFixture();
    const missingFallback = join(fixture.root, "missing", "Tailscale");
    rmSync(join(fixture.bin, "tailscale"));
    overrideFixtureTailscaleAppCli(fixture.root, missingFallback);

    const result = await runLocalBuild(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Tailscale is required to authenticate");
    expect(existsSync(join(fixture.native, ".build"))).toBeFalse();
  });

  test("local-only build fails closed before compilation when identity status or resolver fails", async () => {
    const failedStatus = createBuildFixture();
    const statusResult = await runLocalBuild(failedStatus, { FAIL_BUILDER_TAILSCALE_STATUS: "1" });
    expect(statusResult.exitCode).not.toBe(0);
    expect(statusResult.stderr).toContain("Could not authenticate");
    expect(existsSync(join(failedStatus.native, ".build"))).toBeFalse();

    const missingResolver = createBuildFixture();
    rmSync(join(missingResolver.root, "scripts", "resolve_tailscale_cli.sh"));
    const resolverResult = await runLocalBuild(missingResolver);
    expect(resolverResult.exitCode).not.toBe(0);
    expect(resolverResult.stderr).toContain("Packaged Tailscale CLI resolver is missing");
    expect(existsSync(join(missingResolver.native, ".build"))).toBeFalse();
  });

  test("local-only build rejects missing or same-host target scope", async () => {
    const missing = createBuildFixture();
    const missingResult = await runLocalBuild(missing, { RECORDINGS_LOCAL_APPROVED_TARGET: "" });
    expect(missingResult.exitCode).not.toBe(0);
    expect(missingResult.stderr).toContain("RECORDINGS_LOCAL_APPROVED_TARGET=station06");

    const sameHost = createBuildFixture();
    const sameHostResult = await runLocalBuild(sameHost, { BUILD_FIXTURE_HOSTNAME: "station06" });
    expect(sameHostResult.exitCode).not.toBe(0);
    expect(sameHostResult.stderr).toContain("non-target Mac");

    const legacyHardwareKind = createBuildFixture();
    const legacyHardwareKindResult = await runLocalBuild(legacyHardwareKind, {
      RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND: "hardware_uuid_sha256",
    });
    expect(legacyHardwareKindResult.exitCode).not.toBe(0);
    expect(legacyHardwareKindResult.stderr).toContain("tailscale_node_id_sha256");

    const missingKind = createBuildFixture();
    const missingKindResult = await runLocalBuild(missingKind, {
      RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND: "",
    });
    expect(missingKindResult.exitCode).not.toBe(0);
    expect(missingKindResult.stderr).toContain("RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND");
  });

  test("local-only build requires a distinct authenticated online builder node", async () => {
    const buildScript = readFileSync(
      join(repositoryRoot, "src", "native", "Recordings", "build.sh"),
      "utf8",
    );
    expect(buildScript).toContain("recordings_resolve_tailscale_cli");
    expect(buildScript).toContain("Tailscale is required to authenticate");

    const offlineBuilder = createBuildFixture();
    const offlineResult = await runLocalBuild(offlineBuilder, {
      BUILDER_TAILSCALE_STATUS_JSON: JSON.stringify({
        Self: { Online: false, HostName: "station05", ID: builderTailscaleNodeId },
      }),
    });
    expect(offlineResult.exitCode).not.toBe(0);
    expect(offlineResult.stderr).toContain("Could not authenticate");

    const wrongBuilder = createBuildFixture();
    const wrongResult = await runLocalBuild(wrongBuilder, {
      BUILDER_TAILSCALE_STATUS_JSON: JSON.stringify({
        Self: { Online: true, HostName: "station04", ID: builderTailscaleNodeId },
      }),
    });
    expect(wrongResult.exitCode).not.toBe(0);
    expect(wrongResult.stderr).toContain("Could not authenticate");

    const sameNode = createBuildFixture();
    const sameNodeResult = await runLocalBuild(sameNode, {
      RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256: builderIdentitySha256,
    });
    expect(sameNodeResult.exitCode).not.toBe(0);
    expect(sameNodeResult.stderr).toContain("different authenticated Tailscale node");
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

  test("rejects extra helper entitlements and a signed helper that cannot execute", async () => {
    const fixture = createBuildFixture();
    const extraEntitlement = await runBuild(fixture, { EXTRA_HELPER_ENTITLEMENT: "1" });
    expect(extraEntitlement.exitCode).not.toBe(0);
    expect(extraEntitlement.stderr).toContain("unexpected hardened-runtime entitlements");

    const brokenHelper = await runBuild(fixture, { BREAK_SIGNED_HELPER: "1" });
    expect(brokenHelper.exitCode).not.toBe(0);
    expect(brokenHelper.stderr).toContain("signed companion CLI contract failed");

    const malformedHelper = await runBuild(fixture, { MALFORMED_SIGNED_HELPER_OUTPUT: "1" });
    expect(malformedHelper.exitCode).not.toBe(0);
    expect(malformedHelper.stderr).toContain("invalid JSON");
  });

  test("signed helper contract ignores hostile storage env and entitlement key order", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture, {
      HASNA_RECORDINGS_API_URL: "https://example.invalid",
      HASNA_RECORDINGS_API_KEY: "fixture-not-a-secret",
      HASNA_RECORDINGS_STORAGE_MODE: "cloud",
      HASNA_RECORDINGS_DB_PATH: "/should/not/be/used.sqlite",
      REVERSE_ENTITLEMENT_ORDER: "1",
    });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("signs helper and app then emits finalized ZIP and manifest", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(fixture);
    expect(result.exitCode).toBe(0);
    const codesignLog = readFileSync(join(fixture.markers, "codesign.log"), "utf8");
    expect(codesignLog).toContain("--options runtime --timestamp");
    expect(codesignLog).toContain("--entitlements RecordingsLib/RecordingsCLI.entitlements");
    expect(codesignLog).toContain("Contents/Helpers/recordings");
    const bunLog = readFileSync(join(fixture.markers, "bun.log"), "utf8");
    expect(bunLog).toContain("provenance");
    expect(bunLog).toContain("finalize");
    const buildScript = readFileSync(
      join(repositoryRoot, "src", "native", "Recordings", "build.sh"),
      "utf8",
    );
    const helperSigning = buildScript.indexOf(
      'codesign "${HELPER_SIGN_ARGUMENTS[@]}"',
    );
    const provenance = buildScript.indexOf('macos_artifact.ts" provenance');
    const appSigning = buildScript.indexOf("--entitlements", provenance);
    expect(helperSigning).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(helperSigning);
    expect(appSigning).toBeGreaterThan(provenance);
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.12-macos.zip"))).toBeTrue();
    expect(existsSync(join(fixture.native, ".build", "release", "Recordings-0.2.12-macos.manifest.json"))).toBeTrue();
    expect(readFileSync(join(fixture.markers, "xcrun.log"), "utf8")).toContain("notarytool log");
    expect(readFileSync(join(fixture.markers, "syspolicy.log"), "utf8")).toContain("distribution");
  });

  test("rejects a rejected submission or accepted notary log with issues", async () => {
    const rejected = await runBuild(createBuildFixture(), { NOTARY_SUBMIT_REJECTED: "1" });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain("not accepted");

    const issues = await runBuild(createBuildFixture(), { NOTARY_LOG_ISSUES: "1" });
    expect(issues.exitCode).not.toBe(0);
    expect(issues.stderr).toContain("reported issues");
  });
});
