import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_ERRORS_FILE,
  errorSignatures,
  normalizeMessage,
  parseKnownErrors,
  verdict,
} from "../../scripts/ci-native-build";

/**
 * Contract test for the native build baseline.
 *
 * The mechanism it protects is the only regression protection the Swift/C half has: `main` does not
 * compile, so a plain build gate would be red on arrival and a soft-failing build would assert
 * nothing at all. Both failure directions are therefore tested explicitly — a NEW error must be
 * caught while the build is already failing, and a FIXED error must invalidate its own baseline
 * entry. A baseline verified only on the state it was recorded from proves nothing.
 */
const repoRoot = join(import.meta.dir, "..", "..");

/**
 * The verbatim diagnostic block from the first native CI run on this repository
 * (run 30302342895, macOS 26.4 / Swift 6.3.2 / Xcode 26.5), with the runner's absolute
 * workspace prefix intact. Using the real text is the point: a hand-written approximation would
 * not have caught that clang appends both the standards rationale and the controlling flag.
 */
const REAL_OUTPUT = [
  "[28/45] Write swift-version-5975E236E64FF690.txt",
  "/Users/runner/work/recordings/recordings/src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c:279:5: error: call to undeclared function 'closefrom'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]",
  "  279 |     closefrom(5);",
  "      |     ^",
  "/Users/runner/work/recordings/recordings/src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c:291:9: error: call to undeclared function 'sandbox_init_with_parameters'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]",
  "  291 |     if (sandbox_init_with_parameters(sandbox_profile, 0, sandbox_parameters, &sandbox_error) != 0) {",
  "      |         ^",
  "/Users/runner/work/recordings/recordings/src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c:292:36: warning: 'sandbox_free_error' is deprecated: first deprecated in macOS 10.8 - No longer supported [-Wdeprecated-declarations]",
  "/Applications/Xcode_26.5.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk/usr/include/sandbox.h:98:6: note: 'sandbox_free_error' has been explicitly marked deprecated here",
  "1 warning and 2 errors generated.",
].join("\n");

const CLOSEFROM =
  "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c: call to undeclared function 'closefrom'";
const SANDBOX_INIT =
  "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c: call to undeclared function 'sandbox_init_with_parameters'";

describe("normalizeMessage", () => {
  test("drops the standards rationale and the controlling flag", () => {
    // Both tails move on a compiler upgrade while the defect does not, so a signature that kept
    // them would need re-recording every time the runner image changed.
    expect(
      normalizeMessage(
        "call to undeclared function 'closefrom'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]",
      ),
    ).toBe("call to undeclared function 'closefrom'");
  });

  test("leaves a message with neither tail untouched", () => {
    expect(normalizeMessage("cannot find 'foo' in scope")).toBe("cannot find 'foo' in scope");
  });
});

describe("errorSignatures", () => {
  const observed = errorSignatures(REAL_OUTPUT, "/Users/runner/work/recordings/recordings");

  test("reads exactly the two errors from the real run", () => {
    expect(observed).toEqual([CLOSEFROM, SANDBOX_INIT].sort());
  });

  test("ignores warnings and notes", () => {
    // `sandbox_free_error` is deprecated and appears twice in that output, as a warning and as a
    // note. Counting either as an error would put a warning in the baseline, where a later
    // compiler promoting it to an error would then be invisible.
    expect(observed.join("\n")).not.toContain("sandbox_free_error");
  });

  test("ignores diagnostics from the SDK and the build cache", () => {
    // A signature naming MacOSX26.5.sdk makes the baseline a function of the runner image, so it
    // would go stale on an image bump and be re-recorded rather than investigated.
    expect(observed.join("\n")).not.toContain("MacOSX");
    expect(
      errorSignatures(
        "/Users/runner/work/recordings/recordings/src/native/Recordings/.build/x/generated.c:1:1: error: boom",
        "/Users/runner/work/recordings/recordings",
      ),
    ).toEqual([]);
  });

  test("deduplicates the same error reported once per target", () => {
    expect(errorSignatures(`${REAL_OUTPUT}\n${REAL_OUTPUT}`, "/Users/runner/work/recordings/recordings"))
      .toHaveLength(2);
  });

  test("does not read a quoted 'error:' inside a message as a diagnostic", () => {
    expect(
      errorSignatures('src/a.swift:1:1: note: the string "x.c:9:9: error: nope" is echoed', repoRoot),
    ).toEqual([]);
  });
});

describe("verdict", () => {
  const known = [CLOSEFROM, SANDBOX_INIT];

  test("a failing build with exactly the recorded errors is quarantined, not a failure", () => {
    expect(verdict(false, known, known)).toEqual({ kind: "quarantined", observed: known });
  });

  test("a NEW error is caught even though the build was already failing", () => {
    // The property that makes this whole mechanism worth having. A `continue-on-error` build would
    // report this identically to the line above.
    const introduced = "src/native/Recordings/App/RecordingsApp.swift: cannot find 'foo' in scope";
    expect(verdict(false, [...known, introduced], known)).toEqual({
      kind: "regression",
      introduced: [introduced],
    });
  });

  test("a fixed error invalidates its own baseline entry", () => {
    const result = verdict(false, [SANDBOX_INIT], known);
    expect(result.kind).toBe("stale-baseline");
    expect(result.kind === "stale-baseline" && result.reason).toContain("closefrom");
  });

  test("a NEW error is reported instead of the recorded one it prevented from being emitted", () => {
    // Compilation stops early, so a new error in an earlier translation unit can keep a recorded
    // one from ever being printed. Reporting the baseline as stale here would bury the regression
    // under a bookkeeping complaint and send someone to edit a list rather than fix their code.
    const introduced = "src/native/Recordings/App/RecordingsApp.swift: cannot find 'foo' in scope";
    expect(verdict(false, [introduced], known)).toEqual({ kind: "regression", introduced: [introduced] });
  });

  test("a build that starts succeeding makes the baseline stale", () => {
    // The expiry date. Without this the exemption is permanent by default, which is how a
    // quarantine becomes a place suites go to be forgotten.
    const result = verdict(true, [], known);
    expect(result.kind).toBe("stale-baseline");
    expect(result.kind === "stale-baseline" && result.reason).toContain("now SUCCEEDS");
  });

  test("a clean build against an empty baseline is a plain pass", () => {
    expect(verdict(true, [], [])).toEqual({ kind: "clean" });
  });
});

describe("the committed native baseline", () => {
  test("every entry is a path/message signature with no line numbers", () => {
    // A signature carrying a line number churns whenever anything above it is edited, and a
    // signature that churns is one nobody maintains — it gets re-recorded rather than read.
    const entries = parseKnownErrors(readFileSync(join(repoRoot, KNOWN_ERRORS_FILE), "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry, `not a "<path>: <message>" signature: ${entry}`).toMatch(/^\S+: \S.*$/);
      expect(entry, `signature carries a line:column: ${entry}`).not.toMatch(/:\d+:\d+:/);
    }
  });

  test("the recorded errors are exactly what the first native CI run produced", () => {
    // Pins the baseline to measured output rather than to a transcription of it.
    const entries = parseKnownErrors(readFileSync(join(repoRoot, KNOWN_ERRORS_FILE), "utf8")).sort();
    expect(entries).toEqual([CLOSEFROM, SANDBOX_INIT].sort());
  });
});
