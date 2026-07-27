#!/usr/bin/env bun
/**
 * Compile the native half and compare the compiler's error SET against a recorded baseline.
 *
 * Why a set comparison rather than a plain build gate: `main` at 32c5538 does not compile, which the
 * first CI run on this repository discovered. The two obvious responses are both wrong.
 *
 *   Gate on a green build — the workflow is red on arrival for a defect it does not own, so it gets
 *     ignored or bypassed, and this repository ends up back where it started.
 *   Let the build fail softly (`continue-on-error`) — the native half then has NO regression
 *     protection whatsoever, and a check that renders green while 87 Swift files went unverified is
 *     the precise false assurance the workflow exists to end.
 *
 * So the baseline is recorded and the SET is gated. A newly introduced compile error is caught on
 * the first run that introduces it, even though the build was already failing. The exemption also
 * expires by itself: if the build starts succeeding, or a recorded error stops appearing, this
 * fails and says to update the file.
 *
 * Usage: bun scripts/ci-native-build.ts [--package-path <dir>]
 */
import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const KNOWN_ERRORS_FILE = ".github/native-known-errors.txt";

/** Parse the baseline file: one `path: message` signature per line, `#` comments dropped. */
export function parseKnownErrors(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Normalize one clang/swift diagnostic message into a stable signature body.
 *
 * Truncated at the first `;` and stripped of the trailing `[-Wflag]`, because clang appends both the
 * standards rationale and the controlling flag to the same message, and neither is a property of the
 * defect. Keeping them would make the signature churn on a compiler upgrade.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\s*\[-[A-Za-z0-9=_-]+\]\s*$/, "")
    .split(";")[0]!
    .trim();
}

/**
 * Extract error signatures from combined build output.
 *
 * Deduplicated: a header included by several targets reports the same error once per target, and a
 * baseline that had to list each repetition would break whenever a target was added.
 */
export function errorSignatures(output: string, repoRoot: string): string[] {
  const signatures = new Set<string>();
  // Anchored on the whole line so that a message merely QUOTING the word "error:" — for instance a
  // Swift string literal echoed back in a note — cannot be read as a diagnostic of its own.
  //
  // `[^:\n]` rather than `[^:]` for the path tail, and the newline exclusion is not cosmetic: with
  // `[^:]` the class happily spans line breaks, so the path captured from real build output began at
  // an unrelated progress line several lines earlier and produced a signature with a newline inside
  // it. The contract test for this function caught exactly that.
  const pattern = /^([^\s:][^:\n]*):(\d+):(\d+): error: (.+)$/gm;
  for (const match of output.matchAll(pattern)) {
    const [, rawPath, , , message] = match;
    if (!rawPath || !message) continue;
    const absolute = resolve(repoRoot, rawPath);
    const path = relative(repoRoot, absolute).split("\\").join("/");
    // A diagnostic from inside the SDK or the build cache is not this repository's source, and
    // pinning one would make the baseline a function of the runner image. `.build` is matched as a
    // path SEGMENT anywhere, not as a prefix: SwiftPM's cache sits at src/native/Recordings/.build,
    // so a prefix test never fires.
    if (path.startsWith("..") || path.split("/").includes(".build")) continue;
    signatures.add(`${path}: ${normalizeMessage(message)}`);
  }
  return [...signatures].sort();
}

export type Verdict =
  | { kind: "clean" }
  | { kind: "stale-baseline"; reason: string }
  | { kind: "quarantined"; observed: string[] }
  | { kind: "regression"; introduced: string[] };

/**
 * Decide the outcome from the build's exit status and its error set.
 *
 * `disappeared` is only reported when nothing new appeared. Compilation stops early, so a brand new
 * error in an earlier translation unit can prevent a recorded one from ever being emitted; blaming
 * the baseline in that case would bury the actual regression under a bookkeeping complaint.
 */
export function verdict(succeeded: boolean, observed: string[], known: string[]): Verdict {
  const introduced = observed.filter((signature) => !known.includes(signature));
  if (introduced.length > 0) return { kind: "regression", introduced };
  if (succeeded) {
    if (known.length === 0) return { kind: "clean" };
    return {
      kind: "stale-baseline",
      reason:
        `The native build now SUCCEEDS while ${KNOWN_ERRORS_FILE} still records ${known.length} ` +
        "error(s). Delete the file's entries so this becomes a plain build gate.",
    };
  }
  const disappeared = known.filter((signature) => !observed.includes(signature));
  if (disappeared.length > 0) {
    return {
      kind: "stale-baseline",
      reason:
        "These recorded errors no longer appear, so the baseline overstates what is broken. " +
        `Remove them from ${KNOWN_ERRORS_FILE}:\n${disappeared.map((s) => `  ${s}`).join("\n")}`,
    };
  }
  return { kind: "quarantined", observed };
}

/** Emit a GitHub Actions step output when running under Actions; a no-op elsewhere. */
function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

async function main(argv: string[]): Promise<void> {
  const repoRoot = process.cwd();
  const pathIndex = argv.indexOf("--package-path");
  const packagePath = pathIndex >= 0 ? argv[pathIndex + 1]! : "src/native/Recordings";

  // --build-tests compiles the test targets as well as the products, so one invocation covers every
  // line of native code the package knows about. Running the plain build too would only re-report
  // the same diagnostics from a subset of the same targets.
  const command = ["swift", "build", "--build-tests", "--package-path", packagePath];
  console.log(`$ ${command.join(" ")}`);
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  process.stdout.write(output);

  const known = parseKnownErrors(readFileSync(`${repoRoot}/${KNOWN_ERRORS_FILE}`, "utf8"));
  const observed = errorSignatures(output, repoRoot);
  const result = verdict(exitCode === 0, observed, known);
  setOutput("compiled", exitCode === 0 ? "true" : "false");

  if (result.kind === "clean") {
    console.log("\nNative build is clean and fully gated.");
    return;
  }
  if (result.kind === "regression") {
    console.log(
      `\n::error title=New native compile error::${result.introduced.length} compile error(s) ` +
        `not recorded in ${KNOWN_ERRORS_FILE} appeared in this change. The native half was ` +
        `already failing, so this is a NEW break: ${result.introduced.join(" | ")}`,
    );
    process.exit(1);
  }
  if (result.kind === "stale-baseline") {
    console.log(`\n::error title=Stale native baseline::${result.reason}`);
    process.exit(1);
  }
  console.log(
    `\n::warning title=Native half NOT verified::swift build fails on main with ` +
      `${result.observed.length} recorded pre-existing error(s), so NO Swift or C in this change ` +
      `has been proven to compile. No NEW compile error was introduced. Recorded errors: ` +
      result.observed.join(" | "),
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
