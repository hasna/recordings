import { expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared assertions for contract tests that read source text.
 *
 * These live here rather than inside one suite because the defect they exist to prevent is
 * repo-wide: a sweep of every `*.test.ts` found 40 ordering assertions written as
 * `indexOf(a) < indexOf(b)`, across 11 files. `indexOf` answers -1 when the needle is absent and
 * `-1 < anything` is true, so such an assertion PASSES when the thing being ordered is DELETED.
 * The same hole exists in `.slice(indexOf(...), indexOf(...))` region bounds, where a -1 silently
 * slices from the end of the file or to its start — a region assertion over the wrong text, or over
 * none of it, reads exactly like a satisfied one.
 *
 * ---------------------------------------------------------------------------------------------
 * BEFORE YOU BUILD A MUTATION BATTERY: three suites are RED ON A CONTENDED STATION, not on Linux.
 *
 * A mutation battery is evidence only when its clean control is GREEN. Include a suite that was
 * already failing and the run was non-zero before you changed anything, so every mutation "looks
 * caught" and every verdict is manufactured. That already produced one wrong all-clear here.
 *
 * These three are the suites it happens to, measured deterministically 3 of 3 runs each on `main`
 * at 40c37b1 with `bun install --frozen-lockfile`:
 *
 *   src/__tests__/macos-app-lifecycle.test.ts             EXIT 1,  48 pass /  92 fail
 *   src/__tests__/native-app-companion-contract.test.ts   EXIT 1,  13 pass /   1 fail
 *   src/__tests__/config.test.ts                          EXIT 1,  43 pass /   1 fail
 *
 * CORRECTED 2026-07-27, and the correction is the useful part. This block used to call them
 * "PERMANENTLY RED on Linux" and attribute fixed environmental causes — BSD `stat -f`, a fixture
 * port reading `NaN`, a `getDataDir` HOME-ancestor assumption. The first CI run this repository
 * ever had (run 30302342895, ubuntu-24.04) re-ran all three on a clean single-tenant runner and
 * every one of them PASSED:
 *
 *   macos-app-lifecycle            140 pass / 0 fail   (358.85s)
 *   native-app-companion-contract   14 pass / 0 fail   (  4.50s)
 *   config                          44 pass / 0 fail   (  0.10s)
 *
 * So the cause is not the platform. It is CONTENTION on the station, which routinely runs several
 * full recordings suites at once out of different worktrees — the hazard this very comment warns
 * about below. The 92 macos-app-lifecycle failures are FIFO synchronisation timeouts at an internal
 * 5000ms budget that no `--timeout` flag reaches, and they only trip when another suite is competing
 * for the shared /tmp. Measure on a quiet machine, or in CI, before recording a suite as red.
 *
 * `@hasna/events` MUST resolve 0.1.11, as `bun.lock` pins it. A plain `bun install` pulls 0.1.14,
 * which dropped a shipped CLI command inside the patch range and fails `cli.test.ts` — and it can
 * drift back mid-session, so re-check it before quoting any cross-tree comparison.
 *
 * Corollary, also corrected: this repo NOW HAS CI. `.github/workflows/ci.yml` gates the whole
 * suite with no exemptions on every pull request, so these suites are no longer gated only by
 * somebody remembering to run them. What CI does NOT cover is the Swift/C half, which does not
 * currently compile; see `.github/native-known-errors.txt`.
 * Compare failing test NAMES, never counts — the suite is nondeterministic at the margin.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Assert `first` appears before `second`, requiring BOTH to exist.
 *
 * Use this instead of comparing two `indexOf` results directly. `firstMatch: "last"` selects
 * `lastIndexOf` for the first operand, which has the identical -1 hole.
 */
export function expectOrder(
  haystack: string,
  first: string,
  second: string,
  options: { firstMatch?: "first" | "last" } = {},
): void {
  const firstIndex =
    options.firstMatch === "last" ? haystack.lastIndexOf(first) : haystack.indexOf(first);
  const secondIndex = haystack.indexOf(second);
  expect(firstIndex, `ordering operand is missing entirely: ${first}`).toBeGreaterThan(-1);
  expect(secondIndex, `ordering operand is missing entirely: ${second}`).toBeGreaterThan(-1);
  expect(firstIndex).toBeLessThan(secondIndex);
}

/**
 * Slice between two markers, requiring both to exist and the region to be non-trivial.
 *
 * The length floor matters as much as the -1 checks: `slice(-1)` yields a ONE-CHARACTER string, not
 * an empty one, so a `expect(region.length).toBeGreaterThan(0)` control passes on a region that
 * contains nothing worth asserting about. Any `not.toContain` over such a region is vacuous.
 */
export function sliceBetween(
  source: string,
  open: string,
  close: string,
  options: { minimumLength?: number } = {},
): string {
  const from = source.indexOf(open);
  const to = source.indexOf(close, from + 1);
  expect(from, `slice start marker is missing: ${open}`).toBeGreaterThan(-1);
  expect(to, `slice end marker is missing: ${close}`).toBeGreaterThan(from);
  const region = source.slice(from, to);
  expect(
    region.length,
    `slice between ${open} and ${close} is too small to assert anything about`,
  ).toBeGreaterThanOrEqual(options.minimumLength ?? open.length + 1);
  return region;
}

/**
 * Assert a marker occurs exactly once before slicing on it.
 *
 * A duplicated end marker silently extends a region: `let myPID = ProcessInfo…` occurs twice in
 * `RecordingEngine.swift`, so a region bounded by it could stretch ~127 KB and be satisfied by
 * copies of the needle from an unrelated function.
 */
export function sliceBetweenUnique(source: string, open: string, close: string): string {
  for (const [label, marker] of [["start", open], ["end", close]] as const) {
    const occurrences = source.split(marker).length - 1;
    expect(occurrences, `${label} marker is not unique (${occurrences}x): ${marker}`).toBe(1);
  }
  return sliceBetween(source, open, close);
}

/** Strip Swift line comments so an assertion about code is not defeated by prose. */
export function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/**
 * Evaluate a Swift boolean condition for a given binding of its identifiers.
 *
 * Folded in from PR #43, which pinned the clipboard-restore guard by evaluating it for BOTH values
 * of the decision rather than comparing its text. That is the half worth keeping: an exact
 * `toBe("shouldRestore")` on a captured condition kills the inversion, but it also fails on
 * `(shouldRestore)` and on a trailing comment — reporting refactors as defects while proving
 * nothing about behaviour.
 *
 * Deliberately narrow and fail-CLOSED: `true`, `false`, `!x`, whole-expression parentheses, and
 * identifiers present in `env`. Anything else throws. An added disjunct
 * (`shouldRestore || stillOwnsChangeCount`) is an unevaluatable expression, not a passing one —
 * which is the behaviour that matters, because that disjunct is exactly how the
 * transcript-destroying defect gets reintroduced. Extend the evaluator when a new shape is
 * legitimate; do not loosen the assertion.
 */
export function evaluateSwiftCondition(condition: string, env: Record<string, boolean>): boolean {
  // Comments carry no truth value. PR #43's version of this threw on `if x /* why */ {`.
  const text = condition
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("!")) return !evaluateSwiftCondition(text.slice(1), env);
  // Only strip parentheses wrapping the WHOLE expression, so `(a) || (b)` is not reduced to `a`.
  if (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0 && index < text.length - 1) wrapsAll = false;
      }
    }
    if (wrapsAll) return evaluateSwiftCondition(text.slice(1, -1), env);
  }
  if (text in env) return env[text]!;
  throw new Error(
    `condition contains an expression this evaluator cannot decide: ${JSON.stringify(text)} — ` +
      "extend the evaluator, do not loosen the assertion",
  );
}

/**
 * Every Swift source under a root, so an absence claim can be made about the app rather than about
 * whichever files were on the reviewer's mind.
 */
export function swiftSourcesUnder(root: string): Array<[path: string, source: string]> {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".swift"))
    .map((entry) => [entry, readFileSync(join(root, entry), "utf8")] as [string, string]);
}
