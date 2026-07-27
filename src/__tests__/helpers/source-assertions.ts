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
 * BEFORE YOU BUILD A MUTATION BATTERY: three suites are PERMANENTLY RED on Linux.
 *
 * A mutation battery is evidence only when its clean control is GREEN. Include any of these and
 * the run was already non-zero before you changed anything, so every mutation "looks caught" and
 * every verdict is manufactured. This already produced one wrong all-clear in this repo, and the
 * list in circulation named TWO of the three.
 *
 *   src/__tests__/macos-app-lifecycle.test.ts             EXIT 1,  48 pass /  92 fail
 *   src/__tests__/native-app-companion-contract.test.ts   EXIT 1,  13 pass /   1 fail
 *   src/__tests__/config.test.ts                          EXIT 1,  43 pass /   1 fail
 *
 * Measured deterministically, 3 of 3 runs each, on `main` at 40c37b1 with
 * `bun install --frozen-lockfile`. Causes are environmental, not defects in the code under test:
 * BSD `stat -f` plus hardcoded macOS tool paths, a fixture server port reading `NaN`, and a
 * `getDataDir` HOME-ancestor assumption respectively.
 *
 * `@hasna/events` MUST resolve 0.1.11, as `bun.lock` pins it. A plain `bun install` pulls 0.1.14,
 * which dropped a shipped CLI command inside the patch range and fails `cli.test.ts` — and it can
 * drift back mid-session, so re-check it before quoting any cross-tree comparison.
 *
 * Corollary, equally load-bearing: this repo has NO CI. There is no `.github/workflows/`, and
 * `bun test` on `main` is EXIT 1 (94 failing tests), so `prepublishOnly = typecheck && test`
 * cannot pass on this platform either. Nothing gates these suites except somebody running them.
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
 * Strip EVERY Swift comment — trailing `//` and `/* … *\/` too, not only whole comment lines.
 *
 * `withoutComments` above drops a line only when the line STARTS with `//`, which leaves a trailing
 * comment as ordinary text to any assertion downstream. Two measured defects turned on exactly that:
 *
 *   - A region assertion for `stillOwnsPayload` was satisfied by an attacker's trailing comment
 *     `if shouldRestore { // stillOwnsPayload is folded into the table above` while the switch arm
 *     it was meant to check had been replaced by `true`. The opt-in was gone and the test passed.
 *   - Commenting the guard OUT entirely — `// if shouldRestore {` around an unconditional
 *     `previousClipboard.restore(to: pasteboard)` — still let a guard-locating regex capture
 *     `shouldRestore` out of the comment. That is the maximal transcript-destroying defect, passing.
 *
 * Line count is preserved so any assertion that anchors on `\n` still sees the same shape.
 */
/**
 * Index just past the `close` matching the `open` at `openIndex`, skipping comments and literals.
 *
 * Needed because `lastIndexOf("}")` is not brace matching, and the difference is a live defect: an
 * early exit written between a decision and its use —
 *
 *     }                                        // the decision table closes here
 *     guard stillOwnsChangeCount else { return }
 *     if shouldRestore { … }
 *
 * — puts a NEARER `}` (the `else` block's) between the two, so a "nothing between them" check
 * measured from the last brace saw only whitespace and passed. Counting braces naively fails the
 * other way: one `}` inside a string literal, such as `log("settlement }")`, cancels a real opener.
 * Both were measured surviving at EXIT=0.
 */
export function matchingDelimiterIndex(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  // Comments and literals are neutralised first, which also validates that they all close.
  const scanned = withoutAnyComments(source);
  expect(scanned[openIndex], `no ${open} at index ${openIndex}`).toBe(open);
  let depth = 0;
  for (let index = openIndex; index < scanned.length; index += 1) {
    const character = scanned[index];
    // A delimiter inside a string literal is text. `withoutAnyComments` leaves literals intact by
    // design, so skip them here rather than counting their contents.
    if (character === '"') {
      const literal = scanned.indexOf('"', index + 1);
      index = literal === -1 ? scanned.length : literal;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  expect(depth, `unbalanced ${open}${close} from index ${openIndex}`).toBe(0);
  return scanned.length;
}

export function withoutAnyComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  let index = 0;
  while (index < source.length) {
    // Line comment: blank to end of line.
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      blank(index, stop);
      index = stop;
      continue;
    }
    // Block comment. Swift NESTS these, so a non-greedy match to the first `*/` left the tail
    // `c */` of `/* a /* b */ c */` behind as if it were code.
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let at = index + 2;
      while (at < source.length && depth > 0) {
        if (source.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else at += 1;
      }
      // Same reasoning as the literal below, opposite direction: an unclosed `/*` blanked to end of
      // input, deleting real code. Fail-closed rather than fail-open, but still a region the caller
      // would assert over while believing it was intact.
      if (depth > 0) {
        throw new Error(
          `unterminated block comment at offset ${index} — refusing to strip comments from a ` +
            "region whose comments do not close, because everything after it would be blanked",
        );
      }
      blank(index, at);
      index = at;
      continue;
    }
    // String literal: skipped WHOLE and left intact, tracked across lines and by KIND. Per-line
    // quote parity got this wrong in the obvious way — a `"""` block reset its state at every
    // newline, so `https://x` on the second line of a multiline literal was cut to `https:`.
    // Stripping real code is the inverse of the bug this function exists for and just as bad:
    // an assertion then passes over text that is no longer there.
    let hashes = 0;
    while (source[index + hashes] === "#") hashes += 1;
    const quoteAt = index + hashes;
    const delimiter = source.startsWith('"""', quoteAt)
      ? '"""'
      : source[quoteAt] === '"'
        ? '"'
        : null;
    if (delimiter !== null) {
      const pounds = "#".repeat(hashes);
      const terminator = delimiter + pounds;
      const escape = `\\${pounds}`;
      let at = quoteAt + delimiter.length;
      let terminated = false;
      while (at < source.length) {
        if (source.startsWith(escape, at)) {
          at += escape.length + 1;
          continue;
        }
        if (source.startsWith(terminator, at)) {
          at += terminator.length;
          terminated = true;
          break;
        }
        at += 1;
      }
      // THROW rather than run to end of input. An unterminated literal used to swallow the rest of
      // the file, so every comment after it survived unstripped — and this function is applied to
      // SLICES, so a region boundary that cuts a literal in half silently reopened exactly the
      // defects it exists to close. Failing open is the one outcome that must not be available:
      // the caller sees a clean-looking region and asserts over text that was never scanned.
      if (!terminated) {
        throw new Error(
          `unterminated ${delimiter === '"""' ? "multiline" : "string"} literal at offset ${quoteAt} — ` +
            "refusing to strip comments from a region whose literals do not close, because every " +
            "comment after it would survive and any assertion over this text would be unsound",
        );
      }
      index = at;
      continue;
    }
    index += 1;
  }
  return out.join("");
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
  // `Object.hasOwn`, not `in`: `text in env` walks the prototype chain, so `toString`,
  // `constructor`, `__proto__`, `valueOf` and `hasOwnProperty` all answer truthy on a plain
  // object and would be read as bound identifiers rather than rejected.
  if (Object.hasOwn(env, text)) return env[text]!;
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
