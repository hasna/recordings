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
  | { kind: "unattributable-failure" }
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
  // A failed build from which NO diagnostic could be attributed to this repository cannot be compared
  // against the baseline at all, so it must fail rather than compare equal to it.
  //
  // This is not hypothetical. `errorSignatures` only recognises `path:line:col: error:`, so a linker
  // failure ("ld: symbol(s) not found", "clang: error: linker command failed"), a swift-driver
  // "error: emit-module command failed", or an out-of-disk abort all yield zero signatures. Without
  // this branch, `verdict(false, [], [])` returned `quarantined` and the job exited 0 — a build that
  // failed for a reason nobody parsed would have been GREEN, and green FOREVER once the baseline was
  // emptied, which is exactly what this file's own remediation text tells you to do.
  if (!succeeded && observed.length === 0) return { kind: "unattributable-failure" };
  if (succeeded) {
    if (known.length === 0) return { kind: "clean" };
    return {
      kind: "stale-baseline",
      reason:
        `The native build now SUCCEEDS while ${KNOWN_ERRORS_FILE} still records ${known.length} ` +
        "error(s). Delete the file's entries so this becomes a plain build gate.",
    };
  }
  // Deliberately NOT reporting recorded errors that failed to appear. The whole-package build stops
  // scheduling after its first failure, so most recorded errors are never REACHED and their absence
  // says nothing about whether they are fixed. An earlier version treated that as a stale baseline
  // and failed the job for bookkeeping every single run. Staleness is detected per target instead,
  // where a target that builds clean is real evidence its entries are gone.
  return { kind: "quarantined", observed };
}

export type TargetInfo = { name: string; dir: string; dependencies: string[] };

/**
 * Read the package's targets and their internal dependencies from `swift package dump-package`.
 *
 * The manifest is evaluated rather than parsed, and dumping it works even when the package does not
 * COMPILE, so this stays available in exactly the situation it is needed. A regex over Package.swift
 * would have to re-implement target/path/dependency resolution and would drift the first time a
 * target was declared in a way the regex did not anticipate.
 */
export function targetsFromDump(dump: unknown, packagePath: string): TargetInfo[] {
  const raw = (dump as { targets?: unknown[] })?.targets;
  if (!Array.isArray(raw)) throw new Error("dump-package produced no targets array");
  return raw.map((entry) => {
    const target = entry as {
      name: string;
      path?: string | null;
      dependencies?: unknown[];
    };
    const dependencies: string[] = [];
    for (const dependency of target.dependencies ?? []) {
      // `byName` and `target` are internal references; `product` names a package dependency, which
      // cannot be the thing blocked by an error in THIS repository's sources.
      const named = dependency as { byName?: unknown[]; target?: unknown[] };
      const reference = named.byName?.[0] ?? named.target?.[0];
      if (typeof reference === "string") dependencies.push(reference);
    }
    return {
      name: target.name,
      // SwiftPM defaults an omitted path to Sources/<name>; every target in this package declares
      // one, but relying on that would make the fallback silently wrong rather than absent.
      dir: `${packagePath}/${target.path ?? `Sources/${target.name}`}`.replace(/\/+$/, ""),
      dependencies,
    };
  });
}

/**
 * Targets that cannot be built because a recorded error lives in them, plus everything that depends
 * on those transitively.
 *
 * This is what makes the per-target gate honest. `swift build --build-tests` stops scheduling work
 * after the first failure, and measured on run 30303366777 it reached 41 of 140 tasks and compiled
 * only third-party dependencies — not one of this package's own Swift targets. So "the build failed
 * with only known errors" proves nothing about the other targets: the compiler never looked at them.
 * Everything not blocked is therefore built individually and required to be clean.
 */
export function blockedTargets(targets: TargetInfo[], errorFiles: string[]): string[] {
  const blocked = new Set<string>();
  for (const target of targets) {
    if (errorFiles.some((file) => file === target.dir || file.startsWith(`${target.dir}/`))) {
      blocked.add(target.name);
    }
  }
  // Transitive closure. Iterate to a fixed point rather than recursing, so a dependency cycle in a
  // malformed manifest cannot turn this into a stack overflow.
  for (let changed = true; changed; ) {
    changed = false;
    for (const target of targets) {
      if (blocked.has(target.name)) continue;
      if (target.dependencies.some((dependency) => blocked.has(dependency))) {
        blocked.add(target.name);
        changed = true;
      }
    }
  }
  return [...blocked].sort();
}

/** The source file part of a `<path>: <message>` signature. */
export function signatureFile(signature: string): string {
  return signature.split(": ")[0]!;
}

/** Emit a GitHub Actions step output when running under Actions; a no-op elsewhere. */
function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

/** Run a command, streaming nothing, returning combined output and exit status. */
async function run(command: string[]): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: `${stdout}\n${stderr}`, exitCode };
}

async function main(argv: string[]): Promise<void> {
  const repoRoot = process.cwd();
  const pathIndex = argv.indexOf("--package-path");
  const packagePath = pathIndex >= 0 ? argv[pathIndex + 1]! : "src/native/Recordings";

  // --build-tests compiles the test targets as well as the products, so one invocation covers every
  // line of native code the package knows about — WHEN it succeeds. When it fails it stops early,
  // which is why the per-target pass below exists.
  const whole = ["swift", "build", "--build-tests", "--package-path", packagePath];
  console.log(`$ ${whole.join(" ")}`);
  const { output, exitCode } = await run(whole);
  process.stdout.write(output);

  const known = parseKnownErrors(readFileSync(`${repoRoot}/${KNOWN_ERRORS_FILE}`, "utf8"));
  const observed = errorSignatures(output, repoRoot);
  const result = verdict(exitCode === 0, observed, known);
  setOutput("compiled", exitCode === 0 ? "true" : "false");

  if (result.kind === "clean") {
    console.log("\nNative build is clean: every target and every test target compiles, fully gated.");
    return;
  }
  if (result.kind === "regression") {
    console.log(
      `\n::error title=New native compile error::${result.introduced.length} compile error(s) ` +
        `not recorded in ${KNOWN_ERRORS_FILE} appeared in this change: ` +
        result.introduced.join(" | "),
    );
    process.exit(1);
  }
  if (result.kind === "unattributable-failure") {
    console.log(
      "\n::error title=Native build failed for an unparsed reason::The build exited non-zero but no " +
        "compile diagnostic could be attributed to a file in this repository, so the failure cannot " +
        `be compared against ${KNOWN_ERRORS_FILE}. A linker error, a driver error or an aborted ` +
        "build all look like this. Read the log above; do NOT record anything in the baseline for it.",
    );
    process.exit(1);
  }
  if (result.kind === "stale-baseline") {
    console.log(`\n::error title=Stale native baseline::${result.reason}`);
    process.exit(1);
  }

  // The whole-package build failed with exactly the recorded errors. That alone is NOT evidence about
  // any other target, because the build aborted before reaching them: measured on run 30303366777 it
  // got to 41 of 140 tasks and compiled only third-party dependencies. So build every target that is
  // not blocked by a recorded error, individually, and require each to be clean. This is the
  // difference between "no new error appeared in the 30% that compiled" and a real gate.
  const dump = await run(["swift", "package", "dump-package", "--package-path", packagePath]);
  if (dump.exitCode !== 0) {
    console.log(`\n::error title=Cannot read the package manifest::${dump.output.trim().slice(0, 400)}`);
    process.exit(1);
  }
  const targets = targetsFromDump(JSON.parse(dump.output), packagePath);
  // Blocked is derived from the BASELINE, not from what this build happened to report. The build
  // aborts early, so `observed` names only the errors in whatever compiled first — on this package
  // that is the C launcher, and deriving from it left the four recorded Swift errors in
  // Updater/Protocol unblocked, so the gate demanded that a known-broken target build cleanly.
  const blocked = blockedTargets(targets, known.map(signatureFile));
  const gated = targets.filter((target) => !blocked.includes(target.name)).map((t) => t.name);

  console.log(
    `\nWhole-package build stopped at the recorded errors. Building each target individually: ` +
      `${gated.length} gated, ${blocked.length} blocked by the baseline.\n` +
      `  blocked: ${blocked.join(", ") || "(none)"}\n`,
  );
  if (gated.length === 0) {
    console.log(
      "\n::error title=Nothing could be gated::Every target is blocked by a recorded error, so this " +
        "job proves nothing at all. Fix the recorded errors rather than keeping the baseline.",
    );
    process.exit(1);
  }

  // Surfaced so the `scope` job can name what went uncompiled instead of saying "the native half"
  // and leaving a reader to guess how much of it that is.
  setOutput("blocked", blocked.join(", "));
  setOutput("gatedTargets", String(gated.length));

  const buildTarget = async (name: string) => {
    const attempt = await run(["swift", "build", "--target", name, "--package-path", packagePath]);
    return {
      clean: attempt.exitCode === 0,
      introduced: errorSignatures(attempt.output, repoRoot).filter((s) => !known.includes(s)),
      output: attempt.output,
    };
  };

  const failures: string[] = [];
  for (const name of gated) {
    const { clean, introduced, output } = await buildTarget(name);
    if (clean && introduced.length === 0) {
      console.log(`  ok        ${name}`);
      continue;
    }
    console.log(`  FAILED    ${name}`);
    process.stdout.write(output);
    failures.push(name);
  }

  // The baseline's expiry date, and the reason it is checked HERE. A blocked target that now builds
  // clean is real evidence that its recorded errors are gone, unlike their mere absence from an
  // early-aborting whole-package build. Without this the baseline is permanent by default.
  const revived: string[] = [];
  for (const name of blocked) {
    const { clean } = await buildTarget(name);
    console.log(`  ${clean ? "NOW CLEAN" : "blocked  "} ${name}`);
    if (clean) revived.push(name);
  }

  if (failures.length > 0) {
    console.log(
      `\n::error title=Native target failed to compile::${failures.join(", ")}. Not blocked by any ` +
        `error recorded in ${KNOWN_ERRORS_FILE}, so this is a break introduced by this change.`,
    );
    process.exit(1);
  }
  if (revived.length > 0) {
    console.log(
      `\n::error title=Stale native baseline::${revived.join(", ")} now build cleanly. Delete their ` +
        `entries from ${KNOWN_ERRORS_FILE} so these targets become gated instead of exempt.`,
    );
    process.exit(1);
  }

  console.log(
    `\n::warning title=Native half only PARTLY verified::${gated.length} target(s) compile cleanly ` +
      `(${gated.join(", ")}), but ${blocked.length} could NOT be compiled at all ` +
      `(${blocked.join(", ")}) because of ${known.length} pre-existing error(s) recorded in ` +
      `${KNOWN_ERRORS_FILE}. Nothing in those blocked targets is verified by this run.`,
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
