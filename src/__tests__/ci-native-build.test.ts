import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_ERRORS_FILE,
  blockedTargets,
  errorSignatures,
  normalizeMessage,
  parseKnownErrors,
  signatureFile,
  targetsFromDump,
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

  test("a FAILED build with no attributable diagnostic is a failure, not a quarantine", () => {
    // The hole an adversarial review found in the first version: this returned `quarantined`, which
    // main() treats as success, so a build that failed for a reason the parser does not recognise
    // exited 0. Worse, it was green FOREVER once the baseline was emptied -- which is exactly what
    // the tool's own remediation message instructs you to do.
    expect(verdict(false, [], [])).toEqual({ kind: "unattributable-failure" });
    expect(verdict(false, [], known)).toEqual({ kind: "unattributable-failure" });
  });

  test("the failure modes that produce no attributable diagnostic really do parse to nothing", () => {
    // Establishes that the branch above is reachable rather than defensive. None of these carry a
    // `path:line:col: error:` shape, so errorSignatures returns [] for all of them.
    for (const output of [
      "ld: symbol(s) not found for architecture arm64",
      "clang: error: linker command failed with exit code 1 (use -v to see invocation)",
      "error: emit-module command failed with exit code 1 (use -v to see invocation)",
      "error: terminated(2): /usr/bin/xcrun --sdk macosx ...",
    ]) {
      expect(errorSignatures(output, "/repo"), `should not parse: ${output}`).toEqual([]);
      expect(verdict(false, errorSignatures(output, "/repo"), known).kind).toBe(
        "unattributable-failure",
      );
    }
  });
});

describe("targetsFromDump and blockedTargets", () => {
  /**
   * Shaped like real `swift package dump-package` output for this package, including the two
   * dependency encodings SwiftPM emits (`byName` for an internal reference, `product` for one that
   * comes from a package dependency) and the actual VerifierLauncher relationship.
   */
  const dump = {
    targets: [
      { name: "RecordingsLib", path: "RecordingsLib", dependencies: [{ product: ["KeyboardShortcuts", "KeyboardShortcuts", null, null] }] },
      { name: "App", path: "App", dependencies: [{ byName: ["RecordingsLib", null] }] },
      { name: "RecordingsUpdateProtocol", path: "Updater/Protocol", dependencies: [] },
      { name: "RecordingsVerifierLauncher", path: "Updater/VerifierLauncher", dependencies: [] },
      {
        name: "RecordingsUpdateBroker",
        path: "Updater/Broker",
        dependencies: [{ byName: ["RecordingsUpdateProtocol", null] }, { byName: ["RecordingsVerifierLauncher", null] }],
      },
      { name: "RecordingsUpdateBrokerTests", path: "Updater/BrokerTests", dependencies: [{ byName: ["RecordingsUpdateBroker", null] }] },
      { name: "RecordingsTests", path: "RecordingsTests", dependencies: [{ byName: ["RecordingsLib", null] }, { product: ["Testing", "swift-testing", null, null] }] },
    ],
  };
  const targets = targetsFromDump(dump, "src/native/Recordings");

  test("resolves each target's repo-relative directory", () => {
    expect(targets.find((t) => t.name === "RecordingsVerifierLauncher")?.dir).toBe(
      "src/native/Recordings/Updater/VerifierLauncher",
    );
  });

  test("keeps internal dependencies and drops package products", () => {
    // A product comes from another repository, so it can never be the thing blocked by an error in
    // this one. Counting it would make swift-testing look like a blocked local target.
    expect(targets.find((t) => t.name === "RecordingsTests")?.dependencies).toEqual(["RecordingsLib"]);
    expect(targets.find((t) => t.name === "RecordingsLib")?.dependencies).toEqual([]);
  });

  test("defaults an omitted path to Sources/<name>", () => {
    expect(targetsFromDump({ targets: [{ name: "Foo", dependencies: [] }] }, "pkg")[0]?.dir).toBe(
      "pkg/Sources/Foo",
    );
  });

  test("blocks the target owning the failing file and its transitive dependents only", () => {
    // The measured reality for this package: the C launcher fails, so the broker and the broker's
    // tests cannot build — but RecordingsLib, App, the protocol and RecordingsTests are untouched by
    // it and MUST still be gated. Treating the whole package as unverifiable would discard almost
    // all of the available coverage.
    expect(
      blockedTargets(targets, [
        "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
      ]),
    ).toEqual(["RecordingsUpdateBroker", "RecordingsUpdateBrokerTests", "RecordingsVerifierLauncher"]);
  });

  test("blocks nothing when there are no recorded errors", () => {
    expect(blockedTargets(targets, [])).toEqual([]);
  });

  test("does not block a sibling target that merely shares a parent directory", () => {
    // `Updater/Protocol` and `Updater/VerifierLauncher` share the `Updater` prefix. A prefix test
    // without the boundary slash would block the protocol, and through it every updater target.
    const blocked = blockedTargets(targets, [
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    ]);
    expect(blocked).not.toContain("RecordingsUpdateProtocol");
    expect(blocked).not.toContain("RecordingsTests");
  });

  test("terminates on a dependency cycle instead of overflowing the stack", () => {
    const cyclic = targetsFromDump(
      {
        targets: [
          { name: "A", path: "a", dependencies: [{ byName: ["B", null] }] },
          { name: "B", path: "b", dependencies: [{ byName: ["A", null] }] },
          { name: "C", path: "c", dependencies: [] },
        ],
      },
      "pkg",
    );
    expect(blockedTargets(cyclic, ["pkg/a/x.c"])).toEqual(["A", "B"]);
  });

  test("signatureFile recovers the path from a signature", () => {
    expect(signatureFile(CLOSEFROM)).toBe(
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    );
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
