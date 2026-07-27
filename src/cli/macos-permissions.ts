import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECORDINGS_BUNDLE_IDENTIFIER,
  TCC_DATABASE_UNREADABLE_STATE,
} from "../lib/macos-bundle.js";

/// Bundle identifier TCC keys every Recordings.app grant to. Single source for the
/// permission lookups, the reset path, and the reported status object.
///
/// Re-exported rather than defined here so this module keeps the import path the review ruling
/// named, while the one definition lives in `lib/macos-bundle.ts` — `lib/capture-probe.ts`
/// publishes the same constant through `src/index.ts` and must not import upward from `cli/`.
export { RECORDINGS_BUNDLE_IDENTIFIER, TCC_DATABASE_UNREADABLE_STATE };

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
  // Deliberately does not start with "allowed": a `grep allowed` or a human skim must not
  // read "there is no bundle to check" as a pass.
  | "unverified_no_installed_bundle"
  | "denied"
  | "unknown"
  | "limited"
  | "not_determined"
  | "undetermined_tcc_database_unreadable"
  | "unsupported"
  | `unknown(${string})`;

export type CodesignRequirementRunner = (
  requirementPath: string,
  appPath: string,
) => PermissionHelperProcessResult;

export interface TccPermissionProbe {
  /**
   * Three-valued, and it has to be. This was `databaseExists: (dbPath) => boolean` backed by
   * `existsSync`, which returns `false` for ANY `stat` error rather than just `ENOENT`. When
   * `stat()` on the TCC path is itself refused, the caller took the "no database here" branch,
   * never recorded a refusal, and returned `not_determined` — which
   * `classifyPermissionState` maps to `never_requested`, producing the operator-facing claim
   * "the app has never requested microphone access (no TCC entry exists)" on a machine whose
   * grant row demonstrably exists. That is the exact flagship lie this module was written to kill,
   * reached through the one path that looked too boring to check.
   *
   * Demonstrated on real macOS: a file present but `open()`-refused (`/etc/master.passwd`) gives
   * `existsSync=true` and was handled correctly, while a path whose `stat()` is refused
   * (`/private/var/db/dslocal/nodes/Default/users/root.plist`) gives `existsSync=false` and
   * bypassed the fix entirely.
   *
   * `indeterminate` must be treated as unreadable, never as absent.
   */
  databasePresence: (dbPath: string) => "present" | "absent" | "indeterminate";
  readAccessRow: (dbPath: string, service: string) => TccAccessLookup;
  verifyStoredRequirement: (csreqHex: string, appPath: string) => TccIdentityVerification;
  /// Renders the stored requirement blob as requirement text, or null when it cannot be
  /// decoded. Durability is a property of the requirement the grant was *stored* with, so it
  /// can only be classified from this — never from the bundle's current signature.
  describeStoredRequirement?: (csreqHex: string) => string | null;
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
  databasePresence: (dbPath) => {
    try {
      statSync(dbPath);
      return "present";
    } catch (error) {
      // ENOENT is the only error that means "there is no database at this path". Everything else
      // — EACCES, EPERM, ELOOP, EIO — means we were not allowed or not able to find out, which is
      // a refusal to be reported, not an absence to be assumed.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "indeterminate";
    }
  },
  readAccessRow: (dbPath, service) => {
    // `auth_value` is INTEGER NOT NULL on a real TCC db, so its ifnull is belt-and-braces for a
    // synthetic or corrupt file; `csreq` is the genuinely nullable column. Without the guards a
    // NULL anywhere makes the whole concatenation NULL, which arrives as empty stdout and reads
    // as "no row" — "never asked" for a row that exists. client_type = 0 pins
    // bundle-identifier rows; client_type = 1 rows key on absolute paths.
    const sql =
      "select ifnull(auth_value, '') || '|' || ifnull(hex(csreq), '') from access where service = '" +
      service.replace(/'/g, "''") +
      "' and client = '" +
      RECORDINGS_BUNDLE_IDENTIFIER +
      "' and client_type = 0 order by last_modified desc limit 1;";
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
  describeStoredRequirement: (csreqHex) => describeStoredRequirementWithCsreq(csreqHex),
};

/// Decodes a stored `csreq` blob to its requirement text with `csreq -r <file> -t`, the
/// inverse of how macOS stored it. Returns null rather than guessing when the tool is absent
/// or the blob will not parse.
export function describeStoredRequirementWithCsreq(
  csreqHex: string,
  runner: (requirementPath: string) => { status: number | null; stdout?: string; error?: Error } = (
    requirementPath,
  ) =>
    spawnSync("/usr/bin/csreq", ["-r", requirementPath, "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
): string | null {
  const normalized = csreqHex.trim();
  if (
    normalized.length === 0
    || normalized.length % 2 !== 0
    || !/^[0-9a-fA-F]+$/.test(normalized)
  ) {
    return null;
  }

  let scratchDirectory: string | null = null;
  try {
    scratchDirectory = mkdtempSync(join(tmpdir(), "recordings-tcc-decode-"));
    const requirementPath = join(scratchDirectory, "tcc-requirement.bin");
    writeFileSync(requirementPath, Buffer.from(normalized, "hex"));
    const result = runner(requirementPath);
    if (result.error || result.status !== 0) return null;
    const text = (result.stdout ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

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
  return resolveTccGrant(options).state;
}

/// The authorization state for one service together with the requirement that decision was
/// stored against. Durability is per-service because each service stores its own `csreq`: one
/// app can hold a rebuild-durable Accessibility grant and a cdhash-pinned Microphone grant at
/// the same time, and a single per-app verdict cannot express that.
export interface TccGrantReport {
  state: TccAuthorizationState;
  storedRequirement: string | null;
  durability: TccGrantDurability;
}

export function resolveTccGrant(options: {
  service: string;
  home: string;
  appPath: string | null;
  probe?: TccPermissionProbe;
}): TccGrantReport {
  const probe = options.probe ?? defaultTccPermissionProbe;
  let sawUnreadableDatabase = false;

  for (const dbPath of tccDatabasePaths(options.home)) {
    const presence = probe.databasePresence(dbPath);
    // A path we could not stat is NOT an absent database. Collapsing it into `continue` is what
    // let "never asked" be reported for a granted app.
    if (presence === "indeterminate") {
      sawUnreadableDatabase = true;
      continue;
    }
    if (presence === "absent") continue;
    const lookup = probe.readAccessRow(dbPath, options.service);
    if (lookup.kind === "unreadable") {
      sawUnreadableDatabase = true;
      continue;
    }
    if (lookup.kind === "absent") continue;
    const row = lookup.row;

    // Classify the requirement the grant was STORED with. The bundle's current signature says
    // nothing about an existing grant: a bundle re-signed with a certificate still holds a
    // cdhash-pinned grant from when it was ad-hoc, and reporting the bundle's shape there
    // would promise durability the stored grant does not have.
    const storedRequirement = probe.describeStoredRequirement?.(row.csreqHex) ?? null;
    const durability = classifyTccGrantDurability({
      designatedRequirement: storedRequirement,
      adHocSigned: false,
    });

    // An empty decision is not a decision. Returning `unknown()` here would stop the search on
    // a row that says nothing and print bare empty parens at an operator, while a real grant may
    // sit in the next database — so keep looking, exactly as a missing row does.
    const authValue = row.authValue.trim();
    if (authValue.length === 0) continue;

    const label = tccAuthValueLabel(authValue);
    if (label !== "allowed") {
      return { state: label as TccAuthorizationState, storedRequirement, durability };
    }

    if (!options.appPath) {
      return { state: "unverified_no_installed_bundle", storedRequirement, durability };
    }
    switch (probe.verifyStoredRequirement(row.csreqHex, options.appPath)) {
      case "satisfied":
        return { state: "allowed", storedRequirement, durability };
      case "unsatisfied":
        return { state: "stale_allowed_for_previous_app_build", storedRequirement, durability };
      default:
        return { state: "allowed_identity_unverified", storedRequirement, durability };
    }
  }

  // Only claim "never asked" when every database that exists was actually readable.
  return {
    state: sawUnreadableDatabase ? TCC_DATABASE_UNREADABLE_STATE : "not_determined",
    storedRequirement: null,
    durability: "unknown",
  };
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
