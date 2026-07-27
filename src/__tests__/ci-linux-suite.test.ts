import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  QUARANTINE_FILE,
  compareDiscovery,
  executedFilesFromJUnit,
  isCompleteJUnit,
  parseQuarantine,
  partition,
  testFilesFromGit,
  testFilesFromWalk,
} from "../../scripts/ci-linux-suite";

/**
 * Contract test for the CI partition.
 *
 * The partition decides WHAT THE LINUX GATE RUNS, so a defect in it is not a broken script — it is
 * a green check over a set nobody chose. Most of these tests therefore assert a FAILURE: that the
 * partition rejects a stale exemption, that it refuses to hand back an empty gated set, and that
 * the after-the-fact run check notices a run that did not honour the split. A partition verified
 * only on inputs it accepts proves nothing about the one job it has.
 */
const repoRoot = join(import.meta.dir, "..", "..");

describe("parseQuarantine", () => {
  test("drops comments and blank lines and trims each entry", () => {
    expect(
      parseQuarantine("# reason\n\n  src/a.test.ts  \n\n# another\nsrc/b.test.ts\n"),
    ).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });

  test("an all-comment file yields no exemptions rather than one empty-string exemption", () => {
    // An empty-string entry would match nothing discovered and so would fail `partition` with a
    // confusing message about a file called "".
    expect(parseQuarantine("# nothing quarantined\n\n")).toEqual([]);
  });
});

describe("partition", () => {
  const discovered = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"];

  test("gated is everything not quarantined", () => {
    expect(partition(discovered, ["src/b.test.ts"])).toEqual({
      gated: ["src/a.test.ts", "src/c.test.ts"],
      quarantined: ["src/b.test.ts"],
    });
  });

  test("rejects an entry that names no discovered file, which is how a rename goes stale", () => {
    // The whole anti-rot property: `src/b.test.ts` was renamed, so its exemption now protects
    // nothing while still reading like a deliberate exclusion. This must throw, not silently
    // shrink the quarantine to the entries that happen to still resolve.
    expect(() => partition(discovered, ["src/renamed-away.test.ts"])).toThrow(
      /is not a discovered test file/,
    );
  });

  test("rejects a duplicated entry", () => {
    expect(() => partition(discovered, ["src/a.test.ts", "src/a.test.ts"])).toThrow(
      /more than once/,
    );
  });

  test("quarantining everything leaves an empty gated set, which the caller must refuse", () => {
    // `partition` itself reports the empty set faithfully; refusing it is the CLI's job. Pinning
    // the value here is what makes that refusal testable at all.
    expect(partition(discovered, discovered).gated).toEqual([]);
  });
});

describe("executedFilesFromJUnit", () => {
  /**
   * Trimmed from a real `bun test --reporter=junit` report on bun 1.3.14, including the nested
   * `<testsuite>` that repeats the `file=` attribute — a naive count would report that file twice.
   */
  const report = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test" tests="13" failures="0" time="0.03">',
    '  <testsuite name="src/__tests__/version.test.ts" file="src/__tests__/version.test.ts" tests="1">',
    '    <testsuite name="VERSION" file="src/__tests__/version.test.ts" line="5" tests="1">',
    '      <testcase name="matches package.json" classname="VERSION" file="src/__tests__/version.test.ts" line="6"/>',
    "    </testsuite>",
    "  </testsuite>",
    '  <testsuite name="src/__tests__/types.test.ts" file="src/__tests__/types.test.ts" tests="12"/>',
    "</testsuites>",
  ].join("\n");

  test("reads the executed set and deduplicates the repeated file attribute", () => {
    expect(executedFilesFromJUnit(report)).toEqual([
      "src/__tests__/types.test.ts",
      "src/__tests__/version.test.ts",
    ]);
  });

  test("a truncated report is not mistaken for a small one", () => {
    // A job timeout kills bun mid-write. Without the completeness check, the surviving prefix names
    // fewer suites and reads exactly like a run that had fewer suites to name — so the gate would
    // report a partial run as a clean one.
    const truncated = report.slice(0, report.indexOf("</testsuites>"));
    expect(isCompleteJUnit(report)).toBe(true);
    expect(isCompleteJUnit(truncated)).toBe(false);
    // The truncated prefix still parses, which is precisely why the separate check is needed.
    expect(executedFilesFromJUnit(truncated).length).toBeGreaterThan(0);
  });

  test("ignores file attributes that are not test files", () => {
    expect(executedFilesFromJUnit('<testcase file="scripts/helper.ts"/>')).toEqual([]);
  });
});

describe("the committed quarantine list", () => {
  const discovered = testFilesFromGit(repoRoot);
  const entries = parseQuarantine(readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8"));

  test("no tracked suite is missing from disk", () => {
    // Asserted in this direction only, and on purpose. The other direction — a file on disk that
    // git does not know about — is a suite somebody is writing right now on a developer machine,
    // and failing the whole local suite for that is how a check gets deleted. CI enforces the
    // symmetric version, where the checkout is exactly the tracked tree; see `loadPartition`.
    expect(compareDiscovery(discovered, testFilesFromWalk(repoRoot)).trackedNotOnDisk).toEqual([]);
  });

  test("compareDiscovery separates the two directions rather than reporting one disagreement", () => {
    expect(compareDiscovery(["a.test.ts", "b.test.ts"], ["b.test.ts", "c.test.ts"])).toEqual({
      trackedNotOnDisk: ["a.test.ts"],
      onDiskUntracked: ["c.test.ts"],
    });
  });

  test("every entry still names a discovered suite", () => {
    expect(() => partition(discovered, entries)).not.toThrow();
  });

  test("every entry carries a reason comment above it", () => {
    // An entry without a stated reason cannot be told apart from a suite muted to get a green
    // check, which is the failure mode this whole file exists to prevent.
    const lines = readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8").split("\n");
    for (const entry of entries) {
      const at = lines.findIndex((line) => line.trim() === entry);
      expect(at, `entry not found in ${QUARANTINE_FILE}: ${entry}`).toBeGreaterThan(-1);
      const previous = lines[at - 1]?.trim() ?? "";
      expect(
        previous.startsWith("#") && previous.length > 1,
        `${entry} has no reason comment on the line above it`,
      ).toBe(true);
    }
  });

  test("the gate covers strictly more than it excludes", () => {
    // Not a coverage target, a sanity floor: if the quarantine ever outgrew the gated set, the
    // honest response is to fix the environment, not to keep calling the remainder a gate.
    const { gated } = partition(discovered, entries);
    expect(gated.length).toBeGreaterThan(entries.length);
  });
});
