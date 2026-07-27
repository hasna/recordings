import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
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
    readAccessRow: () => row,
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
      readAccessRow: () => ({ authValue: "0", csreqHex: STATION_CSREQ_HEX }),
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
        return dbPath === systemDatabase ? { authValue: "2", csreqHex: STATION_CSREQ_HEX } : null;
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
