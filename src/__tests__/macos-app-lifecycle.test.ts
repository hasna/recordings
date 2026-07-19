import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureNativeFsGuardAddon } from "./helpers/native-fs-guard";

const repositoryRoot = resolve(import.meta.dir, "../..");
process.env.RECORDINGS_TEST_FS_GUARD_ADDON = ensureNativeFsGuardAddon(repositoryRoot);
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
setDefaultTimeout(30_000);

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

function createFifo(path: string): void {
  const result = Bun.spawnSync(["/usr/bin/mkfifo", path]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

async function readFifoLine(path: string): Promise<string> {
  const reader = Bun.spawn(
    ["/bin/bash", "-c", 'IFS= read -r line < "$1"; printf "%s\\n" "$line"', "_", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = Promise.all([
      reader.exited,
      new Response(reader.stdout).text(),
      new Response(reader.stderr).text(),
    ]);
    const result = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reader.kill();
          reject(new Error(`timed out waiting for FIFO synchronization: ${path}`));
        }, 5_000);
      }),
    ]);
    const [exitCode, stdout, stderr] = result;
    expect(exitCode, stderr).toBe(0);
    return stdout.trim();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (reader.exitCode === null) reader.kill();
  }
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

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function createLegacyState(fixture: ReturnType<typeof createInstallerFixture>): string {
  const state = join(fixture.home, ".hasna", "recordings");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "recordings.db"), "healthy-db\n");
  writeFileSync(join(state, "settings.json"), "{\"healthy\":true}\n");
  writeFileSync(join(state, "transcription-cache.json"), "[]\n");
  for (const name of ["recordings.db", "settings.json", "transcription-cache.json"]) {
    chmodSync(join(state, name), 0o600);
  }
  chmodSync(state, 0o755);
  return state;
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
  const tailscaleApp = join(root, "Tailscale.app");
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
  cpSync(join(repositoryRoot, "scripts", "native_fs_guard.ts"), join(root, "scripts", "native_fs_guard.ts"));
  cpSync(
    join(repositoryRoot, "scripts", "resolve_tailscale_cli.sh"),
    join(root, "scripts", "resolve_tailscale_cli.sh"),
  );
  writeExecutable(
    join(root, "scripts", "smoke_macos_app.sh"),
    "#!/usr/bin/env bash\n[ \"$#\" -eq 2 ] || exit 64\n[ \"$2\" = \"$RECORDINGS_BUN_EXECUTABLE\" ] || exit 65\n[ \"${FAIL_RUNTIME_SMOKE:-0}\" = 0 ] || exit 1\nprintf '%s\\n' \"$1\" >> \"$MARKER_DIRECTORY/runtime-smoke.log\"\n",
  );

  writeExecutable(
    join(bin, "uname"),
    `#!/usr/bin/env bash
if [ "\${REQUIRE_DETERMINISTIC_LOCALE:-0}" = 1 ]; then
  [ "\${LC_ALL:-}" = C ] && [ "\${LANG:-}" = C ] && [ "\${TZ:-}" = UTC0 ] || exit 91
fi
if [ "\${1:-}" = -m ]; then printf 'arm64\n'; else printf 'Darwin\n'; fi
`,
  );
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
  mkdirSync(join(tailscaleApp, "Contents", "MacOS"), { recursive: true });
  cpSync(join(bin, "tailscale"), join(tailscaleApp, "Contents", "MacOS", "Tailscale"));
  chmodSync(join(tailscaleApp, "Contents", "MacOS", "Tailscale"), 0o755);
  writeExecutable(join(bin, "sw_vers"), "#!/usr/bin/env bash\nprintf '26.0\\n'\n");
  writeExecutable(
    join(bin, "stat"),
    `#!/usr/bin/env bash
path="\${3:-}"
case "\${2:-}" in
  '%u')
    if [ "$path" = "$HOME/.hasna/recordings" ] && [ -n "\${FIXTURE_STATE_UID:-}" ]; then
      printf '%s\\n' "$FIXTURE_STATE_UID"
    else
      "$REAL_BUN" -e 'import { statSync } from "node:fs"; console.log(statSync(process.argv.at(-1)).uid)' "$path"
    fi
    ;;
  '%m') "$REAL_BUN" -e 'import { statSync } from "node:fs"; console.log(Math.floor(statSync(process.argv.at(-1)).mtimeMs / 1000))' "$path" ;;
  '%Lp')
    case "$path" in
      "$HOME/.hasna/recordings") "$REAL_BUN" -e 'import { statSync } from "node:fs"; console.log((statSync(process.argv.at(-1)).mode & 0o777).toString(8))' "$path" ;;
      "$HOME") printf '%s\\n' "\${FIXTURE_HOME_MODE:-700}" ;;
      */owner|*/.Recordings-install-transaction.json) printf '600\\n' ;;
      *) printf '700\\n' ;;
    esac
    ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    join(bin, "ls"),
    `#!/usr/bin/env bash
printf 'drwx------ fixture\\n'
if [ "\${@: -1}" = "$HOME/.hasna/recordings" ] && [ "\${FIXTURE_STATE_ACL:-0}" = 1 ]; then
  printf ' 0: user:fixture allow read\\n'
fi
if [ "\${@: -1}" = "$HOME" ]; then
  case "\${FIXTURE_HOME_ACL:-0}" in
    deny) printf ' 0: group:everyone deny delete\\n' ;;
    allow) printf ' 0: user:fixture allow write,delete_child\\n' ;;
  esac
fi
`,
  );
  writeExecutable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MARKER_DIRECTORY/bun.log"
case "$*" in
  *" journal-write "*"--phase processes-stopped"*)
    "$REAL_BUN" "$@"
    if [ "\${RELAUNCH_OLD_AFTER_STOPPED:-0}" = 1 ] && \
       [ ! -e "$MARKER_DIRECTORY/relaunched-old.pid" ]; then
      bash -c '
        if [ "\${RELAUNCH_OLD_WRITE_STATE:-0}" = 1 ]; then
          mkdir -p "$HOME/.hasna/recordings/logs"
          printf "bundled-relaunch-write\\n" > "$HOME/.hasna/recordings/config.json"
          printf "legacy-log-write\\n" > "$HOME/.hasna/recordings/logs/legacy.log"
        fi
        exec -a "$1" sleep 30
      ' _ "$CANONICAL_EXECUTABLE" >/dev/null 2>&1 &
      printf '%s\n' "$!" > "$MARKER_DIRECTORY/relaunched-old.pid"
    fi
    exit 0
    ;;
  *" journal-write "*"--phase committed"*)
    [ "\${FAIL_COMMITTED_JOURNAL:-0}" = 1 ] && exit 1
    exec "$REAL_BUN" "$@"
    ;;
  *" native-fs-guard-check"*|*" journal-write "*|*" journal-get "*|*" journal-recover "*|*" transaction-cleanup "*|*" state-mode-harden "*|*" install-archive-original "*|*" install-publish-candidate "*|*" tree-digest "*)
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
  *" verify-filesystem-tree "*) exec "$REAL_BUN" "$@" ;;
  *" assert-transition "*|*" fsync-tree "*|*" fsync-directory "*) exit 0 ;;
  *" verify-active "*) [ "\${FAIL_ACTIVE_VERIFY:-0}" = 0 ]; exit $? ;;
  *" extract-verified-archive "*)
    staging_target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--staging-target" ]; then staging_target="$2"; break; fi
      shift
    done
    [ -n "$staging_target" ] || exit 1
    if [ "\${EXTRA_ARCHIVE_ENTRY:-0}" = 1 ]; then
      echo "release ZIP contains an entry outside the canonical Recordings.app tree" >&2
      exit 1
    fi
    cp -R "$CANDIDATE_SOURCE" "$staging_target/Recordings.app"
    ;;
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
  if [ "\${FAIL_STATE_COPY_AFTER_WRITE:-0}" = 1 ] && [[ "$2" == */state.initial ]]; then
    exit 91
  fi
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
if [[ "$*" == *"Tailscale.app"* ]] && [[ "$*" == *"-d --verbose=4"* ]]; then
  printf 'Identifier=io.tailscale.ipn.macsys\nTeamIdentifier=W5364U7YZB\n' >&2
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
    join(bin, "mv"),
    `#!/usr/bin/env bash
set -euo pipefail
source_path="$1"
destination_path="$2"
/bin/mv "$@"
if [ "\${RELAUNCH_OLD_DURING_MOVE:-0}" = 1 ] && \
   [ "$source_path/Contents/MacOS/Recordings" = "$CANONICAL_EXECUTABLE" ]; then
  relaunch_old() {
    bash -c 'exec -a "$1" sleep 30' _ "$CANONICAL_EXECUTABLE" >/dev/null 2>&1 &
    printf '%s\n' "$!" > "$MARKER_DIRECTORY/relaunched-old.pid"
    printf '%s\n' "$destination_path/Contents/MacOS/Recordings" > \
      "$MARKER_DIRECTORY/relaunched-old-observed-executable"
  }
  if [ -n "\${RELAUNCH_OLD_DURING_MOVE_DELAY_SECONDS:-}" ]; then
    ( /bin/sleep "$RELAUNCH_OLD_DURING_MOVE_DELAY_SECONDS"; relaunch_old ) \
      >/dev/null 2>&1 &
  else
    relaunch_old
  fi
fi
`,
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
if [ "\${1:-}" = "-o" ] && [ "\${2:-}" = "lstart=" ]; then
  if [ "\${SIMULATE_EXISTING_PID_REUSE:-0}" = 1 ] && [ "\${4:-}" = "\${EXISTING_PID:-}" ]; then
    if [ -e "$MARKER_DIRECTORY/existing-start-observed" ]; then
      printf 'Sat Jul 18 12:00:01 2026\n'
    else
      : > "$MARKER_DIRECTORY/existing-start-observed"
      printf 'Sat Jul 18 12:00:00 2026\n'
    fi
  elif [ "\${4:-}" = 99999 ]; then
    printf 'Sat Jul 18 12:00:00 2026\n'
  else
    exec /bin/ps "$@"
  fi
  exit 0
fi
if [ -f "$MARKER_DIRECTORY/relaunched-old.pid" ]; then
  relaunched_old_pid="$(sed -n '1p' "$MARKER_DIRECTORY/relaunched-old.pid")"
  if kill -0 "$relaunched_old_pid" 2>/dev/null; then
    printf '%s %s\n' "$relaunched_old_pid" "$CANONICAL_EXECUTABLE"
  fi
fi
if [ -n "\${COMMAND_ONLY_PID:-}" ] && kill -0 "$COMMAND_ONLY_PID" 2>/dev/null; then
  printf '%s %s\n' "$COMMAND_ONLY_PID" "$CANONICAL_EXECUTABLE"
fi
if [ ! -e "$MARKER_DIRECTORY/open.log" ]; then
  if [ -n "\${EXISTING_PID:-}" ] && kill -0 "$EXISTING_PID" 2>/dev/null && \
     { [ "\${SIMULATE_EXISTING_PID_REUSE:-0}" != 1 ] || [ ! -e "$MARKER_DIRECTORY/existing-start-observed" ]; }; then
    printf '%s %s\n' "$EXISTING_PID" "$EXISTING_PROCESS_PATH"
  fi
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
  writeExecutable(
    join(bin, "lsof"),
    `#!/usr/bin/env bash
set -euo pipefail
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -p ]; then pid="$2"; shift 2; else shift; fi
done
[ -n "$pid" ] || exit 1
observed=""
if [ "$pid" = 99999 ]; then
  observed="$CANONICAL_EXECUTABLE"
elif [ -n "\${EXISTING_PID:-}" ] && [ "$pid" = "$EXISTING_PID" ]; then
  observed="$EXISTING_PROCESS_PATH"
elif [ -f "$MARKER_DIRECTORY/relaunched-old.pid" ] && [ "$pid" = "$(sed -n '1p' "$MARKER_DIRECTORY/relaunched-old.pid")" ]; then
  if [ -f "$MARKER_DIRECTORY/relaunched-old-observed-executable" ]; then
    observed="$(sed -n '1p' "$MARKER_DIRECTORY/relaunched-old-observed-executable")"
  else
    observed="$CANONICAL_EXECUTABLE"
  fi
elif [ -f "$MARKER_DIRECTORY/launched.pid" ] && [ "$pid" = "$(sed -n '1p' "$MARKER_DIRECTORY/launched.pid")" ]; then
  observed="$CANONICAL_EXECUTABLE"
elif [ -n "\${COMMAND_ONLY_PID:-}" ] && [ "$pid" = "$COMMAND_ONLY_PID" ]; then
  observed="\${COMMAND_ONLY_OBSERVED_EXECUTABLE:-}"
fi
[ -n "$observed" ] || exit 1
printf 'p%s\n' "$pid"
if [ -n "\${LSOF_PREPEND_TEXT_PATH:-}" ]; then
  printf 'n%s\n' "$LSOF_PREPEND_TEXT_PATH"
fi
printf 'n%s\n' "$observed"
`,
  );

  return { root, home, bin, markers, candidate, artifact, manifest, tailscaleApp };
}

function installerToolOverrides(fixture: ReturnType<typeof createInstallerFixture>): Record<string, string> {
  const system = (path: string) => path;
  return {
    RECORDINGS_BUN_EXECUTABLE: join(fixture.bin, "bun"),
    RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: fixture.tailscaleApp,
    RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE: join(fixture.bin, "codesign"),
    RECORDINGS_TEST_TAILSCALE_DITTO_EXECUTABLE: join(fixture.bin, "ditto"),
    RECORDINGS_TEST_INSTALL_AWK_EXECUTABLE: system("/usr/bin/awk"),
    RECORDINGS_TEST_INSTALL_BASENAME_EXECUTABLE: system("/usr/bin/basename"),
    RECORDINGS_TEST_INSTALL_CHMOD_EXECUTABLE: system("/bin/chmod"),
    RECORDINGS_TEST_INSTALL_CODESIGN_EXECUTABLE: join(fixture.bin, "codesign"),
    RECORDINGS_TEST_INSTALL_CP_EXECUTABLE: system("/bin/cp"),
    RECORDINGS_TEST_INSTALL_DATE_EXECUTABLE: system("/bin/date"),
    RECORDINGS_TEST_INSTALL_DD_EXECUTABLE: system("/bin/dd"),
    RECORDINGS_TEST_INSTALL_DF_EXECUTABLE: join(fixture.bin, "df"),
    RECORDINGS_TEST_INSTALL_DIFF_EXECUTABLE: system("/usr/bin/diff"),
    RECORDINGS_TEST_INSTALL_DIRNAME_EXECUTABLE: system("/usr/bin/dirname"),
    RECORDINGS_TEST_INSTALL_DITTO_EXECUTABLE: join(fixture.bin, "ditto"),
    RECORDINGS_TEST_INSTALL_DU_EXECUTABLE: system("/usr/bin/du"),
    RECORDINGS_TEST_INSTALL_GREP_EXECUTABLE: system("/usr/bin/grep"),
    RECORDINGS_TEST_INSTALL_HEAD_EXECUTABLE: system("/usr/bin/head"),
    RECORDINGS_TEST_INSTALL_HOSTNAME_EXECUTABLE: join(fixture.bin, "hostname"),
    RECORDINGS_TEST_INSTALL_ID_EXECUTABLE: system("/usr/bin/id"),
    RECORDINGS_TEST_INSTALL_IOREG_EXECUTABLE: join(fixture.bin, "ioreg"),
    RECORDINGS_TEST_INSTALL_LS_EXECUTABLE: join(fixture.bin, "ls"),
    RECORDINGS_TEST_INSTALL_LSOF_EXECUTABLE: join(fixture.bin, "lsof"),
    RECORDINGS_TEST_INSTALL_MDFIND_EXECUTABLE: join(fixture.bin, "mdfind"),
    RECORDINGS_TEST_INSTALL_MKDIR_EXECUTABLE: system("/bin/mkdir"),
    RECORDINGS_TEST_INSTALL_MKTEMP_EXECUTABLE: system("/usr/bin/mktemp"),
    RECORDINGS_TEST_INSTALL_MV_EXECUTABLE: join(fixture.bin, "mv"),
    RECORDINGS_TEST_INSTALL_OPEN_EXECUTABLE: join(fixture.bin, "open"),
    RECORDINGS_TEST_INSTALL_PS_EXECUTABLE: join(fixture.bin, "ps"),
    RECORDINGS_TEST_INSTALL_RM_EXECUTABLE: system("/bin/rm"),
    RECORDINGS_TEST_INSTALL_RMDIR_EXECUTABLE: system("/bin/rmdir"),
    RECORDINGS_TEST_INSTALL_SED_EXECUTABLE: system("/usr/bin/sed"),
    RECORDINGS_TEST_INSTALL_SHASUM_EXECUTABLE: system("/usr/bin/shasum"),
    RECORDINGS_TEST_INSTALL_SLEEP_EXECUTABLE: system("/bin/sleep"),
    RECORDINGS_TEST_INSTALL_SPCTL_EXECUTABLE: join(fixture.bin, "spctl"),
    RECORDINGS_TEST_INSTALL_SQLITE3_EXECUTABLE: system("/usr/bin/sqlite3"),
    RECORDINGS_TEST_INSTALL_STAT_EXECUTABLE: join(fixture.bin, "stat"),
    RECORDINGS_TEST_INSTALL_SW_VERS_EXECUTABLE: join(fixture.bin, "sw_vers"),
    RECORDINGS_TEST_INSTALL_SYSPOLICY_CHECK_EXECUTABLE: join(fixture.bin, "syspolicy_check"),
    RECORDINGS_TEST_INSTALL_TAIL_EXECUTABLE: system("/usr/bin/tail"),
    RECORDINGS_TEST_INSTALL_TR_EXECUTABLE: system("/usr/bin/tr"),
    RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE: join(fixture.bin, "uname"),
    RECORDINGS_TEST_INSTALL_XCRUN_EXECUTABLE: join(fixture.bin, "xcrun"),
  };
}

async function runInstaller(
  fixture: ReturnType<typeof createInstallerFixture>,
  args: string[] = [],
  environment: Record<string, string> = {},
  cwd?: string,
) {
  const app = join(fixture.home, "Applications", "Recordings.app");
  const state = join(fixture.home, ".hasna", "recordings");
  if (existsSync(state) && mode(state) === 0o775) chmodSync(state, 0o755);
  const normalizeFixtureDescendants = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const details = lstatSync(child);
      if (details.isSymbolicLink()) continue;
      chmodSync(child, (details.mode & 0o777) & ~0o022);
      if (details.isDirectory()) normalizeFixtureDescendants(child);
    }
  };
  if (existsSync(state) && !lstatSync(state).isSymbolicLink()) normalizeFixtureDescendants(state);
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
      cwd,
      env: {
        ...Bun.env,
        RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
        HOME: fixture.home,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        CANDIDATE_SOURCE: fixture.candidate,
        CANONICAL_EXECUTABLE: join(app, "Contents", "MacOS", "Recordings"),
        MARKER_DIRECTORY: fixture.markers,
        REAL_BUN: bunExecutable,
        ...installerToolOverrides(fixture),
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

  test("rejects a relative HOME before creating any install state", async () => {
    const fixture = createInstallerFixture();
    const relativeHome = "relative-home";
    const resolvedRelativeHome = join(fixture.root, relativeHome);
    mkdirSync(resolvedRelativeHome, { mode: 0o700 });

    const result = await runInstaller(fixture, [], { HOME: relativeHome }, fixture.root);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("absolute canonical path");
    expect(existsSync(join(resolvedRelativeHome, ".hasna"))).toBeFalse();
    expect(existsSync(join(resolvedRelativeHome, "Applications"))).toBeFalse();
    expect(existsSync(join(fixture.markers, "bun.log"))).toBeFalse();
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
    expect(installer).not.toMatch(/\bxattr\b[^\n]*quarantine|com\.apple\.quarantine/);
    expect(installer).not.toContain("codesign --force");
  });

  test("publishes app namespace transitions through the retained native guard", () => {
    const installer = readFileSync(
      join(repositoryRoot, "scripts", "install_macos_app.sh"),
      "utf8",
    );
    expect(installer).toContain('"$ARTIFACT_TOOL" install-archive-original');
    expect(installer).toContain('"$ARTIFACT_TOOL" install-publish-candidate');
    expect(installer).not.toContain('"$MV_EXECUTABLE" "$existing_app" "$moved_path"');
    expect(installer).not.toContain('"$MV_EXECUTABLE" "$STAGED_APP" "$APP_DEST"');
  });

  test("does not nest an original app when its archival destination appears after precheck", async () => {
    const fixture = createInstallerFixture();
    const source = join(fixture.home, "Applications", "Recordings.app");
    const readyFifo = join(fixture.root, "archive-destination-ready.fifo");
    const resumeFifo = join(fixture.root, "archive-destination-resume.fifo");
    createApp(source, "installed");
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const installing = runInstaller(fixture, [], {
      RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER: "archive-original:before-rename",
      RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO: readyFifo,
      RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO: resumeFifo,
    });
    const [reportedSource, destination] = (await readFifoLine(readyFifo)).split("\t");
    expect(reportedSource).toBe(source);
    mkdirSync(destination!, { mode: 0o700 });
    writeFileSync(join(destination!, "concurrent-sentinel.txt"), "preserve\n", { mode: 0o600 });
    writeFileSync(resumeFifo, "continue\n");
    const result = await installing;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("rename retained source without replacement at capability failed");
    expect(readFileSync(join(source, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
    expect(readFileSync(join(destination!, "concurrent-sentinel.txt"), "utf8")).toBe(
      "preserve\n",
    );
    expect(existsSync(join(destination!, "Recordings.app"))).toBeFalse();
  });

  test("rejects original source substitution after retaining the authenticated handle", async () => {
    const fixture = createInstallerFixture();
    const source = join(fixture.home, "Applications", "Recordings.app");
    const parkedSource = join(fixture.root, "parked-original.app");
    const readyFifo = join(fixture.root, "archive-source-ready.fifo");
    const resumeFifo = join(fixture.root, "archive-source-resume.fifo");
    createApp(source, "installed");
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const installing = runInstaller(fixture, [], {
      RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER: "archive-original:before-rename",
      RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO: readyFifo,
      RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO: resumeFifo,
    });
    const [reportedSource, destination] = (await readFifoLine(readyFifo)).split("\t");
    expect(reportedSource).toBe(source);
    renameSync(source, parkedSource);
    createApp(source, "concurrent-substitute");
    writeFileSync(resumeFifo, "continue\n");
    const result = await installing;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("retained rename source binding failed");
    expect(readFileSync(join(source, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "concurrent-substitute",
    );
    expect(readFileSync(join(parkedSource, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
    expect(existsSync(destination!)).toBeFalse();
  });

  test("does not replace or nest into a candidate destination created after precheck", async () => {
    const fixture = createInstallerFixture();
    const destination = join(fixture.home, "Applications", "Recordings.app");
    const readyFifo = join(fixture.root, "candidate-destination-ready.fifo");
    const resumeFifo = join(fixture.root, "candidate-destination-resume.fifo");
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const installing = runInstaller(fixture, [], {
      RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER: "publish-candidate:before-rename",
      RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO: readyFifo,
      RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO: resumeFifo,
    });
    const [staging, reportedDestination] = (await readFifoLine(readyFifo)).split("\t");
    expect(reportedDestination).toBe(destination);
    mkdirSync(destination, { mode: 0o700 });
    writeFileSync(join(destination, "concurrent-sentinel.txt"), "preserve\n", { mode: 0o600 });
    writeFileSync(resumeFifo, "continue\n");
    const result = await installing;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("rename retained source without replacement at capability failed");
    expect(readFileSync(join(destination, "concurrent-sentinel.txt"), "utf8")).toBe(
      "preserve\n",
    );
    expect(existsSync(join(destination, "Recordings.app"))).toBeFalse();
    expect(existsSync(staging!)).toBeFalse();
  });

  test("rejects staged candidate substitution after retaining the authenticated handle", async () => {
    const fixture = createInstallerFixture();
    const destination = join(fixture.home, "Applications", "Recordings.app");
    const parkedCandidate = join(fixture.root, "parked-candidate.app");
    const readyFifo = join(fixture.root, "candidate-source-ready.fifo");
    const resumeFifo = join(fixture.root, "candidate-source-resume.fifo");
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const installing = runInstaller(fixture, [], {
      RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER: "publish-candidate:before-rename",
      RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO: readyFifo,
      RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO: resumeFifo,
    });
    const [staging] = (await readFifoLine(readyFifo)).split("\t");
    renameSync(staging!, parkedCandidate);
    createApp(staging!, "concurrent-substitute");
    writeFileSync(resumeFifo, "continue\n");
    const result = await installing;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("retained rename source binding failed");
    expect(readFileSync(join(staging!, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "concurrent-substitute",
    );
    expect(readFileSync(join(parkedCandidate, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(destination)).toBeFalse();
  });

  test.each([
    ["archive-original", "after-rename"],
    ["archive-original", "after-destination-fsync"],
    ["archive-original", "after-source-fsync"],
    ["publish-candidate", "after-rename"],
    ["publish-candidate", "after-destination-fsync"],
    ["publish-candidate", "after-source-fsync"],
  ] as const)(
    "recovers the exact prior app after a %s %s crash boundary",
    async (operation, point) => {
      const fixture = createInstallerFixture();
      const applications = join(fixture.home, "Applications");
      const installed = join(applications, "Recordings.app");
      createApp(installed, "installed");

      const crashed = await runInstaller(fixture, [], {
        RECORDINGS_TEST_CRASH_INSTALL_TRANSITION: `${operation}:${point}`,
      });
      expect(crashed.exitCode).not.toBe(0);
      rmSync(join(applications, ".Recordings-install-lock"), { recursive: true, force: true });

      const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
      expect(recovered.exitCode).not.toBe(0);
      expect(recovered.stderr).toContain("Recovering incomplete");
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "installed",
      );
      expect(existsSync(join(applications, ".Recordings-install-transaction.json"))).toBeFalse();
      expect(
        readdirSync(applications).filter((entry) =>
          entry.startsWith(".Recordings-install.") ||
          entry.startsWith(".Recordings-transaction.") ||
          entry.startsWith(".Recordings-recovery-quarantine.")
        ),
      ).toEqual([]);
    },
  );

  test("fails closed on a missing descriptor guard before creating install state", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], {
      RECORDINGS_TEST_FS_GUARD_ADDON: join(fixture.root, "missing-native-guard.node"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8")).toContain(
      "native-fs-guard-check",
    );
    expect(
      existsSync(join(fixture.home, "Applications")),
      `${result.stderr}\n${readFileSync(join(fixture.markers, "bun.log"), "utf8")}`,
    ).toBeFalse();
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
  });

  test("uses one private authenticated manifest snapshot for every installer preflight read", async () => {
    const fixture = createInstallerFixture();
    const manifestDigest = "a".repeat(64);
    const result = await runInstaller(fixture);
    expect(result.exitCode, result.stderr).toBe(0);

    const bunLog = readFileSync(join(fixture.markers, "bun.log"), "utf8").trim().split("\n");
    const manifestConsumers = bunLog.filter((line) =>
      [
        " verify-archive ",
        " extract-verified-archive ",
        " verify-app ",
        " verify-active ",
        " assert-transition ",
        " manifest-get ",
      ].some((command) => line.includes(command))
    );
    const manifestPaths = manifestConsumers.map((line) => {
      const match = line.match(/--manifest ([^ ]+)/);
      expect(match, line).not.toBeNull();
      return match?.[1] ?? "";
    });
    expect(manifestPaths.length).toBeGreaterThan(3);
    expect(new Set(manifestPaths).size).toBe(1);
    expect(manifestPaths[0]).not.toBe(fixture.manifest);
    expect(manifestPaths[0]).toContain("/tmp/recordings-install.");
    for (const line of manifestConsumers) {
      expect(line).toContain(`--manifest-sha256 ${manifestDigest}`);
    }

    const installer = readFileSync(
      join(repositoryRoot, "scripts", "install_macos_app.sh"),
      "utf8",
    );
    expect(
      installer.indexOf('"$CP_EXECUTABLE" "$MANIFEST_PATH" "$MANIFEST_SNAPSHOT"'),
    ).toBeLessThan(installer.indexOf('"$ARTIFACT_TOOL" verify-archive'));
    expect(installer).not.toContain('manifest-get --manifest "$MANIFEST_PATH"');
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
    const executedCli = readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim();
    expect(executedCli.endsWith("/tailscale-identity-snapshot/Tailscale.app/Contents/MacOS/Tailscale")).toBeTrue();
    expect(executedCli).not.toBe(join(fixture.bin, "tailscale"));
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8")).toContain(
      "tailscale-node-id-sha256 --expected-hostname station06",
    );
  });

  test("Tailscale-bound local install ignores a hostile PATH CLI with matching identity output", async () => {
    const fixture = createInstallerFixture();
    const hostileBin = join(fixture.root, "hostile-bin");
    const hostileMarker = join(fixture.markers, "hostile-tailscale-ran");
    writeExecutable(
      join(hostileBin, "tailscale"),
      `#!/bin/bash\nprintf hostile > ${JSON.stringify(hostileMarker)}\nprintf '%s\\n' '{"Self":{"Online":true,"HostName":"station06","ID":"${targetTailscaleNodeId}"}}'\n`,
    );

    const result = await runTailscaleLocalInstaller(fixture, [], {
      PATH: `${hostileBin}:${fixture.bin}:${Bun.env.PATH ?? ""}`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const executedCli = readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim();
    expect(executedCli.endsWith("/tailscale-identity-snapshot/Tailscale.app/Contents/MacOS/Tailscale")).toBeTrue();
    expect(executedCli).not.toBe(join(fixture.bin, "tailscale"));
    expect(existsSync(hostileMarker)).toBeFalse();
  });

  test("Tailscale-bound local install uses the standard app CLI fallback", async () => {
    const fixture = createInstallerFixture();
    const fallback = join(fixture.root, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    cpSync(join(fixture.bin, "tailscale"), fallback);
    chmodSync(fallback, 0o755);
    rmSync(join(fixture.bin, "tailscale"));
    const result = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: join(fixture.root, "Applications", "Tailscale.app"),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const executedCli = readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim();
    expect(executedCli.endsWith("/tailscale-identity-snapshot/Tailscale.app/Contents/MacOS/Tailscale")).toBeTrue();
    expect(executedCli).not.toBe(fallback);
  });

  test("Tailscale-bound local install rejects a non-executable app fallback before mutation", async () => {
    const fixture = createInstallerFixture();
    const fallback = join(fixture.root, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, "not executable\n");
    chmodSync(fallback, 0o644);
    rmSync(join(fixture.bin, "tailscale"));
    const result = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: join(fixture.root, "Applications", "Tailscale.app"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not an executable file");
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("Tailscale-bound local install fails closed when Tailscale is missing", async () => {
    const fixture = createInstallerFixture();
    rmSync(fixture.tailscaleApp, { recursive: true });
    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test.each([
    ["symlink", 0o755],
    ["group-writable", 0o775],
  ] as const)("Tailscale-bound local install rejects an unsafe trusted CLI %s", async (kind, permissions) => {
    const fixture = createInstallerFixture();
    const realCli = join(fixture.tailscaleApp, "Contents", "MacOS", "Tailscale");
    const candidateApp = join(fixture.root, "trusted", "Tailscale.app");
    const candidate = join(candidateApp, "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(candidate), { recursive: true });
    if (kind === "symlink") {
      symlinkSync(realCli, candidate);
    } else {
      cpSync(realCli, candidate);
      chmodSync(candidate, permissions);
    }

    const result = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: candidateApp,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Trusted Tailscale CLI");
    expect(existsSync(join(fixture.home, ".hasna"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("trusted Tailscale resolver keeps its test override unreachable on Darwin", () => {
    const source = readFileSync(join(repositoryRoot, "scripts", "resolve_tailscale_cli.sh"), "utf8");
    const resolverFunction = source.indexOf("recordings_resolve_trusted_tailscale_app_cli() {");
    const darwinBranch = source.indexOf('if [ "$real_host_kernel" = "Darwin" ]; then', resolverFunction);
    const standardCandidate = source.indexOf("source_app='/Applications/Tailscale.app'", darwinBranch);
    const testOverride = source.indexOf('RECORDINGS_TEST_TRUSTED_TAILSCALE_APP', darwinBranch);
    expect(darwinBranch).toBeGreaterThan(-1);
    expect(standardCandidate).toBeGreaterThan(darwinBranch);
    expect(testOverride).toBeGreaterThan(standardCandidate);
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

  test("hardens a healthy three-file legacy state root and preserves its data", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const expected = ["recordings.db", "settings.json", "transcription-cache.json"].map((name) => [
      name,
      readFileSync(join(state, name), "utf8"),
    ]);

    const result = await runTailscaleLocalInstaller(fixture);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(mode(state)).toBe(0o700);
    for (const [name, contents] of expected) {
      expect(readFileSync(join(state, name), "utf8")).toBe(contents);
    }
    expect(existsSync(join(state, "audio"))).toBeTrue();
    expect(existsSync(join(state, "rollbacks"))).toBeTrue();
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeFalse();
  });

  test.each([
    ["immediately after hardening", { RECORDINGS_TEST_FAIL_AFTER_STATE_MODE_HARDEN: "1" }],
    ["after candidate activation", { FAIL_ACTIVE_VERIFY: "1" }],
    ["while committing", { FAIL_COMMITTED_JOURNAL: "1" }],
  ])("restores legacy mode and exact data on failure %s", async (_label, environment) => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const before = ["recordings.db", "settings.json", "transcription-cache.json"].map((name) =>
      readFileSync(join(state, name), "utf8")
    );

    const result = await runTailscaleLocalInstaller(fixture, [], environment);

    expect(result.exitCode).not.toBe(0);
    expect(mode(state)).toBe(0o755);
    expect(["recordings.db", "settings.json", "transcription-cache.json"].map((name) =>
      readFileSync(join(state, name), "utf8")
    )).toEqual(before);
    expect(existsSync(join(state, "audio"))).toBeFalse();
    expect(existsSync(join(state, "rollbacks"))).toBeFalse();
  });

  test("recovers a crash immediately after fd-based hardening back to legacy mode", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const crashed = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "state-mode-hardened",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(mode(state)).toBe(0o700);

    const recovered = await runTailscaleLocalInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(mode(state)).toBe(0o755);
    expect(readFileSync(join(state, "recordings.db"), "utf8")).toBe("healthy-db\n");
  });

  test("recovers app and state before restoring legacy mode after candidate activation", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const crashed = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(mode(state)).toBe(0o700);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");

    const recovered = await runTailscaleLocalInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(recovered.exitCode).not.toBe(0);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(readFileSync(join(state, "recordings.db"), "utf8")).toBe("healthy-db\n");
    expect(mode(state)).toBe(0o755);
  });

  test("a committed crash retains hardened state mode", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const crashed = await runTailscaleLocalInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "committed",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(mode(state)).toBe(0o700);

    const recovered = await runTailscaleLocalInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(mode(state)).toBe(0o700);
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeFalse();
  });

  test.each([0o777, 0o750])("rejects unsupported existing state mode %o without mutation", async (stateMode) => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    chmodSync(state, stateMode);
    const result = await runTailscaleLocalInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(mode(state)).toBe(stateMode);
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
    expect(existsSync(join(state, "audio"))).toBeFalse();
  });

  test.each([
    ["foreign owner", { FIXTURE_STATE_UID: "99999" }, "unexpected owner"],
    ["ACL", { FIXTURE_STATE_ACL: "1" }, "unexpected ACL"],
  ])("rejects a legacy state root with %s without mutation", async (_label, environment, message) => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const result = await runTailscaleLocalInstaller(fixture, [], environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(mode(state)).toBe(0o755);
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("rejects state-root and child symlinks before creating install paths", async () => {
    const rootSymlink = createInstallerFixture();
    const outside = join(rootSymlink.root, "outside");
    mkdirSync(join(rootSymlink.home, ".hasna"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(rootSymlink.home, ".hasna", "recordings"));
    const rejectedRoot = await runTailscaleLocalInstaller(rootSymlink);
    expect(rejectedRoot.exitCode).not.toBe(0);
    expect(existsSync(join(rootSymlink.home, "Applications"))).toBeFalse();

    const childSymlink = createInstallerFixture();
    const state = createLegacyState(childSymlink);
    symlinkSync(join(childSymlink.root, "outside-file"), join(state, "linked"));
    const rejectedChild = await runTailscaleLocalInstaller(childSymlink);
    expect(rejectedChild.exitCode).not.toBe(0);
    expect(rejectedChild.stderr).toContain("filesystem tree contains a symlink");
    expect(mode(state)).toBe(0o755);
    expect(existsSync(join(childSymlink.home, "Applications"))).toBeFalse();
  });

  test("wrong live target identity leaves legacy mode and children untouched", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const result = await runTailscaleLocalInstaller(fixture, [], {
      TAILSCALE_STATUS_JSON: '{"Self":{"Online":true,"HostName":"station06","ID":"wrong-node"}}',
    });
    expect(result.exitCode).not.toBe(0);
    expect(mode(state)).toBe(0o755);
    expect(readdirSync(state).sort()).toEqual([
      "recordings.db",
      "settings.json",
      "transcription-cache.json",
    ]);
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
  });

  test("normal private and absent state roots finish private", async () => {
    const privateFixture = createInstallerFixture();
    const privateState = createLegacyState(privateFixture);
    chmodSync(privateState, 0o700);
    const privateResult = await runTailscaleLocalInstaller(privateFixture);
    expect(privateResult.exitCode, privateResult.stderr).toBe(0);
    expect(mode(privateState)).toBe(0o700);

    const absentFixture = createInstallerFixture();
    const absentResult = await runTailscaleLocalInstaller(absentFixture);
    expect(absentResult.exitCode, absentResult.stderr).toBe(0);
    expect(mode(join(absentFixture.home, ".hasna", "recordings"))).toBe(0o700);
  });

  test("allows a restrictive platform Home ACL while keeping state ACL checks strict", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const result = await runTailscaleLocalInstaller(fixture, [], {
      FIXTURE_HOME_ACL: "deny",
      FIXTURE_HOME_MODE: "750",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(mode(state)).toBe(0o700);
  });

  test("rejects a Home ACL that grants mutation before creating install paths", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    const before = readFileSync(join(state, "recordings.db"), "utf8");

    const result = await runTailscaleLocalInstaller(fixture, [], { FIXTURE_HOME_ACL: "allow" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Home ancestor has an ACL that grants access");
    expect(mode(state)).toBe(0o755);
    expect(readFileSync(join(state, "recordings.db"), "utf8")).toBe(before);
    expect(existsSync(join(fixture.home, "Applications"))).toBeFalse();
    expect(existsSync(join(state, "audio"))).toBeFalse();
    expect(existsSync(join(state, "rollbacks"))).toBeFalse();
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
    expect(installer).not.toMatch(/\bxattr\b[^\n]*quarantine|com\.apple\.quarantine/);
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
    expect(existsSync(installed), result.stderr).toBeTrue();
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
    const result = await runInstaller(fixture, [], { EXTRA_ARCHIVE_ENTRY: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("canonical Recordings.app tree");
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

  test("safely removes a nonempty nonce-bound transaction before the first journal", async () => {
    const fixture = createInstallerFixture();
    const state = join(fixture.home, ".hasna", "recordings");
    const applications = join(fixture.home, "Applications");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "pre-journal.json"), "preserve source state\n");

    const result = await runInstaller(fixture, [], { FAIL_STATE_COPY_AFTER_WRITE: "1" });

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(state, "pre-journal.json"), "utf8")).toBe(
      "preserve source state\n",
    );
    const transactions = readdirSync(applications).filter(
      (entry) => entry.startsWith(".Recordings-transaction."),
    );
    expect(transactions).toEqual([]);
    expect(existsSync(join(applications, ".Recordings-install-transaction.json"))).toBeFalse();
    expect(existsSync(join(fixture.home, ".hasna", ".recordings-install-maintenance"))).toBeFalse();
  });

  test("binds an existing process when the exact executable is not the first lsof text record", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const expectedExecutable = join(installed, "Contents", "MacOS", "Recordings");
    createApp(installed, "installed");
    const prior = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const result = await runInstaller(fixture, [], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: expectedExecutable,
        LSOF_PREPEND_TEXT_PATH: "/usr/lib/dyld",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const stopped = await Promise.race([
        prior.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      expect(stopped).toBeTrue();
    } finally {
      if (prior.exitCode === null) prior.kill();
      await prior.exited;
    }
  });

  test("keeps the committed app and duplicate cleanup when post-commit launch fails", async () => {
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
        "candidate",
      );
      expect(existsSync(duplicate)).toBeFalse();
      const launches = readFileSync(join(fixture.markers, "open.log"), "utf8")
        .trim()
        .split("\n");
      expect(launches).toHaveLength(1);
      expect(launches[0]).toContain(installed);
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

  test("installer ignores hostile PATH shadows for verification, extraction, and launch tools", async () => {
    const fixture = createInstallerFixture();
    const hostileBin = join(fixture.root, "hostile-bin");
    const hostileMarker = join(fixture.markers, "hostile-path.log");
    for (const name of [
      "bun",
      "codesign",
      "ditto",
      "hostname",
      "lsof",
      "open",
      "spctl",
      "sw_vers",
      "syspolicy_check",
      "uname",
      "xcrun",
      "zipinfo",
    ]) {
      writeExecutable(
        join(hostileBin, name),
        `#!/usr/bin/env bash\nprintf '%s\\n' '${name}' >> '${hostileMarker}'\nexit 88\n`,
      );
    }

    const result = await runInstaller(fixture, ["--launch"], {
      PATH: `${hostileBin}:/usr/bin:/bin`,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(hostileMarker)).toBe(false);
    expect(readFileSync(join(fixture.markers, "open.log"), "utf8")).toContain("Recordings.app");
  });

  test("installer pins deterministic locale and timezone before invoking host tools", async () => {
    const fixture = createInstallerFixture();

    const result = await runInstaller(fixture, [], {
      LANG: "tr_TR.UTF-8",
      LC_ALL: "tr_TR.UTF-8",
      REQUIRE_DETERMINISTIC_LOCALE: "1",
      TZ: "Pacific/Honolulu",
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("stops a legacy same-path relaunch after the stopped snapshot and never accepts it as the candidate", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const prior = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    let relaunchedPid = 0;
    createApp(installed, "installed");
    try {
      const result = await runInstaller(fixture, ["--launch", "--launch-timeout", "1"], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        LAUNCH_SUCCEEDS: "0",
        RELAUNCH_OLD_AFTER_STOPPED: "1",
      });
      expect(result.exitCode).not.toBe(0);
      const relaunchedPidPath = join(fixture.markers, "relaunched-old.pid");
      expect(existsSync(relaunchedPidPath)).toBeTrue();
      relaunchedPid = Number(readFileSync(relaunchedPidPath, "utf8").trim());
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(relaunchedPid, 0);
        } catch {
          break;
        }
        await Bun.sleep(10);
      }
      expect(() => process.kill(relaunchedPid, 0)).toThrow();
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "candidate",
      );
      expect(result.stderr).toContain("Canonical app did not launch");
    } finally {
      if (relaunchedPid > 0) {
        try {
          process.kill(relaunchedPid);
        } catch {
          // The secure path stops it before the test cleanup path runs.
        }
      }
      prior.kill();
      await prior.exited;
    }
  });

  test("does not signal a reused PID whose start identity changed after discovery", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const reused = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    createApp(installed, "installed");
    try {
      const result = await runInstaller(fixture, [], {
        EXISTING_PID: String(reused.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        SIMULATE_EXISTING_PID_REUSE: "1",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(() => process.kill(reused.pid, 0)).not.toThrow();
      expect(existsSync(join(fixture.markers, "existing-start-observed"))).toBeTrue();
    } finally {
      reused.kill();
      await reused.exited;
    }
  });

  test("holds the barrier while a legacy relaunch after bundle move is quiesced", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const readyFifo = join(fixture.root, "legacy-relaunch-ready.fifo");
    const resumeFifo = join(fixture.root, "legacy-relaunch-resume.fifo");
    let relaunched: ReturnType<typeof Bun.spawn> | undefined;
    createApp(installed, "installed");
    createFifo(readyFifo);
    createFifo(resumeFifo);
    try {
      const installing = runInstaller(fixture, ["--launch", "--launch-timeout", "1"], {
        LAUNCH_SUCCEEDS: "0",
        RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER: "archive-original:after-rename",
        RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO: readyFifo,
        RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO: resumeFifo,
      });
      const [, movedPath] = (await readFifoLine(readyFifo)).split("\t");
      relaunched = Bun.spawn(
        ["bash", "-c", 'exec -a "$1" sleep 30', "_", join(installed, "Contents", "MacOS", "Recordings")],
        { stdout: "ignore", stderr: "ignore" },
      );
      writeFileSync(join(fixture.markers, "relaunched-old.pid"), `${relaunched.pid}\n`);
      writeFileSync(
        join(fixture.markers, "relaunched-old-observed-executable"),
        `${join(movedPath!, "Contents", "MacOS", "Recordings")}\n`,
      );
      writeFileSync(resumeFifo, "continue\n");
      const result = await installing;
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Canonical app did not launch");
      expect(result.stderr).not.toContain("invalid prior running app paths");
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "candidate",
      );
      expect(() => process.kill(relaunched!.pid, 0)).toThrow();
    } finally {
      relaunched?.kill();
      if (relaunched) await relaunched.exited;
    }
  });

  test("does not accept command-only candidate launch evidence from another executable", async () => {
    const fixture = createInstallerFixture();
    const impostor = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const result = await runInstaller(fixture, ["--launch", "--launch-timeout", "1"], {
        COMMAND_ONLY_OBSERVED_EXECUTABLE: "/usr/bin/sleep",
        COMMAND_ONLY_PID: String(impostor.pid),
        LAUNCH_SUCCEEDS: "0",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Canonical app did not launch");
      expect(() => process.kill(impostor.pid, 0)).not.toThrow();
    } finally {
      impostor.kill();
      await impostor.exited;
    }
  });

  test("recovery preserves safe standalone writes while restoring ambiguous deletions", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const stateFile = join(state, "config.json");
    const deletedFile = join(state, "keep-on-ambiguous-delete.json");
    const addedAudio = join(state, "audio", "post-snapshot.wav");
    const addedLog = join(state, "logs", "standalone.log");
    createApp(installed, "installed");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, "original-state\n");
    writeFileSync(deletedFile, "restore-on-delete\n");

    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    expect(existsSync(journalPath)).toBeTrue();
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      installer_owned_state: Array<{ path: string; sha256: string }>;
      non_database_rollback: string;
      state_backup: string;
    };
    expect(journal.non_database_rollback).toBe("preserve-safe-live-writes");
    expect(journal.installer_owned_state).toHaveLength(1);
    expect(existsSync(join(journal.state_backup, "rollbacks"))).toBeFalse();
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    writeFileSync(stateFile, "mutated-after-crash\n");
    mkdirSync(dirname(addedAudio), { recursive: true });
    mkdirSync(dirname(addedLog), { recursive: true });
    writeFileSync(addedAudio, "standalone-audio\n");
    writeFileSync(addedLog, "standalone-log\n");
    rmSync(deletedFile);

    const recovered = await runInstaller(fixture, [], {
      FAIL_ARCHIVE_VERIFY: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("installed");
    expect(readFileSync(stateFile, "utf8")).toBe("mutated-after-crash\n");
    expect(readFileSync(addedAudio, "utf8")).toBe("standalone-audio\n");
    expect(readFileSync(addedLog, "utf8")).toBe("standalone-log\n");
    expect(readFileSync(deletedFile, "utf8")).toBe("restore-on-delete\n");
    expect(existsSync(join(state, "rollbacks"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeFalse();
  });

  test("recovery replays after SIGKILL during an atomic missing-file copy", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const restoredDirectory = join(state, "nested", "state");
    const restoredFile = join(restoredDirectory, "large-state.bin");
    const originalContents = Buffer.alloc(256 * 1024, 0x5a);
    const journalPath = join(
      fixture.home,
      "Applications",
      ".Recordings-install-transaction.json",
    );
    createApp(installed, "installed");
    mkdirSync(restoredDirectory, { recursive: true });
    writeFileSync(restoredFile, originalContents);

    const installCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(installCrash.exitCode).not.toBe(0);
    rmSync(join(state, "nested"), { recursive: true });

    const copyCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_CRASH_RECOVERY_DURING_FILE_COPY: "nested/state/large-state.bin",
    });

    expect(copyCrash.exitCode).not.toBe(0);
    expect(existsSync(join(state, "nested"))).toBeTrue();
    expect(existsSync(restoredDirectory)).toBeTrue();
    expect(existsSync(restoredFile)).toBeFalse();
    expect(existsSync(journalPath)).toBeTrue();
    const recoveryTemporaries = readdirSync(restoredDirectory).filter((entry) =>
      /^\.large-state\.bin\.recordings-recovery\.[0-9a-f]{16}\.[0-9a-f-]+\.tmp$/.test(entry)
    );
    expect(recoveryTemporaries).toHaveLength(1);
    const partialBytes = statSync(join(restoredDirectory, recoveryTemporaries[0]!)).size;
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(originalContents.length);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const publishCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_CRASH_RECOVERY_AFTER_FILE_PUBLISH: "nested/state/large-state.bin",
    });

    expect(publishCrash.exitCode).not.toBe(0);
    expect(readFileSync(restoredFile)).toEqual(originalContents);
    expect(existsSync(journalPath)).toBeTrue();
    expect(
      readdirSync(restoredDirectory).filter((entry) => entry.includes(".recordings-recovery.")),
    ).toHaveLength(1);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const replayed = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });

    expect(replayed.exitCode).not.toBe(0);
    expect(replayed.stderr).toContain("Recovering incomplete");
    expect(readFileSync(restoredFile)).toEqual(originalContents);
    expect(
      readdirSync(restoredDirectory).some((entry) => entry.includes(".recordings-recovery.")),
    ).toBeFalse();
    expect(existsSync(journalPath)).toBeFalse();
  });

  test("recovery replays after SIGKILL following durable archive unlink", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const restored = join(state, "restore-after-archive-unlink.json");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(restored, "snapshot-state\n");
    const installCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(installCrash.exitCode).not.toBe(0);
    const originalJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      installer_owned_state: Array<{ path: string }>;
    };
    const archivePath = originalJournal.installer_owned_state[0]!.path;
    rmSync(restored);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const unlinkCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_RECOVERY_AFTER_ARCHIVE_UNLINK: "1",
    });
    expect(unlinkCrash.exitCode).not.toBe(0);
    expect(readFileSync(restored, "utf8")).toBe("snapshot-state\n");
    expect(existsSync(archivePath)).toBeFalse();
    expect(JSON.parse(readFileSync(journalPath, "utf8")).phase).toBe("state-restored");
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const replayed = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
    expect(replayed.exitCode).not.toBe(0);
    expect(replayed.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
    expect(readFileSync(restored, "utf8")).toBe("snapshot-state\n");
    expect(existsSync(journalPath)).toBeFalse();
    expect(existsSync(join(state, "rollbacks"))).toBeFalse();
  });

  test("a concurrent live file wins atomic recovery publication", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const restoredFile = join(state, "concurrent-state.bin");
    const readyFifo = join(fixture.root, "recovery-publish-ready.fifo");
    const resumeFifo = join(fixture.root, "recovery-publish-resume.fifo");
    const snapshotContents = Buffer.alloc(128 * 1024, 0x41);
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(restoredFile, snapshotContents);

    const installCrash = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(installCrash.exitCode).not.toBe(0);
    rmSync(restoredFile);
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      FAIL_ARCHIVE_VERIFY: "1",
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH: "concurrent-state.bin",
      RECORDINGS_TEST_RECOVERY_PUBLISH_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_PUBLISH_RESUME_FIFO: resumeFifo,
    });
    const publishTarget = await readFifoLine(readyFifo);
    writeFileSync(restoredFile, "concurrent-live-write\n", { mode: 0o600 });
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(publishTarget).toBe("concurrent-state.bin");
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(restoredFile, "utf8")).toBe("concurrent-live-write\n");
    expect(readdirSync(state).some((entry) => entry.includes(".recordings-recovery."))).toBeFalse();
    expect(
      existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json")),
      recovered.stderr,
    ).toBeFalse();
  });

  test("refreshes the stopped snapshot after a bundled relaunch writes state", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const config = join(state, "config.json");
    const legacyLog = join(state, "logs", "legacy.log");
    const prior = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    let relaunchedPid = 0;
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(config, "before-relaunch\n");
    try {
      const result = await runInstaller(fixture, [], {
        EXISTING_PID: String(prior.pid),
        EXISTING_PROCESS_PATH: join(installed, "Contents", "MacOS", "Recordings"),
        FAIL_ACTIVE_VERIFY: "1",
        RELAUNCH_OLD_AFTER_STOPPED: "1",
        RELAUNCH_OLD_WRITE_STATE: "1",
      });
      expect(result.exitCode).not.toBe(0);
      relaunchedPid = Number(
        readFileSync(join(fixture.markers, "relaunched-old.pid"), "utf8").trim(),
      );
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "installed",
      );
      expect(readFileSync(config, "utf8")).toBe("bundled-relaunch-write\n");
      expect(readFileSync(legacyLog, "utf8")).toBe("legacy-log-write\n");
      expect(existsSync(join(state, "rollbacks"))).toBeFalse();
      expect(() => process.kill(relaunchedPid, 0)).toThrow();
    } finally {
      if (relaunchedPid > 0) {
        try {
          process.kill(relaunchedPid);
        } catch {
          // The installer should already have stopped the exact old process.
        }
      }
      prior.kill();
      await prior.exited;
    }
  });

  test("recovery rejects unsafe post-snapshot state before restoring the app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const outside = join(fixture.root, "outside-state");
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), "original\n");
    writeFileSync(outside, "outside\n");
    await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    symlinkSync(outside, join(state, "unsafe-link"));
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("filesystem tree contains a symlink");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json")))
      .toBeTrue();
  });

  test("recovery rejects an altered installer-owned archive before restoring the app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      installer_owned_state: Array<{ path: string; sha256: string }>;
    };
    expect(journal.installer_owned_state).toHaveLength(1);
    writeFileSync(journal.installer_owned_state[0]!.path, "altered archive\n");
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("installer-owned state artifact changed before rollback");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("recovery rejects a same-owner state-root swap after pinning without external mutation", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const parkedState = join(fixture.home, ".hasna", "recordings.parked");
    const external = join(fixture.root, "external-state-root");
    const readyFifo = join(fixture.root, "state-root-pinned.fifo");
    const resumeFifo = join(fixture.root, "state-root-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), "snapshot-state\n");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel.txt"), "external-unchanged\n");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_AFTER_ROOT_PIN_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_AFTER_ROOT_PIN_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toMatch(/^\.Recordings-transaction\./);
    renameSync(state, parkedState);
    symlinkSync(external, state);
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("state root binding changed during recovery");
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("external-unchanged\n");
    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(state);
    renameSync(parkedState, state);
  });

  test("recovery rejects a nested state ancestor swap after validation without external mutation", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const nested = join(state, "nested");
    const parkedNested = join(state, "nested.parked");
    const missing = join(nested, "state", "missing.json");
    const external = join(fixture.root, "external-nested-state");
    const readyFifo = join(fixture.root, "nested-state-ready.fifo");
    const resumeFifo = join(fixture.root, "nested-state-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    mkdirSync(dirname(missing), { recursive: true });
    writeFileSync(missing, "restore-me\n");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel.txt"), "external-unchanged\n");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    rmSync(missing);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH_TARGET: "nested/state/missing.json",
      RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe("nested/state/missing.json");
    renameSync(nested, parkedNested);
    symlinkSync(external, nested);
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("live state ancestor binding changed during recovery");
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("external-unchanged\n");
    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
    expect(existsSync(join(parkedNested, "state", "missing.json"))).toBeFalse();
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(nested);
    renameSync(parkedNested, nested);
  });

  test("recovery rejects an Applications ancestor swap before app publication", async () => {
    const fixture = createInstallerFixture();
    const applications = join(fixture.home, "Applications");
    const parkedApplications = join(fixture.home, "Applications.parked");
    const installed = join(applications, "Recordings.app");
    const external = join(fixture.root, "external-applications");
    const readyFifo = join(fixture.root, "app-publish-ready.fifo");
    const resumeFifo = join(fixture.root, "app-publish-resume.fifo");
    createApp(installed, "installed");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel.txt"), "external-unchanged\n");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    rmSync(join(applications, ".Recordings-install-lock"), { recursive: true, force: true });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_TARGET: "Recordings.app",
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe("Recordings.app");
    renameSync(applications, parkedApplications);
    symlinkSync(external, applications);
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("Applications binding changed during recovery");
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("external-unchanged\n");
    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
    expect(existsSync(join(parkedApplications, ".Recordings-install-transaction.json"))).toBeTrue();
    rmSync(applications);
    renameSync(parkedApplications, applications);
    rmSync(join(applications, ".Recordings-install-lock"), { recursive: true, force: true });
  });

  test("recovery rejects authenticated app-backup leaf substitution before publication", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const readyFifo = join(fixture.root, "app-source-ready.fifo");
    const resumeFifo = join(fixture.root, "app-source-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      originals: Array<{ backup: string }>;
    };
    const backup = journal.originals[0]!.backup;
    const parkedBackup = `${backup}.parked`;
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_TARGET: "Recordings.app",
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_APP_PUBLISH_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe("Recordings.app");
    renameSync(backup, parkedBackup);
    createApp(backup, "substituted-backup");
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("app backup binding changed during recovery");
    expect(existsSync(installed)).toBeFalse();
    expect(readFileSync(join(backup, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "substituted-backup",
    );
    expect(readFileSync(join(parkedBackup, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "installed",
    );
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(backup, { recursive: true });
    renameSync(parkedBackup, backup);
  });

  test("recovery rejects a rollback archive-parent swap before unlink without external mutation", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const state = join(fixture.home, ".hasna", "recordings");
    const rollbacks = join(state, "rollbacks");
    const parkedRollbacks = join(state, "rollbacks.parked");
    const external = join(fixture.root, "external-rollbacks");
    const readyFifo = join(fixture.root, "archive-unlink-ready.fifo");
    const resumeFifo = join(fixture.root, "archive-unlink-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), "snapshot-state\n");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel.txt"), "external-unchanged\n");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      installer_owned_state: Array<{ path: string }>;
    };
    const archiveLeaf = journal.installer_owned_state[0]!.path.split("/").at(-1)!;
    expect(existsSync(join(rollbacks, archiveLeaf))).toBeTrue();
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_ARCHIVE_UNLINK_TARGET: archiveLeaf,
      RECORDINGS_TEST_RECOVERY_BEFORE_ARCHIVE_UNLINK_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_ARCHIVE_UNLINK_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe(archiveLeaf);
    renameSync(rollbacks, parkedRollbacks);
    symlinkSync(external, rollbacks);
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("rollback archive parent binding changed during recovery");
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("external-unchanged\n");
    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
    expect(existsSync(join(parkedRollbacks, archiveLeaf))).toBeTrue();
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(rollbacks);
    renameSync(parkedRollbacks, rollbacks);
  });

  test("recovery quarantines the proven archive and preserves final-delete leaf substitutions", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const readyFifo = join(fixture.root, "archive-quarantine-ready.fifo");
    const resumeFifo = join(fixture.root, "archive-quarantine-resume.fifo");
    createApp(installed, "installed");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      installer_owned_state: Array<{ path: string }>;
    };
    const archivePath = journal.installer_owned_state[0]!.path;
    const archiveLeaf = archivePath.split("/").at(-1)!;
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_TARGET: archiveLeaf,
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_RESUME_FIFO: resumeFifo,
    });
    const [reportedLeaf, quarantineLeaf] = (await readFifoLine(readyFifo)).split("\t");
    expect(reportedLeaf).toBe(archiveLeaf);
    const quarantinePath = join(dirname(archivePath), quarantineLeaf!);
    const parkedArchive = `${quarantinePath}.parked`;
    renameSync(quarantinePath, parkedArchive);
    writeFileSync(quarantinePath, "manual quarantine substitute\n");
    writeFileSync(archivePath, "manual original-name substitute\n");
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("installer-owned state artifact quarantine binding changed");
    expect(readFileSync(quarantinePath, "utf8")).toBe("manual quarantine substitute\n");
    expect(readFileSync(archivePath, "utf8")).toBe("manual original-name substitute\n");
    expect(existsSync(parkedArchive)).toBeTrue();
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("schema-v6 recovery fails closed instead of using destructive state restore", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown> & {
      transaction_dir: string;
    };
    const legacyBackup = join(journal.transaction_dir, "state.stopped");
    const digest = Bun.spawnSync([
      bunExecutable,
      join(fixture.root, "scripts", "macos_artifact.ts"),
      "tree-digest",
      "--path",
      legacyBackup,
    ]);
    expect(digest.exitCode, digest.stderr.toString()).toBe(0);
    journal.schema_version = 6;
    delete journal.candidate_tree_sha256;
    delete journal.candidate_staging;
    journal.state_backup = legacyBackup;
    journal.state_backup_sha256 = digest.stdout.toString().trim();
    delete journal.non_database_rollback;
    delete journal.installer_owned_state;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain(
      "legacy install transaction cannot safely merge post-snapshot non-database writes",
    );
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("legacy recovery rejects injected candidate-tree deletion evidence", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.schema_version = 8;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });

    const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain(
      "legacy install transaction journal contains unsupported candidate-tree evidence",
    );
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("recovers a committed pre-launch crash without launching the app", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    createApp(installed, "installed");
    const crashed = await runInstaller(fixture, ["--launch", "--launch-timeout", "2"], {
      SPAWN_LAUNCHED_PROCESS: "1",
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "committed",
    });
    expect(crashed.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.markers, "launched.pid"))).toBeFalse();
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json"))).toBeTrue();

    const recovered = await runInstaller(fixture, [], {
      SPAWN_LAUNCHED_PROCESS: "1",
      FAIL_ARCHIVE_VERIFY: "1",
    });
    expect(recovered.stderr).toContain("Recovering incomplete");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe("candidate");
    expect(existsSync(join(fixture.markers, "launched.pid"))).toBeFalse();
  });

  test("committed journal write failure rolls back before launching and restarts the prior app", async () => {
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
      expect(
        readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8"),
        result.stderr,
      ).toBe("installed");
      const pids = readFileSync(join(fixture.markers, "launched-pids.log"), "utf8")
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(1);
      expect(() => process.kill(pids[0]!, 0)).not.toThrow();
      process.kill(pids[0]!);
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
        RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-launched-after-commit",
      });
      expect(crashed.exitCode).not.toBe(0);
      launchedPid = Number(readFileSync(join(fixture.markers, "launched.pid"), "utf8").trim());
      const recovered = await runInstaller(fixture, [], {
        SPAWN_LAUNCHED_PROCESS: "1",
        FAIL_ARCHIVE_VERIFY: "1",
      });
      expect(recovered.stderr).not.toContain("Recovering incomplete");
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

  test("recovery restarts only the recorded legacy app after maintenance release and rejects pathless journals", async () => {
    const prepareRunningLegacyRecovery = async (fixture: ReturnType<typeof createInstallerFixture>) => {
      const legacyApp = join(fixture.home, ".hasna", "recordings", "Recordings.app");
      const canonicalApp = join(fixture.home, "Applications", "Recordings.app");
      createApp(legacyApp, "legacy-installed");
      createApp(canonicalApp, "canonical-installed");
      const prior = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const crashed = await runLocalInstaller(fixture, [], {
          EXISTING_PID: String(prior.pid),
          EXISTING_PROCESS_PATH: join(legacyApp, "Contents", "MacOS", "Recordings"),
          RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
        });
        expect(crashed.exitCode).not.toBe(0);
        const stopped = await Promise.race([
          prior.exited.then(() => true),
          new Promise<false>((resolve) => {
            stopTimeout = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        expect(stopped).toBeTrue();
      } finally {
        if (stopTimeout !== undefined) clearTimeout(stopTimeout);
        if (prior.exitCode === null) prior.kill();
        await prior.exited;
      }
      const journalPath = join(
        fixture.home,
        "Applications",
        ".Recordings-install-transaction.json",
      );
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        prior_running_app_paths: string[];
        was_running: boolean;
      };
      expect(journal.was_running).toBeTrue();
      expect(journal.prior_running_app_paths).toEqual([legacyApp]);
      return { journalPath, legacyApp, canonicalApp };
    };

    const runRestartOrderingContract = async (restartBeforeRelease: boolean) => {
      const fixture = createInstallerFixture();
      const { legacyApp, canonicalApp } = await prepareRunningLegacyRecovery(fixture);
      const fixtureInstaller = join(fixture.root, "scripts", "install_macos_app.sh");
      if (restartBeforeRelease) {
        const source = readFileSync(fixtureInstaller, "utf8");
        const protectedOrdering = `release_sqlite_barrier || status=1
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && ! release_maintenance_marker; then
    RECOVERED_APP_RESTART_ON_ABORT=0
    status=1
  fi
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && \\
     [ "$RECOVERED_APP_RESTART_ON_ABORT" -eq 1 ]; then
    restart_recorded_app_paths
  fi`;
        expect(source).toContain(protectedOrdering);
        writeFileSync(
          fixtureInstaller,
          source.replace(
            protectedOrdering,
            `release_sqlite_barrier || status=1
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && \\
     [ "$RECOVERED_APP_RESTART_ON_ABORT" -eq 1 ]; then
    restart_recorded_app_paths
  fi
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && ! release_maintenance_marker; then
    RECOVERED_APP_RESTART_ON_ABORT=0
    status=1
  fi`,
          ),
        );
      }
      const recoveryOpen = join(fixture.bin, "recovery-open");
      const openLog = join(fixture.markers, "recovery-open.log");
      writeExecutable(
        recoveryOpen,
        `#!/usr/bin/env bash
set -euo pipefail
marker_state=released
[ ! -e "$HOME/.hasna/.recordings-install-maintenance" ] || marker_state=present
printf '%s|%s\\n' "$marker_state" "$*" >> "$RECOVERY_OPEN_LOG"
`,
      );
      const recovered = await runLocalInstaller(fixture, [], {
        FAIL_ARCHIVE_VERIFY: "1",
        RECORDINGS_TEST_INSTALL_OPEN_EXECUTABLE: recoveryOpen,
        RECOVERY_OPEN_LOG: openLog,
      });
      expect(recovered.exitCode).not.toBe(0);
      expect(recovered.stderr).toContain("Recovering incomplete");
      expect(readFileSync(join(legacyApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "legacy-installed",
      );
      expect(readFileSync(join(canonicalApp, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "canonical-installed",
      );
      return { legacyApp, openLog: readFileSync(openLog, "utf8").trim() };
    };

    const preFixControl = await runRestartOrderingContract(true);
    expect(preFixControl.openLog).toBe(`present|-n ${preFixControl.legacyApp}`);

    const protectedResult = await runRestartOrderingContract(false);
    expect(protectedResult.openLog).toBe(`released|-n ${protectedResult.legacyApp}`);

    const malformed = createInstallerFixture();
    const { journalPath } = await prepareRunningLegacyRecovery(malformed);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.schema_version = 4;
    delete journal.candidate_tree_sha256;
    delete journal.candidate_staging;
    delete journal.prior_running_app_paths;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const rejectedOpen = join(malformed.bin, "rejected-recovery-open");
    const rejectedOpenLog = join(malformed.markers, "rejected-recovery-open.log");
    writeExecutable(
      rejectedOpen,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$REJECTED_OPEN_LOG"
`,
    );
    const rejected = await runLocalInstaller(malformed, [], {
      FAIL_ARCHIVE_VERIFY: "1",
      RECORDINGS_TEST_INSTALL_OPEN_EXECUTABLE: rejectedOpen,
      REJECTED_OPEN_LOG: rejectedOpenLog,
    });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain(
      "legacy install transaction journal cannot safely restore prior running app paths",
    );
    expect(rejected.stderr).toContain("maintenance remains fail-closed");
    expect(existsSync(rejectedOpenLog)).toBeFalse();
    expect(existsSync(join(malformed.home, ".hasna", ".recordings-install-maintenance"))).toBeTrue();
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
    expect(existsSync(join(fixture.home, ".hasna", ".recordings-install-maintenance"))).toBeTrue();
    expect(existsSync(join(fixture.home, "Applications", ".Recordings-install-lock"))).toBeFalse();
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
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
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

  test("recovery transaction cleanup rejects a swapped leaf without deleting its substitute", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const readyFifo = join(fixture.root, "transaction-cleanup-ready.fifo");
    const resumeFifo = join(fixture.root, "transaction-cleanup-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    createApp(installed, "installed");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      transaction_dir: string;
    };
    const parkedTransaction = `${journal.transaction_dir}.parked`;
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);

    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_RECOVERY_BEFORE_TRANSACTION_CLEANUP_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_TRANSACTION_CLEANUP_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe(journal.transaction_dir.split("/").at(-1)!);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).phase).toBe("rollback-complete");
    renameSync(journal.transaction_dir, parkedTransaction);
    mkdirSync(journal.transaction_dir, { mode: 0o700 });
    writeFileSync(join(journal.transaction_dir, "external-sentinel.txt"), "do not delete\n");
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("transaction root binding changed during recovery");
    expect(readFileSync(join(journal.transaction_dir, "external-sentinel.txt"), "utf8")).toBe(
      "do not delete\n",
    );
    expect(existsSync(parkedTransaction)).toBeTrue();
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(journal.transaction_dir, { recursive: true });
    renameSync(parkedTransaction, journal.transaction_dir);

    const cleanupOnlyRecovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_RECOVERY_BEFORE_TRANSACTION_CLEANUP_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_TRANSACTION_CLEANUP_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe(journal.transaction_dir.split("/").at(-1)!);
    renameSync(journal.transaction_dir, parkedTransaction);
    mkdirSync(journal.transaction_dir, { mode: 0o700 });
    writeFileSync(join(journal.transaction_dir, "cleanup-only-sentinel.txt"), "do not delete\n");
    writeFileSync(resumeFifo, "continue\n");
    const cleanupOnlyResult = await cleanupOnlyRecovery;
    expect(cleanupOnlyResult.exitCode).not.toBe(0);
    expect(
      readFileSync(join(journal.transaction_dir, "cleanup-only-sentinel.txt"), "utf8"),
    ).toBe("do not delete\n");
    expect(existsSync(journalPath)).toBeTrue();
    rmSync(journal.transaction_dir, { recursive: true });
    renameSync(parkedTransaction, journal.transaction_dir);
  });

  test("shell crash hooks require the explicit non-production master flag", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "0",
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      readFileSync(
        join(fixture.home, "Applications", "Recordings.app", "Contents", "MacOS", "Recordings"),
        "utf8",
      ),
    ).toBe("candidate");
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

  test("recovery preserves a manual candidate replacement that does not match durable evidence", async () => {
    const fixture = createInstallerFixture();
    const installed = join(fixture.home, "Applications", "Recordings.app");
    const parkedCandidate = join(fixture.home, "Applications", "Recordings.candidate.parked");
    const readyFifo = join(fixture.root, "candidate-proof-ready.fifo");
    const resumeFifo = join(fixture.root, "candidate-proof-resume.fifo");
    const journalPath = join(fixture.home, "Applications", ".Recordings-install-transaction.json");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      schema_version: number;
      candidate_tree_sha256?: string;
    };
    expect(journal.schema_version).toBe(9);
    expect(journal.candidate_tree_sha256).toMatch(/^[a-f0-9]{64}$/);
    rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
      recursive: true,
      force: true,
    });
    createFifo(readyFifo);
    createFifo(resumeFifo);
    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_CANDIDATE_REMOVE_TARGET: "Recordings.app",
      RECORDINGS_TEST_RECOVERY_BEFORE_CANDIDATE_REMOVE_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_CANDIDATE_REMOVE_RESUME_FIFO: resumeFifo,
    });
    expect(await readFifoLine(readyFifo)).toBe("Recordings.app");
    renameSync(installed, parkedCandidate);
    createApp(installed, "manual-replacement");
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("uncommitted candidate does not match durable recovery evidence");
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "manual-replacement",
    );
    expect(readFileSync(join(parkedCandidate, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
  });

  test("candidate quarantine final-delete swap preserves both substitute leaves", async () => {
    const fixture = createInstallerFixture();
    const applications = join(fixture.home, "Applications");
    const installed = join(applications, "Recordings.app");
    const readyFifo = join(fixture.root, "candidate-quarantine-ready.fifo");
    const resumeFifo = join(fixture.root, "candidate-quarantine-resume.fifo");
    const journalPath = join(applications, ".Recordings-install-transaction.json");
    const crashed = await runInstaller(fixture, [], {
      RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
    });
    expect(crashed.exitCode).not.toBe(0);
    rmSync(join(applications, ".Recordings-install-lock"), { recursive: true, force: true });
    createFifo(readyFifo);
    createFifo(resumeFifo);
    const recovery = runInstaller(fixture, [], {
      RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_TARGET: "Recordings.app",
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_READY_FIFO: readyFifo,
      RECORDINGS_TEST_RECOVERY_BEFORE_QUARANTINE_REMOVE_RESUME_FIFO: resumeFifo,
    });
    const [reportedLeaf, quarantineLeaf] = (await readFifoLine(readyFifo)).split("\t");
    expect(reportedLeaf).toBe("Recordings.app");
    const quarantinePath = join(applications, quarantineLeaf!);
    const parkedCandidate = `${quarantinePath}.parked`;
    renameSync(quarantinePath, parkedCandidate);
    createApp(quarantinePath, "quarantine-substitute");
    createApp(installed, "original-name-substitute");
    writeFileSync(resumeFifo, "continue\n");
    const recovered = await recovery;

    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toContain("uncommitted candidate quarantine binding changed");
    expect(readFileSync(join(quarantinePath, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "quarantine-substitute",
    );
    expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "original-name-substitute",
    );
    expect(readFileSync(join(parkedCandidate, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(journalPath)).toBeTrue();
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
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8").trim()).toMatch(
      /scripts\/macos_artifact\.ts native-fs-guard-check$/,
    );
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
        ...installerToolOverrides(fixture),
        RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS: "1",
        RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS: "30",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const owner = join(fixture.home, "Applications", ".Recordings-install-lock", "owner");
    const maintenanceOwner = join(
      fixture.home,
      ".hasna",
      ".recordings-install-maintenance",
      "owner",
    );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(owner); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(owner)).toBeTrue();
      for (let attempt = 0; attempt < 100 && !existsSync(maintenanceOwner); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(maintenanceOwner)).toBeTrue();
      const bunLog = join(fixture.markers, "bun.log");
      const beforeSecond = readFileSync(bunLog, "utf8");
      const second = await runInstaller(fixture);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("owns the active install lock");
      expect(readFileSync(bunLog, "utf8").slice(beforeSecond.length)).not.toContain("verify-archive");
    } finally {
      first.kill();
      await first.exited;
    }
  });

  test("holds the real SQLite writer barrier through the stopped-state snapshot and rollback", async () => {
    const runBarrierContract = async (releaseBeforeSnapshot: boolean) => {
      const fixture = createInstallerFixture();
      const installed = join(fixture.home, "Applications", "Recordings.app");
      const state = join(fixture.home, ".hasna", "recordings");
      const databasePath = join(state, "recordings.db");
      createApp(installed, "installed");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const database = new Database(databasePath, { create: true });
      database.run("PRAGMA journal_mode = WAL");
      database.run("CREATE TABLE coordination_probe (value TEXT PRIMARY KEY)");
      database.run("INSERT INTO coordination_probe VALUES ('original')");
      database.close();
      chmodSync(databasePath, 0o600);

      const fixtureInstaller = join(fixture.root, "scripts", "install_macos_app.sh");
      if (releaseBeforeSnapshot) {
        const source = readFileSync(fixtureInstaller, "utf8");
        const protectedBoundary = `stop_old_processes
acquire_sqlite_barrier
# A previous release may ignore the new maintenance marker`;
        expect(source).toContain(protectedBoundary);
        writeFileSync(
          fixtureInstaller,
          source.replace(
            protectedBoundary,
            `stop_old_processes
acquire_sqlite_barrier
release_sqlite_barrier
# A previous release may ignore the new maintenance marker`,
          ),
        );
      }

      const snapshotEntered = join(fixture.root, "snapshot-entered.fifo");
      const snapshotRelease = join(fixture.root, "snapshot-release.fifo");
      const writerEntered = join(fixture.root, "writer-entered.fifo");
      createFifo(snapshotEntered);
      createFifo(snapshotRelease);
      createFifo(writerEntered);
      const synchronizedDitto = join(fixture.bin, "synchronized-ditto");
      writeExecutable(
        synchronizedDitto,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = -x ]; then
  destination="\${@: -1}"
  cp -R "$CANDIDATE_SOURCE" "$destination/Recordings.app"
elif [ "$1" = -c ]; then
  printf archive > "\${@: -1}"
else
  if [[ "$2" == */state.stopped ]]; then
    printf 'snapshot-entered\\n' > "$SNAPSHOT_ENTERED_FIFO"
    IFS= read -r release < "$SNAPSHOT_RELEASE_FIFO"
    [ "$release" = release ]
  fi
  cp -R "$1" "$2"
fi
`,
      );
      const writer = join(fixture.root, "previous-release-writer.sh");
      writeExecutable(
        writer,
        `#!/usr/bin/env bash
set -euo pipefail
printf 'writer-entered\\n' > "$2"
exec /usr/bin/sqlite3 -batch "$1" <<'SQL'
.bail on
.timeout 0
INSERT INTO coordination_probe VALUES ('concurrent');
SQL
`,
      );

      const snapshotSignal = readFifoLine(snapshotEntered);
      const installResult = runInstaller(fixture, [], {
        FAIL_ACTIVE_VERIFY: "1",
        RECORDINGS_TEST_INSTALL_DITTO_EXECUTABLE: synchronizedDitto,
        SNAPSHOT_ENTERED_FIFO: snapshotEntered,
        SNAPSHOT_RELEASE_FIFO: snapshotRelease,
      });
      expect(await snapshotSignal).toBe("snapshot-entered");

      const writerSignal = readFifoLine(writerEntered);
      const previousReleaseWriter = Bun.spawn([writer, databasePath, writerEntered], {
        stdout: "pipe",
        stderr: "pipe",
      });
      let writerExitCode = -1;
      let writerStderr = "";
      try {
        expect(await writerSignal).toBe("writer-entered");
        [writerExitCode, writerStderr] = await Promise.all([
          previousReleaseWriter.exited,
          new Response(previousReleaseWriter.stderr).text(),
        ]);
      } finally {
        writeFileSync(snapshotRelease, "release\n");
        if (previousReleaseWriter.exitCode === null) previousReleaseWriter.kill();
        await previousReleaseWriter.exited;
      }
      const result = await installResult;
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(installed, "Contents", "MacOS", "Recordings"), "utf8")).toBe(
        "installed",
      );
      const recovered = new Database(databasePath, { readonly: true });
      const values = recovered
        .query("SELECT value FROM coordination_probe ORDER BY value")
        .all() as Array<{ value: string }>;
      recovered.close();
      return { writerExitCode, writerStderr, values: values.map(({ value }) => value) };
    };

    const preFixControl = await runBarrierContract(true);
    expect(preFixControl.writerExitCode).toBe(0);
    expect(preFixControl.values).toEqual(["concurrent", "original"]);

    const protectedResult = await runBarrierContract(false);
    expect(protectedResult.writerExitCode).not.toBe(0);
    expect(protectedResult.writerStderr).toContain("database is locked");
    expect(protectedResult.values).toEqual(["original"]);
  });

  test("an existing bun:sqlite handle writes through recovery without path-replacing SQLite files", async () => {
    const runOpenHandleContract = async (replaceCanonicalDatabase: boolean) => {
      const fixture = createInstallerFixture();
      const installed = join(fixture.home, "Applications", "Recordings.app");
      const state = join(fixture.home, ".hasna", "recordings");
      const databasePath = join(state, "recordings.db");
      const sqlitePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      createApp(installed, "installed");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const database = new Database(databasePath, { create: true });
      database.run("PRAGMA journal_mode = WAL");
      database.run("PRAGMA wal_autocheckpoint = 0");
      database.run("CREATE TABLE open_handle_probe (value TEXT PRIMARY KEY)");
      database.run("INSERT INTO open_handle_probe VALUES ('before-recovery')");
      chmodSync(databasePath, 0o600);
      const originalIdentities = new Map(
        sqlitePaths
          .filter((path) => existsSync(path))
          .map((path) => [path, { dev: statSync(path).dev, ino: statSync(path).ino }]),
      );
      expect(originalIdentities.has(databasePath)).toBeTrue();

      const interrupted = await runInstaller(fixture, [], {
        RECORDINGS_TEST_CRASH_AFTER_PHASE: "candidate-installed",
      });
      expect(interrupted.exitCode).not.toBe(0);
      expect(
        existsSync(join(fixture.home, "Applications", ".Recordings-install-transaction.json")),
      ).toBeTrue();
      rmSync(join(fixture.home, "Applications", ".Recordings-install-lock"), {
        recursive: true,
        force: true,
      });

      if (replaceCanonicalDatabase) {
        const artifactTool = join(fixture.root, "scripts", "macos_artifact.ts");
        const source = readFileSync(artifactTool, "utf8");
        const restoreStart = source.indexOf("function restoreStatePreservingDatabase(");
        const restoreEnd = source.indexOf("\nfunction recoverJournal(", restoreStart);
        expect(restoreStart).toBeGreaterThan(0);
        expect(restoreEnd).toBeGreaterThan(restoreStart);
        const inodeReplacingRecovery = `function restoreStatePreservingDatabase(
  journal: InstallJournal,
  _capabilities: RecoveryCapabilities,
): void {
  const backupPath = journal.state_backup;
  const dataPath = journal.data_dir;
  rmSync(dataPath, { recursive: true, force: true });
  cpSync(backupPath, dataPath, { recursive: true, preserveTimestamps: true });
  fsyncTree(dataPath);
  fsyncDirectory(dirname(dataPath));
}
`;
        writeFileSync(
          artifactTool,
          `${source.slice(0, restoreStart)}${inodeReplacingRecovery}${source.slice(restoreEnd + 1)}`,
        );
      }

      const recovered = await runInstaller(fixture, [], { FAIL_ARCHIVE_VERIFY: "1" });
      expect(recovered.exitCode).not.toBe(0);
      expect(recovered.stderr).toContain("Recovering incomplete");
      const canonicalIdentities = new Map(
        sqlitePaths
          .filter((path) => existsSync(path))
          .map((path) => [path, { dev: statSync(path).dev, ino: statSync(path).ino }]),
      );
      for (const path of canonicalIdentities.keys()) {
        const details = lstatSync(path);
        expect(details.isFile()).toBeTrue();
        expect(details.isSymbolicLink()).toBeFalse();
        expect(details.uid).toBe(process.getuid?.());
        expect(details.mode & 0o022).toBe(0);
      }
      let openHandleWriteError: unknown;
      try {
        database.run("INSERT INTO open_handle_probe VALUES ('after-recovery')");
      } catch (error) {
        openHandleWriteError = error;
      } finally {
        database.close();
      }

      const canonical = new Database(databasePath, { readonly: true });
      const integrity = canonical.query("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      const values = canonical
        .query("SELECT value FROM open_handle_probe ORDER BY value")
        .all() as Array<{ value: string }>;
      canonical.close();
      return {
        canonicalIdentities,
        databasePath,
        integrity: integrity.integrity_check,
        openHandleWriteError,
        originalIdentities,
        values: values.map(({ value }) => value),
      };
    };

    const inodeReplacingControl = await runOpenHandleContract(true);
    expect(inodeReplacingControl.canonicalIdentities.get(inodeReplacingControl.databasePath))
      .not.toEqual(
        inodeReplacingControl.originalIdentities.get(inodeReplacingControl.databasePath),
      );
    expect(
      inodeReplacingControl.openHandleWriteError !== undefined ||
        !inodeReplacingControl.values.includes("after-recovery"),
    ).toBeTrue();

    const preserved = await runOpenHandleContract(false);
    expect(preserved.openHandleWriteError).toBeUndefined();
    expect(preserved.integrity).toBe("ok");
    expect(preserved.values).toEqual(["after-recovery", "before-recovery"]);
    for (const [path, identity] of preserved.originalIdentities) {
      expect(preserved.canonicalIdentities.has(path)).toBeTrue();
      expect(preserved.canonicalIdentities.get(path)).toEqual(identity);
    }
  });

  test("the shared app-parent lock blocks an older pre-lock-mutating installer from replacement", async () => {
    const fixture = createInstallerFixture();
    const state = createLegacyState(fixture);
    chmodSync(state, 0o700);
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
        ...installerToolOverrides(fixture),
        RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS: "5",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const owner = join(fixture.home, "Applications", ".Recordings-install-lock", "owner");
    const legacy = join(fixture.root, "legacy-installer.sh");
    writeExecutable(
      legacy,
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.hasna/recordings/audio" "$HOME/.hasna/recordings/rollbacks" "$HOME/Applications"
if mkdir "$HOME/Applications/.Recordings-install-lock" 2>/dev/null; then
  mkdir -p "$HOME/Applications/Recordings.app"
  exit 0
fi
exit 73
`,
    );
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(owner); attempt += 1) await Bun.sleep(10);
      expect(existsSync(owner)).toBeTrue();
      const oldAttempt = Bun.spawnSync(["bash", legacy], { env: { ...Bun.env, HOME: fixture.home } });
      expect(oldAttempt.exitCode).toBe(73);
      expect(existsSync(join(fixture.home, "Applications", "Recordings.app"))).toBeFalse();
      // Old binaries may create their historical child paths before the shared lock.
      expect(existsSync(join(state, "audio"))).toBeTrue();
      expect(existsSync(join(state, "rollbacks"))).toBeTrue();
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
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8").trim()).toMatch(
      /scripts\/macos_artifact\.ts native-fs-guard-check$/,
    );
  });

  test("rejects a zero incomplete-lock grace", async () => {
    const fixture = createInstallerFixture();
    const result = await runInstaller(fixture, [], { RECORDINGS_LOCK_STALE_SECONDS: "0" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("at least 5 seconds");
    expect(readFileSync(join(fixture.markers, "bun.log"), "utf8").trim()).toMatch(
      /scripts\/macos_artifact\.ts native-fs-guard-check$/,
    );
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
acknowledgement=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--runtime-smoke-output" ]; then output="$2"; shift 2; continue; fi
  if [ "$1" = "--runtime-smoke-ack" ]; then acknowledgement="$2"; shift 2; continue; fi
  shift
done
/bin/true &
app_pid="$!"
wait "$app_pid"
printf '{"processIdentifier":%s}\n' "$app_pid" > "$output"
while [ ! -e "$acknowledgement" ]; do /bin/sleep 0.01; done
`,
    );
    writeExecutable(join(fixture.bin, "bun"), "#!/usr/bin/env bash\nprintf '123\\n'\n");
    const smoke = Bun.spawn(["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), app, bunExecutable], {
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN: "1",
        RECORDINGS_TEST_SMOKE_LSOF_EXECUTABLE: join(fixture.bin, "lsof"),
        RECORDINGS_TEST_SMOKE_OPEN_EXECUTABLE: join(fixture.bin, "open"),
      },
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
      `#!/usr/bin/env bash
acknowledgement=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--runtime-smoke-ack" ]; then acknowledgement="$2"; shift 2; continue; fi
  shift
done
while [ ! -e "$acknowledgement" ]; do /bin/sleep 0.01; done
`,
    );
    writeExecutable(join(fixture.bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(join(fixture.bin, "bun"), "#!/usr/bin/env bash\nexit 1\n");
    const smoke = Bun.spawn(["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), app, bunExecutable], {
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN: "1",
        RECORDINGS_TEST_SMOKE_LSOF_EXECUTABLE: join(fixture.bin, "lsof"),
        RECORDINGS_TEST_SMOKE_OPEN_EXECUTABLE: join(fixture.bin, "open"),
      },
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
    chmodSync(join(fixture.root, "scripts", "smoke_macos_app.sh"), 0o755);
    const appLog = join(fixture.markers, "opened-apps.log");
    const lsofState = join(fixture.markers, "lsof-state");
    writeExecutable(
      join(physicalApp, "Contents", "MacOS", "Recordings"),
      `#!/usr/bin/env bash
output=""
mode=""
acknowledgement=""
completion=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --runtime-smoke ]; then mode="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-output ]; then output="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-ack ]; then acknowledgement="$2"; shift 2; continue; fi
  if [ "$1" = --runtime-smoke-completion ]; then completion="$2"; shift 2; continue; fi
  shift
done
app="$FIXTURE_APP_PATH"
printf '%s\\n' "$app" >> '${appLog}'
app_pid="$$"
printf '%s\\n%s\\n' "$app_pid" "$app/Contents/MacOS/Recordings" > '${lsofState}'
ln -sfn '${driftRelease}' '${releaseLink}'
if [ "$mode" = normal ]; then
  printf '{"mode":"normal","processIdentifier":%s,"menuBarSurfaceCount":1,"renderedStatusLabels":["Recordings","Recordings, recording","Recordings, transcribing"],"accessibilityObservationStatus":"available","accessibilityMenuBarItemCount":1,"accessibilityMenuBarLabels":["Recordings, transcribing"],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":1,"windowActivationCount":2,"retainedWindowReused":true,"applicationActivationPolicy":0,"applicationIsActive":false,"mainWindowIsVisible":true,"mainWindowCanBecomeKey":true,"mainWindowIsKey":false,"resolvedCompanionPath":null,"companionCapabilitiesPassed":false}\\n' "$app_pid" > "$output"
elif [ "$mode" = resolver ]; then
  printf '{"mode":"resolver","processIdentifier":%s,"menuBarSurfaceCount":0,"renderedStatusLabels":[],"accessibilityObservationStatus":"absent","accessibilityMenuBarItemCount":0,"accessibilityMenuBarLabels":[],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":0,"windowActivationCount":0,"retainedWindowReused":false,"applicationActivationPolicy":1,"applicationIsActive":false,"mainWindowIsVisible":false,"mainWindowCanBecomeKey":false,"mainWindowIsKey":false,"resolvedCompanionPath":"%s/Contents/Helpers/recordings","companionCapabilitiesPassed":true}\\n' "$app_pid" "$app" > "$output"
else
  printf '{"mode":"permission-helper","processIdentifier":%s,"menuBarSurfaceCount":0,"renderedStatusLabels":[],"accessibilityObservationStatus":"absent","accessibilityMenuBarItemCount":0,"accessibilityMenuBarLabels":[],"globalHandlersInstalled":false,"permissionRequestsStarted":0,"windowCreationCount":0,"windowActivationCount":0,"retainedWindowReused":false,"applicationActivationPolicy":1,"applicationIsActive":false,"mainWindowIsVisible":false,"mainWindowCanBecomeKey":false,"mainWindowIsKey":false,"resolvedCompanionPath":null,"companionCapabilitiesPassed":false}\\n' "$app_pid" > "$output"
fi
while [ ! -e "$acknowledgement" ]; do /bin/sleep 0.01; done
IFS= read -r challenge < "$acknowledgement"
printf '{"challenge":"%s","mode":"%s","processIdentifier":%s}\\n' \
  "$challenge" "$mode" "$app_pid" > "$completion.tmp"
/bin/mv "$completion.tmp" "$completion"
`,
    );
    writeExecutable(
      join(fixture.bin, "open"),
      `#!/usr/bin/env bash
set -euo pipefail
app=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -W ]; then app="$2"; shift 2; continue; fi
  if [ "$1" = --args ]; then shift; break; fi
  shift
done
FIXTURE_APP_PATH="$app" "$app/Contents/MacOS/Recordings" "$@" &
app_pid="$!"
if wait "$app_pid"; then exit 0; else exit $?; fi
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
state_pid="$(sed -n '1p' '${lsofState}')"
executable="$(sed -n '2p' '${lsofState}')"
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
      RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN: "1",
      RECORDINGS_TEST_SMOKE_LSOF_EXECUTABLE: join(fixture.bin, "lsof"),
      RECORDINGS_TEST_SMOKE_OPEN_EXECUTABLE: join(fixture.bin, "open"),
    };
    delete baseEnvironment.SSH_CONNECTION;
    const spawnSmoke = (env: Record<string, string | undefined>) =>
      Bun.spawn(
        ["bash", join(fixture.root, "scripts", "smoke_macos_app.sh"), join(releaseLink, "Recordings.app"), bunExecutable],
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
      realpathSync(physicalApp),
      realpathSync(physicalApp),
      realpathSync(physicalApp),
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
    const tailscaleApp = join(root, "Tailscale.app");
    const releaseBuildRoot = join(root, "release-build-root");
    const envelopePrivateKey = join(root, "release-envelope-private.raw");
    const envelopePublicKey = join(root, "release-envelope-public.raw");
    const compatibleCohortManifest = join(root, "compatible-cohort.json");
    mkdirSync(join(native, "RecordingsLib"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(markers, { recursive: true });
    mkdirSync(releaseBuildRoot, { mode: 0o700 });
    writeFileSync(envelopePrivateKey, new Uint8Array(32).fill(0x11));
    writeFileSync(envelopePublicKey, new Uint8Array(32).fill(0x22));
    chmodSync(envelopePrivateKey, 0o600);
    chmodSync(envelopePublicKey, 0o600);
    writeFileSync(
      compatibleCohortManifest,
      `${JSON.stringify({
        artifact_verifier_designated_requirement:
          'identifier "com.hasna.recordings.artifact-verifier"',
        artifact_verifier_sha256: "a".repeat(64),
        bootstrap_marker_sha256: "b".repeat(64),
        envelope_public_key_sha256: Bun.CryptoHasher.hash(
          "sha256",
          readFileSync(envelopePublicKey),
          "hex",
        ),
        installer_certificate_sha256: "c".repeat(64),
        key_epoch: 3,
        key_rotation_supported: false,
        lifecycle: "bootstrap-v1-app-updates-only",
        minimum_broker_version: "0.2.12",
        package_sha256: "d".repeat(64),
        protocol_version: 1,
        root_maintenance_supported: false,
        schema_version: 2,
        signing_team_identifier: "EXAMPLE123",
        update_broker_designated_requirement:
          'identifier "com.hasna.recordings.update-broker"',
        update_broker_sha256: "e".repeat(64),
      })}\n`,
    );
    const fixtureBuildScript = join(native, "build.sh");
    cpSync(join(repositoryRoot, "src", "native", "Recordings", "build.sh"), fixtureBuildScript);
    writeFileSync(
      fixtureBuildScript,
      readFileSync(fixtureBuildScript, "utf8").replace(
        'BUILD_ROOT="/tmp"',
        `BUILD_ROOT=${JSON.stringify(releaseBuildRoot)}`,
      ),
    );
    chmodSync(fixtureBuildScript, 0o755);
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
    writeExecutable(
      join(root, "packaging", "macos", "build_release_pkg.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
installer_identity=""
release_sequence=""
key_epoch=""
expires_at_utc=""
private_key=""
public_key=""
compatible_cohort_manifest=""
bootstrap_preflight_verifier=""
artifact_basename=""
bun_executable=""
publication_identity_sha256=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --installer-identity) installer_identity="$2"; shift 2 ;;
    --release-sequence) release_sequence="$2"; shift 2 ;;
    --key-epoch) key_epoch="$2"; shift 2 ;;
    --expires-at-utc) expires_at_utc="$2"; shift 2 ;;
    --envelope-private-key) private_key="$2"; shift 2 ;;
    --public-key) public_key="$2"; shift 2 ;;
    --artifact-basename) artifact_basename="$2"; shift 2 ;;
    --bun-executable) bun_executable="$2"; shift 2 ;;
    --bootstrap-preflight-verifier) bootstrap_preflight_verifier="$2"; shift 2 ;;
    --publication-identity-sha256) publication_identity_sha256="$2"; shift 2 ;;
    --*) shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ "$installer_identity" = "Developer ID Installer:"* ]] || exit 65
[[ "$release_sequence" =~ ^[1-9][0-9]*$ ]] || exit 66
[[ "$key_epoch" =~ ^[1-9][0-9]*$ ]] || exit 67
[ -n "$expires_at_utc" ] || exit 68
[ -f "$private_key" ] && [ ! -L "$private_key" ] || exit 69
[ -f "$public_key" ] && [ ! -L "$public_key" ] || exit 70
[ "$artifact_basename" = "Recordings-0.2.12-macos-initial-bootstrap" ] || exit 71
case "$bun_executable" in /*) ;; *) exit 73 ;; esac
[ -x "$bun_executable" ] || exit 73
[[ "$publication_identity_sha256" =~ ^[a-f0-9]{64}$ ]] || exit 74
case "$bootstrap_preflight_verifier" in
  /*/recordings-bootstrap-preflight) ;;
  *) exit 72 ;;
esac
printf '%s\n' \
  "installer_identity=$installer_identity" \
  "release_sequence=$release_sequence" \
  "key_epoch=$key_epoch" \
  "expires_at_utc=$expires_at_utc" \
  "private_key=$private_key" \
  "public_key=$public_key" \
  "artifact_basename=$artifact_basename" \
  "bun_executable=$bun_executable" \
  "bootstrap_preflight_verifier=$bootstrap_preflight_verifier" \
  "publication_identity_sha256=$publication_identity_sha256" \
  > "$MARKER_DIRECTORY/release-pkg.log"
`,
    );
    cpSync(
      join(repositoryRoot, "packaging", "macos", "release_lifecycle.ts"),
      join(root, "packaging", "macos", "release_lifecycle.ts"),
    );
    writeFileSync(
      join(root, "scripts", "macos_artifact.ts"),
      `import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const args = Bun.argv.slice(2);
appendFileSync(Bun.env.MARKER_DIRECTORY + "/bun.log", args.join(" ") + "\\n");
const argument = (name: string): string => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) process.exit(64);
  return args[index + 1];
};
if (args[0] === "tailscale-node-id-sha256") {
  const expectedHostname = args[args.indexOf("--expected-hostname") + 1];
  const status = await Bun.stdin.json();
  if (status?.Self?.Online !== true || status?.Self?.HostName !== expectedHostname || typeof status?.Self?.ID !== "string") process.exit(65);
  process.stdout.write(Bun.CryptoHasher.hash("sha256", status.Self.ID, "hex") + "\\n");
  process.exit(0);
}
if (args[0] === "provenance") process.exit(0);
if (args[0] === "snapshot-regular-file") {
  const source = argument("--source");
  const destination = argument("--destination");
  const maximumBytes = Number(argument("--maximum-bytes"));
  const expectedBytesIndex = args.indexOf("--expected-bytes");
  const expectedBytes =
    expectedBytesIndex >= 0 ? Number(args[expectedBytesIndex + 1]) : undefined;
  const contents = readFileSync(source);
  if (
    !Number.isSafeInteger(maximumBytes) ||
    contents.length > maximumBytes ||
    (expectedBytes !== undefined &&
      (!Number.isSafeInteger(expectedBytes) || contents.length !== expectedBytes))
  ) process.exit(65);
  writeFileSync(destination, contents, { flag: "wx", mode: 0o400 });
  process.stdout.write(Bun.CryptoHasher.hash("sha256", contents, "hex") + "\\n");
  process.exit(0);
}
if (args[0] === "release-publication-identity") {
  const components: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--component" && args[index + 1]) components.push(args[index + 1]);
  }
  process.stdout.write(Bun.CryptoHasher.hash("sha256", components.sort().join("\\n"), "hex") + "\\n");
  process.exit(0);
}
if (args[0] === "assert-notary-log") {
  const notaryLogPath = argument("--notary-log");
  const submissionId = argument("--submission-id");
  const submittedArchiveSha256 = argument("--submitted-archive-sha256");
  const value = JSON.parse(readFileSync(notaryLogPath, "utf8"));
  const issuesAreEmpty =
    value?.issues === null ||
    (Array.isArray(value?.issues) && value.issues.length === 0);
  if (
    value?.status !== "Accepted" ||
    !Object.prototype.hasOwnProperty.call(value, "issues") ||
    !issuesAreEmpty ||
    typeof value?.jobId !== "string" ||
    value.jobId.toLowerCase() !== submissionId.toLowerCase() ||
    !/^[0-9a-f]{64}$/.test(submittedArchiveSha256) ||
    value?.sha256 !== submittedArchiveSha256
  ) process.exit(65);
  process.exit(0);
}
if (args[0] === "prepare-release-publication") {
  const reservation = argument("--reservation");
  const publicationIdentitySha256 = argument("--publication-identity-sha256");
  const aliases: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--alias" && args[index + 1]) aliases.push(args[index + 1]);
  }
  mkdirSync(reservation, { recursive: true });
  const descriptor = JSON.stringify({
    staging: argument("--staging"),
    destination: argument("--destination"),
    publicationIdentitySha256,
    aliases,
  });
  writeFileSync(join(reservation, "fixture-publication.json"), descriptor);
  writeFileSync(join(argument("--staging"), "fixture-publication.json"), descriptor);
  process.exit(0);
}
if (args[0] === "publish-release-directory") {
  renameSync(argument("--staging"), argument("--destination"));
  process.exit(0);
}
if (args[0] === "complete-release-publication") {
  const destination = argument("--destination");
  const reservation = argument("--reservation");
  const outputRoot = argument("--output-root");
  const publicationIdentitySha256 = argument("--publication-identity-sha256");
  const descriptor = JSON.parse(
    readFileSync(join(reservation, "fixture-publication.json"), "utf8"),
  );
  if (
    descriptor.destination !== destination ||
    descriptor.publicationIdentitySha256 !== publicationIdentitySha256
  ) process.exit(65);
  for (const alias of descriptor.aliases) {
    symlinkSync(join(destination, alias), join(outputRoot, alias));
  }
  rmSync(reservation, { recursive: true });
  process.exit(0);
}
if (args[0] === "assert-release-publication-complete") {
  const destination = argument("--destination");
  const outputRoot = argument("--output-root");
  const publicationIdentitySha256 = argument("--publication-identity-sha256");
  if (!existsSync(destination)) process.exit(65);
  const descriptor = JSON.parse(
    readFileSync(join(destination, "fixture-publication.json"), "utf8"),
  );
  if (descriptor.publicationIdentitySha256 !== publicationIdentitySha256) process.exit(65);
  for (const entry of readdirSync(destination)) {
    if (entry === "fixture-publication.json") continue;
    const target = join(destination, entry);
    if (!lstatSync(target).isFile()) continue;
    const alias = join(outputRoot, entry);
    if (!existsSync(alias) || realpathSync(alias) !== realpathSync(target)) process.exit(65);
  }
  process.exit(0);
}
if (args[0] === "finalize" || args[0] === "finalize-local") {
  const manifestIndex = args.indexOf("--manifest");
  if (manifestIndex < 0 || !args[manifestIndex + 1]) process.exit(64);
  const archive = argument("--archive");
  writeFileSync(
    args[manifestIndex + 1],
    JSON.stringify({
      archive: {
        sha256: Bun.CryptoHasher.hash("sha256", readFileSync(archive), "hex"),
      },
      architectures: ["arm64", "x86_64"],
      binding: {
        bundle_tree_sha256: "f".repeat(64),
      },
      bundle_build_version: "1",
      bundle_version: "0.2.12",
      git_sha: "0".repeat(40),
      minimum_macos: "26.0",
      signing: {
        designated_requirement_sha256: Bun.CryptoHasher.hash(
          "sha256",
          'identifier "com.hasna.recordings"',
          "hex",
        ),
      },
      team_id: "EXAMPLE123",
    }) + "\\n",
  );
  process.exit(0);
}
process.exit(64);
`,
    );
    writeExecutable(
      join(bin, "swift"),
      `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = build ] || exit 0
configuration="\${3:-debug}"
output_directory=".build/$configuration"
if [ -d ${JSON.stringify(join(releaseBuildRoot, "release-output"))} ]; then
  output_directory=${JSON.stringify(join(releaseBuildRoot, "release-output"))}
fi
mkdir -p "$output_directory"
for product in \
  App \
  recordings-update-broker \
  recordings-update-client \
  recordings-envelope-signer \
  recordings-bootstrap-preflight; do
  printf '%s' "$product" > "$output_directory/$product"
  chmod +x "$output_directory/$product"
done
cat > "$output_directory/recordings-envelope-signer" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --payload|--private-key|--public-key) shift 2 ;;
    *) exit 64 ;;
  esac
done
[ -n "$output" ] || exit 64
printf '%s\n' "$output" >> "$MARKER_DIRECTORY/envelope-signer.log"
printf '{"fixture":"signed-app-update-envelope"}\n' > "$output"
EOF
chmod +x "$output_directory/recordings-envelope-signer"
`,
    );
    writeExecutable(
      join(bin, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" status --porcelain=v1 --untracked-files=all "*) exit 0 ;;
  *" rev-parse --verify HEAD^{commit} "*|*" rev-parse HEAD "*) printf '%040d\n' 0 ;;
  *) exit 64 ;;
esac
`,
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
    mkdirSync(join(tailscaleApp, "Contents", "MacOS"), { recursive: true });
    cpSync(join(bin, "tailscale"), join(tailscaleApp, "Contents", "MacOS", "Tailscale"));
    chmodSync(join(tailscaleApp, "Contents", "MacOS", "Tailscale"), 0o755);
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
if [[ "$*" == *"Tailscale.app"* ]] && [[ "$*" == *"-d --verbose=4"* ]]; then
  printf 'Identifier=io.tailscale.ipn.macsys\nTeamIdentifier=W5364U7YZB\n' >&2
elif [[ "$*" == *"--entitlements :-"* ]]; then
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
  submitted_archive="\${3:-}"
  [ -f "$submitted_archive" ] || exit 65
  /usr/bin/shasum -a 256 "$submitted_archive" | /usr/bin/awk '{print $1}' > "$MARKER_DIRECTORY/notary-submitted-sha256"
  if [ "\${NOTARY_SUBMIT_REJECTED:-0}" = 1 ]; then
    printf '{"id":"11111111-1111-4111-8111-111111111111","status":"Invalid"}\n'
  else
    printf '{"id":"11111111-1111-4111-8111-111111111111","status":"Accepted"}\n'
  fi
elif [[ "$*" == *"notarytool log"* ]]; then
  submitted_archive_sha256="$(/bin/cat "$MARKER_DIRECTORY/notary-submitted-sha256")"
  if [ "\${NOTARY_LOG_ISSUES:-0}" = 1 ]; then
    printf '{"jobId":"11111111-1111-4111-8111-111111111111","status":"Accepted","issues":[{"severity":"warning"}],"sha256":"%s"}\n' "$submitted_archive_sha256"
  else
    printf '{"jobId":"11111111-1111-4111-8111-111111111111","status":"Accepted","issues":null,"sha256":"%s"}\n' "$submitted_archive_sha256"
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
    return {
      root,
      native,
      bin,
      markers,
      tailscaleApp,
      envelopePrivateKey,
      envelopePublicKey,
      compatibleCohortManifest,
      releaseBuildRoot,
    };
  }

  function buildToolOverrides(fixture: ReturnType<typeof createBuildFixture>) {
    return {
      RECORDINGS_TEST_GIT_EXECUTABLE: join(fixture.bin, "git"),
      RECORDINGS_TEST_SWIFT_EXECUTABLE: join(fixture.bin, "swift"),
      RECORDINGS_TEST_CODESIGN_EXECUTABLE: join(fixture.bin, "codesign"),
      RECORDINGS_TEST_XCRUN_EXECUTABLE: join(fixture.bin, "xcrun"),
      RECORDINGS_TEST_SPCTL_EXECUTABLE: join(fixture.bin, "spctl"),
      RECORDINGS_TEST_SYSPOLICY_CHECK_EXECUTABLE: join(fixture.bin, "syspolicy_check"),
      RECORDINGS_TEST_DITTO_EXECUTABLE: join(fixture.bin, "ditto"),
      RECORDINGS_TEST_HOSTNAME_EXECUTABLE: join(fixture.bin, "hostname"),
    };
  }

  async function runBuild(
    fixture: ReturnType<typeof createBuildFixture>,
    environment = {},
    subtype = "initial-bootstrap",
  ) {
    rmSync(join(fixture.releaseBuildRoot, "release-output"), { recursive: true, force: true });
    const process = Bun.spawn(
      ["bash", join(fixture.native, "build.sh"), "release", subtype],
      {
      cwd: fixture.native,
      env: {
        ...Bun.env,
        PATH: `${fixture.bin}:${Bun.env.PATH ?? ""}`,
        MARKER_DIRECTORY: fixture.markers,
        PLIST_BUDDY: join(fixture.bin, "plistbuddy"),
        PLUTIL: join(fixture.bin, "plutil"),
        BUN_EXECUTABLE: bunExecutable,
        ...buildToolOverrides(fixture),
        EXPECTED_HELPER_ENTITLEMENTS: join(fixture.native, "RecordingsLib", "RecordingsCLI.entitlements"),
        RECORDINGS_CODESIGN_IDENTITY: "Developer ID Application: Example Corp (EXAMPLE123)",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "EXAMPLE123",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "recordings-notary",
        RECORDINGS_INSTALLER_CODESIGN_IDENTITY: "Developer ID Installer: Example Corp (EXAMPLE123)",
        RECORDINGS_RELEASE_SEQUENCE: "12",
        RECORDINGS_RELEASE_KEY_EPOCH: "3",
        RECORDINGS_RELEASE_ENVELOPE_EXPIRES_AT_UTC: "2026-08-01T00:00:00.000Z",
        RECORDINGS_RELEASE_ENVELOPE_PRIVATE_KEY: fixture.envelopePrivateKey,
        RECORDINGS_RELEASE_ENVELOPE_PUBLIC_KEY: fixture.envelopePublicKey,
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
        ...buildToolOverrides(fixture),
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
        ...buildToolOverrides(fixture),
        EXPECTED_HELPER_ENTITLEMENTS: join(fixture.native, "RecordingsLib", "RecordingsCLI.entitlements"),
        RECORDINGS_CODESIGN_IDENTITY: "",
        RECORDINGS_EXPECTED_TEAM_IDENTIFIER: "",
        RECORDINGS_NOTARY_KEYCHAIN_PROFILE: "",
        RECORDINGS_LOCAL_APPROVED_TARGET: "station06",
        RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND: "tailscale_node_id_sha256",
        RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256: targetTailscaleIdentitySha256,
        RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: fixture.tailscaleApp,
        RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE: join(fixture.bin, "codesign"),
        RECORDINGS_TEST_TAILSCALE_DITTO_EXECUTABLE: join(fixture.bin, "ditto"),
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
    const result = await runLocalBuild(fixture, {
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: join(fixture.root, "Applications", "Tailscale.app"),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Built immutable local-only app artifact");
    const executedCli = readFileSync(join(fixture.markers, "tailscale.log"), "utf8").trim();
    expect(executedCli.endsWith("/tailscale-identity-snapshot/Tailscale.app/Contents/MacOS/Tailscale")).toBeTrue();
    expect(executedCli).not.toBe(fallback);
  });

  test("local-only build fails closed when no executable Tailscale CLI exists", async () => {
    const fixture = createBuildFixture();
    const missingFallback = join(fixture.root, "missing", "Tailscale.app");
    rmSync(join(fixture.bin, "tailscale"));

    const result = await runLocalBuild(fixture, {
      RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: missingFallback,
    });
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
    expect(buildScript).toContain("recordings_resolve_trusted_tailscale_app_cli");
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

    const missingInstaller = await runBuild(fixture, {
      RECORDINGS_INSTALLER_CODESIGN_IDENTITY: "",
    });
    expect(missingInstaller.exitCode).not.toBe(0);
    expect(missingInstaller.stderr).toContain("RECORDINGS_INSTALLER_CODESIGN_IDENTITY");
  });

  test("enforces subtype-specific Installer and compatible-cohort inputs", async () => {
    const bootstrap = createBuildFixture();
    const bootstrapWithCohort = await runBuild(bootstrap, {
      RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST: bootstrap.compatibleCohortManifest,
    });
    expect(bootstrapWithCohort.exitCode).not.toBe(0);
    expect(bootstrapWithCohort.stderr).toContain(
      "Initial-bootstrap releases do not consume RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST",
    );

    const update = createBuildFixture();
    const updateWithoutCohortOrInstaller = await runBuild(
      update,
      {
        RECORDINGS_INSTALLER_CODESIGN_IDENTITY: "",
        RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST: "",
      },
      "app-update",
    );
    expect(updateWithoutCohortOrInstaller.exitCode).not.toBe(0);
    expect(updateWithoutCohortOrInstaller.stderr).toContain(
      "App-update test fixture requires one regular compatible-cohort manifest",
    );
    expect(updateWithoutCohortOrInstaller.stderr).not.toContain(
      "RECORDINGS_INSTALLER_CODESIGN_IDENTITY",
    );

    const updateWithInstaller = createBuildFixture();
    const updateWithInstallerResult = await runBuild(
      updateWithInstaller,
      {
        RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST:
          updateWithInstaller.compatibleCohortManifest,
      },
      "app-update",
    );
    expect(updateWithInstallerResult.exitCode).not.toBe(0);
    expect(updateWithInstallerResult.stderr).toContain(
      "App-update releases do not consume RECORDINGS_INSTALLER_CODESIGN_IDENTITY",
    );
  });

  test("builds an app-update with one update envelope and no bootstrap outputs", async () => {
    const fixture = createBuildFixture();
    const result = await runBuild(
      fixture,
      {
        RECORDINGS_INSTALLER_CODESIGN_IDENTITY: "",
        RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST: fixture.compatibleCohortManifest,
      },
      "app-update",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const outputRoot = join(fixture.releaseBuildRoot, "release-output");
    const basename = "Recordings-0.2.12-macos-app-update";
    expect(existsSync(join(outputRoot, `${basename}.zip`))).toBeTrue();
    expect(existsSync(join(outputRoot, `${basename}.manifest.json`))).toBeTrue();
    expect(existsSync(join(outputRoot, `${basename}.update-envelope.json`))).toBeTrue();
    expect(existsSync(join(outputRoot, `${basename}-updater.pkg`))).toBeFalse();
    expect(
      existsSync(join(outputRoot, `${basename}-updater.bootstrap-envelope.json`)),
    ).toBeFalse();
    expect(
      existsSync(join(outputRoot, `${basename}-updater.compatible-cohort.json`)),
    ).toBeFalse();
    expect(existsSync(join(fixture.markers, "release-pkg.log"))).toBeFalse();
    expect(
      readFileSync(join(fixture.markers, "envelope-signer.log"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
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
    expect(result.exitCode, result.stderr).toBe(0);
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
      '"$CODESIGN_EXECUTABLE" "${HELPER_SIGN_ARGUMENTS[@]}"',
    );
    const provenance = buildScript.indexOf('macos_artifact.ts" provenance');
    const appSigning = buildScript.indexOf("--entitlements", provenance);
    expect(helperSigning).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(helperSigning);
    expect(appSigning).toBeGreaterThan(provenance);
    expect(
      existsSync(
        join(
          fixture.releaseBuildRoot,
          "release-output",
          "Recordings-0.2.12-macos-initial-bootstrap.zip",
        ),
      ),
    ).toBeTrue();
    expect(
      existsSync(
        join(
          fixture.releaseBuildRoot,
          "release-output",
          "Recordings-0.2.12-macos-initial-bootstrap.manifest.json",
        ),
      ),
    ).toBeTrue();
    expect(readFileSync(join(fixture.markers, "xcrun.log"), "utf8")).toContain("notarytool log");
    expect(readFileSync(join(fixture.markers, "syspolicy.log"), "utf8")).toContain("distribution");
    const releasePackageLog = readFileSync(join(fixture.markers, "release-pkg.log"), "utf8");
    expect(releasePackageLog).toContain(
      "installer_identity=Developer ID Installer: Example Corp (EXAMPLE123)",
    );
    expect(releasePackageLog).toContain("release_sequence=12");
    expect(releasePackageLog).toContain("key_epoch=3");
    expect(releasePackageLog).toContain("expires_at_utc=2026-08-01T00:00:00.000Z");
    expect(releasePackageLog).toContain(`private_key=${fixture.envelopePrivateKey}`);
    expect(releasePackageLog).toContain("public_key=");
    expect(releasePackageLog).toContain("/release-envelope-public.raw");
    expect(releasePackageLog).toContain(
      "artifact_basename=Recordings-0.2.12-macos-initial-bootstrap",
    );
    expect(releasePackageLog).toContain(`bun_executable=${bunExecutable}`);
    expect(releasePackageLog).toContain("bootstrap_preflight_verifier=");
    expect(releasePackageLog).toContain("/recordings-bootstrap-preflight");
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
