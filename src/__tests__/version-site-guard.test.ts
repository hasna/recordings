import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import packageJson from "../../package.json";
import {
  applyVersion,
  assertReleaseVersion,
  checkVersionSites,
  repoRoot,
  versionSites,
} from "../../scripts/set-version";

// native-bundle-version.test.ts asserts the same agreement against literal
// patterns of its own; this file covers the writer that keeps the sites in sync
// and the reader used by `bun run version:check`.

// Copies only the version-bearing files so a bad write cannot touch the repo, then
// normalizes them to `version` so the fixture does not inherit the working tree's
// own version state.
function stageVersionSites(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "recordings-set-version-test-"));
  for (const file of new Set(versionSites.map((site) => site.file))) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(repoRoot(), file), "utf8"));
  }
  applyVersion(version, root);
  return root;
}

describe("release version sites", () => {
  test("agree in the working tree, on the version package.json declares", () => {
    const { expected, mismatched, readings } = checkVersionSites();

    expect(mismatched).toEqual([]);
    expect(expected).toBe(packageJson.version);
    expect(readings).toHaveLength(versionSites.length);
  });

  test("a single stale site is reported rather than silently accepted", () => {
    const root = stageVersionSites("0.0.1");
    const stale = versionSites[versionSites.length - 1];
    const path = join(root, stale.file);
    writeFileSync(path, readFileSync(path, "utf8").replace(stale.pattern, "$10.0.0$3"));

    const { expected, mismatched } = checkVersionSites(root);

    expect(expected).toBe("0.0.1");
    expect(mismatched.map((reading) => reading.site.label)).toEqual([stale.label]);
  });

  test("applyVersion rewrites every site in one pass", () => {
    const root = stageVersionSites("0.0.1");

    applyVersion("9.8.7", root);

    const { expected, mismatched } = checkVersionSites(root);
    expect(expected).toBe("9.8.7");
    expect(mismatched).toEqual([]);
    // The plist carries two sites in one file; both must land, not just the first.
    expect(readFileSync(join(root, "src/native/Recordings/RecordingsLib/Info.plist"), "utf8"))
      .not.toContain("0.0.1");
  });

  test("rejects versions the release path already refuses", () => {
    expect(() => assertReleaseVersion("v1.2.3")).toThrow(/invalid release version/);
    expect(() => assertReleaseVersion("1.2")).toThrow(/invalid release version/);
    expect(assertReleaseVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });
});
