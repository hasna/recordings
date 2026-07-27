import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IDENTITY_GUARD_RELATIVE_PATH, POLICY_RELATIVE_PATH, READER_RELATIVE_PATH, readRepositoryFile } from "./installer-preflight";

// Resolved from this module, not the working directory, so callers pass from any cwd.
const repositoryRoot = resolve(import.meta.dir, "../../..");

/// Runs `scripts/install_macos_app.sh` far enough to EXECUTE the identity-migration guard
/// call at its real call site, on Linux, hermetically.
///
/// Why this exists, and why it is not another assertion over the installer's text:
/// every text-level check of that call site is blind to REACHABILITY. The strongest text
/// check available -- "the call sits between the flag's initialization and the loop's
/// `done`" -- cannot see the opening brace of a construct that encloses BOTH markers,
/// because such an opener is by definition outside the slice. Two adversarial rounds
/// measured six survivors that each disable the guard while the whole suite stays green:
/// a never-invoked wrapper function, `function _gate() {`, a `_gate() (` subshell body,
/// `if false; then ... fi` around the loop and the call, a never-taken `case` arm, and one
/// that SHOULD survive because it really does execute -- a bare `{ ... }` group.
/// Reachability is a property of running, so this runs it.
///
/// The fixture root lives under the real `$HOME`, never under `/tmp`: `/tmp` is mode 1777
/// on Linux and the installer's `verify_secure_parent` / `verify_safe_home_ancestor`
/// correctly refuse a world-writable ancestor. That single detail is why the full
/// `macos-app-lifecycle.test.ts` fixtures are red here and cannot gate anything.
///
/// The macOS-only tool set is stubbed and every tool whose OUTPUT the installer consumes
/// stays real. Nothing outside the fixture root is read or written, and the guard is
/// reached BEFORE the installer's first user-data mutation (the `mv` of an installed app),
/// so a denied run never touches an app bundle at all.

/// Distinct so the guard's refusal names two different identities, and so a swap of the
/// two digest arguments is visible in its message rather than symmetric.
export const EXISTING_IDENTITY_SHA256 = "a".repeat(64);
export const CANDIDATE_IDENTITY_SHA256 = "b".repeat(64);

/// The approved local-only target this fixture presents itself as. Read from the packaged
/// policy rather than written twice: the installer refuses any target not on that list, so
/// hardcoding a name here would silently break when the policy changes.
const approvedTarget = (): string => {
  const targets = readRepositoryFile(POLICY_RELATIVE_PATH)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const target = targets[0];
  if (target === undefined) {
    throw new Error(`No approved local-only target in ${POLICY_RELATIVE_PATH}`);
  }
  return target;
};

const platformIdentity = "11111111-1111-4111-8111-111111111111";

/// Tools the installer resolves through `RECORDINGS_TEST_INSTALL_<NAME>_EXECUTABLE` whose
/// OUTPUT it parses or whose EFFECT it depends on. These stay real: stubbing them would
/// make the run pass for reasons unrelated to the guard.
/// `ps -o lstart=` is real on Linux (procps), and it has to be: the install lock and the
/// maintenance marker bind their owner PID to that start time, and an empty answer makes
/// the installer refuse to establish either.
const realTools = [
  "AWK", "BASENAME", "CHMOD", "CP", "DATE", "DD", "DF", "DIFF", "DIRNAME", "DU",
  "GREP", "HEAD", "ID", "MKDIR", "MV", "PS", "RM", "RMDIR", "SED", "SHASUM", "TAIL", "TR",
];

/// macOS-only tools with no Linux equivalent that the installer never parses before the
/// guard. A no-op success is the faithful answer for all of them.
const inertTools = [
  "DITTO", "LSOF", "OPEN", "SLEEP", "SPCTL", "SQLITE3", "SYSPOLICY_CHECK", "XCRUN",
];

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const writeExecutable = (path: string, lines: string[]): void => {
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o700 });
  chmodSync(path, 0o700);
};

/// A minimal signed-app tree. `du`, `cp -R` and the installer's own directory checks are
/// the only things that read it before the guard.
const createApp = (path: string, marker: string): void => {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"), `<plist><!-- ${marker} --></plist>\n`);
  writeExecutable(join(path, "Contents", "MacOS", "Recordings"), ["#!/bin/bash", "exit 0"]);
};

export type GuardExecutionOptions = {
  /// Whether the stubbed `codesign --verify --strict -R` refuses each app against the
  /// other's designated requirement. That refusal is the ONLY thing that raises
  /// `identity_migration`, so this drives the installer's real computation rather than
  /// injecting the flag.
  identityMigration: boolean;
  /// Appended after the base arguments, so a case can supply the ad-hoc approval.
  extraArguments?: string[];
};

export type GuardExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /// True when the installer asked for a `.Recordings-transaction.` directory. That
  /// `mktemp -d` is the FIRST thing the installer does after the guard returns 0, so it is
  /// a behavioural witness of whether execution continued past the gate -- which is what
  /// catches `|| true`, where the refusal is printed and the install proceeds anyway.
  reachedTransaction: boolean;
  /// Every `codesign` invocation, so a case can prove the identity comparison really ran
  /// instead of the run failing earlier for an unrelated reason.
  codesignInvocations: string[];
};

export function runInstallerToIdentityGuard(
  options: GuardExecutionOptions,
): GuardExecutionResult {
  const target = approvedTarget();
  const targetIdentitySha256 = Bun.CryptoHasher.hash("sha256", platformIdentity, "hex");
  // Under the real HOME, and canonical: the installer requires `$HOME` to equal its own
  // `pwd -P`, so a symlinked home would abort before any gate.
  const root = mkdtempSync(join(realpathSync(process.env["HOME"] ?? tmpdir()), ".rec-guard-exec-"));
  try {
    const bin = join(root, "bin");
    const logs = join(root, "logs");
    const work = join(root, "work");
    const home = join(root, "home");
    const packageRoot = join(root, "pkg");
    const scripts = join(packageRoot, "scripts");
    const candidateSource = join(root, "candidate", "Recordings.app");
    for (const directory of [bin, logs, work, home, join(scripts, "policy")]) {
      mkdirSync(directory, { recursive: true });
    }
    // 700 exactly: `verify_safe_home_ancestor` refuses a group- or world-writable home,
    // and `verify_secure_parent` refuses anything but a private install parent.
    chmodSync(home, 0o700);
    createApp(candidateSource, "candidate");
    // An already-installed app at the canonical destination, so `MANAGEABLE_APPS` is
    // non-empty and the comparison loop that computes the flag actually has a subject. An
    // empty search space reads identical to a clean result, which would make every case
    // here allow for the wrong reason.
    mkdirSync(join(home, "Applications"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "Applications"), 0o700);
    createApp(join(home, "Applications", "Recordings.app"), "installed");

    for (const [relativePath, mode] of [
      ["scripts/install_macos_app.sh", 0o700],
      [IDENTITY_GUARD_RELATIVE_PATH, 0o600],
      [READER_RELATIVE_PATH, 0o600],
      ["scripts/resolve_tailscale_cli.sh", 0o600],
      ["scripts/macos_artifact.ts", 0o600],
      [POLICY_RELATIVE_PATH, 0o600],
    ] as const) {
      const destination = join(packageRoot, relativePath);
      cpSync(join(repositoryRoot, relativePath), destination);
      chmodSync(destination, mode);
    }
    // Only its executability is checked before the guard; it is invoked long after.
    writeExecutable(join(scripts, "smoke_macos_app.sh"), ["#!/bin/bash", "exit 0"]);

    writeExecutable(join(bin, "uname"), [
      "#!/bin/bash",
      'if [ "${1:-}" = "-m" ]; then printf \'arm64\\n\'; else printf \'Darwin\\n\'; fi',
    ]);
    writeExecutable(join(bin, "sw_vers"), ["#!/bin/bash", "printf '26.0\\n'"]);
    writeExecutable(join(bin, "hostname"), [
      "#!/bin/bash",
      `printf '%s\\n' ${shellQuote(target)}`,
    ]);
    writeExecutable(join(bin, "ioreg"), [
      "#!/bin/bash",
      `printf '    \"IOPlatformUUID\" = \"%s\"\\n' ${shellQuote(platformIdentity)}`,
    ]);
    // No Spotlight on Linux, and no duplicate apps to discover beyond the one created
    // above. Silence, not failure: the installer treats any output as another install.
    writeExecutable(join(bin, "mdfind"), ["#!/bin/bash", "exit 0"]);
    // The installer reads only BSD `-f` formats. Translating the three it uses is what
    // lets its ownership and mode gates evaluate real filesystem facts on Linux instead of
    // being bypassed.
    writeExecutable(join(bin, "stat"), [
      "#!/bin/bash",
      '[ "${1:-}" = "-f" ] || exec /usr/bin/stat "$@"',
      'case "${2:-}" in',
      "  '%u') exec /usr/bin/stat -c '%u' \"${3:-}\" ;;",
      "  '%Lp') exec /usr/bin/stat -c '%a' \"${3:-}\" ;;",
      "  '%m') exec /usr/bin/stat -c '%Y' \"${3:-}\" ;;",
      '  *) exit 2 ;;',
      "esac",
    ]);
    // `ls -lde` is BSD ACL output. One line and no ACL entries is the "no ACL" answer the
    // installer's `tail -n +2` checks for; GNU `ls` has no `-e` and would abort the
    // command substitutions that capture it.
    writeExecutable(join(bin, "ls"), [
      "#!/bin/bash",
      "printf 'drwx------  1 fixture fixture 0 Jan  1 00:00 fixture\\n'",
    ]);
    // The installer's preflight work directory is hardcoded to `/tmp`, which is mode 1777
    // here. Redirecting that one template into the fixture root is what makes the run
    // hermetic; every other template is already inside it and passes through.
    writeExecutable(join(bin, "mktemp"), [
      "#!/bin/bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/mktemp.log"',
      'if [ "${1:-}" = "-d" ] && [ "$#" -eq 2 ]; then',
      '  template="$2"',
      '  case "$template" in',
      '    /tmp/*) template="$RECORDINGS_FIXTURE_WORK_ROOT/${template#/tmp/}" ;;',
      "  esac",
      '  exec /usr/bin/mktemp -d "$template"',
      "fi",
      'exec /usr/bin/mktemp "$@"',
    ]);
    // The designated-requirement comparison, which is the installer's own computation of
    // the migration flag. `-d -r-` reports each app's requirement; `--verify --strict -R`
    // cross-checks each against the other's, and its refusal is what sets the flag.
    writeExecutable(join(bin, "codesign"), [
      "#!/bin/bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/codesign.log"',
      'case "$*" in',
      '  *"-d -r-"*)',
      '    label=installed',
      '    case "$*" in *"/unpacked/"*) label=candidate ;; esac',
      "    printf 'designated => identifier \"com.hasna.recordings\" and certificate leaf = \"%s\"\\n' \"$label\" >&2",
      "    exit 0",
      "    ;;",
      '  *" -R "*) [ "$RECORDINGS_FIXTURE_IDENTITY_MIGRATION" = 1 ] && exit 1 ;;',
      "esac",
      "exit 0",
    ]);
    // The artifact tool. Real `bun` still runs the installer's inline `-e` comparisons, so
    // the macOS version check is genuinely evaluated; the subcommands that need a real
    // signed artifact, a real ZIP, or macOS filesystem APIs are answered from the fixture.
    writeExecutable(join(bin, "bun"), [
      "#!/bin/bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/bun.log"',
      'case "$*" in',
      "  -e*) exec \"$RECORDINGS_FIXTURE_REAL_BUN\" \"$@\" ;;",
      '  *" requirement-digest "*)',
      '    case "$*" in',
      '      *"/unpacked/"*) printf \'%s\\n\' "$RECORDINGS_FIXTURE_CANDIDATE_IDENTITY" ;;',
      '      *) printf \'%s\\n\' "$RECORDINGS_FIXTURE_EXISTING_IDENTITY" ;;',
      "    esac",
      "    ;;",
      // Must agree with the candidate's requirement digest or the installer refuses the
      // artifact before ever reaching the guard.
      '  *" manifest-get "*"--field identity"*) printf \'%s\\n\' "$RECORDINGS_FIXTURE_CANDIDATE_IDENTITY" ;;',
      "  *\" manifest-get \"*\"--field builder_identity_kind\"*) printf 'none\\n' ;;",
      "  *\" manifest-get \"*\"--field minimum_macos\"*) printf '26.0\\n' ;;",
      "  *\" manifest-get \"*\"--field architectures\"*) printf 'arm64\\n' ;;",
      "  *\" tree-digest \"*) printf '%s\\n' \"$RECORDINGS_FIXTURE_TREE_DIGEST\" ;;",
      '  *" extract-verified-archive "*)',
      '    staging_target=""',
      '    while [ "$#" -gt 0 ]; do',
      '      if [ "$1" = "--staging-target" ]; then staging_target="${2:-}"; break; fi',
      "      shift",
      "    done",
      '    [ -n "$staging_target" ] || exit 1',
      '    cp -R "$RECORDINGS_FIXTURE_CANDIDATE_SOURCE" "$staging_target/Recordings.app"',
      "    ;;",
      "esac",
      "exit 0",
    ]);
    for (const tool of inertTools) {
      writeExecutable(join(bin, tool.toLowerCase()), ["#!/bin/bash", "exit 0"]);
    }

    const artifact = join(root, "Recordings-0.2.14-macos.zip");
    const manifest = join(root, "Recordings-0.2.14-macos.manifest.json");
    writeFileSync(artifact, "finalized archive");
    writeFileSync(manifest, "{}\n");

    const environment: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      RECORDINGS_BUN_EXECUTABLE: join(bin, "bun"),
      RECORDINGS_FIXTURE_REAL_BUN: process.execPath,
      RECORDINGS_FIXTURE_LOG_DIR: logs,
      RECORDINGS_FIXTURE_WORK_ROOT: work,
      RECORDINGS_FIXTURE_CANDIDATE_SOURCE: candidateSource,
      RECORDINGS_FIXTURE_CANDIDATE_IDENTITY: CANDIDATE_IDENTITY_SHA256,
      RECORDINGS_FIXTURE_EXISTING_IDENTITY: EXISTING_IDENTITY_SHA256,
      RECORDINGS_FIXTURE_TREE_DIGEST: "c".repeat(64),
      RECORDINGS_FIXTURE_IDENTITY_MIGRATION: options.identityMigration ? "1" : "0",
    };
    for (const tool of realTools) {
      const real = Bun.which(tool.toLowerCase());
      if (real === null) throw new Error(`Fixture requires a real ${tool.toLowerCase()}`);
      environment[`RECORDINGS_TEST_INSTALL_${tool}_EXECUTABLE`] = real;
    }
    for (const tool of [...inertTools, "BUN", "CODESIGN", "HOSTNAME", "IOREG", "LS", "MDFIND", "MKTEMP", "STAT", "SW_VERS", "UNAME"]) {
      environment[`RECORDINGS_TEST_INSTALL_${tool}_EXECUTABLE`] = join(bin, tool.toLowerCase());
    }

    const argumentList = [
      "--artifact", artifact,
      "--manifest", manifest,
      "--manifest-sha256", "a".repeat(64),
      "--expected-source-sha", "b".repeat(40),
      "--expected-version", "0.2.14",
      "--artifact-policy", "local-only",
      "--approved-target", target,
      "--approved-target-identity-kind", "hardware_uuid_sha256",
      "--approved-target-identity-sha256", targetIdentitySha256,
      "--acknowledge-local-signing-and-permissions",
      ...(options.extraArguments ?? []),
    ];

    const result = Bun.spawnSync(
      ["bash", join(scripts, "install_macos_app.sh"), ...argumentList],
      { env: environment },
    );
    // An absent log means the tool was never invoked, which is itself an assertable fact
    // rather than an error.
    const logLines = (name: string): string[] =>
      existsSync(join(logs, name))
        ? readFileSync(join(logs, name), "utf8").split("\n").filter((line) => line !== "")
        : [];
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      reachedTransaction: logLines("mktemp.log").some((line) =>
        line.includes(".Recordings-transaction."),
      ),
      codesignInvocations: logLines("codesign.log"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
