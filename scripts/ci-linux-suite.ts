#!/usr/bin/env bun
/**
 * Partition the `bun test` suite into the Linux-GATED set and the Linux-QUARANTINED set, and prove
 * afterwards that the run actually honoured the partition.
 *
 * Why this is a script with its own contract test rather than a glob in the workflow YAML:
 *
 *   A gate that names its files explicitly stops covering anything added after it was written, and
 *   a gate that silently narrows its own file list is the same vacuity class this repo spent a day
 *   closing in its assertions — a green check over almost nothing looks exactly like a green check
 *   over everything. So discovery is DYNAMIC (a new `*.test.ts` is gated the moment it lands) and
 *   the narrowing is verified after the fact against the runner's own output.
 *
 * Three independent facts are cross-checked, because any one of them alone can fail silently:
 *
 *   1. `git ls-files` and a filesystem walk must agree on the set of test files. A walker with a
 *      broken suffix check, or a suite that was never `git add`ed, shows up as a disagreement
 *      instead of as a quietly smaller gate.
 *   2. Every quarantine entry must name a DISCOVERED test file. A renamed or deleted suite cannot
 *      keep its exemption; the entry goes stale and `--check` fails.
 *   3. After the gated run, the number of files the runner reports must equal the gated count, and
 *      no quarantined file may appear as an executed file. `bun test` treats its positional
 *      arguments as SUBSTRING filters rather than paths, so "I passed it a list" is not evidence
 *      that it ran that list — only its own output is.
 *
 * Counts of passing/failing TESTS are deliberately never asserted. The suite is nondeterministic at
 * the margin (subprocess and FIFO timeouts), so any count is a flake generator; see
 * src/__tests__/helpers/source-assertions.ts. Only set membership and directions are gated.
 *
 * Usage:
 *   bun scripts/ci-linux-suite.ts --check                 validate the quarantine file, print counts
 *   bun scripts/ci-linux-suite.ts --gated                 newline-separated gated files
 *   bun scripts/ci-linux-suite.ts --quarantined           newline-separated quarantined files
 *   bun scripts/ci-linux-suite.ts --verify-run <log>      assert a gated run honoured the partition
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Repo-relative path of the quarantine list, relative to the repository root. */
export const QUARANTINE_FILE = ".github/linux-quarantine.txt";

const TEST_SUFFIX = ".test.ts";

/** Directories never worth walking. `.build` holds SwiftPM output, which can be enormous. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".build", "dist"]);

/**
 * Parse the quarantine list.
 *
 * Blank lines and `#` comments are dropped. Leading and trailing whitespace is stripped so a stray
 * indent cannot produce an entry that matches no discovered file and reads as a typo in the list
 * rather than as the misformatting it is.
 */
export function parseQuarantine(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Entries not directly preceded by a `# reason:` line.
 *
 * An exemption without a stated reason cannot be told apart from a suite somebody muted to get a
 * green check, which is the whole failure mode this file guards. Implemented in the script rather
 * than in the test so that it is enforced whenever an entry is ADDED — the list is currently empty,
 * and a check living only in a test runs against the list as it stands today.
 *
 * The marker is required rather than accepting any comment, and that is not pedantry: the first
 * version accepted "the line above starts with #", which the explanatory header at the top of the
 * file satisfies. Appending an entry to the end of that header therefore passed with no reason of
 * its own — found by running the negative control rather than by reading the code.
 */
const REASON_MARKER = /^#\s*reason:\s*\S/;

export function entriesMissingReason(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim());
  const missing: string[] = [];
  lines.forEach((line, index) => {
    if (line.length === 0 || line.startsWith("#")) return;
    if (!REASON_MARKER.test(lines[index - 1] ?? "")) missing.push(line);
  });
  return missing;
}

/**
 * Enumerate tracked test files with git.
 *
 * git is the authoritative enumeration in CI, where the checkout contains tracked files and
 * nothing else. It is also the one enumeration that cannot be fooled by a leftover build artifact
 * in the working tree.
 */
export function testFilesFromGit(repoRoot: string): string[] {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", `*${TEST_SUFFIX}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (${result.status}): ${result.stderr?.trim() ?? ""}`);
  }
  // -z because a path may legally contain a newline, and a newline-split enumeration would report
  // one such path as two missing files — a disagreement that reads as a broken walker.
  return result.stdout.split("\0").filter((path) => path.length > 0).sort();
}

/**
 * Enumerate test files by walking the filesystem.
 *
 * This exists purely as an independent second opinion on {@link testFilesFromGit}. It is not the
 * gate's source of truth; it is the thing that makes a wrong source of truth visible.
 */
export function testFilesFromWalk(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
        found.push(relative(repoRoot, absolute).split(sep).join("/"));
      }
    }
  };
  walk(repoRoot);
  return found.sort();
}

export type DiscoveryDisagreement = { trackedNotOnDisk: string[]; onDiskUntracked: string[] };

/**
 * Compare the two enumerations.
 *
 * The two directions are NOT symmetric, and treating them as one check is what made the first
 * version of this script unusable:
 *
 *   trackedNotOnDisk — always fatal. The index names a suite the checkout does not have, so the
 *     gated list contains a file the runner cannot run.
 *   onDiskUntracked  — fatal in CI ONLY. In CI the checkout is exactly the tracked tree, so an
 *     untracked suite means the enumeration itself is wrong. On a developer's machine it usually
 *     means a test being written right now, and failing the whole suite for that teaches people to
 *     delete the check rather than to commit the file.
 */
export function compareDiscovery(fromGit: string[], fromWalk: string[]): DiscoveryDisagreement {
  const gitSet = new Set(fromGit);
  const walkSet = new Set(fromWalk);
  return {
    trackedNotOnDisk: fromGit.filter((path) => !walkSet.has(path)),
    onDiskUntracked: fromWalk.filter((path) => !gitSet.has(path)),
  };
}

export type Partition = { gated: string[]; quarantined: string[] };

/**
 * Split `discovered` using `quarantined`.
 *
 * Throws when an entry names something that was not discovered, which is the anti-rot property:
 * the exemption list can only ever refer to suites that currently exist.
 */
export function partition(discovered: string[], quarantined: string[]): Partition {
  const discoveredSet = new Set(discovered);
  const seen = new Set<string>();
  for (const entry of quarantined) {
    if (!discoveredSet.has(entry)) {
      throw new Error(
        `${QUARANTINE_FILE} names "${entry}", which is not a discovered test file. ` +
          `If the suite was renamed or deleted, delete this line.`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`${QUARANTINE_FILE} lists "${entry}" more than once.`);
    }
    seen.add(entry);
  }
  return {
    gated: discovered.filter((path) => !seen.has(path)),
    quarantined: [...seen].sort(),
  };
}

/**
 * The set of test files a run actually executed, read from bun's JUnit report.
 *
 * WHY THE JUNIT REPORT AND NOT THE CONSOLE OUTPUT. Not because the console is empty — an earlier
 * version of this comment claimed a fully passing run prints only a summary, which is true when you
 * run bun in a terminal and FALSE on an Actions runner, where it emits a `##[group]<file>:` header
 * and a `(pass)` line per test. Asserting against a stream whose shape depends on the environment is
 * the problem; the JUnit report has one documented shape with a `file=` attribute per suite whether
 * or not anything failed.
 *
 * What makes the check load-bearing at all is measured bun behaviour that is genuinely surprising:
 * positional arguments are SUBSTRING FILTERS, not paths, so `bun test gen1` matched four files, and
 * `bun test src/nope.test.ts` on a path that does not exist EXITS 0 — it reports nothing to run and
 * succeeds. So "the command was given 56 paths and returned 0" is not evidence that 56 suites ran,
 * or that any did.
 *
 * Attributes are matched with a regex rather than a parser because the path set is already known to
 * be free of whitespace and XML metacharacters (`--check` enforces the whitespace half, and the
 * paths are repo-relative `*.test.ts`), so there is nothing for a parser to disambiguate.
 */
export function executedFilesFromJUnit(xml: string): string[] {
  const executed = new Set<string>();
  for (const match of xml.matchAll(/\bfile="([^"]+)"/g)) {
    const path = match[1];
    if (path?.endsWith(TEST_SUFFIX)) executed.add(path);
  }
  return [...executed].sort();
}

export type SuiteSkips = { file: string; total: number; skipped: number };

/**
 * Per-file test and skip counts from the JUnit report.
 *
 * Membership in the executed set is NOT the same as being asserted. bun emits a `file=` attribute for
 * a suite whose every test is `describe.skip`ped, so such a file counts as executed and the partition
 * check still reports "56 suites executed, exactly the 56 gated" while that suite asserts nothing.
 * Set equality cannot see that; only the skip counts can.
 *
 * A skipped case is `<testcase ...><skipped /></testcase>` while a real one self-closes, so each
 * `<testcase` chunk is inspected up to its terminator rather than the attributes being trusted —
 * the `skipped=` attribute appears on the enclosing `<testsuite>` at several nesting levels and
 * summing those double-counts.
 */
export function suiteSkips(xml: string): SuiteSkips[] {
  const counts = new Map<string, { total: number; skipped: number }>();
  for (const chunk of xml.split("<testcase").slice(1)) {
    const file = chunk.match(/\bfile="([^"]+)"/)?.[1];
    if (!file?.endsWith(TEST_SUFFIX)) continue;
    const body = chunk.split("</testcase>")[0] ?? chunk;
    const entry = counts.get(file) ?? { total: 0, skipped: 0 };
    entry.total += 1;
    // The self-closing form ends the element before any child could appear, so a `<skipped` found in
    // a self-closed chunk belongs to the NEXT case and must not be attributed here.
    if (!/^[^>]*\/>/.test(chunk) && /<skipped\b/.test(body)) entry.skipped += 1;
    counts.set(file, entry);
  }
  return [...counts.entries()]
    .map(([file, { total, skipped }]) => ({ file, total, skipped }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Whether the JUnit report is a complete one.
 *
 * A run killed by a job timeout can leave a truncated file behind. Without this, a truncated report
 * naming three suites looks identical to a run that only had three suites to name.
 */
export function isCompleteJUnit(xml: string): boolean {
  return /<testsuites\b/.test(xml) && /<\/testsuites>/.test(xml);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadPartition(repoRoot: string): Partition & { discovered: string[] } {
  const fromGit = testFilesFromGit(repoRoot);
  const { trackedNotOnDisk, onDiskUntracked } = compareDiscovery(fromGit, testFilesFromWalk(repoRoot));
  if (trackedNotOnDisk.length > 0) {
    fail(
      "The index names test files the checkout does not have, so the gated list contains files the " +
        `runner cannot run:\n${trackedNotOnDisk.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  if (onDiskUntracked.length > 0) {
    const detail = onDiskUntracked.map((path) => `  ${path}`).join("\n");
    // In CI the checkout IS the tracked tree, so this is a broken enumeration rather than
    // work in progress, and a smaller gate is exactly the failure that must not pass quietly.
    if (process.env.CI) {
      fail(`Untracked test files are invisible to the gate; commit or delete them:\n${detail}`);
    }
    console.error(`warning: untracked test files are not gated (local only):\n${detail}`);
  }
  if (fromGit.length === 0) {
    fail("Discovered zero test files. A gate over zero files is green for the wrong reason.");
  }
  const quarantineText = readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8");
  const unexplained = entriesMissingReason(quarantineText);
  if (unexplained.length > 0) {
    fail(
      `Every entry in ${QUARANTINE_FILE} needs a reason comment on the line directly above it. ` +
        `Without one an exemption is indistinguishable from a muted suite:\n` +
        unexplained.map((entry) => `  ${entry}`).join("\n"),
    );
  }
  let split: Partition;
  try {
    split = partition(fromGit, parseQuarantine(quarantineText));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (split.gated.length === 0) {
    fail(
      `Every discovered test file is quarantined by ${QUARANTINE_FILE}. The gate would run nothing.`,
    );
  }
  // The workflow expands `--gated` unquoted so the runner receives one argument per file, which is
  // only safe while no path contains whitespace. Asserting it here keeps that assumption in the
  // same place as the list, instead of leaving a shell-quoting bug to be discovered by a suite that
  // silently stopped being gated.
  const whitespace = split.gated.filter((path) => /\s/.test(path));
  if (whitespace.length > 0) {
    fail(
      "Test paths containing whitespace cannot be passed through unquoted word splitting:\n" +
        whitespace.map((path) => `  ${path}`).join("\n"),
    );
  }
  return { ...split, discovered: fromGit };
}

function main(argv: string[]): void {
  const repoRoot = process.cwd();
  if (!statSync(join(repoRoot, QUARANTINE_FILE), { throwIfNoEntry: false })) {
    fail(`Run this from the repository root; ${QUARANTINE_FILE} is not there.`);
  }
  const mode = argv[0];
  const { gated, quarantined, discovered } = loadPartition(repoRoot);

  if (mode === "--gated") {
    console.log(gated.join("\n"));
    return;
  }
  if (mode === "--quarantined") {
    console.log(quarantined.join("\n"));
    return;
  }
  if (mode === "--check") {
    console.log(
      `discovered ${discovered.length} test files: ${gated.length} gated, ` +
        `${quarantined.length} quarantined by ${QUARANTINE_FILE}`,
    );
    for (const entry of quarantined) console.log(`  quarantined: ${entry}`);
    return;
  }
  if (mode === "--verify-run") {
    const reportPath = argv[1];
    if (!reportPath) fail("usage: --verify-run <junit.xml>");
    // Reported as a verdict rather than as an exception. This step runs with `if: always()`, so it
    // is the step that speaks when the suite crashed before writing anything, and a stack trace
    // there buries the actual failure under a Node error.
    if (!statSync(reportPath, { throwIfNoEntry: false })) {
      fail(`${reportPath} does not exist; the gated run produced no report at all.`);
    }
    const xml = readFileSync(reportPath, "utf8");
    if (!isCompleteJUnit(xml)) {
      fail(`${reportPath} is not a complete JUnit report; the gated run did not finish.`);
    }
    const executed = executedFilesFromJUnit(xml);
    const leaked = executed.filter((path) => quarantined.includes(path));
    if (leaked.length > 0) {
      fail(
        "The gated run executed quarantined suites, so its result is not the gated result. " +
          "`bun test` matches its arguments as SUBSTRING filters, not as paths:\n" +
          leaked.map((path) => `  ${path}`).join("\n"),
      );
    }
    const missing = gated.filter((path) => !executed.includes(path));
    if (missing.length > 0) {
      fail(
        `${missing.length} gated suite(s) contributed nothing to the run, so the gate did not ` +
          "cover them. Either the filter did not match the path, or the file declares no tests:\n" +
          missing.map((path) => `  ${path}`).join("\n"),
      );
    }
    const unexpected = executed.filter((path) => !gated.includes(path));
    if (unexpected.length > 0) {
      fail(
        "The gated run executed suites outside the gated set:\n" +
          unexpected.map((path) => `  ${path}`).join("\n"),
      );
    }
    console.log(
      `gated run honoured the partition: ${executed.length} suites executed, ` +
        `exactly the ${gated.length} gated, none of the ${quarantined.length} quarantined`,
    );

    // Membership is not assertion. Reported rather than gated: a suite MAY legitimately skip
    // everything on a given platform, so failing here would be a false red — but leaving it silent is
    // how `describe.skip` hollows out a gate that still reports full coverage.
    const skips = suiteSkips(xml);
    const totalSkipped = skips.reduce((sum, s) => sum + s.skipped, 0);
    const hollow = skips.filter((s) => s.total > 0 && s.skipped === s.total);
    console.log(
      `${skips.reduce((sum, s) => sum + s.total, 0)} tests reported, ${totalSkipped} skipped`,
    );
    for (const suite of hollow) {
      console.log(
        `::warning title=Suite asserts nothing::${suite.file} ran ${suite.total} test(s) and skipped ` +
          "ALL of them. It counts as covered by the gate while asserting nothing.",
      );
    }
    return;
  }
  fail("usage: --check | --gated | --quarantined | --verify-run <junit.xml>");
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
