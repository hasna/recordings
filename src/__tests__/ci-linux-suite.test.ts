import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  QUARANTINE_FILE,
  compareDiscovery,
  entriesMissingReason,
  executedFilesFromJUnit,
  isCompleteJUnit,
  suiteSkips,
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

describe("entriesMissingReason", () => {
  test("accepts an entry with a reason: marker directly above it", () => {
    expect(entriesMissingReason("# reason: BSD stat -f\nsrc/a.test.ts\n")).toEqual([]);
  });

  test("rejects an entry with no comment above it", () => {
    // The list is empty today, so this synthetic input is the ONLY thing that proves the check
    // fires. Asserting it against the committed file would pass over zero entries and prove nothing.
    expect(entriesMissingReason("src/a.test.ts\n")).toEqual(["src/a.test.ts"]);
  });

  test("rejects an entry explained only by the file's prose header", () => {
    // The regression that motivated the marker. An earlier version accepted any line starting with
    // '#', so appending an entry to the end of the explanatory header at the top of the file passed
    // with no reason of its own. The negative control caught it; reading the code had not.
    expect(
      entriesMissingReason("# TO ADD AN ENTRY: one path per line, with a reason.\nsrc/a.test.ts\n"),
    ).toEqual(["src/a.test.ts"]);
  });

  test("rejects an entry separated from its reason by a blank line", () => {
    // A blank line means the comment above documents the section rather than this entry, and the
    // next person adding a line underneath inherits a reason that was never about their suite.
    expect(entriesMissingReason("# reason: BSD stat -f\n\nsrc/a.test.ts\n")).toEqual([
      "src/a.test.ts",
    ]);
  });

  test("rejects a reason: marker with nothing after it", () => {
    expect(entriesMissingReason("# reason:\nsrc/a.test.ts\n")).toEqual(["src/a.test.ts"]);
  });

  test("reports only the unexplained entry when a sibling is fine", () => {
    expect(entriesMissingReason("# reason: why\nsrc/a.test.ts\nsrc/b.test.ts\n")).toEqual([
      "src/b.test.ts",
    ]);
  });
});

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

describe("suiteSkips", () => {
  /** Both encodings bun actually emits: a self-closing case, and one wrapping `<skipped />`. */
  const report = [
    '<testsuites name="bun test" tests="3" skipped="1">',
    '  <testcase name="a" file="src/x.test.ts" line="1" assertions="5" />',
    '  <testcase name="b" file="src/x.test.ts" line="2" assertions="0">',
    "    <skipped />",
    "  </testcase>",
    '  <testcase name="c" file="src/y.test.ts" line="1" assertions="0">',
    "    <skipped />",
    "  </testcase>",
    "</testsuites>",
  ].join("\n");

  test("counts tests and skips per file", () => {
    expect(suiteSkips(report)).toEqual([
      { file: "src/x.test.ts", total: 2, skipped: 1 },
      { file: "src/y.test.ts", total: 1, skipped: 1 },
    ]);
  });

  test("does not attribute a following skip to a self-closed case", () => {
    // The bug this guards: scanning past a self-closing `/>` finds the NEXT case's `<skipped />` and
    // marks a passing test as skipped, which would report healthy suites as hollow and get the whole
    // warning ignored.
    expect(suiteSkips(report).find((s) => s.file === "src/x.test.ts")?.skipped).toBe(1);
  });

  test("identifies a suite that ran only skipped tests", () => {
    // The hole this exists for: such a file still emits `file=`, so it counts as executed and the
    // partition check reports full coverage while the suite asserts nothing.
    const hollow = suiteSkips(report).filter((s) => s.total > 0 && s.skipped === s.total);
    expect(hollow.map((s) => s.file)).toEqual(["src/y.test.ts"]);
  });

  test("ignores non-test files", () => {
    expect(suiteSkips('<testcase name="a" file="scripts/x.ts" />')).toEqual([]);
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

  test("carries no unexplained entry", () => {
    expect(entriesMissingReason(readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8"))).toEqual([]);
  });

  test("partitions the discovered suites exactly, losing none", () => {
    // The invariant, asserted instead of the emptiness. An earlier version pinned
    // `expect(entries).toEqual([])`, which meant ADDING a quarantine entry failed the gated suite --
    // a booby trap for the next person following the file's own "TO ADD AN ENTRY" instructions.
    const { gated, quarantined } = partition(discovered, entries);
    expect([...gated, ...quarantined].sort()).toEqual([...discovered].sort());
    expect(gated.length + quarantined.length).toBe(discovered.length);
  });
});
