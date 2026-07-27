import { describe, expect, test } from "bun:test";

import { evaluateSwiftCondition, withoutAnyComments } from "./helpers/source-assertions.js";

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
