import { describe, expect, it } from "bun:test";

import {
  expectOrder,
  sliceBetween,
  sliceBetweenUnique,
} from "./helpers/source-assertions";

/**
 * A positive control for the guards themselves.
 *
 * The helpers in `source-assertions.ts` exist to close a hole that a whole class of assertions in
 * this repo fell into: `expect(s.indexOf(a)).toBeLessThan(s.indexOf(b))` is SATISFIED by deleting
 * `a`, because `indexOf` answers -1 and `-1 < n`. Converting 80-odd call sites onto helpers is only
 * worth anything if the helpers actually fail on the inputs the old form let through — a conversion
 * verified only on inputs it allows is another instance of the same bug.
 *
 * So every test here asserts a FAILURE. `expect(...).toThrow()` around a helper call is the point:
 * it proves the guard fires, rather than proving the happy path still passes.
 *
 * WHAT THE SWEEP DELIBERATELY LEFT BEHIND, so the next person does not read the remainder as an
 * oversight. Four files still carry sites of this class:
 *   - `macos-shortcut-contract.test.ts` and `native-paste-delivery-verification-contract.test.ts`
 *     are owned by an unmerged PR that rewrites the same guards; converting them here would have
 *     produced a conflict in the one place a conflict is most expensive.
 *   - `native-secure-input-clipboard-restore-contract.test.ts` is owned by another open PR.
 *   - `native-app-companion-contract.test.ts` fails on CLEAN source, so a mutation battery over it
 *     reports every mutation as caught. It cannot be verified here at all, and converting a file
 *     whose conversions cannot be checked is how vacuous assertions get added rather than removed.
 */
describe("expectOrder", () => {
  const haystack = "alpha\nbeta\ngamma\n";

  it("passes when both operands exist in the asserted order", () => {
    expect(() => expectOrder(haystack, "alpha", "gamma")).not.toThrow();
  });

  it("fails when the FIRST operand is deleted, which the raw indexOf form allowed", () => {
    // The whole defect in one case: "alpha" is gone, so indexOf answers -1, and the old
    // `expect(-1).toBeLessThan(12)` passed. This must now throw.
    expect(() => expectOrder("beta\ngamma\n", "alpha", "gamma")).toThrow(
      /ordering operand is missing entirely: alpha/,
    );
  });

  it("fails when the SECOND operand is deleted, the mirror hole on toBeGreaterThan", () => {
    expect(() => expectOrder("alpha\nbeta\n", "alpha", "gamma")).toThrow(
      /ordering operand is missing entirely: gamma/,
    );
  });

  it("fails when both operands are deleted", () => {
    expect(() => expectOrder("beta\n", "alpha", "gamma")).toThrow(
      /ordering operand is missing entirely/,
    );
  });

  it("still fails on a genuine out-of-order pair, not just on absence", () => {
    expect(() => expectOrder(haystack, "gamma", "alpha")).toThrow();
  });

  it("uses lastIndexOf for the first operand under firstMatch: last", () => {
    const repeated = "guard\nwork\nguard\nfinish\n";
    // The last "guard" precedes "finish"; the first does not decide the assertion.
    expect(() =>
      expectOrder(repeated, "guard", "finish", { firstMatch: "last" }),
    ).not.toThrow();
    // And the -1 hole is closed on that path too: lastIndexOf answers -1 identically.
    expect(() =>
      expectOrder("work\nfinish\n", "guard", "finish", { firstMatch: "last" }),
    ).toThrow(/ordering operand is missing entirely: guard/);
  });
});

describe("sliceBetween", () => {
  const source = "head\nOPEN\nbody line\nCLOSE\ntail\n";

  it("returns the region between existing markers", () => {
    expect(sliceBetween(source, "OPEN", "CLOSE")).toContain("body line");
  });

  it("fails when the start marker is absent instead of slicing from the end", () => {
    // indexOf answers -1, and `slice(-1, n)` silently yields a region that is not the one the
    // caller named. A `not.toContain` over that region reads exactly like a satisfied assertion.
    expect(() => sliceBetween("head\nbody\nCLOSE\n", "OPEN", "CLOSE")).toThrow(
      /slice start marker is missing: OPEN/,
    );
  });

  it("fails when the end marker is absent instead of slicing to the start", () => {
    expect(() => sliceBetween("head\nOPEN\nbody\n", "OPEN", "CLOSE")).toThrow(
      /slice end marker is missing: CLOSE/,
    );
  });

  it("fails when the end marker precedes the start marker", () => {
    expect(() => sliceBetween("CLOSE\nOPEN\n", "OPEN", "CLOSE")).toThrow(
      /slice end marker is missing: CLOSE/,
    );
  });

  it("rejects a region too small to assert anything about", () => {
    // The length floor is not decoration. `slice(-1)` yields a ONE-CHARACTER string, so a
    // `region.length > 0` control passes on a region containing nothing worth checking, and every
    // assertion inside it is vacuous.
    expect(() => sliceBetween("OPENCLOSE", "OPEN", "CLOSE")).toThrow(
      /too small to assert anything about/,
    );
    expect(() =>
      sliceBetween(source, "OPEN", "CLOSE", { minimumLength: 10_000 }),
    ).toThrow(/too small to assert anything about/);
  });
});

describe("sliceBetweenUnique", () => {
  it("accepts markers that occur exactly once", () => {
    expect(() =>
      sliceBetweenUnique("head\nOPEN\nbody line\nCLOSE\ntail\n", "OPEN", "CLOSE"),
    ).not.toThrow();
  });

  it("fails when the end marker is duplicated, which silently extends the region", () => {
    // A duplicated bound lets a region stretch far past the function under test and be satisfied by
    // a copy of the needle from somewhere unrelated.
    expect(() =>
      sliceBetweenUnique("OPEN\nbody\nCLOSE\nmore\nCLOSE\n", "OPEN", "CLOSE"),
    ).toThrow(/end marker is not unique \(2x\): CLOSE/);
  });

  it("fails when the start marker is duplicated", () => {
    expect(() =>
      sliceBetweenUnique("OPEN\nbody\nOPEN\nCLOSE\n", "OPEN", "CLOSE"),
    ).toThrow(/start marker is not unique \(2x\): OPEN/);
  });

  it("fails when a marker is absent, reported as a uniqueness count of zero", () => {
    expect(() => sliceBetweenUnique("body\nCLOSE\n", "OPEN", "CLOSE")).toThrow(
      /start marker is not unique \(0x\): OPEN/,
    );
  });
});
