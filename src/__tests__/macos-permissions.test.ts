import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  classifyTccGrantDurability,
  describeTccAuthorizationSubject,
  RECORDINGS_BUNDLE_IDENTIFIER,
  resolveTccPermission,
  runMacOSPermissionRequest,
  tccDatabasePaths,
  verifyStoredRequirementWithCodesign,
  type PermissionHelperRunner,
  type TccAccessRow,
  type TccIdentityVerification,
  type TccPermissionProbe,
} from "../cli/macos-permissions.js";

const APP_PATH = "/Users/tester/.hasna/recordings/Recordings.app";

/// Real blob taken from station03's system TCC.db row for
/// kTCCServiceAccessibility / com.hasna.recordings. Decodes (via `csreq -r <file> -t`) to:
///   identifier "com.hasna.recordings" and certificate root = H"6eb85e38...dfe4"
const STATION_CSREQ_HEX =
  "FADE0C000000004C00000001000000060000000200000014636F6D2E6861736E612E7265636F7264696E677300000004FFFFFFFF000000146EB85E38B7750391E313D7ED4119972CB4BDDFE4";

function probeReturning(
  row: TccAccessRow | null,
  verification: TccIdentityVerification = "satisfied",
  options: { presentDatabases?: string[] } = {},
): TccPermissionProbe {
  return {
    databaseExists: (dbPath) =>
      options.presentDatabases ? options.presentDatabases.includes(dbPath) : true,
    readAccessRow: () => (row ? { kind: "row", row } : { kind: "absent" }),
    verifyStoredRequirement: () => verification,
  };
}

describe("macOS permission helper exit relay", () => {
  test("runs the installed app executable directly and relays denied status", () => {
    const invocations: Array<{
      executable: string;
      arguments_: string[];
      options: { stdio: "inherit" };
    }> = [];
    const runner: PermissionHelperRunner = (executable, arguments_, options) => {
      invocations.push({ executable, arguments_, options });
      return { status: 1 };
    };

    const result = runMacOSPermissionRequest("/Applications/Recordings.app", runner);

    expect(result).toEqual({ exitCode: 1, errorMessage: undefined });
    expect(invocations).toEqual([{
      executable: "/Applications/Recordings.app/Contents/MacOS/Recordings",
      arguments_: ["--request-permissions", "--open-permission-settings"],
      options: { stdio: "inherit" },
    }]);
  });

  test("relays a fully granted helper status as success", () => {
    const result = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: 0 }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
  });

  test("maps launch errors and missing statuses to failure", () => {
    const failed = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: null, error: new Error("launch failed") }),
    );
    const missingStatus = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: null }),
    );

    expect(failed).toEqual({ exitCode: 1, errorMessage: "launch failed" });
    expect(missingStatus.exitCode).toBe(1);
  });
});

describe("TCC grant identity verification", () => {
  test("an allowed row whose stored requirement still validates is genuinely allowed", () => {
    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning({ authValue: "2", csreqHex: STATION_CSREQ_HEX }, "satisfied"),
    });

    expect(state).toBe("allowed");
  });

  test("an allowed row bound to a previous build is reported stale, never allowed", () => {
    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning({ authValue: "2", csreqHex: STATION_CSREQ_HEX }, "unsatisfied"),
    });

    expect(state).toBe("stale_allowed_for_previous_app_build");
  });

  test("an unverifiable allowed row is disclosed as unverified rather than allowed", () => {
    const unverifiable = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning({ authValue: "2", csreqHex: "" }, "unverifiable"),
    });
    const noInstalledApp = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: null,
      probe: probeReturning({ authValue: "2", csreqHex: STATION_CSREQ_HEX }, "satisfied"),
    });

    expect(unverifiable).toBe("allowed_identity_unverified");
    expect(noInstalledApp).toBe("allowed_identity_unverified");
  });

  test("non-allowed decisions are returned without consulting the signature", () => {
    let verifyCalls = 0;
    const probe: TccPermissionProbe = {
      databaseExists: () => true,
      readAccessRow: () => ({
        kind: "row",
        row: { authValue: "0", csreqHex: STATION_CSREQ_HEX },
      }),
      verifyStoredRequirement: () => {
        verifyCalls += 1;
        return "satisfied";
      },
    };

    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe,
    });

    expect(state).toBe("denied");
    expect(verifyCalls).toBe(0);
  });

  test("missing databases and missing rows fall through to not_determined", () => {
    const noDatabase = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning(null, "satisfied", { presentDatabases: [] }),
    });
    const noRow = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning(null),
    });

    expect(noDatabase).toBe("not_determined");
    expect(noRow).toBe("not_determined");
  });

  test("the user database is consulted before the system database", () => {
    const [userDatabase, systemDatabase] = tccDatabasePaths("/Users/tester");
    const consulted: string[] = [];
    const probe: TccPermissionProbe = {
      databaseExists: () => true,
      readAccessRow: (dbPath) => {
        consulted.push(dbPath);
        return dbPath === systemDatabase
          ? { kind: "row", row: { authValue: "2", csreqHex: STATION_CSREQ_HEX } }
          : { kind: "absent" };
      },
      verifyStoredRequirement: () => "satisfied",
    };

    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe,
    });

    expect(state).toBe("allowed");
    expect(consulted).toEqual([userDatabase, systemDatabase]);
    expect(userDatabase).toContain("/Users/tester/Library/Application Support/com.apple.TCC/TCC.db");
    expect(systemDatabase).toBe("/Library/Application Support/com.apple.TCC/TCC.db");
  });

  test("queries the row for the canonical bundle identifier", () => {
    expect(RECORDINGS_BUNDLE_IDENTIFIER).toBe("com.hasna.recordings");
  });

  /// Accessibility lives only in the system database, which needs Full Disk Access to open.
  /// Reporting `not_determined` there would tell an operator the app had never been granted
  /// when in fact the answer was simply unread — the failure this suite exists to prevent.
  test("an unreadable database is reported as undetermined, never as not_determined", () => {
    const probe: TccPermissionProbe = {
      databaseExists: () => true,
      readAccessRow: () => ({ kind: "unreadable", detail: "unable to open database file" }),
      verifyStoredRequirement: () => "satisfied",
    };

    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe,
    });

    expect(state).toBe("undetermined_tcc_database_unreadable");
    expect(state).not.toBe("not_determined");
  });

  test("an unreadable user database does not mask a real grant in the system database", () => {
    const [userDatabase, systemDatabase] = tccDatabasePaths("/Users/tester");
    const probe: TccPermissionProbe = {
      databaseExists: () => true,
      readAccessRow: (dbPath) =>
        dbPath === userDatabase
          ? { kind: "unreadable", detail: "permission denied" }
          : { kind: "row", row: { authValue: "2", csreqHex: STATION_CSREQ_HEX } },
      verifyStoredRequirement: () => "satisfied",
    };

    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe,
    });

    expect(state).toBe("allowed");
    expect(systemDatabase).toBe("/Library/Application Support/com.apple.TCC/TCC.db");
  });

  test("an absent row is still not_determined when every present database was readable", () => {
    const state = resolveTccPermission({
      service: "kTCCServiceAccessibility",
      home: "/Users/tester",
      appPath: APP_PATH,
      probe: probeReturning(null),
    });

    expect(state).toBe("not_determined");
  });
});

describe("TCC grant durability across rebuilds", () => {
  /// The real requirement from station03's live Accessibility grant, decoded with
  /// `csreq -r <blob> -t`. It names the signing certificate's root, not the binary.
  const STATION_REQUIREMENT =
    'identifier "com.hasna.recordings" and certificate root = H"6eb85e38b7750391e313d7ed4119972cb4bddfe4"';

  test("a certificate-rooted requirement survives a rebuild", () => {
    expect(
      classifyTccGrantDurability({
        designatedRequirement: STATION_REQUIREMENT,
        adHocSigned: false,
      }),
    ).toBe("survives_rebuild_certificate_anchored");
  });

  test("a Developer ID requirement survives a rebuild", () => {
    expect(
      classifyTccGrantDurability({
        designatedRequirement:
          'identifier "com.hasna.recordings" and anchor apple generic and certificate '
          + 'leaf[subject.CN] = "Developer ID Application: VASILE ANDREI HASNA (HKZ326A8Y3)"',
        adHocSigned: false,
      }),
    ).toBe("survives_rebuild_developer_id");
  });

  /// The shape of the stale `com.hasna.recordings-helper` grant measured on station03, and
  /// the shape `build.sh` produces whenever it signs with `-`.
  test("a cdhash-pinned requirement dies on rebuild", () => {
    expect(
      classifyTccGrantDurability({
        designatedRequirement: 'cdhash H"d7e467f995dc72102c86f15c6ed5bdebc7918c2e"',
        adHocSigned: false,
      }),
    ).toBe("dies_on_rebuild_cdhash_pinned");
  });

  test("ad-hoc signing decides the verdict even with no readable requirement", () => {
    expect(
      classifyTccGrantDurability({ designatedRequirement: null, adHocSigned: true }),
    ).toBe("dies_on_rebuild_cdhash_pinned");
  });

  test("an unreadable requirement on a certificate-signed bundle stays unknown", () => {
    expect(
      classifyTccGrantDurability({ designatedRequirement: null, adHocSigned: false }),
    ).toBe("unknown");
  });

  /// A bundle identifier is free to contain the word "cdhash". Classifying on the raw text
  /// would call this certificate-anchored grant pinned, and so warn about a revocation that
  /// is not going to happen.
  test("cdhash inside a quoted identifier does not count as a cdhash term", () => {
    expect(
      classifyTccGrantDurability({
        designatedRequirement:
          'identifier "com.example.cdhash-tool" and certificate root = H"6eb85e38b7750391e313d7ed4119972cb4bddfe4"',
        adHocSigned: false,
      }),
    ).toBe("survives_rebuild_certificate_anchored");
  });

  test("an anchor-hash requirement is recognised as certificate anchored", () => {
    expect(
      classifyTccGrantDurability({
        designatedRequirement: 'identifier "com.hasna.recordings" and anchor H"6eb85e38b775"',
        adHocSigned: false,
      }),
    ).toBe("survives_rebuild_certificate_anchored");
  });

  /// `anchor apple` (the platform-binary anchor, e.g. /bin/ls) is not `anchor apple generic`
  /// (Developer ID), but it is still anchored to a certificate rather than to one binary.
  /// Measured on macOS 26.5.1: `codesign -d -r- /bin/ls` reports
  /// `identifier "com.apple.ls" and anchor apple`.
  test("plain anchor apple is certificate anchored, not a Developer ID and not unknown", () => {
    const durability = classifyTccGrantDurability({
      designatedRequirement: 'identifier "com.apple.ls" and anchor apple',
      adHocSigned: false,
    });

    expect(durability).toBe("survives_rebuild_certificate_anchored");
    expect(durability).not.toBe("survives_rebuild_developer_id");
  });
});

/// The system TCC database only opens for a process holding Full Disk Access, so telling
/// "could not read" apart from "no grant recorded" is the whole point of the lookup type.
/// Exit codes measured against sqlite3 3.45.1 and 3.51.0.
describe("TCC database read failures", () => {
  function probeWithSqliteFailure(detail: string): TccPermissionProbe {
    return {
      databaseExists: () => true,
      readAccessRow: () =>
        /no such table/i.test(detail) ? { kind: "absent" } : { kind: "unreadable", detail },
      verifyStoredRequirement: () => "satisfied",
    };
  }

  /// sqlite3 exits 1 with "no such table: access" — the file opened and answered, so this is
  /// absence, not illegibility.
  test("a database with no access table is absence, not illegibility", () => {
    expect(
      resolveTccPermission({
        service: "kTCCServiceAccessibility",
        home: "/Users/tester",
        appPath: APP_PATH,
        probe: probeWithSqliteFailure("Error: in prepare, no such table: access"),
      }),
    ).toBe("not_determined");
  });

  /// sqlite3 exits 1 "unable to open database file" without Full Disk Access, and 26
  /// "file is not a database" on a corrupt file. Neither means "not granted".
  test("a database that cannot be opened or parsed is undetermined", () => {
    for (const detail of [
      'Error: unable to open database "TCC.db": unable to open database file',
      "Error: in prepare, file is not a database (26)",
    ]) {
      expect(
        resolveTccPermission({
          service: "kTCCServiceAccessibility",
          home: "/Users/tester",
          appPath: APP_PATH,
          probe: probeWithSqliteFailure(detail),
        }),
      ).toBe("undetermined_tcc_database_unreadable");
    }
  });
});

/// A CLI inherits its terminal's Accessibility grant, so a report that does not name its
/// subject can read "allowed" on the strength of Ghostty's grant while Recordings.app is
/// denied. The subject string must always identify the bundle being reported on.
describe("authorization subject disclosure", () => {
  test("names the installed bundle path and the bundle identifier", () => {
    const subject = describeTccAuthorizationSubject(
      "/Users/hasna/.hasna/recordings/Recordings.app",
    );

    expect(subject).toContain("/Users/hasna/.hasna/recordings/Recordings.app");
    expect(subject).toContain(RECORDINGS_BUNDLE_IDENTIFIER);
  });

  test("says plainly when there is no bundle to report a grant for", () => {
    const subject = describeTccAuthorizationSubject(null);

    expect(subject).toContain(RECORDINGS_BUNDLE_IDENTIFIER);
    expect(subject).toContain("no installed bundle");
  });
});

describe("codesign requirement evaluation", () => {
  test("maps the measured codesign exit codes to verdicts", () => {
    const evaluate = (status: number | null, error?: Error) =>
      verifyStoredRequirementWithCodesign(
        STATION_CSREQ_HEX,
        APP_PATH,
        () => ({ status, error }),
        () => true,
      );

    // 0 = "explicit requirement satisfied", 3 = "code failed to satisfy specified code
    // requirement(s)", 1 = missing bundle or corrupt requirement (verdict unknown).
    expect(evaluate(0)).toBe("satisfied");
    expect(evaluate(3)).toBe("unsatisfied");
    expect(evaluate(1)).toBe("unverifiable");
    expect(evaluate(null)).toBe("unverifiable");
    expect(evaluate(null, new Error("codesign missing"))).toBe("unverifiable");
  });

  test("passes the requirement blob as a file to codesign --verify -R", () => {
    const invocations: Array<{ requirementPath: string; appPath: string }> = [];
    const verdict = verifyStoredRequirementWithCodesign(
      STATION_CSREQ_HEX,
      APP_PATH,
      (requirementPath, appPath) => {
        invocations.push({ requirementPath, appPath });
        return { status: 0 };
      },
      () => true,
    );

    expect(verdict).toBe("satisfied");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.appPath).toBe(APP_PATH);
    expect(invocations[0]!.requirementPath).toEndWith("tcc-requirement.bin");
  });

  test("refuses to guess when the blob or bundle is unusable", () => {
    const runner = () => ({ status: 0 });
    expect(verifyStoredRequirementWithCodesign("", APP_PATH, runner, () => true))
      .toBe("unverifiable");
    expect(verifyStoredRequirementWithCodesign("ABC", APP_PATH, runner, () => true))
      .toBe("unverifiable");
    expect(verifyStoredRequirementWithCodesign("ZZZZ", APP_PATH, runner, () => true))
      .toBe("unverifiable");
    expect(verifyStoredRequirementWithCodesign(STATION_CSREQ_HEX, APP_PATH, runner, () => false))
      .toBe("unverifiable");
    expect(verifyStoredRequirementWithCodesign(STATION_CSREQ_HEX, "", runner, () => true))
      .toBe("unverifiable");
  });

  test("removes the temporary requirement file after evaluating", () => {
    let capturedPath = "";
    verifyStoredRequirementWithCodesign(
      STATION_CSREQ_HEX,
      APP_PATH,
      (requirementPath) => {
        capturedPath = requirementPath;
        return { status: 0 };
      },
      () => true,
    );

    expect(capturedPath).not.toBe("");
    expect(existsSync(capturedPath)).toBe(false);
  });
});
