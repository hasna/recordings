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
    // Record correction: #39's commit message says it "replaced a substring grep" with the
    // argument-vector parser below. It did not -- `git diff --numstat` for that commit on this
    // file is 139 insertions and ZERO deletions, and this is the grep, still live. The parser
    // was added ALONGSIDE it. The effect is structural supersession, so the assertion is now
    // redundant rather than wrong, and it is kept only as a cheap presence check. Anyone
    // auditing this later should not go looking for a deletion that never happened.
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

  // The guard itself is a pure function of eight positional arguments and is covered
  // above. What was covered by nothing is the CALL: an eight-slot unnamed positional
  // contract pinned only by `toContain("recordings_enforce_identity_migration \\")`. That
  // substring survives every semantic corruption of the call — hardcoding a policy,
  // hardcoding an approval to "0", swapping the two approval arguments, swapping the two
  // digest arguments, prefixing the call with a policy condition, or discarding its verdict
  // with `|| true`. Each of those was measured as a survivor.
  //
  // So parse the invocation instead of grepping for it: join its backslash continuations
  // into one logical line and assert the argument VECTOR, in order, plus the terminator.
  // This is the same technique the Swift-interpolation renderer in trigger-diagnosis.test.ts
  // uses — structure rather than substring.
  //
  // Stated plainly, because it is the difference between this and a proof: reading the
  // call site is not the same as executing it. This does not demonstrate the guard runs
  // during a real install; the one test that would is in macos-app-lifecycle.test.ts,
  // which is 92 of 140 red on `main` on Linux and cannot serve as a gate here.
  const identityGuardInvocation = (): { argv: string[]; terminator: string } => {
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const lines = installer.split("\n");
    const starts = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trimStart().startsWith("recordings_enforce_identity_migration"));
    // A second invocation, or one nested under a condition, is exactly the reintroduction
    // this PR exists to prevent, so pin the count rather than taking the first match.
    expect(starts.length).toBe(1);
    const start = starts[0]!;
    // Nothing may precede the call on its own logical line: `[ "$ARTIFACT_POLICY" = ... ] &&`
    // in front of it re-conjoins the gate to one policy while every substring still matches.
    expect(start.line).toBe(`recordings_enforce_identity_migration \\`);

    let logical = "";
    for (let index = start.index; index < lines.length; index += 1) {
      const line = lines[index]!;
      const continues = line.endsWith("\\");
      logical += (continues ? line.slice(0, -1) : line).trim() + " ";
      if (!continues) break;
    }
    const [call, ...terminatorParts] = logical.trim().split("||");
    const tokens = call!.trim().split(/\s+/);
    expect(tokens[0]).toBe("recordings_enforce_identity_migration");
    return {
      argv: tokens.slice(1),
      terminator: terminatorParts.length === 0 ? "" : `||${terminatorParts.join("||")}`.trim(),
    };
  };

  test("the installer passes the guard its eight arguments in the documented order", () => {
    const { argv } = identityGuardInvocation();
    // The order is the guard's whole contract and it is unnamed positionals, so a swap is
    // the single most likely real edit. The two approval slots and the two digest slots are
    // adjacent same-shaped values -- swapping either pair inverts the release/ad-hoc
    // separation the script header calls "distinct on purpose", and neither swap changes
    // any substring in the file.
    expect(argv).toEqual([
      '"$ARTIFACT_POLICY"',
      '"$identity_migration"',
      '"$ALLOW_IDENTITY_MIGRATION"',
      '"$ALLOW_ADHOC_IDENTITY_MIGRATION"',
      '"$previous_identity_sha256"',
      '"$candidate_identity_sha256"',
      '"$EXPECTED_OLD_IDENTITY_SHA256"',
      '"$EXPECTED_NEW_IDENTITY_SHA256"',
    ]);
  });

  test("the installer aborts on the guard's refusal instead of discarding it", () => {
    // `|| true` leaves the guard running, printing its refusal to stderr, and the install
    // proceeding anyway -- the worst of the measured survivors, because the diagnostic
    // still looks correct in the log.
    expect(identityGuardInvocation().terminator).toBe("|| exit 1");
  });

  test("the computed migration flag is set, not hardcoded, by the requirement comparison", () => {
    // `identity_migration=1` -> `=0` in the comparison loop feeds the guard a permanently
    // clean input, so it always allows: an empty search space reading identical to a clean
    // result. Pin both the initialization and the one place the comparison raises it.
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const assignments = installer
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^identity_migration=/.test(line));
    expect(assignments).toEqual(["identity_migration=0", "identity_migration=1"]);
  });

  test("every use of the migration flag is one the design accounts for", () => {
    // `/^identity_migration=/` above sees a plain assignment line and nothing else. Two
    // measured EXIT=0 evasions write the flag without matching it, and both zero it after
    // the comparison loop has raised it:
    //
    //   declare identity_migration=0        -- a declaration, not an assignment line
    //   : $((identity_migration = 0))       -- arithmetic assignment
    //
    // Enumerating every mention and pinning the exact set is stronger than adding those two
    // shapes to a pattern, because it does not depend on having thought of the shapes: any
    // new line touching this flag fails here and has to be argued for. A shell script has no
    // parser available to this suite, so an exact-set tripwire is the structural option.
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const uses = installer
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\bidentity_migration\b/.test(line));
    expect(uses).toEqual([
      "identity_migration=0",
      "identity_migration=1",
      '"$identity_migration" \\',
      'if [ "$identity_migration" -eq 1 ]; then',
      'elif [ "$identity_migration" -eq 1 ]; then',
    ]);
  });

  test("the guard is called after the comparison that computes its input, not before it", () => {
    // Moving the call's nine lines VERBATIM -- zero character changes -- to above the
    // comparison loop defeats every assertion in this file at EXIT=0, and defeats all 116
    // usable tests in the repo. Nothing here was ever about POSITION: `starts.length` stays
    // 1, the argument vector is byte-identical, the terminator is still `|| exit 1`, and the
    // two assignment lines never moved. The loop still raises the flag; nothing enforces it;
    // the install proceeds and voids the grants. It is a plausible refactor ("gate earlier,
    // fail fast"), and the only things that could catch it were a human noticing the
    // orphaned comment left behind, or macos-app-lifecycle.test.ts -- which is 92 of 140 red
    // on `main` on Linux and cannot serve as a gate.
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const lines = installer.split("\n");
    const initialize = lines.findIndex((line) => line.trim() === "identity_migration=0");
    const raise = lines.findIndex((line) => line.trim() === "identity_migration=1");
    const call = lines.findIndex((line) =>
      line.trimStart().startsWith("recordings_enforce_identity_migration"),
    );
    for (const [label, index] of [
      ["the flag's initialization", initialize],
      ["the comparison that raises the flag", raise],
      ["the guard invocation", call],
    ] as const) {
      expect(index, `${label} is missing entirely`).toBeGreaterThan(-1);
    }
    // The loop's `done` closes the search space. Before it, the flag is still being
    // computed, so a guard reading it there reads a partial answer -- and an empty search
    // space reads identical to a clean result.
    const loopEnd = lines.findIndex((line, index) => index > raise && line.trim() === "done");
    expect(loopEnd, "the comparison loop's `done` is missing").toBeGreaterThan(raise);
    expect(initialize).toBeLessThan(raise);
    expect(loopEnd).toBeLessThan(call);

    // And nothing in the gap may stub the guard out. `eval` is called out by name because
    // `eval 'recordings_enforce_identity_migration() { return 0; }'` evades the
    // `starts.length` count above: that filter uses `startsWith`, and the line starts with
    // `eval`, so the stub is never counted as an invocation.
    const between = lines.slice(loopEnd + 1, call).join("\n");
    expect(between).not.toMatch(/\beval\b/);
    expect(installer).not.toMatch(/\beval\b[^\n]*recordings_enforce_identity_migration/);
    // The installer sources the packaged guard; it must not define its own.
    expect(installer).not.toMatch(/recordings_enforce_identity_migration\s*\(\s*\)\s*\{/);
  });

  // A gate whose only escape hatch is undiscoverable is an outage, not a safeguard. This
  // guard turns what used to be a warn-and-proceed local-only reinstall into exit 1, and
  // every ad-hoc rebuild changes the CDHash, so the approval flag is on the routine repair
  // path rather than an exotic one. Before this PR the flag appeared in no usage output, no
  // README text, and -- worst -- not in the `recordings app install` wrapper at all, which
  // is the only install path the README documents. It was reachable solely by invoking the
  // shell script directly after reading the refusal on stderr.
  describe("the ad-hoc approval flag is discoverable", () => {
    const flag = "--allow-adhoc-identity-migration";

    test("the installer prints usage naming the flag, and exits 0", () => {
      const result = Bun.spawnSync([
        "bash",
        join(repositoryRoot, "scripts/install_macos_app.sh"),
        "--help",
      ]);
      expect(result.exitCode).toBe(0);
      const usage = result.stdout.toString();
      expect(usage).toContain("Usage: install_macos_app.sh");
      expect(usage).toContain(flag);
      // The consequence, not just the spelling: an operator reading this has to learn that
      // approving the replacement is what costs them the grants.
      expect(usage).toContain("Microphone");
      expect(usage).toContain("Accessibility");
    });

    test("an unrecognized argument points at the usage output", () => {
      // Pinned because the pre-existing negative test elsewhere asserts only the
      // "Unknown argument" prefix, which a rewrite could satisfy while dropping the hint.
      const result = Bun.spawnSync([
        "bash",
        join(repositoryRoot, "scripts/install_macos_app.sh"),
        "--not-a-real-flag",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("--help");
    });

    test("the recordings CLI declares the flag and forwards it to the installer", () => {
      // Declaring it without forwarding it, or forwarding it without declaring it, both
      // leave the flag unusable through the documented path while a grep for the name
      // still succeeds -- so assert both halves.
      //
      // The FORWARDING half is all this test ever enforced, and it says so now rather than
      // implying otherwise: `toContain('"<flag>"')` is wholly subsumed by the
      // `installerArgs.push("<flag>")` assertion below it, because that line contains the
      // same quoted literal. The declaration half is pinned behaviourally in the next test.
      const cli = readRepositoryFile("src/cli/index.ts");
      expect(cli).toContain(`installerArgs.push("${flag}")`);
      expect(cli).toContain("allowAdhocIdentityMigration");
    });

    test("the recordings CLI's own --help offers the flag, not just its source text", () => {
      // This is the surface whose absence was the ORIGINAL finding, and it was the one
      // surface of the four still unpinned. Deleting the four-line commander `.option()`
      // block left this suite at EXIT=0: `toContain('"<flag>"')` was satisfied by the
      // forwarding line's own literal, and `toContain("allowAdhocIdentityMigration")` by the
      // options type and the `opts.` read, both of which survive the deletion. With the
      // declaration gone commander rejects the flag as an unknown option, so
      // `recordings app install` cannot pass it -- the exact pre-#39 state, suite green.
      // Runbook k_ms3hpbyj_50m0tr documents that wrapper invocation as the repair path, so
      // this is the surface that matters operationally.
      //
      // Asserted behaviourally rather than as text: commander's generated help is the
      // artifact an operator actually reads, and it exists only if the option is declared.
      // That is also reformat-proof, which `.option(\n  "<flag>",` is not.
      const home = mkdtempSync(join(tmpdir(), "rec-adhoc-help-"));
      try {
        const result = Bun.spawnSync(
          ["bun", "run", join(repositoryRoot, "src/cli/index.ts"), "app", "install", "--help"],
          {
            cwd: repositoryRoot,
            // `--help` exits before any command action runs, so nothing here reaches the
            // network. Sandboxed anyway because HOME alone does NOT sandbox this CLI: the
            // API URL and key come from the process environment, and a review demo that
            // assumed otherwise made an authenticated call to production.
            env: {
              ...process.env,
              HOME: home,
              HASNA_RECORDINGS_API_URL: "",
              HASNA_RECORDINGS_API_KEY: "",
            },
          },
        );
        expect(result.exitCode).toBe(0);
        const help = result.stdout.toString();
        expect(help).toContain("Usage: recordings app install");
        expect(help).toContain(flag);
        // The consequence, in the operator-facing surface: the help has to say what
        // approving costs, not merely that a flag exists.
        expect(help).toContain("Microphone");
        expect(help).toContain("Accessibility");
        // Positive control on the absence claim. A help output that lost EVERY option would
        // otherwise satisfy nothing above by simply being empty; the sibling flag's
        // declaration is untouched by any mutation of this one.
        expect(help).toContain("--allow-signing-identity-migration");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("the README documents the flag on the local-only install path", () => {
      const readme = readRepositoryFile("README.md");
      expect(readme).toContain(flag);
    });
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
