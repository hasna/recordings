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
/// The fixture root lives under the real `$HOME`, never under `/tmp`. WITHDRAWN 2026-07-28:
/// this comment used to explain that as `/tmp` being mode 1777 while
/// `verify_secure_parent` / `verify_safe_home_ancestor` refuse a world-writable ancestor,
/// and to call it "that single detail is why the full `macos-app-lifecycle.test.ts`
/// fixtures are red here". BOTH HALVES WERE FALSE. Neither function inspects an ancestor —
/// each `stat`s exactly the one path it is handed (`install_macos_app.sh:558-581`, `:600-622`),
/// the sole call is `verify_safe_home_ancestor "$HOME"` at `:648`, and `/tmp`'s mode is never
/// examined by the installer at all. The lifecycle fixture also hardcodes every `%Lp` answer in
/// its `stat` stub, so no mode check can fail there under any root. For what does make that
/// suite red on this station — `FORCE_COLOR` and /tmp contention, measured — see the block at
/// the top of `helpers/source-assertions.ts`; it is not a property of the file.
///
/// Keeping the root under `$HOME` used to be load-bearing for a second reason, disclosed by
/// #54: the `mktemp` stub rewrote EVERY `/tmp/…` template into the work root, not only the
/// installer's one template, so re-rooting under `/tmp` produced a doubled path and failed.
/// FIXED below — the rewrite is now keyed on the FIXTURE ROOT rather than on the `/tmp` prefix,
/// so templates the installer places inside the root pass through untouched and the stub no
/// longer depends on where the root lives. The root stays under `$HOME` because that is where
/// a canonical, 700, single-owner directory is cheap to guarantee, not because the stub needs it.
///
/// The macOS-only tool set is stubbed and every tool whose OUTPUT the installer consumes
/// stays real. Nothing outside the fixture root is read or written, and the guard is
/// reached BEFORE the installer's first user-data mutation (the `mv` of an installed app),
/// so a denied run never touches an app bundle at all.
///
/// One execution sees only the input vector it fixes. `artifactPolicy` is varied for exactly
/// that reason: a wrapper conditioned on `$ARTIFACT_POLICY` around the comparison loop and the
/// call was measured surviving the whole installer battery unchanged while unenforcing the gate
/// for release artifacts. Every OTHER input this fixture holds constant -- the environment, the
/// stubbed-tool overrides, `uname`, the hostname -- remains a condition a wrapper could hide
/// behind. See the BOUND note in src/__tests__/identity-migration-guard.test.ts.

/// Distinct so the guard's refusal names two different identities, and so a swap of the
/// two digest arguments is visible in its message rather than symmetric.
///
/// Every 64-hex value this fixture feeds the installer is distinct, which is what makes that
/// claim true by construction rather than by luck. `EXISTING_IDENTITY_SHA256` used to be
/// byte-identical to the `--manifest-sha256` argument (both `"a".repeat(64)`): not exploitable,
/// because the installer never echoes `EXPECTED_MANIFEST_SHA256`, but it meant an assertion that
/// the refusal names the INSTALLED identity was also satisfied by a run that echoed the manifest
/// digest instead. `MANIFEST_SHA256` exists so no two of these can be confused for each other.
export const EXISTING_IDENTITY_SHA256 = "a".repeat(64);
export const CANDIDATE_IDENTITY_SHA256 = "b".repeat(64);
export const MANIFEST_SHA256 = "d".repeat(64);
const TREE_DIGEST = "c".repeat(64);

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

/// The two values `--artifact-policy` accepts, spelled as the installer's own usage text
/// spells them (`scripts/install_macos_app.sh` usage: `--artifact-policy <release|local-only>`).
export type ArtifactPolicy = "local-only" | "release";

/// Any non-empty value: a release install only requires `--expected-team-id` to be set, and
/// the artifact tool that would interpret it is stubbed. Named so the reason it is arbitrary
/// is on the page rather than inferred from a bare literal.
const releaseTeamIdentifier = "FIXTURETEAMID";

/// The policy-specific part of the argument vector.
///
/// A local-only run has to present the whole approved-target triple plus the local-signing
/// acknowledgment or the installer refuses before any gate. A release run must present NONE
/// of them -- the installer rejects a target identity, a target identity kind, and the
/// acknowledgment for a release artifact -- so the release vector carries only the policy and
/// the team identifier and lets the installer's own defaults (`APPROVED_TARGET="fleet"`,
/// `APPROVED_TARGET_IDENTITY_SHA256="none"`, kind defaulted to `none` for release) supply the
/// rest. Restating `fleet` here would hardcode a value the installer already owns.
///
/// If those defaults ever drift, the release cases fail loudly rather than silently
/// degrading into local-only runs: their load-bearing assertion is the refusal wording that
/// only the guard's release branch prints.
const policyArguments = (policy: ArtifactPolicy, target: string, targetIdentitySha256: string): string[] =>
  policy === "release"
    ? ["--artifact-policy", "release", "--expected-team-id", releaseTeamIdentifier]
    : [
        "--artifact-policy", "local-only",
        "--approved-target", target,
        "--approved-target-identity-kind", "hardware_uuid_sha256",
        "--approved-target-identity-sha256", targetIdentitySha256,
        "--acknowledge-local-signing-and-permissions",
      ];

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

/// Refusal preamble shared by the stubs that can be asked something they do not recognise.
///
/// The refusal is RECORDED to the log directory, not only printed. The installer runs its
/// designated-requirement cross-checks as `codesign --verify --strict -R … >/dev/null 2>&1`
/// (install_macos_app.sh:1753-1754), so a stderr-only marker on that path is discarded by the
/// caller and unobservable to a test -- and `exit 90` there is indistinguishable from a genuine
/// "not compatible" answer. Appending to a log the harness reads back is what makes the refusal
/// assertable regardless of how the installer redirects the call.
const unstubbedRefusal = [
  "unstubbed() {",
  '  printf \'%s\\n\' "$1" >> "$RECORDINGS_FIXTURE_LOG_DIR/unstubbed.log"',
  '  echo "unstubbed $1" >&2',
  "  exit 90",
  "}",
];

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

/// Which direction of the designated-requirement cross-check the stubbed `codesign` refuses.
///
/// The installer checks compatibility BOTH ways (install_macos_app.sh:1753-1754): the installed
/// app's requirement against the candidate, and the candidate's requirement against the installed
/// app. They are joined by `||`, so when the first refuses the second is never invoked -- the deny
/// path makes 3 codesign calls, not 4, and `:1754` is executed by no denying case. Selecting a
/// direction is what lets a case refuse only the SECOND check, which raises the flag through the
/// clause that otherwise never runs.
export type IncompatibleDirection =
  /// `-R <installed requirement> <candidate app>` -- install_macos_app.sh:1753, short-circuits :1754.
  | "installed-requirement-vs-candidate"
  /// `-R <candidate requirement> <installed app>` -- install_macos_app.sh:1754, reached only when
  /// :1753 passed, so this is the direction no other case exercises.
  | "candidate-requirement-vs-installed"
  /// Both refuse. Indistinguishable from the first at the installer level, because of the `||`.
  | "both";

export type GuardExecutionOptions = {
  /// Whether the stubbed `codesign --verify --strict -R` refuses each app against the
  /// other's designated requirement. That refusal is the ONLY thing that raises
  /// `identity_migration`, so this drives the installer's real computation rather than
  /// injecting the flag.
  identityMigration: boolean;
  /// Which of the two cross-checks refuses when `identityMigration` is true. Ignored when it is
  /// false, because then neither refuses. Defaults to `"both"`.
  incompatibleDirection?: IncompatibleDirection;
  /// Which artifact policy the run executes under. A run pinned to one policy cannot see a
  /// wrapper conditioned on the other, and this is the only input the installer's own
  /// policy-shaped conditionals read -- see the BOUND note in
  /// src/__tests__/identity-migration-guard.test.ts.
  artifactPolicy?: ArtifactPolicy;
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
  /// Every stubbed-`bun` invocation, for the same reason: a case can prove the stub was really
  /// driven rather than the run failing before it.
  bunInvocations: string[];
  /// Every argument vector a stub REFUSED as unrecognised. Must be empty for a run to mean
  /// anything: a stub that answers success by default degrades silently the moment the installer
  /// learns a new pre-guard subcommand, which is the exact failure mode this harness exists to
  /// prevent. Read from a log rather than from stderr because the installer discards stderr on
  /// the designated-requirement cross-checks.
  unstubbedInvocations: string[];
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
    // The stubs discriminate installed-vs-candidate by comparing against this exact path, so it
    // is named once and handed to them rather than each stub re-deriving it from an installer
    // internal.
    const installedApp = join(home, "Applications", "Recordings.app");
    createApp(installedApp, "installed");

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
    // The installer's preflight work directory is hardcoded to `/tmp`
    // (install_macos_app.sh:355, the only one of its five `mktemp -d` templates that is not
    // already inside the fixture root). Redirecting it into the root is what makes the run
    // hermetic.
    //
    // Keyed on the FIXTURE ROOT, not on the `/tmp` prefix. The prefix form rewrote EVERY
    // template, so the fixture's own four templates were rewritten too the moment the root
    // itself sat under `/tmp` -- producing
    // `/tmp/<root>/work/<root>/home/.hasna/.recordings-install-maintenance.claim.XXXXXX` and a
    // `failed to create directory via template` abort. Anchoring on the root is what makes the
    // rewrite mean "outside my sandbox" instead of "spelled /tmp", so it holds wherever the
    // root lives and does not restate an installer-internal path literal.
    writeExecutable(join(bin, "mktemp"), [
      "#!/bin/bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/mktemp.log"',
      'if [ "${1:-}" = "-d" ] && [ "$#" -eq 2 ]; then',
      '  template="$2"',
      '  case "$template" in',
      '    "$RECORDINGS_FIXTURE_ROOT"/*) ;;',
      '    *) template="$RECORDINGS_FIXTURE_WORK_ROOT/${template##*/}" ;;',
      "  esac",
      '  exec /usr/bin/mktemp -d "$template"',
      "fi",
      'exec /usr/bin/mktemp "$@"',
    ]);
    // The designated-requirement comparison, which is the installer's own computation of
    // the migration flag. `-d -r-` reports each app's requirement; `--verify --strict -R`
    // cross-checks each against the other's, and its refusal is what sets the flag.
    //
    // Which app a call is ABOUT is decided by comparing the subject to the installed app path
    // this fixture created, not by looking for `/unpacked/` in the arguments. `/unpacked/` is
    // `install_macos_app.sh:1303`'s internal spelling of its staging directory: renaming it there
    // would have made this stub label the candidate as the installed app, the two digests would
    // have collided, and the run would have died on the manifest mismatch at `:1726` -- fail-closed,
    // but for a reason no message names. The fixture owns the installed path, so it is the honest
    // discriminator.
    //
    // Anything this stub does not recognise EXITS 90 rather than succeeding. A default-success
    // stub silently stops testing the moment the installer learns a new pre-guard `codesign`
    // invocation, which is the failure this harness exists to prevent.
    writeExecutable(join(bin, "codesign"), [
      "#!/bin/bash",
      "set -euo pipefail",
      ...unstubbedRefusal,
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/codesign.log"',
      // The app a call is about is always its LAST argument, for both invocation shapes.
      'subject=""',
      'if [ "$#" -gt 0 ]; then subject="${!#}"; fi',
      'case "$*" in',
      '  *"-d -r-"*)',
      '    label=candidate',
      '    if [ "$subject" = "$RECORDINGS_FIXTURE_INSTALLED_APP" ]; then label=installed; fi',
      "    printf 'designated => identifier \"com.hasna.recordings\" and certificate leaf = \"%s\"\\n' \"$label\" >&2",
      "    exit 0",
      "    ;;",
      // The two directions of install_macos_app.sh:1753-1754, told apart by their SUBJECT: the
      // first verifies the candidate against the installed requirement, the second verifies the
      // installed app against the candidate's.
      '  *"--verify --strict -R "*)',
      '    if [ "$RECORDINGS_FIXTURE_IDENTITY_MIGRATION" != 1 ]; then exit 0; fi',
      '    case "$RECORDINGS_FIXTURE_INCOMPATIBLE_DIRECTION" in',
      "      both) exit 1 ;;",
      '      installed-requirement-vs-candidate)',
      '        if [ "$subject" != "$RECORDINGS_FIXTURE_INSTALLED_APP" ]; then exit 1; fi',
      "        exit 0",
      "        ;;",
      '      candidate-requirement-vs-installed)',
      '        if [ "$subject" = "$RECORDINGS_FIXTURE_INSTALLED_APP" ]; then exit 1; fi',
      "        exit 0",
      "        ;;",
      '      *) unstubbed "codesign direction: $RECORDINGS_FIXTURE_INCOMPATIBLE_DIRECTION" ;;',
      "    esac",
      "    ;;",
      '  *) unstubbed "codesign: $*" ;;',
      "esac",
    ]);
    // The artifact tool. Real `bun` still runs the installer's inline `-e` comparisons, so
    // the macOS version check is genuinely evaluated; the subcommands that need a real
    // signed artifact, a real ZIP, or macOS filesystem APIs are answered from the fixture.
    //
    // The inert subcommands are ENUMERATED and everything else EXITS 90. Falling through to
    // `exit 0` meant this stub answered success for a subcommand nobody had considered, so an
    // installer change that added a parsed pre-guard call would have degraded the harness
    // silently -- it would keep passing while no longer proving anything. Adding a subcommand
    // to the installer now fails here with the argument vector printed, which is a two-second
    // diagnosis instead of a green run that means nothing.
    //
    // `requirement-digest` picks its answer from the SUBJECT app path the fixture created, not
    // from `/unpacked/`: see the codesign stub above for why that literal was the wrong key.
    writeExecutable(join(bin, "bun"), [
      "#!/bin/bash",
      "set -euo pipefail",
      ...unstubbedRefusal,
      'printf \'%s\\n\' "$*" >> "$RECORDINGS_FIXTURE_LOG_DIR/bun.log"',
      'case "$*" in',
      "  -e*) exec \"$RECORDINGS_FIXTURE_REAL_BUN\" \"$@\" ;;",
      '  *" requirement-digest "*)',
      '    case "$*" in',
      '      *"$RECORDINGS_FIXTURE_INSTALLED_APP"*) printf \'%s\\n\' "$RECORDINGS_FIXTURE_EXISTING_IDENTITY" ;;',
      '      *) printf \'%s\\n\' "$RECORDINGS_FIXTURE_CANDIDATE_IDENTITY" ;;',
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
      // Subcommands the installer invokes before or just after the guard whose EFFECT this run
      // does not depend on: each verifies, fsyncs, or journals something the fixture has already
      // arranged. Enumerated rather than left to a default so that a NEW one is not silently
      // added to this list by omission. Every entry corresponds to a real call site --
      // native-fs-guard-check :523, verify-filesystem-tree :643/:1660/:1735,
      // fsync-directory :688/:893/:905, fsync-tree :892/:1776, verify-archive :1309/:1356,
      // verify-app :1646, assert-transition :1736, journal-write :1627, journal-get :1249-1251,
      // journal-recover :1265, transaction-cleanup :1559.
      ...[
        "native-fs-guard-check",
        "verify-filesystem-tree",
        "verify-archive",
        "verify-app",
        "assert-transition",
        "fsync-directory",
        "fsync-tree",
        "journal-write",
        "journal-get",
        "journal-recover",
        "transaction-cleanup",
      ].map((subcommand) => `  *" ${subcommand}"*) exit 0 ;;`),
      '  *) unstubbed "bun: $*" ;;',
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
      RECORDINGS_FIXTURE_ROOT: root,
      RECORDINGS_FIXTURE_WORK_ROOT: work,
      RECORDINGS_FIXTURE_CANDIDATE_SOURCE: candidateSource,
      RECORDINGS_FIXTURE_INSTALLED_APP: installedApp,
      RECORDINGS_FIXTURE_CANDIDATE_IDENTITY: CANDIDATE_IDENTITY_SHA256,
      RECORDINGS_FIXTURE_EXISTING_IDENTITY: EXISTING_IDENTITY_SHA256,
      RECORDINGS_FIXTURE_TREE_DIGEST: TREE_DIGEST,
      RECORDINGS_FIXTURE_IDENTITY_MIGRATION: options.identityMigration ? "1" : "0",
      RECORDINGS_FIXTURE_INCOMPATIBLE_DIRECTION: options.incompatibleDirection ?? "both",
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
      "--manifest-sha256", MANIFEST_SHA256,
      "--expected-source-sha", "b".repeat(40),
      "--expected-version", "0.2.14",
      ...policyArguments(options.artifactPolicy ?? "local-only", target, targetIdentitySha256),
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
      bunInvocations: logLines("bun.log"),
      unstubbedInvocations: logLines("unstubbed.log"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
