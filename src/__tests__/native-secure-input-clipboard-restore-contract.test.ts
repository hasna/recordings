import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The defect this file exists for: a secure-input refusal used to DESTROY the user's
 * transcript. `PasteDeliveryOutcome.secureInputActive` was grouped with `.pasted` in the
 * settlement `shouldRestore` decision, so after the app refused to post a keystroke it
 * restored the previous clipboard over the transcript it had just written — while the outcome's
 * own documentation promised "the payload is left on the clipboard for the user to paste".
 *
 * Why this is a parser plus an evaluator rather than a compiled test: the decision lives in
 * Swift and no Swift toolchain is reachable from this runner, so the real behavioural test
 * (`PasteDeliveryVerificationTests.secureInputRefusalKeepsTheTranscriptOnTheClipboard`) cannot
 * be executed here. Rather than pin source text -- which would pass whenever the strings happen
 * to match and prove nothing about the decision -- this extracts the real decision table out of
 * the real source and EVALUATES it for concrete scenarios. A regrouping of `.secureInputActive`
 * fails these tests even if every identifier and string in the file is left untouched.
 *
 * Every parse step that cannot find what it expects throws. A test that silently stops
 * checking is worse than no test, so there is no fallback that lets an unparsed file pass.
 */

const ENGINE_PATH = "src/native/Recordings/RecordingsLib/RecordingEngine.swift";
const SOURCE = readFileSync(ENGINE_PATH, "utf8");

/** The scenario the defect fires in, and why each value is what it is.
 *
 * `PasteTransactionCoordinator.submit` reaches `.secureInputActive` only after
 * `writeAndVerify` returned `verified` and `payloadIsReady()` passed, and `postPaste` probes
 * secure input BEFORE it constructs any `CGEvent`. So at the moment of a refusal the
 * transcript is on the pasteboard, nothing else has written it, and the change count is the
 * one this transaction took ownership of.
 */
const REFUSAL_SCENARIO = { stillOwnsPayload: true, stillOwnsChangeCount: true } as const;

// ---------------------------------------------------------------------------
// Minimal Swift readers. Deliberately narrow: they understand the two switches
// under test and throw on anything else.
// ---------------------------------------------------------------------------

/** Body of the brace-delimited block whose opening brace is at or after `from`. */
function blockBody(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) throw new Error(`no opening brace after offset ${from}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces starting at offset ${open}`);
}

/** Index of the first `:` outside parentheses, brackets and string literals. */
function topLevelIndex(text: string, needle: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && ch === needle) return i;
  }
  return -1;
}

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

type Arm = { readonly outcomes: readonly string[]; readonly expression: string };

/** Split a `switch` body into arms keyed by the outcome cases each arm matches. */
function switchArms(body: string): Arm[] {
  const starts: number[] = [];
  const armStart = /^[ \t]*(case|default)\b/gm;
  for (let m = armStart.exec(body); m !== null; m = armStart.exec(body)) starts.push(m.index);
  if (starts.length === 0) throw new Error("switch body contains no case arms");

  return starts.map((start, index) => {
    const chunk = body.slice(start, starts[index + 1] ?? body.length);
    if (/^[ \t]*default\b/.test(chunk)) return { outcomes: ["default"], expression: "" };
    const colon = topLevelIndex(chunk, ":");
    if (colon < 0) throw new Error(`case arm has no terminating colon: ${chunk.slice(0, 80)}`);
    const list = chunk.slice(chunk.indexOf("case") + "case".length, colon);
    const outcomes = list
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const name = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(entry);
        if (!name) throw new Error(`unrecognised case pattern: ${JSON.stringify(entry)}`);
        return name[1];
      });
    return { outcomes, expression: chunk.slice(colon + 1).trim() };
  });
}

function armFor(arms: readonly Arm[], outcome: string): Arm {
  const found = arms.filter((arm) => arm.outcomes.includes(outcome));
  if (found.length !== 1) {
    throw new Error(`expected exactly one arm for .${outcome}, found ${found.length}`);
  }
  return found[0];
}

/** Every case declared by the `PasteDeliveryOutcome` enum, payloads stripped. */
function declaredOutcomes(): string[] {
  const declaration = SOURCE.indexOf("enum PasteDeliveryOutcome");
  if (declaration < 0) throw new Error("PasteDeliveryOutcome declaration not found");
  const body = blockBody(SOURCE, declaration);
  const cases: string[] = [];
  // `case <lowercase>` declares a case; `case .<something>` is a pattern inside a nested
  // switch (the enum body also holds `forDeliveryEvidence`), so the absent dot is the test.
  const decl = /^[ \t]*case[ \t]+([a-z][A-Za-z0-9_]*)/gm;
  for (let m = decl.exec(body); m !== null; m = decl.exec(body)) cases.push(m[1]);
  if (cases.length === 0) throw new Error("PasteDeliveryOutcome declared no cases");
  return cases;
}

/**
 * The settlement decision table: outcome -> the expression deciding whether the PREVIOUS
 * clipboard is restored over the payload. Reads the named helper when one exists and the
 * inline `let shouldRestore = switch outcome` otherwise, so the assertions below are about
 * the decision's semantics and not about which shape the code happens to be in.
 */
function restoreDecisionArms(): Arm[] {
  const named = SOURCE.indexOf("func shouldRestorePreviousClipboard");
  if (named >= 0) {
    const signatureEnd = SOURCE.indexOf("-> Bool", named);
    if (signatureEnd < 0) throw new Error("shouldRestorePreviousClipboard has no Bool return");
    return switchArms(blockBody(blockBody(SOURCE, signatureEnd), 0));
  }
  const inline = SOURCE.indexOf("let shouldRestore = switch outcome");
  if (inline < 0) {
    throw new Error(
      "found neither shouldRestorePreviousClipboard nor an inline shouldRestore switch — " +
        "the clipboard-restore decision moved and this test must be pointed at it again",
    );
  }
  return switchArms(blockBody(SOURCE, inline));
}

/** Evaluate one decision expression. Throws rather than guessing. */
function decides(expression: string, env: Record<string, boolean>): boolean {
  const text = stripComments(expression).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("!")) return !decides(text.slice(1), env);
  if (text in env) return env[text];
  throw new Error(
    `the restore decision contains an expression this test cannot evaluate: ` +
      `${JSON.stringify(text)} — extend the evaluator, do not loosen the assertion`,
  );
}

function restoresPreviousClipboard(outcome: string, env: Record<string, boolean>): boolean {
  return decides(armFor(restoreDecisionArms(), outcome).expression, env);
}

/**
 * The condition actually guarding the restore call.
 *
 * Everything above reasons about the decision TABLE. None of it looks at the code that reads
 * the table, and a correct table wired to an inverted guard destroys the transcript exactly as
 * the original defect did: negating `if shouldRestore` passed every test in this file at exit 0.
 * A table nobody obeys is not a safeguard.
 *
 * Structural rather than textual: find every restore call, then the innermost `if` that
 * encloses it with no intervening block. Throws if the call is unguarded or duplicated, because
 * both are ways for the decision to stop being consulted.
 */
function restoreGuardConditions(): string[] {
  const RESTORE_CALL = "previousClipboard.restore(to: pasteboard)";
  const conditions: string[] = [];
  for (let at = SOURCE.indexOf(RESTORE_CALL); at >= 0; at = SOURCE.indexOf(RESTORE_CALL, at + 1)) {
    // `[^{}]*$` is the load-bearing part: it requires the matched `if`'s brace to be the last
    // brace before the call, so this is the innermost enclosing block and not some outer `if`.
    const guard = /if[ \t]+([^\n{]+?)[ \t]*\{[^{}]*$/.exec(SOURCE.slice(0, at));
    if (guard === null) {
      throw new Error(
        `a previousClipboard.restore call at offset ${at} is not directly guarded by an \`if\` ` +
          "— an unconditional restore is the transcript-destroying defect this file exists for",
      );
    }
    conditions.push(guard[1].trim());
  }
  if (conditions.length === 0) {
    throw new Error("no previousClipboard.restore call found at all — this test lost its subject");
  }
  return conditions;
}

/** The user-facing status switch, evaluated for a given `restoreClipboard` value. */
function statusMessage(outcome: string, env: Record<string, boolean>): string {
  const start = SOURCE.indexOf("let message = switch outcome");
  if (start < 0) throw new Error("the delivery status switch was not found");
  const expression = stripComments(armFor(switchArms(blockBody(SOURCE, start)), outcome).expression).trim();

  const question = topLevelIndex(expression, "?");
  if (question >= 0) {
    const condition = expression.slice(0, question).trim();
    const branches = expression.slice(question + 1);
    const colon = topLevelIndex(branches, ":");
    if (colon < 0) throw new Error(`ternary status message has no else branch: ${expression}`);
    const chosen = decides(condition, env) ? branches.slice(0, colon) : branches.slice(colon + 1);
    return literal(chosen);
  }
  return literal(expression);
}

/** Swift string literal, or several concatenated with `+` across lines. */
function literal(text: string): string {
  const pieces = text
    .trim()
    .split("\n")
    .map((line) => line.trim().replace(/^\+\s*/, "").replace(/\s*\+$/, ""))
    .filter((line) => line.length > 0);
  if (pieces.length === 0) throw new Error("expected a string literal, got nothing");
  return pieces
    .map((piece) => {
      const match = /^"((?:[^"\\]|\\.)*)"$/.exec(piece);
      if (!match) {
        throw new Error(`expected a string literal, got: ${JSON.stringify(piece)}`);
      }
      return match[1];
    })
    .join("");
}

// ---------------------------------------------------------------------------

describe("secure input must never cost the user their transcript", () => {
  test("a refused paste does not restore the previous clipboard over the transcript", () => {
    // The whole defect, in one assertion. At 4ab7ced this evaluates `stillOwnsPayload`,
    // which is true in a refusal, so the previous clipboard was restored and the transcript
    // was gone.
    expect(restoresPreviousClipboard("secureInputActive", REFUSAL_SCENARIO)).toBe(false);
  });

  test("the refusal never restores, whatever the app still owns", () => {
    // "Never" has to mean unconditional, not merely false in the case we happened to model:
    // an arm that reads any ownership flag is one pasteboard race away from deleting the
    // transcript again.
    for (const stillOwnsPayload of [true, false]) {
      for (const stillOwnsChangeCount of [true, false]) {
        expect(
          restoresPreviousClipboard("secureInputActive", {
            stillOwnsPayload,
            stillOwnsChangeCount,
          }),
          `secureInputActive restored with stillOwnsPayload=${stillOwnsPayload} ` +
            `stillOwnsChangeCount=${stillOwnsChangeCount}`,
        ).toBe(false);
      }
    }
  });

  test("a confirmed paste still gives the user their clipboard back", () => {
    // Teeth in the other direction: "never restore anything" would satisfy the assertions
    // above while permanently clobbering the clipboard of every successful dictation.
    expect(restoresPreviousClipboard("pasted", REFUSAL_SCENARIO)).toBe(true);
  });

  test("a failed clipboard write still restores on the change count it owns", () => {
    // Pins the one arm that must keep its distinct predicate: nothing of ours reached the
    // pasteboard, so ownership of the change count is the only safe signal.
    expect(
      restoresPreviousClipboard("clipboardWriteFailed", {
        stillOwnsPayload: false,
        stillOwnsChangeCount: true,
      }),
    ).toBe(true);
  });

  test("the status line tells the user to paste it themselves either way", () => {
    // The honesty invariant, and the reason the payload is kept: whether or not the caller
    // asked for a restore, the message must direct the user to paste the transcript
    // themselves -- which is only truthful because the refusal no longer restores. At
    // 4ab7ced neither branch said so ("Paste blocked by secure input" / "Copied — paste
    // blocked by secure input") and the text had already been deleted.
    //
    // Note this deliberately does NOT require the two branches to be identical: saying
    // "kept on the clipboard instead of restoring it" when a restore was requested is more
    // informative than saying "copied", and both are true.
    for (const restoreClipboard of [true, false]) {
      const message = statusMessage("secureInputActive", { restoreClipboard });
      expect(message.toLowerCase(), `restoreClipboard=${restoreClipboard}`).toContain("cmd-v");
      expect(message.toLowerCase(), `restoreClipboard=${restoreClipboard}`).not.toContain(
        "pasted",
      );
    }
  });

  test("no clipboard restore in the engine is reached without a condition", () => {
    // This is what survives of this PR, and it is deliberately narrow.
    //
    // The consumer half this PR was written for — "the guard is `shouldRestore`, not `!shouldRestore`
    // and not `true`" — is now covered by #42, and covered more strictly: it slices the settlement
    // closure, asserts `restores.length === 1` inside it, and asserts the captured condition is
    // EXACTLY `shouldRestore`, so an inversion, a constant or an added disjunct all fail on text
    // without needing an evaluator. Keeping a second, weaker copy of that here would only add a
    // second thing to update.
    //
    // What #42 does NOT cover is the OTHER restore. Its scope comment says so outright: it excludes
    // `writeClipboardPreservingOnFailure`, which legitimately restores what its own failed write
    // clobbered, gated by `pasteboard.changeCount == result.ownershipChangeCount`. Deleting that
    // gate makes the restore unconditional — clobbering whoever took the pasteboard after our failed
    // write — and it survived at EXIT 0 across every test file that reads RecordingEngine.swift
    // (130 pass / 0 fail on main c11bc3d). `restoreGuardConditions` throws on exactly that shape.
    const conditions = restoreGuardConditions();
    // A count, so a THIRD restore call has to be argued for here rather than appearing quietly.
    expect(conditions.length).toBe(2);
    // Named, not positional: reordering the two sites is a refactor, losing either condition is not.
    expect(conditions).toContain("shouldRestore");
    expect(
      conditions.filter((condition) => condition.includes("changeCount")),
      "the failed-write restore must stay gated on the change count it owns",
    ).toHaveLength(1);
  });

  test("the restore decision stays exhaustive over every outcome, with no default arm", () => {
    // Exhaustive-by-enumeration is what caught the adjacent bugs in this file. A `default:`
    // would have silently swallowed `.secureInputActive` into the restoring group.
    const arms = restoreDecisionArms();
    const covered = arms.flatMap((arm) => arm.outcomes);
    expect(covered).not.toContain("default");
    expect([...covered].sort()).toEqual([...declaredOutcomes()].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });
});
