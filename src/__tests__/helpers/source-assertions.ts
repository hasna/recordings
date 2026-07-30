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
 * These are the three suites it happens to. NO PASS/FAIL SPLIT IS RECORDED FOR THEM ON PURPOSE —
 * see below. `macos-app-lifecycle.test.ts` has 140 tests, `native-app-companion-contract.test.ts`
 * has 14, `config.test.ts` has 44, and how many of those fail is a property of the MACHINE:
 *
 *   src/__tests__/macos-app-lifecycle.test.ts
 *   src/__tests__/native-app-companion-contract.test.ts
 *   src/__tests__/config.test.ts
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
 * So the cause is not the platform. Measure on a quiet machine, or in CI, before recording a suite
 * as red. There were TWO independent station-local causes, and every earlier version of this comment
 * named only one of them. In a 92-fail run of `macos-app-lifecycle.test.ts` on this station the
 * failure messages broke down as 38 × `Home ancestor has an unexpected owner.`, 22 × FIFO
 * synchronisation timeout, 24 × ENOENT on a fixture marker. The first cause is now fixed in the
 * fixture and only the second remains; do not collapse them into one, because a quiet machine with
 * `FORCE_COLOR` set still showed all 38 aborts, so "measure on a quiet machine" was necessary and
 * not sufficient:
 *
 *   1. `FORCE_COLOR` — **FIXED IN THE FIXTURE, no longer a live cause.** The `stat` stub answered
 *      `%u` by shelling out to `bun -e '… console.log(statSync(…).uid)'`
 *      (`macos-app-lifecycle.test.ts:217`) and spread `...Bun.env` into the installer, so with
 *      `FORCE_COLOR` set Bun COLOURED the number: the installer compared `\e[0m\e[33m1000\e[0m`
 *      against `id -u`'s `1000` at `install_macos_app.sh:143` and aborted before reaching any gate.
 *      `NO_COLOR=1` did NOT help — FORCE_COLOR wins in Bun. The stub now writes bare integers with
 *      `process.stdout.write` and `unset FORCE_COLOR`s its own children, which takes that message
 *      from 38 to 0 in place, positive-controlled (the same grep still finds 38 in the pre-fix log).
 *      Nothing about ancestor MODE was ever involved: `verify_secure_parent` and
 *      `verify_safe_home_ancestor` each `stat` only the one path handed to them, the sole call is
 *      `verify_safe_home_ancestor "$HOME"`, and the stub hardcodes every `%Lp` answer anyway.
 *      Kept here rather than deleted because it is the reason this file's split moved, and because
 *      the same trap recurs in any stub that parses `console.log` of a NUMBER: only strings are
 *      left uncoloured.
 *   2. CONTENTION — **FIXED BY SHARING THE SUITE BUDGET.** The station routinely runs several full
 *      recordings suites at once out of different worktrees, and this suite scans a shared /tmp —
 *      the hazard this very comment warns about below. Those were FIFO timeouts at an internal
 *      5000ms budget that no `--timeout` flag reached. The FIFO helper now uses the same validated
 *      `RECORDINGS_TEST_TIMEOUT_MS` value as the enclosing lifecycle test, so a hosted or contended
 *      run no longer fails on a hidden shorter deadline.
 *
 * WHY NO SPLIT IS RECORDED. Every split ever written here has gone stale, including two written as
 * corrections. On one unchanged tree, three consecutive runs measured 48/92, 48/92, 49/91; the
 * single test that flips is `runtime smoke timeout does not wait forever on a live open process`
 * (`macos-app-lifecycle.test.ts:3594`), which races a hardcoded internal `Bun.sleep(2_000)` that no
 * `--timeout` flag reaches either. So a count comparison across two trees shows a phantom delta
 * from this file alone — which is the concrete reason for the rule below: compare failing test
 * NAMES, never counts. Two trees whose failing NAME SETS are identical are identical regardless of
 * what the totals say.
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
 * Index just past the Swift string literal starting at `index`, or null if none starts there.
 *
 * ONE implementation, used by both the comment stripper and the brace matcher, because they had two
 * and the second was wrong. `matchingDelimiterIndex` skipped literals with `indexOf('"', index + 1)`,
 * which pairs an opening quote with an ESCAPED one — so `{ log("a\\"}") }` returned the `}` INSIDE
 * the literal as the matching brace, and an odd `"` in a `"""` body desynchronised it entirely. That
 * was exploitable: two phantom-literal tokens placed either side of a real
 * `guard … else { return }` made the `else` block's brace read as the decision table's own, so an
 * adjacency check saw the early exit as adjacent and passed.
 *
 * Handles the three kinds Swift has — `"`, `"""`, and raw `#…"` with a matching pound count whose
 * escape introducer is `\#…` — and returns null when the literal does not close, so callers decide
 * whether that is fatal rather than silently running to end of input.
 *
 * KNOWN DEFECT, filed rather than fixed here, and stated so nobody re-derives it: a PLAIN `"` literal
 * whose interpolation contains a nested literal is measured wrong. For `{ log("v=\(f("}"))") }` this
 * returns 14 where the true close is 21 — the nested literal's opening quote is taken as the outer
 * terminator, and the `}` inside it is then counted as structure. The raw-string form
 * (`#"v=\#(f("}"))"#`) is correct, because its terminator cannot be confused with a bare quote.
 *
 * It is fail-CLOSED at both call sites today, which is why it is filed and not rushed:
 * `withoutAnyComments` throws on an unterminated literal, so quote parity is always even by the time
 * a caller reaches the brace matcher, and the arithmetic can then only land EARLY (the adjacency
 * slice is non-empty and the assertion fires) or LATE (`tableClose > guardAt` and the assertion
 * fires). Both directions fail the test rather than passing it. The proper fix is to scan
 * interpolations as code — the same treatment `withoutAnyComments` gives them — rather than treating
 * the literal body as opaque.
 */
function stringLiteralEnd(source: string, index: number): number | null {
  let hashes = 0;
  while (source[index + hashes] === "#") hashes += 1;
  const quoteAt = index + hashes;
  const delimiter = source.startsWith('"""', quoteAt)
    ? '"""'
    : source[quoteAt] === '"'
      ? '"'
      : null;
  if (delimiter === null) return null;
  const pounds = "#".repeat(hashes);
  const terminator = delimiter + pounds;
  const escape = `\\${pounds}`;
  let at = quoteAt + delimiter.length;
  while (at < source.length) {
    if (source.startsWith(escape, at)) {
      at += escape.length + 1;
      continue;
    }
    if (source.startsWith(terminator, at)) return at + terminator.length;
    at += 1;
  }
  return null;
}

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
  let index = openIndex;
  while (index < scanned.length) {
    // A delimiter inside a string literal is text. `withoutAnyComments` leaves literals intact by
    // design, so skip each one WHOLE using the same scanner it uses.
    const literalEnd = stringLiteralEnd(scanned, index);
    if (literalEnd !== null) {
      index = literalEnd;
      continue;
    }
    const character = scanned[index];
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error(
    `unbalanced ${open}${close} from index ${openIndex} — refusing to report a matching delimiter ` +
      "that was never found, because the caller would treat end-of-input as the closing position",
  );
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
    const literalEnd = stringLiteralEnd(source, index);
    if (literalEnd !== null) {
      index = literalEnd;
      continue;
    }
    // A literal that opens and never closes: THROW rather than run to end of input. This function is
    // applied to SLICES, so a region boundary that cuts a literal in half used to leave every
    // comment after it unstripped, and the caller then asserted over text that was never scanned.
    // Failing open is the one outcome that must not be available.
    if (source[index] === '"' || (source[index] === "#" && /^#+"/.test(source.slice(index)))) {
      throw new Error(
        `unterminated string literal at offset ${index} — refusing to strip comments from a region ` +
          "whose literals do not close, because every comment after it would survive and any " +
          "assertion over this text would be unsound",
      );
    }
    index += 1;
  }
  return out.join("");
}

/**
 * The arms of a Swift `switch` body, as a mapping from each matched case to its expression.
 *
 * Order- and grouping-independent, which matters because pinning an arm by its exact TEXT gets both
 * directions wrong. It false-positives on a pure reorder — `.deliveredUnverified, .deliveryNotObserved`
 * is the same table and failed — and it misses a real defect: splitting one outcome out of a group
 * into its own arm with a different expression leaves the pinned needle intact, so
 * `.targetUnavailable` could be given `false` while the six-outcome needle still matched.
 *
 * `body` is the text between the switch's braces, comments already stripped by the caller.
 */
export function switchArmsByOutcome(body: string): Map<string, string> {
  const arms = new Map<string, string>();
  // Case labels may wrap across lines, so split on `case`/`default` at the start of a line and take
  // everything up to the first `:` as the label list.
  const starts = [...body.matchAll(/^[ \t]*(case|default)\b/gm)];
  starts.forEach((start, position) => {
    const from = start.index ?? 0;
    const nextStart = starts[position + 1];
    const to = nextStart?.index ?? body.length;
    const arm = body.slice(from, to);
    const colon = arm.indexOf(":");
    expect(colon, `a switch arm has no \`:\` separating its label from its body: ${arm.slice(0, 60)}`)
      .toBeGreaterThan(-1);
    const label = arm.slice(0, colon);
    const expression = arm.slice(colon + 1).trim();
    if (start[1] === "default") {
      arms.set("default", expression);
      return;
    }
    for (const outcome of label.replace(/^[ \t]*case\b/, "").split(",")) {
      const name = outcome.trim().replace(/^\./, "");
      if (name) arms.set(name, expression);
    }
  });
  return arms;
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
  if (Object.hasOwn(env, text)) {
    const value = env[text];
    if (value !== undefined) return value;
  }
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
