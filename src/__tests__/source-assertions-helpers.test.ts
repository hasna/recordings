import { describe, expect, test } from "bun:test";

import {
  evaluateSwiftCondition,
  matchingDelimiterIndex,
  switchArmsByOutcome,
  withoutAnyComments,
} from "./helpers/source-assertions.js";

/**
 * These helpers rewrite Swift source before other suites assert on it, so a defect here is not a
 * failing test — it is every assertion downstream reading the wrong text and passing. Both
 * directions are dangerous and both have happened:
 *
 *   - Too little stripping: a trailing comment satisfied `toContain("stillOwnsPayload")` while the
 *     switch arm it was checking had been replaced by `true`, and commenting a guard out left a
 *     locator capturing the condition out of the comment around an UNCONDITIONAL restore.
 *   - Too much stripping: per-line quote parity cut `https://x` out of the second line of a `"""`
 *     literal, so an assertion would pass over string content that no longer existed.
 *
 * Every case below is one of those, written as its own input.
 */
describe("withoutAnyComments", () => {
  test("removes trailing line comments but keeps the code before them", () => {
    expect(withoutAnyComments('log("a") // real comment').trimEnd()).toBe('log("a")');
    expect(withoutAnyComments("let q = a / b // c").trimEnd()).toBe("let q = a / b");
  });

  test("removes block comments, including NESTED ones", () => {
    expect(withoutAnyComments("if x /* why */ { y() }")).toBe("if x           { y() }");
    // Swift nests block comments. A non-greedy match to the first `*/` left `c */` behind as code.
    expect(withoutAnyComments("if x /* a /* b */ c */ { y() }")).toBe("if x                   { y() }");
  });

  test("never touches text inside a string literal", () => {
    for (const line of [
      'log("see https://example.com/x")',
      'log("a \\" b // not a comment")',
      'let r = #"has // inside"#',
    ]) {
      expect(withoutAnyComments(line)).toBe(line);
    }
  });

  test("tracks a multiline literal across newlines rather than resetting per line", () => {
    // The whole literal is code. Per-line parity saw `"""` as three toggles, reset at the newline,
    // and cut this second line at the `//` — deleting real string content.
    const source = 'let m = """\n  https://x // y\n  """';
    expect(withoutAnyComments(source)).toBe(source);
  });

  test("tracks the literal KIND, so a stray quote inside a multiline body does not desynchronise", () => {
    // Coverage gap an adversarial reviewer found: disabling the `"""` branch left the previous
    // version of this suite at 10 pass / 0 fail, because the only multiline case round-tripped
    // either way. An ODD number of quotes in the body is what distinguishes the two.
    const source = 'let m = """\n  say "hi\n  """\ncode() // c';
    const stripped = withoutAnyComments(source);
    expect(stripped).toContain('say "hi');
    expect(stripped).toContain("code()");
    expect(stripped).not.toContain("// c");
  });

  test("refuses a region whose literals or comments do not close, rather than failing open", () => {
    // This function is applied to SLICES. An unterminated literal used to swallow the rest of the
    // input, so every comment after it survived unstripped and the caller asserted over text that
    // was never scanned. Failing open is the one outcome that must not be available.
    expect(() => withoutAnyComments('let a = "oops\ncode() // survives')).toThrow(/unterminated/);
    expect(() => withoutAnyComments('let a = #"oops\ncode() // survives')).toThrow(/unterminated/);
    expect(() => withoutAnyComments("code() /* oops\nmore code")).toThrow(/unterminated/);
  });

  test("preserves line count, so newline-anchored assertions still match", () => {
    const source = 'a()\n// gone\nb() /* also\ngone */\nc()';
    expect(withoutAnyComments(source).split("\n")).toHaveLength(source.split("\n").length);
  });

  test("blanks rather than deletes, so offsets are preserved", () => {
    const source = "abc // xyz";
    expect(withoutAnyComments(source)).toHaveLength(source.length);
  });
});

describe("evaluateSwiftCondition", () => {
  test("decides the shapes that are genuinely identity on the bound name", () => {
    for (const condition of [
      "shouldRestore",
      "(shouldRestore)",
      "((shouldRestore))",
      "shouldRestore /* why */",
      "shouldRestore // why",
      "!!shouldRestore",
    ]) {
      expect(evaluateSwiftCondition(condition, { shouldRestore: true })).toBe(true);
      expect(evaluateSwiftCondition(condition, { shouldRestore: false })).toBe(false);
    }
  });

  test("decides the constants and the inversion", () => {
    expect(evaluateSwiftCondition("true", {})).toBe(true);
    expect(evaluateSwiftCondition("false", {})).toBe(false);
    expect(evaluateSwiftCondition("!shouldRestore", { shouldRestore: true })).toBe(false);
  });

  test("fails CLOSED on anything it cannot decide, rather than guessing", () => {
    // An added disjunct is how the transcript-destroying defect gets reintroduced. It must throw,
    // not evaluate to something convenient.
    for (const condition of [
      "shouldRestore || stillOwnsChangeCount",
      "shouldRestore && true",
      "shouldRestore == true",
      "(shouldRestore) || (false)",
      "shouldRestore ? true : false",
      "somethingElse",
    ]) {
      expect(() => evaluateSwiftCondition(condition, { shouldRestore: true })).toThrow();
    }
  });

  test("does not read inherited Object properties as bound identifiers", () => {
    // `text in env` walks the prototype chain, so these answered truthy on a plain object and
    // would have been treated as bound names instead of rejected.
    for (const inherited of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
      expect(() => evaluateSwiftCondition(inherited, { shouldRestore: true })).toThrow();
    }
  });
});

describe("matchingDelimiterIndex", () => {
  // Every case here exists because the previous implementation skipped literals with
  // `indexOf('"', index + 1)`, which pairs an opening quote with an ESCAPED one. That was not a
  // theoretical flaw: two phantom-literal tokens placed either side of a real
  // `guard … else { return }` made the `else` block's brace read as a decision table's own, so an
  // adjacency check saw the early exit as adjacent and passed while the defect was live.
  //
  // The branch also had zero coverage — flipping `if (character === '"')` to `if (false)` left the
  // whole suite green, because no input in the repo needed it. It only ever fires once someone adds
  // a literal, which is exactly the attack.
  const close = (source: string): number =>
    matchingDelimiterIndex(source, source.indexOf("{"), "{", "}");

  test("matches the real brace, not one inside a string literal", () => {
    expect(close('{ log("a }") }')).toBe('{ log("a }") }'.length - 1);
  });

  test("is not fooled by an escaped quote inside a literal", () => {
    const source = '{ log("a\\"}") }';
    expect(close(source)).toBe(source.length - 1);
  });

  test("handles multiline and raw literals containing braces and odd quotes", () => {
    for (const source of ['{ let s = """\n  a"b }\n  """\n }', '{ let s = #"}"# }']) {
      expect(close(source)).toBe(source.length - 1);
    }
  });

  test("throws rather than reporting end-of-input as the closing position", () => {
    expect(() => close("{ unclosed")).toThrow(/unbalanced/);
  });
});

describe("switchArmsByOutcome", () => {
  // Pinning an arm by its exact TEXT is wrong in both directions: it false-positives on a pure
  // reorder of the case list, and it misses one outcome being split out of a group into its own arm
  // with a different expression. A mapping is invariant under the first and catches the second.
  const body = `
            case .clipboardWriteFailed:
                stillOwnsChangeCount
            case .secureInputActive:
                false
            case .targetUnavailable, .clipboardOwnershipLost, .eventPostFailed, .pasted,
                 .deliveryNotObserved, .deliveredUnverified:
                stillOwnsPayload
`;

  test("maps every outcome in a multi-line, multi-outcome case list to its expression", () => {
    const arms = switchArmsByOutcome(body);
    expect(arms.get("clipboardWriteFailed")).toBe("stillOwnsChangeCount");
    expect(arms.get("secureInputActive")).toBe("false");
    expect(arms.get("deliveredUnverified")).toBe("stillOwnsPayload");
    expect(arms.get("targetUnavailable")).toBe("stillOwnsPayload");
    expect(arms.size).toBe(8);
  });

  test("is invariant under reordering a case list", () => {
    const reordered = body.replace(
      ".deliveryNotObserved, .deliveredUnverified:",
      ".deliveredUnverified, .deliveryNotObserved:",
    );
    expect(switchArmsByOutcome(reordered)).toEqual(switchArmsByOutcome(body));
  });

  test("sees an outcome split out of a group with a different expression", () => {
    const split = body.replace(
      "case .targetUnavailable, .clipboardOwnershipLost",
      "case .targetUnavailable:\n                false\n            case .clipboardOwnershipLost",
    );
    expect(switchArmsByOutcome(split).get("targetUnavailable")).toBe("false");
  });

  test("records a default arm under its own key, so its presence is assertable", () => {
    expect(switchArmsByOutcome(`${body}            default:\n                true\n`).has("default")).toBe(true);
    expect(switchArmsByOutcome(body).has("default")).toBe(false);
  });
});
