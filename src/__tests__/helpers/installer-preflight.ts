import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolved from this module, not the working directory, so callers pass from any cwd.
const repositoryRoot = resolve(import.meta.dir, "../../..");

export const POLICY_RELATIVE_PATH = "scripts/policy/local-only-approved-targets.txt";
export const READER_RELATIVE_PATH = "scripts/read_local_only_targets.sh";
export const IDENTITY_GUARD_RELATIVE_PATH = "scripts/enforce_identity_migration.sh";

export const readRepositoryFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8");

// The macOS-only tool set is stubbed and HOME is placed outside the world-writable /tmp
// that makes the full lifecycle fixtures fail on Linux, so the run reaches the installer's
// own argument and policy gates. Everything reachable this way is pre-mutation: the gates
// are in the first ~430 lines of install_macos_app.sh and the first user-data mutation is
// the `mv` far below them.
const installerToolOverrides = [
  "AWK", "BASENAME", "CHMOD", "CODESIGN", "CP", "DATE", "DD", "DF", "DIFF", "DIRNAME",
  "DITTO", "DU", "GREP", "HEAD", "HOSTNAME", "ID", "IOREG", "LS", "LSOF", "MDFIND",
  "MKDIR", "MKTEMP", "MV", "OPEN", "PS", "RM", "RMDIR", "SED", "SHASUM", "SLEEP",
  "SPCTL", "STAT", "SW_VERS", "SYSPOLICY_CHECK", "TAIL", "TR", "XCRUN",
];

export type InstallerPreflightOptions = {
  artifactPolicy?: "release" | "local-only";
  approvedTarget?: string;
  /// Stubs `hostname -s`, which is what lets a run on any host reach the gates that sit
  /// behind the installer's target/host binding. Left real by default.
  hostname?: string;
  /// Appended after the base arguments, so a case can add or override a flag.
  extraArguments?: string[];
  policyContents?: string | null;
  removeReader?: boolean;
  removeIdentityGuard?: boolean;
  /// Replaces the packaged identity-migration guard, for the cases where a stripped,
  /// truncated, or malformed guard must still deny.
  identityGuardContents?: string;
  /// Installs the guard as a symlink to the real file, which the installer refuses the
  /// same way the approved-target reader refuses one.
  symlinkIdentityGuard?: boolean;
  /// Extra environment entries, used to prove an inherited bash function cannot
  /// pre-empt the sourced guard.
  environment?: Record<string, string>;
};

export function runInstallerPreflight(
  options: InstallerPreflightOptions = {},
): { exitCode: number; stdout: string; stderr: string } {
  const artifactPolicy = options.artifactPolicy ?? "local-only";
  const root = mkdtempSync(join(process.env["HOME"] ?? tmpdir(), ".rec-gate-"));
  try {
    const bin = join(root, "bin");
    const home = join(root, "home");
    const packageRoot = join(root, "pkg");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(packageRoot, "scripts", "policy"), { recursive: true });

    writeFileSync(join(bin, "stub"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
    // The only stat format the script uses before the gates is BSD `-f '%u'` (owner uid),
    // which GNU stat spells `-c '%u'`. Translating just that is what lets the
    // home-ancestor check pass on Linux and the run reach the gates.
    writeFileSync(
      join(bin, "stat"),
      '#!/bin/sh\n[ "$1" = "-f" ] && [ "$2" = "%u" ] && exec /usr/bin/stat -c "%u" "$3"\nexec /usr/bin/stat "$@"\n',
      { mode: 0o755 },
    );
    if (options.hostname !== undefined) {
      writeFileSync(
        join(bin, "hostname"),
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(options.hostname)}\n`,
        { mode: 0o755 },
      );
    }

    const scripts = join(packageRoot, "scripts");
    writeFileSync(
      join(scripts, "install_macos_app.sh"),
      readRepositoryFile("scripts/install_macos_app.sh"),
      { mode: 0o755 },
    );
    if (!options.removeReader) {
      writeFileSync(
        join(scripts, "read_local_only_targets.sh"),
        readRepositoryFile(READER_RELATIVE_PATH),
        { mode: 0o644 },
      );
    }
    const identityGuard = join(scripts, "enforce_identity_migration.sh");
    if (options.symlinkIdentityGuard) {
      symlinkSync(join(repositoryRoot, IDENTITY_GUARD_RELATIVE_PATH), identityGuard);
    } else if (!options.removeIdentityGuard) {
      writeFileSync(
        identityGuard,
        options.identityGuardContents ?? readRepositoryFile(IDENTITY_GUARD_RELATIVE_PATH),
        { mode: 0o644 },
      );
    }
    const policy = join(scripts, "policy", "local-only-approved-targets.txt");
    if (options.policyContents !== null) {
      writeFileSync(policy, options.policyContents ?? readRepositoryFile(POLICY_RELATIVE_PATH));
    }
    const artifact = join(root, "artifact.zip");
    const manifest = join(root, "manifest.json");
    writeFileSync(artifact, "");
    writeFileSync(manifest, "{}");

    const environment: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      RECORDINGS_BUN_EXECUTABLE: process.execPath,
      RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE: join(bin, "uname"),
    };
    for (const tool of installerToolOverrides) {
      // The script derives PACKAGE_ROOT from `dirname`, so tools whose OUTPUT it consumes
      // must be real; only the macOS-only ones get the no-op stub.
      let shimmed: string | null = null;
      if (tool === "STAT") shimmed = join(bin, "stat");
      if (tool === "HOSTNAME" && options.hostname !== undefined) shimmed = join(bin, "hostname");
      const real = shimmed ?? Bun.which(tool.toLowerCase());
      environment[`RECORDINGS_TEST_INSTALL_${tool}_EXECUTABLE`] = real ?? join(bin, "stub");
    }
    Object.assign(environment, options.environment ?? {});

    const argumentList = [
      "--artifact", artifact,
      "--manifest", manifest,
      "--manifest-sha256", "a".repeat(64),
      "--expected-source-sha", "b".repeat(40),
      "--expected-version", "0.2.14",
      "--artifact-policy", artifactPolicy,
    ];
    if (artifactPolicy === "local-only") {
      argumentList.push(
        "--approved-target", options.approvedTarget ?? "station03",
        "--approved-target-identity-kind", "tailscale_node_id_sha256",
        "--approved-target-identity-sha256", "c".repeat(64),
        "--acknowledge-local-signing-and-permissions",
      );
    } else {
      argumentList.push("--expected-team-id", "EXAMPLE123");
    }
    argumentList.push(...(options.extraArguments ?? []));

    const result = Bun.spawnSync(
      ["bash", join(scripts, "install_macos_app.sh"), ...argumentList],
      { env: environment },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
