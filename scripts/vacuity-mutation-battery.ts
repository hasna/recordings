/**
 * Mutation battery for the indexOf/-1 vacuity sweep (OPE41-00029).
 *
 * A converted ordering assertion is only proven non-vacuous by an input that makes it FAIL. This
 * driver takes a manifest of mutations and, for each one:
 *
 *   1. asserts the mutation actually CHANGED the file — a positive control, because a needle that
 *      never matched, or an occurrence index past the last match, would otherwise read as a caught
 *      mutation when nothing was mutated at all;
 *   2. runs the target test CLEAN and requires it to PASS — without this control an already-red
 *      test makes every mutation look caught, which is the inverse trap;
 *   3. applies the mutation and requires the named test to FAIL;
 *   4. restores the file byte-for-byte from the copy held in memory, never from git, so sibling
 *      working-tree edits are never reverted.
 *
 * Mutation kinds, and why one is not enough:
 *
 *   delete     — remove the Nth occurrence of a needle. The occurrence index is not optional.
 *                `options: .atomic` occurs twice in RecordingsApp.swift and only the SECOND is
 *                inside the region under test, so deleting the first must stay GREEN; a harness
 *                that always deletes the first records a false survivor and sends someone to
 *                "fix" a guard that was working. Three more needles are masked the same way by an
 *                earlier occurrence that is the helper's own DEFINITION rather than its call site.
 *   swap       — exchange two needles' text so the ordering flips. An ordering assertion that
 *                survives a REORDER is the same vacuity class this sweep exists to close wearing
 *                different clothes, and it is entirely invisible to a deletion-only harness.
 *   duplicate  — insert a second copy of a needle. This is what separates a uniqueness bound from
 *                a bare `toContain`: the `toContain` stays green on a duplicate, the bound does not.
 *   corrupt    — replace a string literal in the TEST at an exact byte offset with a sentinel that
 *                cannot occur in any source. Equivalent, from the assertion's point of view, to
 *                deleting that needle from the source, but it needs no map from haystack variable
 *                to source path, so it covers every converted site mechanically.
 *
 * Needles may contain \n and \t as escapes, because several properties can only be pinned by a
 * whole-line needle (a bare helper name matches its own definition first).
 *
 * Exit codes come from spawnSync status, never through a pipe. Runs are strictly serial: a sibling
 * assertion in capture-probe.test.ts scans a shared /tmp, so concurrent suites corrupt each other.
 *
 * Usage: bun scripts/vacuity-mutation-battery.ts <manifest.tsv> [--only <substring>]
 * Manifest, tab-separated: kind <TAB> testFile <TAB> testName <TAB> targetFile <TAB> a <TAB> b
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Kind = "delete" | "swap" | "duplicate" | "corrupt";
type Row = { kind: Kind; testFile: string; testName: string; target: string; a: string; b: string };

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: bun scripts/vacuity-mutation-battery.ts <manifest.tsv> [--only <substr>]");
  process.exit(2);
}
const onlyIndex = rest.indexOf("--only");
const only = onlyIndex >= 0 ? rest[onlyIndex + 1] : undefined;

const rows: Row[] = readFileSync(manifestPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const [kind, testFile, testName, target, a, b] = line.split("\t");
    return { kind: kind as Kind, testFile, testName, target, a: a ?? "", b: b ?? "" };
  })
  .filter((r) => !only || `${r.testFile} ${r.testName} ${r.a}`.includes(only));

/** Byte offset of the nth (1-based) occurrence, or -1. */
function nthIndex(haystack: string, needle: string, n: number): number {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = haystack.indexOf(needle, i === 0 ? 0 : at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/** TSV cannot carry literal tabs or newlines, so needles arrive escaped. */
function unescape(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** Apply a mutation, or return undefined — which the caller treats as a control FAILURE. */
function mutate(row: Row, original: string): string | undefined {
  const a = unescape(row.a);
  const b = unescape(row.b);

  if (row.kind === "corrupt") {
    // Deliberately NOT unescaped: this mutates the test file's RAW bytes, and a `\n` inside a
    // TypeScript string literal is two bytes on disk. Unescaping it would move the offset and the
    // guard below would reject every row — silently, as a control failure rather than a survivor.
    const offset = Number(row.a);
    if (!Number.isFinite(offset)) return undefined;
    if (original.slice(offset, offset + row.b.length) !== row.b) return undefined;
    return (
      original.slice(0, offset) +
      row.b +
      "__OPE41_00029_ABSENT__" +
      original.slice(offset + row.b.length)
    );
  }

  if (row.kind === "delete") {
    const at = nthIndex(original, a, Number(row.b || "1"));
    if (at < 0) return undefined;
    return original.slice(0, at) + original.slice(at + a.length);
  }

  if (row.kind === "duplicate") {
    const at = nthIndex(original, a, Number(row.b || "1"));
    if (at < 0) return undefined;
    return original.slice(0, at + a.length) + a + original.slice(at + a.length);
  }

  if (row.kind === "swap") {
    const atA = original.indexOf(a);
    const atB = original.indexOf(b);
    if (atA < 0 || atB < 0 || a === b) return undefined;
    const firstAt = Math.min(atA, atB);
    const secondAt = Math.max(atA, atB);
    const [first, second] = atA < atB ? [a, b] : [b, a];
    if (firstAt + first.length > secondAt) return undefined; // overlapping; cannot swap cleanly
    return (
      original.slice(0, firstAt) +
      second +
      original.slice(firstAt + first.length, secondAt) +
      first +
      original.slice(secondAt + second.length)
    );
  }
  return undefined;
}

/**
 * `bun test -t` takes a REGEX, not a substring.
 *
 * A test named `rendering RecordingEngine.logResolvedTrigger()'s format string parses as expected`
 * contains `()`, which as a pattern is an empty capture group, so the literal parentheses in the
 * name are never matched and bun reports `matched 0 tests` and exits 1. Unescaped, that presented as
 * RED-ON-CLEAN — a refusal to conclude rather than a false pass, but still two sites left unproven
 * for a reason that had nothing to do with them.
 */
function escapeForTestFilter(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runTest(testFile: string, testName: string): { code: number; output: string } {
  const filter = escapeForTestFilter(testName);
  const result = spawnSync("bun", ["test", testFile, "-t", filter, "--timeout", "120000"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Did the filter select anything? 0 pass 0 fail exits 0 and would read as a clean pass. */
function ranSomething(output: string): boolean {
  const p = output.match(/(\d+)\s+pass/);
  const f = output.match(/(\d+)\s+fail/);
  return (p ? Number(p[1]) : 0) + (f ? Number(f[1]) : 0) > 0;
}

type Verdict =
  | "KILLED"
  | "KILLED-UNATTRIBUTED"
  | "SURVIVED"
  | "MUTATION-NOT-APPLIED"
  | "RED-ON-CLEAN"
  | "FILTER-MATCHED-NOTHING";

/**
 * A red test is not automatically proof that the converted assertion fired.
 *
 * Most of these suites EXECUTE the script they also read, so deleting a needle from
 * `install_macos_app.sh` can break the run and fail `expect(result.exitCode).toBe(0)` long before
 * the ordering assertion is reached. The driver would see a non-zero exit and record KILLED while
 * the assertion under test did nothing at all — a kill credited to the wrong cause is exactly the
 * "evidence that does not prove the claim" this sweep exists to remove.
 *
 * So a kill only counts when the failure output carries one of the guard's own messages. Anything
 * else is reported as KILLED-UNATTRIBUTED and proves nothing about the site.
 *
 * The patterns are deliberately fragments rather than whole sentences. Suites add their own named
 * guards — "test override is missing entirely: ...", "resolver function is missing entirely: ..." —
 * and a signal list enumerating only the helper's own wording reported those as UNATTRIBUTED, which
 * cost two hand-attributions that the driver should have made itself.
 */
const GUARD_SIGNAL =
  /(is missing entirely|marker is missing|marker is not unique|too small to assert anything about|is missing or out of order|no longer sanitizes)/;

function attributed(output: string): boolean {
  return GUARD_SIGNAL.test(output);
}

const results: { row: Row; verdict: Verdict }[] = [];
const cleanCache = new Map<string, "ok" | "red" | "no-match">();

for (const [n, row] of rows.entries()) {
  const label = `[${n + 1}/${rows.length}] ${row.kind} ${row.testFile} :: ${row.testName}`;
  const original = readFileSync(row.target, "utf8");

  const mutated = mutate(row, original);
  if (mutated === undefined || mutated === original) {
    results.push({ row, verdict: "MUTATION-NOT-APPLIED" });
    console.log(`${label}\n    MUTATION-NOT-APPLIED  ${row.a.slice(0, 70)}`);
    continue;
  }

  // The cache records WHY a clean run was unusable, not merely that it was. Collapsing both causes
  // into one boolean made every row after the first report RED-ON-CLEAN, so a broken `-t` filter
  // masqueraded as a failing test and pointed the reader at the wrong thing to fix.
  const cleanKey = `${row.testFile} ${row.testName}`;
  if (!cleanCache.has(cleanKey)) {
    const clean = runTest(row.testFile, row.testName);
    cleanCache.set(
      cleanKey,
      !ranSomething(clean.output) ? "no-match" : clean.code === 0 ? "ok" : "red",
    );
  }
  const cleanState = cleanCache.get(cleanKey);
  if (cleanState !== "ok") {
    const verdict: Verdict = cleanState === "no-match" ? "FILTER-MATCHED-NOTHING" : "RED-ON-CLEAN";
    results.push({ row, verdict });
    console.log(`${label}\n    ${verdict} - no mutation verdict can be drawn here`);
    continue;
  }

  try {
    writeFileSync(row.target, mutated, "utf8");
    const after = runTest(row.testFile, row.testName);
    const verdict: Verdict =
      after.code === 0 ? "SURVIVED" : attributed(after.output) ? "KILLED" : "KILLED-UNATTRIBUTED";
    results.push({ row, verdict });
    console.log(`${label}\n    ${verdict} (mutated exit ${after.code})  ${row.a.slice(0, 60)}`);
  } finally {
    writeFileSync(row.target, original, "utf8");
  }
}

const tally = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log(`\n==== BATTERY SUMMARY (${results.length} mutations) ====`);
for (const [verdict, count] of Object.entries(tally).sort()) console.log(`${verdict}: ${count}`);

const notKilled = results.filter((r) => r.verdict !== "KILLED");
if (notKilled.length) {
  console.log(`\n---- NOT KILLED (${notKilled.length}) ----`);
  for (const s of notKilled) {
    console.log(
      `${s.verdict}\t${s.row.kind}\t${s.row.testFile}\t${s.row.testName}\t${s.row.a.slice(0, 60)}`,
    );
  }
}

// An instrument that always exits 0 is not a gate. Anything other than a clean kill — a survivor, a
// kill credited to the wrong cause, or a control that could not be applied — has to be able to fail
// a caller, or the summary is decoration that a script above it will happily ignore.
process.exit(notKilled.length === 0 ? 0 : 1);
