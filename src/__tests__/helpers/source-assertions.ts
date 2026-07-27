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
 * Every Swift source under a root, so an absence claim can be made about the app rather than about
 * whichever files were on the reviewer's mind.
 */
export function swiftSourcesUnder(root: string): Array<[path: string, source: string]> {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".swift"))
    .map((entry) => [entry, readFileSync(join(root, entry), "utf8")] as [string, string]);
}
