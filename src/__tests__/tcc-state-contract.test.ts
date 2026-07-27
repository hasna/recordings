import { describe, expect, test } from "bun:test";
import {
  RECORDINGS_BUNDLE_IDENTIFIER as BUNDLE_ID_FROM_PERMISSIONS,
  TCC_DATABASE_UNREADABLE_STATE,
  resolveTccGrant,
  type TccAuthorizationState,
  type TccPermissionProbe,
} from "../cli/macos-permissions.js";
import {
  RECORDINGS_BUNDLE_IDENTIFIER as BUNDLE_ID_FROM_CAPTURE_PROBE,
  TCC_UNREADABLE_STATE,
  classifyPermissionState,
  type PermissionRequestState,
} from "../lib/capture-probe.js";
import { RECORDINGS_BUNDLE_IDENTIFIER as BUNDLE_ID_CANONICAL } from "../lib/macos-bundle.js";

/**
 * Why this file exists.
 *
 * `cli/macos-permissions.ts` (from PR #24) is the only producer of TCC authorization states.
 * `lib/capture-probe.ts` (from PR #25) consumes those strings to decide whether the app has ever
 * asked for a permission, and `cli/index.ts` compares against them to choose between "denied"
 * and "cannot tell". The two branches were developed in parallel against different producers, so
 * the vocabularies drifted: the consumer looked for `"unreadable_no_full_disk_access"` while the
 * producer emitted `"undetermined_tcc_database_unreadable"`, and the consumer's prefix tests
 * assumed every readable row carried an `_identity_unverified` suffix that #24 no longer adds.
 *
 * Neither drift is detectable by `tsc`: both sides are `string`, so a comparison that can never
 * be true typechecks cleanly and silently becomes dead code. Only an executing test that names
 * every member of the union catches it, which is what this is.
 *
 * The `satisfies Record<...>` on `CLASSIFICATION` is the mechanism: adding a member to
 * `TccAuthorizationState` without adding it here is a compile error, so a state cannot be
 * introduced later and quietly fall through the consumer's `default` branch.
 */

/**
 * Every non-parameterised member of `TccAuthorizationState`, mapped to what it means for the
 * question `classifyPermissionState` answers: does a TCC row exist for this service?
 *
 * A row's existence — not its verdict — is what decides whether System Settings shows a
 * Recordings toggle yet, which is the only thing this classification drives.
 */
const CLASSIFICATION = {
  // Row exists, carries a decision.
  allowed: "requested",
  denied: "requested",
  limited: "requested",
  unknown: "requested",
  // Row exists and says allowed; the binding to the installed bundle is what is in doubt.
  allowed_identity_unverified: "requested",
  stale_allowed_for_previous_app_build: "requested",
  unverified_no_installed_bundle: "requested",
  // Positively established that no row exists.
  not_determined: "never_requested",
  // Reporter-level failures to resolve. These say nothing about the app.
  undetermined_tcc_database_unreadable: "unknown",
  unsupported: "unknown",
} satisfies Record<Exclude<TccAuthorizationState, `unknown(${string})`>, PermissionRequestState>;

describe("TCC state vocabulary contract (PR #24 producer x PR #25 consumer)", () => {
  test("every producer state classifies as intended, with none falling through", () => {
    for (const [state, expected] of Object.entries(CLASSIFICATION)) {
      expect(classifyPermissionState(state)).toBe(expected);
    }
  });

  test("the three states the pre-rebase prefix tests downgraded now read as requested", () => {
    // These are the exact regressions the #24 x #25 rebase introduced and this contract closes.
    // Each is an allowed-or-decided row, so the app has demonstrably asked; the old prefix tests
    // returned "unknown" for all three because none of them starts with allowed/denied/limited
    // and none carries the `_identity_unverified` suffix #25's own reader used to append.
    expect(classifyPermissionState("unknown")).toBe("requested");
    expect(classifyPermissionState("stale_allowed_for_previous_app_build")).toBe("requested");
    expect(classifyPermissionState("unverified_no_installed_bundle")).toBe("requested");
  });

  test("an unrecognised auth_value still counts as a row that exists", () => {
    expect(classifyPermissionState("unknown(7)")).toBe("requested");
    expect(classifyPermissionState("unknown(99)")).toBe("requested");
  });

  test("the retired _identity_unverified vocabulary is tolerated, not silently downgraded", () => {
    // Scoped compatibility, pinned here so its removal is a deliberate act. Nothing emits these
    // today; captured `recordings check --json` output from a pre-#24 build still contains them.
    for (const retired of [
      "denied_identity_unverified",
      "limited_identity_unverified",
      "unknown_identity_unverified",
      "unknown(7)_identity_unverified",
    ]) {
      expect(classifyPermissionState(retired)).toBe("requested");
    }
    // The tolerance must not swallow the reporter-level failures, which do not carry the suffix.
    expect(classifyPermissionState(TCC_DATABASE_UNREADABLE_STATE)).toBe("unknown");
  });

  test("an unrecognised state is reported as unknown, never as never_requested", () => {
    // Failing closed matters more than completeness here: claiming "the app never asked" on a
    // state we do not understand is the false statement, not admitting we cannot tell.
    expect(classifyPermissionState("some_state_added_later")).toBe("unknown");
    expect(classifyPermissionState("")).toBe("unknown");
    expect(classifyPermissionState("ambiguous_multiple_installations")).toBe("unknown");
  });

  test("consumer and producer name the unreadable-database state with the same bytes", () => {
    // The drift this catches made `micState === TCC_UNREADABLE_STATE` in the check renderer
    // permanently false, so a refused database read rendered as a red "denied" with instructions
    // to grant a permission that may already have been granted.
    expect(TCC_UNREADABLE_STATE).toBe(TCC_DATABASE_UNREADABLE_STATE);
  });

  test("the unreadable-database state is what resolveTccGrant actually returns", () => {
    // Pin the constant to observed producer behaviour, not to a second copy of the literal:
    // a database that exists but cannot be read must not be reported as "never asked".
    const probe: TccPermissionProbe = {
      databasePresence: () => "present",
      readAccessRow: () => ({ kind: "unreadable", detail: "authorization denied" }),
      verifyStoredRequirement: () => "unverifiable",
    };
    const report = resolveTccGrant({
      service: "kTCCServiceMicrophone",
      home: "/Users/nobody",
      appPath: null,
      probe,
    });
    expect(report.state).toBe(TCC_UNREADABLE_STATE);
    expect(classifyPermissionState(report.state)).toBe("unknown");
  });

  test("a readable database with no row is the only path to never_requested", () => {
    const probe: TccPermissionProbe = {
      databasePresence: () => "present",
      readAccessRow: () => ({ kind: "absent" }),
      verifyStoredRequirement: () => "unverifiable",
    };
    const report = resolveTccGrant({
      service: "kTCCServiceMicrophone",
      home: "/Users/nobody",
      appPath: null,
      probe,
    });
    expect(report.state).toBe("not_determined");
    expect(classifyPermissionState(report.state)).toBe("never_requested");
  });

  // The blocker a third review proved by mutation: reverting the unreadable-database handling left
  // the suite at 64 pass / 0 fail / exit 0. These four tests exist so each revert fails.
  describe("a database that cannot be read is never reported as never-asked", () => {
    test("a stat-refused database is unreadable, NOT absent", () => {
      // `existsSync` returns false for ANY stat error, so an EACCES on the TCC path used to take
      // the "no database here" branch and return not_determined -> never_requested -> the
      // operator-facing claim "no TCC entry exists" for an app that is in fact granted.
      const report = resolveTccGrant({
        service: "kTCCServiceMicrophone",
        home: "/Users/nobody",
        appPath: null,
        probe: {
          databasePresence: () => "indeterminate",
          readAccessRow: () => ({ kind: "absent" }),
          verifyStoredRequirement: () => "unverifiable",
        },
      });
      expect(report.state).toBe(TCC_DATABASE_UNREADABLE_STATE);
      expect(report.state).not.toBe("not_determined");
      expect(classifyPermissionState(report.state)).toBe("unknown");
      expect(classifyPermissionState(report.state)).not.toBe("never_requested");
    });

    test("an open-refused database is unreadable, NOT absent", () => {
      const report = resolveTccGrant({
        service: "kTCCServiceMicrophone",
        home: "/Users/nobody",
        appPath: null,
        probe: {
          databasePresence: () => "present",
          readAccessRow: () => ({ kind: "unreadable", detail: "authorization denied" }),
          verifyStoredRequirement: () => "unverifiable",
        },
      });
      expect(report.state).toBe(TCC_DATABASE_UNREADABLE_STATE);
      expect(classifyPermissionState(report.state)).not.toBe("never_requested");
    });

    test("one unreadable database poisons the never-asked claim even if another is absent", () => {
      // Both candidate paths are consulted. If EITHER was unreadable, "never asked" is unprovable.
      const paths: string[] = [];
      const report = resolveTccGrant({
        service: "kTCCServiceMicrophone",
        home: "/Users/nobody",
        appPath: null,
        probe: {
          databasePresence: (dbPath) => {
            paths.push(dbPath);
            return paths.length === 1 ? "indeterminate" : "absent";
          },
          readAccessRow: () => ({ kind: "absent" }),
          verifyStoredRequirement: () => "unverifiable",
        },
      });
      expect(paths.length).toBeGreaterThan(1);
      expect(report.state).toBe(TCC_DATABASE_UNREADABLE_STATE);
    });

    test("only every-database-readable-and-empty yields never_requested", () => {
      const report = resolveTccGrant({
        service: "kTCCServiceMicrophone",
        home: "/Users/nobody",
        appPath: null,
        probe: {
          databasePresence: () => "absent",
          readAccessRow: () => ({ kind: "absent" }),
          verifyStoredRequirement: () => "unverifiable",
        },
      });
      expect(report.state).toBe("not_determined");
      expect(classifyPermissionState(report.state)).toBe("never_requested");
    });
  });

  test("all three queue branches resolve to one bundle identifier definition", () => {
    // #24 (cli/macos-permissions.ts), #25 (lib/capture-probe.ts) and #26 (cli/macos-shortcut.ts)
    // each introduced their own copy of this literal; none exists on the base commit. Identity
    // comparison, not string equality, is the point — two modules agreeing by coincidence is the
    // state this replaces.
    expect(BUNDLE_ID_FROM_PERMISSIONS).toBe(BUNDLE_ID_CANONICAL);
    expect(BUNDLE_ID_FROM_CAPTURE_PROBE).toBe(BUNDLE_ID_CANONICAL);
    expect(BUNDLE_ID_CANONICAL).toBe("com.hasna.recordings");
  });
});
