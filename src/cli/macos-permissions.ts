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

/// Outcome of looking for one service's row in one TCC database. `absent` and `unreadable`
/// must stay distinct: Accessibility and Input Monitoring live in the *system* database,
/// which only opens for a process holding Full Disk Access. Collapsing an unreadable
/// database into "no row" reports `not_determined` for an app that is in fact fully
/// authorized — the silent-failure mode this module exists to remove.
export type TccAccessLookup =
  | { kind: "row"; row: TccAccessRow }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

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
  | "undetermined_tcc_database_unreadable"
  | `unknown(${string})`;

export type CodesignRequirementRunner = (
  requirementPath: string,
  appPath: string,
) => PermissionHelperProcessResult;

export interface TccPermissionProbe {
  databaseExists: (dbPath: string) => boolean;
  readAccessRow: (dbPath: string, service: string) => TccAccessLookup;
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    // sqlite3 exits non-zero when it cannot open the file at all — the ordinary outcome for
    // the system database without Full Disk Access. That is not "no grant", so it must not
    // be reported as one.
    if (result.error) return { kind: "unreadable", detail: result.error.message };
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim() || `sqlite3 exited ${result.status}`;
      // A database that opens but holds no `access` table has answered the question: there is
      // no grant recorded here. That is absence, not illegibility — reporting it as unreadable
      // would claim ignorance we do not have.
      if (/no such table/i.test(detail)) return { kind: "absent" };
      return { kind: "unreadable", detail };
    }
    const value = result.stdout?.trim() ?? "";
    if (!value) return { kind: "absent" };
    const [authValue = "", csreqHex = ""] = value.split("|");
    return { kind: "row", row: { authValue, csreqHex } };
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
  let sawUnreadableDatabase = false;

  for (const dbPath of tccDatabasePaths(options.home)) {
    if (!probe.databaseExists(dbPath)) continue;
    const lookup = probe.readAccessRow(dbPath, options.service);
    if (lookup.kind === "unreadable") {
      sawUnreadableDatabase = true;
      continue;
    }
    if (lookup.kind === "absent") continue;
    const row = lookup.row;

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

  // Only claim "never asked" when every database that exists was actually readable.
  return sawUnreadableDatabase ? "undetermined_tcc_database_unreadable" : "not_determined";
}

/// How long a TCC grant given to this bundle will outlive the build it was granted to.
/// TCC stores the code requirement the grant was made against, so the requirement's *shape*
/// decides persistence:
/// - an ad-hoc signature yields a `cdhash H"..."` requirement, pinned to one exact binary,
///   so every rebuild silently voids the grant;
/// - a certificate-rooted requirement (`certificate root = H"..."`, or Developer ID's
///   `anchor apple generic` form) names the signing certificate rather than the binary, so
///   rebuilds with the same certificate keep the grant.
///
/// Measured on station03 (macOS 26.5.1): the live `com.hasna.recordings` Accessibility grant
/// stores `identifier "com.hasna.recordings" and certificate root = H"6eb85e38..."` and
/// survives rebuilds, while the stale `com.hasna.recordings-helper` grant stores a bare
/// `cdhash` and did not.
export type TccGrantDurability =
  | "survives_rebuild_developer_id"
  | "survives_rebuild_certificate_anchored"
  | "dies_on_rebuild_cdhash_pinned"
  | "unknown";

export function classifyTccGrantDurability(options: {
  designatedRequirement: string | null;
  adHocSigned: boolean;
}): TccGrantDurability {
  // Ad-hoc signing cannot produce anything but a cdhash-pinned requirement, so it decides
  // the answer even when the requirement text could not be read.
  if (options.adHocSigned) return "dies_on_rebuild_cdhash_pinned";

  const requirement = options.designatedRequirement?.trim();
  if (!requirement) return "unknown";

  // Quoted spans are data — a bundle identifier is free to contain "cdhash", and matching it
  // there would misreport a certificate-anchored grant as pinned. Requirement *operators*
  // live outside the quotes, so drop the quoted spans before classifying.
  const operators = requirement.replace(/"[^"]*"/g, '""');
  if (/\bcdhash\b/i.test(operators)) return "dies_on_rebuild_cdhash_pinned";
  if (/\banchor\s+apple\s+generic\b/i.test(operators)) return "survives_rebuild_developer_id";
  // `anchor apple` without `generic` is the Apple *platform binary* anchor (e.g. /bin/ls).
  // It anchors to Apple's own root, so it is certificate-anchored and survives rebuilds —
  // matched after the `generic` form above, which is the Developer ID case.
  if (/\banchor\s+apple\b/i.test(operators)) return "survives_rebuild_certificate_anchored";
  if (/\bcertificate\s+(root|leaf|\d+)\b|\banchor\s+H""/i.test(operators)) {
    return "survives_rebuild_certificate_anchored";
  }
  return "unknown";
}

/// Names the exact code the reported grant belongs to.
///
/// A CLI process inherits the *terminal's* Accessibility grant, never the app's: run from
/// Ghostty, `AXIsProcessTrusted()` answers for `com.mitchellh.ghostty` (which is itself
/// granted on station03), so a permission report that does not name its subject will read
/// "granted" while `Recordings.app` is denied. Every reported state here is a property of
/// the bundle below and of nothing else.
export function describeTccAuthorizationSubject(appPath: string | null): string {
  if (!appPath) {
    return `${RECORDINGS_BUNDLE_IDENTIFIER} (no installed bundle found — nothing to report a grant for)`;
  }
  return `${appPath} (${RECORDINGS_BUNDLE_IDENTIFIER})`;
}
