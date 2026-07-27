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
    // Listed literally rather than as `versionSites.length`, which compares the array to its own
    // source and so can never fail: dropping a site leaves the writer silently not writing it,
    // every remaining site still agrees, and the stale plist key is exactly the defect this file
    // exists to prevent. A mutation that deletes the CFBundleVersion entry survived the length
    // form and is killed by this one.
    expect(readings.map((reading) => [reading.site.file, reading.site.label])).toEqual([
      ["package.json", "package.json version"],
      ["src/version.ts", "src/version.ts VERSION"],
      ["src/native/Recordings/RecordingsLib/Info.plist", "Info.plist CFBundleShortVersionString"],
      ["src/native/Recordings/RecordingsLib/Info.plist", "Info.plist CFBundleVersion"],
    ]);
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
    // The plist carries two sites in one file; both must land, not just the first. Asserted
    // positively, per key, by a literal pattern independent of `versionSites`: the earlier
    // `not.toContain("0.0.1")` form was satisfied by a key that was never written at all, so it
    // survived the dropped-site mutation it was there to catch.
    const plist = readFileSync(
      join(root, "src/native/Recordings/RecordingsLib/Info.plist"),
      "utf8",
    );
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
      expect(match?.[1]).toBe("9.8.7");
    }
  });

  test("rejects versions the release path already refuses", () => {
    expect(() => assertReleaseVersion("v1.2.3")).toThrow(/invalid release version/);
    expect(() => assertReleaseVersion("1.2")).toThrow(/invalid release version/);
    // Binds the trailing anchor. `v1.2.3` only binds the leading one and `1.2` only binds arity,
    // so deleting `$` from the pattern left both green while junk-suffixed versions were accepted.
    expect(() => assertReleaseVersion("1.2.3.4")).toThrow(/invalid release version/);
    expect(assertReleaseVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });

  // `version:check` in prepack was previously unasserted by anything: the only prepack needle in
  // the repo is native-release-build-hardening-contract's `toStartWith`, which this PR's original
  // ordering broke outright. build:native-fs-guard has to stay first -- it is the fail-closed
  // macOS gate, and nothing may run ahead of it -- so the version check goes immediately after it
  // and still short-circuits before the expensive `bun run build`.
  test("prepack checks the version sites after the platform gate and before the build", () => {
    const steps = packageJson.scripts.prepack.split(" && ");

    expect(steps[0]).toBe("bun run build:native-fs-guard");
    expect(steps.indexOf("bun run version:check")).toBeGreaterThan(-1);
    expect(steps.indexOf("bun run build")).toBeGreaterThan(-1);
    expect(steps.indexOf("bun run version:check")).toBeLessThan(steps.indexOf("bun run build"));
  });
});
