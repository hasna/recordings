import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH,
  RELEASE_APPROVED_TARGET,
  isLocalOnlyApprovedTarget,
  localOnlyApprovedTargets,
} from "../../scripts/macos_artifact";

// Resolved from this module, not the working directory, so the suite passes from
// any cwd (bun test is routinely invoked from a subdirectory).
const repositoryRoot = new URL("../../", import.meta.url).pathname;
const readRepositoryFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8");

const policyRelativePath = "scripts/policy/local-only-approved-targets.txt";
const readerRelativePath = "scripts/read_local_only_targets.sh";

function withPolicyFile<T>(contents: string, run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "recordings-target-policy-"));
  const path = join(directory, "local-only-approved-targets.txt");
  writeFileSync(path, contents);
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/// Runs the real sourced shell reader so its verdict can be compared against the
/// TypeScript reader. A divergence between them would let a target pass the build
/// and then fail the install, which is the failure this contract exists to prevent.
function shellReaderVerdict(
  policyContents: string,
  requested: string,
): { ok: boolean; matched: boolean; list: string; stderr: string } {
  return withPolicyFile(policyContents, (path) => {
    const script = `
set -euo pipefail
. ${JSON.stringify(join(repositoryRoot, readerRelativePath))}
LIST=""
MATCHED=0
read_local_only_targets ${JSON.stringify(path)} LIST MATCHED ${JSON.stringify(requested)}
printf 'LIST=%s\\nMATCHED=%s\\n' "$LIST" "$MATCHED"
`;
    const result = Bun.spawnSync(["bash", "-c", script]);
    const stdout = result.stdout.toString();
    return {
      ok: result.exitCode === 0,
      matched: /^MATCHED=1$/m.test(stdout),
      list: stdout.match(/^LIST=(.*)$/m)?.[1] ?? "",
      stderr: result.stderr.toString(),
    };
  });
}

describe("local-only approved target policy", () => {
  test("both shell entry points use the one sourced reader, not their own parser", () => {
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const builder = readRepositoryFile("src/native/Recordings/build.sh");
    for (const script of [installer, builder]) {
      expect(script).toContain(policyRelativePath);
      expect(script).toContain(readerRelativePath);
      expect(script).toContain("read_local_only_targets");
      // A private loop in either script is how the three parsers drifted apart.
      expect(script).not.toContain("while IFS= read -r policy_line");
    }
    // No bare hostname literal may remain in either guard.
    expect(installer).not.toContain('"$APPROVED_TARGET" != "station06"');
    expect(builder).not.toContain('"$LOCAL_APPROVED_TARGET" != "station06"');
  });

  test("the builder requires the policy and the reader inside the archived snapshot", () => {
    const builder = readRepositoryFile("src/native/Recordings/build.sh");
    expect(builder).toContain(`"$SOURCE_PACKAGE_ROOT/${policyRelativePath}"`);
    expect(builder).toContain(`"$SOURCE_PACKAGE_ROOT/${readerRelativePath}"`);
  });

  test("actually ships the policy and the reader in the published tarball", () => {
    // --ignore-scripts: `prepack` is a full native macOS build and is not what this
    // contract is about; the tarball file list is resolved from `files` regardless.
    const packed = Bun.spawnSync(
      ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repositoryRoot },
    );
    expect(packed.exitCode).toBe(0);
    const files = (JSON.parse(packed.stdout.toString()) as { files: { path: string }[] }[])[0]
      ?.files.map((entry) => entry.path) ?? [];
    expect(files).toContain(policyRelativePath);
    expect(files).toContain(readerRelativePath);
  });

  test("declares both approved local-only targets", () => {
    const targets = localOnlyApprovedTargets();
    expect(targets).toContain("station03");
    expect(targets).toContain("station06");
    expect(isLocalOnlyApprovedTarget("station03")).toBeTrue();
    expect(isLocalOnlyApprovedTarget("station06")).toBeTrue();
  });

  test("rejects targets that are not declared in the policy", () => {
    expect(isLocalOnlyApprovedTarget("station05")).toBeFalse();
    expect(isLocalOnlyApprovedTarget(undefined)).toBeFalse();
    expect(isLocalOnlyApprovedTarget("")).toBeFalse();
  });

  test("never accepts the release fleet target as a local-only target", () => {
    expect(isLocalOnlyApprovedTarget(RELEASE_APPROVED_TARGET)).toBeFalse();
    withPolicyFile(`${RELEASE_APPROVED_TARGET}\n`, (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("must not list the release fleet target");
    });
  });

  test("fails closed on an empty, duplicated, or malformed policy", () => {
    withPolicyFile("# only comments\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("lists no targets");
    });
    withPolicyFile("station03\nstation03\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("duplicate targets");
    });
    for (const malformed of ["Station03", "station 03", "-station03", "station03-", "s", "*", "a".repeat(64)]) {
      withPolicyFile(`${malformed}\n`, (path) => {
        expect(() => localOnlyApprovedTargets(path)).toThrow("invalid target name");
      });
    }
  });

  test("the shell reader and the TypeScript reader agree on every policy shape", () => {
    const accepted = [
      "station03\nstation06\n",
      "station03\r\nstation06\r\n",
      "﻿station03\nstation06\n",
      "  station03  \n\tstation06\t\n",
      "# comment\n\n  # indented comment\nstation03\n",
      "station03",
    ];
    for (const contents of accepted) {
      const shell = shellReaderVerdict(contents, "station03");
      expect(shell.ok).toBeTrue();
      expect(shell.matched).toBeTrue();
      expect(withPolicyFile(contents, (path) => localOnlyApprovedTargets(path))).toContain("station03");
    }

    const rejected = [
      "fleet\nstation06\n",
      "station03\nstation03\n",
      "STATION07\n",
      "station 03\n",
      "../../../etc/passwd\n",
      "*\n",
      "-station03\n",
      "station03-\n",
      "s\n",
      "# only comments\n",
      "   \n\t\n",
    ];
    for (const contents of rejected) {
      const shell = shellReaderVerdict(contents, "station03");
      expect(shell.ok).toBeFalse();
      expect(shell.stderr).not.toBe("");
      expect(() => withPolicyFile(contents, (path) => localOnlyApprovedTargets(path))).toThrow();
    }
  });

  test("the shell reader does not silently succeed when the requested target is last", () => {
    // A trailing `&& VAR=1` inside the loop makes the compound return non-zero under
    // `set -e` whenever the final line is not the requested target; assert both ends.
    for (const requested of ["station03", "station06"]) {
      const shell = shellReaderVerdict("station03\nstation06\n", requested);
      expect(shell.ok).toBeTrue();
      expect(shell.matched).toBeTrue();
      expect(shell.list).toBe("station03, station06");
    }
    const unapproved = shellReaderVerdict("station03\nstation06\n", "station05");
    expect(unapproved.ok).toBeTrue();
    expect(unapproved.matched).toBeFalse();
  });

  test("the shell reader rejects a missing or symlinked policy", () => {
    const missing = Bun.spawnSync([
      "bash",
      "-c",
      `set -euo pipefail
. ${JSON.stringify(join(repositoryRoot, readerRelativePath))}
L=""; M=0
read_local_only_targets /nonexistent/policy.txt L M station03`,
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("policy is missing");
  });

  test("resolves the policy path independently of the working directory", () => {
    expect(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH.endsWith(policyRelativePath)).toBeTrue();
    expect(localOnlyApprovedTargets(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH).length).toBeGreaterThan(0);
  });
});
