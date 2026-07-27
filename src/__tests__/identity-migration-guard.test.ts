import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  IDENTITY_GUARD_RELATIVE_PATH,
  readRepositoryFile,
  runInstallerPreflight,
} from "./helpers/installer-preflight";

const repositoryRoot = resolve(import.meta.dir, "../..");
const guardPath = join(repositoryRoot, IDENTITY_GUARD_RELATIVE_PATH);

// Single-quote escaping, not JSON: several cases below are deliberately shaped like shell
// expansions, and a double-quoted heredoc would expand them before the guard ever sees
// them — which would test bash rather than the guard.
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

type GuardInputs = {
  artifactPolicy: string;
  identityMigration: string;
  allowReleaseMigration: string;
  allowAdhocMigration: string;
  previousIdentity?: string;
  candidateIdentity?: string;
  expectedOldIdentity?: string;
  expectedNewIdentity?: string;
};

const OLD_DIGEST = "1".repeat(64);
const NEW_DIGEST = "2".repeat(64);

/// Runs the real sourced guard exactly as install_macos_app.sh runs it — same `set -euo
/// pipefail`, same argument order — so the decision table below is the shipped decision
/// table and not a restatement of it.
function guardVerdict(
  inputs: GuardInputs,
): { exitCode: number; stderr: string } {
  const argumentValues = [
    inputs.artifactPolicy,
    inputs.identityMigration,
    inputs.allowReleaseMigration,
    inputs.allowAdhocMigration,
    inputs.previousIdentity ?? OLD_DIGEST,
    inputs.candidateIdentity ?? NEW_DIGEST,
    inputs.expectedOldIdentity ?? "",
    inputs.expectedNewIdentity ?? "",
  ];
  return runGuardScript(
    `recordings_enforce_identity_migration ${argumentValues.map(shellQuote).join(" ")}`,
  );
}

function runGuardScript(
  invocation: string,
  environment?: Record<string, string>,
): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      `set -euo pipefail\n. ${JSON.stringify(guardPath)}\n${invocation}\n`,
    ],
    environment ? { env: { ...process.env, ...environment } } : {},
  );
  return { exitCode: result.exitCode ?? 1, stderr: result.stderr.toString() };
}

const allowed = (inputs: GuardInputs): void => {
  const verdict = guardVerdict(inputs);
  expect(verdict.exitCode, verdict.stderr).toBe(0);
  expect(verdict.stderr).toBe("");
};

const denied = (inputs: GuardInputs, expectedMessage: string): void => {
  const verdict = guardVerdict(inputs);
  expect(verdict.exitCode, verdict.stderr).not.toBe(0);
  expect(verdict.stderr).toContain(expectedMessage);
};

describe("designated-requirement identity-migration guard", () => {
  // The regression this file exists for. Before this guard was policy-independent, all
  // three enforcement points were conjoined with ARTIFACT_POLICY = "release", so a
  // local-only install computed identity_migration=1 and then discarded it — and a
  // local-only artifact is ad-hoc signed, so that replacement voids the installed app's
  // certificate-rooted Microphone and Accessibility grants.
  test("a local-only replacement of an incompatible identity is refused without the ad-hoc approval", () => {
    denied(
      {
        artifactPolicy: "local_only",
        identityMigration: "1",
        allowReleaseMigration: "0",
        allowAdhocMigration: "0",
      },
      "not mutually compatible",
    );
    const verdict = guardVerdict({
      artifactPolicy: "local_only",
      identityMigration: "1",
      allowReleaseMigration: "0",
      allowAdhocMigration: "0",
    });
    expect(verdict.stderr).toContain("--allow-adhoc-identity-migration");
    // Names the identities it is refusing to replace, so the operator can check what the
    // approval would destroy rather than approving blind.
    expect(verdict.stderr).toContain(OLD_DIGEST);
    expect(verdict.stderr).toContain(NEW_DIGEST);
  });

  test("the release approval never authorizes an ad-hoc local-only replacement", () => {
    denied(
      {
        artifactPolicy: "local_only",
        identityMigration: "1",
        allowReleaseMigration: "1",
        allowAdhocMigration: "0",
      },
      "not mutually compatible",
    );
  });

  test("the ad-hoc approval never authorizes a release signer migration", () => {
    denied(
      {
        artifactPolicy: "release",
        identityMigration: "1",
        allowReleaseMigration: "0",
        allowAdhocMigration: "1",
        expectedOldIdentity: OLD_DIGEST,
        expectedNewIdentity: NEW_DIGEST,
      },
      "--allow-signing-identity-migration",
    );
  });

  test("the explicit ad-hoc approval permits the local-only replacement", () => {
    allowed({
      artifactPolicy: "local_only",
      identityMigration: "1",
      allowReleaseMigration: "0",
      allowAdhocMigration: "1",
    });
  });

  test("an approval that is not required is refused under both policies", () => {
    denied(
      {
        artifactPolicy: "local_only",
        identityMigration: "0",
        allowReleaseMigration: "0",
        allowAdhocMigration: "1",
      },
      "no identity migration is required",
    );
    denied(
      {
        artifactPolicy: "release",
        identityMigration: "0",
        allowReleaseMigration: "1",
        allowAdhocMigration: "0",
        expectedOldIdentity: OLD_DIGEST,
        expectedNewIdentity: NEW_DIGEST,
      },
      "no identity migration is required",
    );
  });

  test("an install with no identity change proceeds under both policies", () => {
    for (const artifactPolicy of ["release", "local_only"]) {
      allowed({
        artifactPolicy,
        identityMigration: "0",
        allowReleaseMigration: "0",
        allowAdhocMigration: "0",
      });
    }
  });

  test("release migrations stay pinned to the exact operator-approved identity pair", () => {
    allowed({
      artifactPolicy: "release",
      identityMigration: "1",
      allowReleaseMigration: "1",
      allowAdhocMigration: "0",
      expectedOldIdentity: OLD_DIGEST,
      expectedNewIdentity: NEW_DIGEST,
    });
    for (const wrongPair of [
      { expectedOldIdentity: "3".repeat(64), expectedNewIdentity: NEW_DIGEST },
      { expectedOldIdentity: OLD_DIGEST, expectedNewIdentity: "3".repeat(64) },
      { expectedOldIdentity: "", expectedNewIdentity: "" },
    ]) {
      denied(
        {
          artifactPolicy: "release",
          identityMigration: "1",
          allowReleaseMigration: "1",
          allowAdhocMigration: "0",
          ...wrongPair,
        },
        "exact operator-approved old/new identities",
      );
    }
  });

  // The gate must deny an unexpected state rather than fall through it. Each of these
  // would previously have been evaluated by `[ x -eq 1 ]` or matched no branch at all.
  test("an unrecognised artifact policy is refused, including an empty one", () => {
    for (const artifactPolicy of ["", " ", "release ", "RELEASE", "local-only", "localonly", "debug", "fleet", "*"]) {
      denied(
        {
          artifactPolicy,
          identityMigration: "1",
          allowReleaseMigration: "0",
          allowAdhocMigration: "1",
        },
        "does not recognise the artifact policy",
      );
    }
  });

  test("a migration state that is not exactly 0 or 1 is refused", () => {
    for (const identityMigration of ["", " ", "2", "01", "1 ", " 1", "-1", "yes", "true", "1;true", "0x1"]) {
      denied(
        {
          artifactPolicy: "local_only",
          identityMigration,
          allowReleaseMigration: "0",
          allowAdhocMigration: "1",
        },
        "is not a 0/1 decision",
      );
    }
  });

  test("an approval flag that is not exactly 0 or 1 is refused under both policies", () => {
    for (const value of ["", " ", "2", "01", "yes", "true", "-1"]) {
      denied(
        {
          artifactPolicy: "release",
          identityMigration: "1",
          allowReleaseMigration: value,
          allowAdhocMigration: "0",
          expectedOldIdentity: OLD_DIGEST,
          expectedNewIdentity: NEW_DIGEST,
        },
        "Release identity-migration approval",
      );
      denied(
        {
          artifactPolicy: "local_only",
          identityMigration: "1",
          allowReleaseMigration: "0",
          allowAdhocMigration: value,
        },
        "Ad-hoc identity-migration approval",
      );
    }
  });

  test("a wrong argument count is refused instead of reading unset positionals", () => {
    for (const invocation of [
      "recordings_enforce_identity_migration",
      "recordings_enforce_identity_migration 'local_only'",
      "recordings_enforce_identity_migration 'local_only' '1' '0' '1' 'a' 'b' ''",
      "recordings_enforce_identity_migration 'local_only' '1' '0' '1' 'a' 'b' '' '' 'extra'",
    ]) {
      const verdict = runGuardScript(invocation);
      expect(verdict.exitCode, verdict.stderr).not.toBe(0);
      expect(verdict.stderr).toContain("arguments instead of 8");
    }
  });

  test("an unset caller variable aborts under set -u instead of passing an empty value", () => {
    const verdict = runGuardScript(
      'recordings_enforce_identity_migration "local_only" "$MISSING_MIGRATION_STATE" "0" "1" "a" "b" "" ""',
    );
    expect(verdict.exitCode).not.toBe(0);
    expect(verdict.stderr).toContain("unbound variable");
  });

  test("guard inputs are never evaluated as shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "recordings-guard-injection-"));
    try {
      const marker = join(directory, "executed");
      const injection = `$(touch ${marker})`;
      // Denied because "$(touch …)" is not a recognised policy, and the marker proves the
      // value was compared as a string rather than run.
      denied(
        {
          artifactPolicy: injection,
          identityMigration: "1",
          allowReleaseMigration: "0",
          allowAdhocMigration: "1",
        },
        "does not recognise the artifact policy",
      );
      allowed({
        artifactPolicy: "local_only",
        identityMigration: "1",
        allowReleaseMigration: "0",
        allowAdhocMigration: "1",
        previousIdentity: injection,
        candidateIdentity: injection,
      });
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the installer enforces the guard for every artifact policy, not only release", () => {
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    // The exact shape of the hole: all three enforcement points were conjoined with the
    // release policy, so local_only computed identity_migration and discarded it.
    expect(installer).not.toMatch(
      /ARTIFACT_POLICY" = "release" \] && \[ "\$identity_migration"/,
    );
    expect(installer).toContain("recordings_enforce_identity_migration \\");
    expect(installer).toContain(IDENTITY_GUARD_RELATIVE_PATH);
    // Sourced and proven present before either policy branch, so a stripped package
    // cannot skip the gate.
    expect(installer).toContain("Packaged identity-migration guard is missing.");
    expect(installer).toContain("declare -F recordings_enforce_identity_migration");
    // The premise the guard rests on: the local-only and debug build paths sign ad-hoc,
    // which is what makes a local-only replacement a designated-requirement change.
    expect(readRepositoryFile("src/native/Recordings/build.sh")).toContain('CODESIGN_IDENTITY="-"');
  });

  test("the installer refuses to run at all when the packaged guard is absent", () => {
    for (const artifactPolicy of ["release", "local-only"] as const) {
      const result = runInstallerPreflight({ artifactPolicy, removeIdentityGuard: true });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Packaged identity-migration guard is missing.");
    }
  });

  test("the installer refuses a symlinked, empty, functionless, or malformed guard", () => {
    const symlinked = runInstallerPreflight({ symlinkIdentityGuard: true });
    expect(symlinked.exitCode).toBe(2);
    expect(symlinked.stderr).toContain("Packaged identity-migration guard is missing.");

    for (const identityGuardContents of ["", "# nothing here\ntrue\n"]) {
      const result = runInstallerPreflight({ identityGuardContents });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("does not define its enforcement function");
    }

    // A guard that cannot be parsed must abort the installer, not be skipped: `set -e`
    // plus a non-zero `.` is what makes that true, so pin it.
    const malformed = runInstallerPreflight({
      identityGuardContents: "recordings_enforce_identity_migration() {\n  if [ \n}\n",
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout).not.toContain("Installed");
  });

  test("an inherited exported bash function cannot pre-empt the sourced guard", () => {
    const injection = {
      "BASH_FUNC_recordings_enforce_identity_migration%%": "() { return 0; }",
    };
    // bash 5 imports BASH_FUNC_name%% from the environment; assert the injection really
    // does take effect, or the check below would pass for the wrong reason.
    const unguarded = Bun.spawnSync(
      ["bash", "-c", "recordings_enforce_identity_migration && echo INJECTED_WON"],
      { env: { ...process.env, ...injection } },
    );
    expect(unguarded.stdout.toString()).toContain("INJECTED_WON");

    // Sourcing the packaged guard after that import redefines the function, so the
    // packaged decision wins and the refusal still happens.
    const verdict = runGuardScript(
      "recordings_enforce_identity_migration 'local_only' '1' '0' '0' 'a' 'b' '' ''",
      injection,
    );
    expect(verdict.exitCode).not.toBe(0);
    expect(verdict.stderr).toContain("not mutually compatible");

    const installed = runInstallerPreflight({
      artifactPolicy: "release",
      extraArguments: ["--allow-adhoc-identity-migration"],
      environment: injection,
    });
    expect(installed.exitCode).toBe(2);
    expect(installed.stderr).toContain("not valid for a release artifact");
  });

  test("the installer refuses the ad-hoc approval for a release artifact", () => {
    const result = runInstallerPreflight({
      artifactPolicy: "release",
      extraArguments: ["--allow-adhoc-identity-migration"],
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not valid for a release artifact");
    // The release flag pair remains accepted for release, so the check is specific to the
    // ad-hoc approval rather than rejecting every migration flag.
    const releaseFlags = runInstallerPreflight({
      artifactPolicy: "release",
      extraArguments: [
        "--allow-signing-identity-migration",
        "--expected-old-identity-sha256", OLD_DIGEST,
        "--expected-new-identity-sha256", NEW_DIGEST,
      ],
    });
    expect(releaseFlags.stderr).not.toContain("not valid for a release artifact");
  });

  test("the guard file is a plain sourced contract with no side effects", () => {
    const guard = readRepositoryFile(IDENTITY_GUARD_RELATIVE_PATH);
    // Sourced into the installer's own shell: a top-level command, `exit`, or `set` here
    // would run in, or terminate, the installer process. No command substitution either —
    // the decision must be a pure function of its arguments so this file's table is the
    // whole behaviour.
    for (const forbidden of ["\nexit ", "\nset -", "\nrm ", "\ncodesign", "$("]) {
      expect(guard).not.toContain(forbidden);
    }
    expect(guard).toContain("recordings_enforce_identity_migration() {");
  });
});
