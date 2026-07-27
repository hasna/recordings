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

const policyRelativePath = "scripts/policy/local-only-approved-targets.txt";

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

describe("local-only approved target policy", () => {
  test("is the single source of truth shared by both shell entry points", () => {
    const installer = readFileSync("scripts/install_macos_app.sh", "utf8");
    const builder = readFileSync("src/native/Recordings/build.sh", "utf8");
    for (const script of [installer, builder]) {
      expect(script).toContain(policyRelativePath);
    }
    // A bare hostname literal in either guard would silently diverge from the policy
    // file, which is exactly the drift that blocked earlier station03 installs.
    expect(installer).not.toContain('"$APPROVED_TARGET" != "station06"');
    expect(builder).not.toContain('"$LOCAL_APPROVED_TARGET" != "station06"');
  });

  test("the builder requires the policy file inside the archived source snapshot", () => {
    const builder = readFileSync("src/native/Recordings/build.sh", "utf8");
    expect(builder).toContain(`"$SOURCE_PACKAGE_ROOT/${policyRelativePath}"`);
  });

  test("ships the policy file inside the published package", () => {
    const packaged = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(packaged.files.some((entry) => "scripts/".startsWith(entry) || entry === "scripts/"))
      .toBeTrue();
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

  test("ignores comments and blank lines", () => {
    withPolicyFile("# comment\n\n  station03  \n\n# station99\n", (path) => {
      expect(localOnlyApprovedTargets(path)).toEqual(["station03"]);
    });
  });

  test("fails closed on an empty, duplicated, or malformed policy", () => {
    withPolicyFile("# only comments\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("lists no targets");
    });
    withPolicyFile("station03\nstation03\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("duplicate targets");
    });
    for (const malformed of ["Station03", "station 03", "-station03", "station03-", "s", "a".repeat(64)]) {
      withPolicyFile(`${malformed}\n`, (path) => {
        expect(() => localOnlyApprovedTargets(path)).toThrow("invalid target name");
      });
    }
  });

  test("resolves the policy path independently of the working directory", () => {
    expect(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH.endsWith(policyRelativePath)).toBeTrue();
    expect(localOnlyApprovedTargets(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH).length).toBeGreaterThan(0);
  });
});
