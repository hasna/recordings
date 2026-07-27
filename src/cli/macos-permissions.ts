import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/// Bundle identifier TCC keys every Recordings.app grant to. Single source for the
/// permission lookups, the reset path, and the reported status object.
export const RECORDINGS_BUNDLE_IDENTIFIER = "com.hasna.recordings";

export interface PermissionHelperProcessResult {
  status: number | null;
  error?: Error;
}

export type PermissionHelperRunner = (
  executable: string,
  arguments_: string[],
  options: { stdio: "inherit" },
) => PermissionHelperProcessResult;

export interface PermissionHelperResult {
  exitCode: number;
  errorMessage?: string;
}

const defaultPermissionHelperRunner: PermissionHelperRunner = (
  executable,
  arguments_,
  options,
) => spawnSync(executable, arguments_, options);

export function runMacOSPermissionRequest(
  appPath: string,
  runner: PermissionHelperRunner = defaultPermissionHelperRunner,
): PermissionHelperResult {
  const executable = join(appPath, "Contents", "MacOS", "Recordings");
  const result = runner(
    executable,
    ["--request-permissions", "--open-permission-settings"],
    { stdio: "inherit" },
  );
  return {
    exitCode: result.error ? 1 : (result.status ?? 1),
    errorMessage: result.error?.message,
  };
}

/// A TCC `access` row carries both the decision and the code requirement that decision was
/// granted to. Reading `auth_value` alone is not a permission check: the row survives app
/// rebuilds, so an `allowed` row whose `csreq` no longer matches the installed binary means
/// macOS will deny at runtime while the database still reads "allowed".
export interface TccAccessRow {
  authValue: string;
  csreqHex: string;
}

/// Result of evaluating a stored `csreq` against the installed bundle.
/// - `satisfied`: macOS will honour the grant for this exact binary.
/// - `unsatisfied`: the grant belongs to a previous build/identity and is dead.
/// - `unverifiable`: we could not decide (no bundle, no blob, codesign unavailable).
export type TccIdentityVerification = "satisfied" | "unsatisfied" | "unverifiable";

export type TccAuthorizationState =
  | "allowed"
  | "stale_allowed_for_previous_app_build"
  | "allowed_identity_unverified"
  | "denied"
  | "unknown"
  | "limited"
  | "not_determined"
  | `unknown(${string})`;

export type CodesignRequirementRunner = (
  requirementPath: string,
  appPath: string,
) => PermissionHelperProcessResult;

export interface TccPermissionProbe {
  databaseExists: (dbPath: string) => boolean;
  readAccessRow: (dbPath: string, service: string) => TccAccessRow | null;
  verifyStoredRequirement: (csreqHex: string, appPath: string) => TccIdentityVerification;
}

/// `codesign --verify -R <requirement>` exit codes, measured on macOS 26.5.1 (station03):
///   0 -> "explicit requirement satisfied"
///   3 -> "test-requirement: code failed to satisfy specified code requirement(s)"
///   1 -> bundle missing, or the requirement blob is corrupt (verdict unknown, not a denial)
const CODESIGN_REQUIREMENT_SATISFIED_STATUS = 0;
const CODESIGN_REQUIREMENT_UNSATISFIED_STATUS = 3;

export function tccDatabasePaths(home: string): string[] {
  return [
    join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    join("/", "Library", "Application Support", "com.apple.TCC", "TCC.db"),
  ];
}

export function tccAuthValueLabel(value: string): string {
  switch (value) {
    case "0":
      return "denied";
    case "1":
      return "unknown";
    case "2":
      return "allowed";
    case "3":
      return "limited";
    default:
      return `unknown(${value})`;
  }
}

const defaultCodesignRequirementRunner: CodesignRequirementRunner = (
  requirementPath,
  appPath,
) =>
  spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--verbose=2", "-R", requirementPath, appPath],
    { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
  );

/// Writes the raw `csreq` blob to a temp file and asks codesign whether the installed
/// bundle still satisfies it. This is the same evaluation macOS performs before honouring
/// a TCC grant, which is why it — and not the `auth_value` column — decides the answer.
export function verifyStoredRequirementWithCodesign(
  csreqHex: string,
  appPath: string,
  runner: CodesignRequirementRunner = defaultCodesignRequirementRunner,
  bundleExists: (path: string) => boolean = existsSync,
): TccIdentityVerification {
  const normalized = csreqHex.trim();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    return "unverifiable";
  }
  if (!appPath || !bundleExists(appPath)) return "unverifiable";

  let scratchDirectory: string | null = null;
  try {
    scratchDirectory = mkdtempSync(join(tmpdir(), "recordings-tcc-csreq-"));
    const requirementPath = join(scratchDirectory, "tcc-requirement.bin");
    writeFileSync(requirementPath, Buffer.from(normalized, "hex"));
    const result = runner(requirementPath, appPath);
    if (result.error) return "unverifiable";
    if (result.status === CODESIGN_REQUIREMENT_SATISFIED_STATUS) return "satisfied";
    if (result.status === CODESIGN_REQUIREMENT_UNSATISFIED_STATUS) return "unsatisfied";
    return "unverifiable";
  } catch {
    return "unverifiable";
  } finally {
    if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

const defaultTccPermissionProbe: TccPermissionProbe = {
  databaseExists: existsSync,
  readAccessRow: (dbPath, service) => {
    const sql =
      "select auth_value || '|' || ifnull(hex(csreq), '') from access where service = '" +
      service.replace(/'/g, "''") +
      "' and client = '" +
      RECORDINGS_BUNDLE_IDENTIFIER +
      "' order by last_modified desc limit 1;";
    const result = spawnSync("/usr/bin/sqlite3", [dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = result.stdout?.trim() ?? "";
    if (!value) return null;
    const [authValue = "", csreqHex = ""] = value.split("|");
    return { authValue, csreqHex };
  },
  verifyStoredRequirement: (csreqHex, appPath) =>
    verifyStoredRequirementWithCodesign(csreqHex, appPath),
};

/// Resolves the real authorization state for one TCC service, verifying that an `allowed`
/// row still binds to the installed bundle. Never reports a bare `allowed` on the strength
/// of `auth_value` alone — an unverifiable grant is reported as unverifiable so callers
/// cannot mistake "a row exists" for "the app is authorized".
export function resolveTccPermission(options: {
  service: string;
  home: string;
  appPath: string | null;
  probe?: TccPermissionProbe;
}): TccAuthorizationState {
  const probe = options.probe ?? defaultTccPermissionProbe;

  for (const dbPath of tccDatabasePaths(options.home)) {
    if (!probe.databaseExists(dbPath)) continue;
    const row = probe.readAccessRow(dbPath, options.service);
    if (!row) continue;

    const label = tccAuthValueLabel(row.authValue.trim());
    if (label !== "allowed") return label as TccAuthorizationState;

    if (!options.appPath) return "allowed_identity_unverified";
    switch (probe.verifyStoredRequirement(row.csreqHex, options.appPath)) {
      case "satisfied":
        return "allowed";
      case "unsatisfied":
        return "stale_allowed_for_previous_app_build";
      default:
        return "allowed_identity_unverified";
    }
  }

  return "not_determined";
}
