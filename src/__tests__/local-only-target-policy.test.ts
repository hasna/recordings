import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH,
  RELEASE_APPROVED_TARGET,
  isLocalOnlyApprovedTarget,
  localOnlyApprovedTargets,
} from "../../scripts/macos_artifact";

// Resolved from this module, not the working directory, so the suite passes from
// any cwd (bun test is routinely invoked from a subdirectory).
const repositoryRoot = new URL("../../", import.meta.url).pathname;
const readRepositoryFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8");

const policyRelativePath = "scripts/policy/local-only-approved-targets.txt";
const readerRelativePath = "scripts/read_local_only_targets.sh";

function withPolicyFile<T>(contents: string, run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "recordings-target-policy-"));
  const path = join(directory, "local-only-approved-targets.txt");
  writeFileSync(path, contents);
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/// Writes `contents` to a real file and additionally exposes a symlink pointing at it,
/// so the two readers can be compared on a policy path that is not a regular file.
function withPolicySymlink<T>(
  contents: string,
  run: (symlinkPath: string, targetPath: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), "recordings-target-policy-link-"));
  const target = join(directory, "real-policy.txt");
  const link = join(directory, "local-only-approved-targets.txt");
  writeFileSync(target, contents);
  symlinkSync(target, link);
  try {
    return run(link, target);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/// Runs the real sourced shell reader so its verdict can be compared against the
/// TypeScript reader. A divergence between them would let a target pass the build
/// and then fail the install, which is the failure this contract exists to prevent.
function shellReaderVerdictAtPath(
  path: string,
  requested: string,
  options: { preamble?: string; env?: Record<string, string> } = {},
): { ok: boolean; matched: boolean; list: string; stderr: string } {
  const script = `
set -euo pipefail
${options.preamble ?? ""}
. ${JSON.stringify(join(repositoryRoot, readerRelativePath))}
LIST=""
MATCHED=0
read_local_only_targets ${JSON.stringify(path)} LIST MATCHED ${JSON.stringify(requested)}
printf 'LIST=%s\\nMATCHED=%s\\n' "$LIST" "$MATCHED"
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
  const stdout = result.stdout.toString();
  return {
    ok: result.exitCode === 0,
    matched: /^MATCHED=1$/m.test(stdout),
    list: stdout.match(/^LIST=(.*)$/m)?.[1] ?? "",
    stderr: withoutSetlocaleWarnings(result.stderr.toString()),
  };
}

/**
 * Drops bash's own `warning: setlocale:` lines from a captured stderr.
 *
 * The hostile-locale test asks for `LC_ALL=en_US.UTF-8`. On a machine where that locale is
 * not installed — a slim CI image, or `Dockerfile.package`'s `oven/bun:*-alpine`, where musl
 * has no glibc locales at all — bash cannot honour it and writes
 * `bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)` to the very stderr
 * this suite compares against the TypeScript reader byte for byte. That turned CORRECT code
 * RED, and it did so with a message that reads like a reader divergence, which is the exact
 * confusion this contract exists to end. bash emits it a second time when the function-local
 * `LC_ALL` goes out of scope, so a single-line filter is not enough.
 *
 * This only ever removes bash's own diagnostics. Both readers prefix every message they own
 * with "Local-only approved target policy", so no reader output can be swallowed here — and a
 * policy that produced NO reader message would still fail the `not.toBe("")` assertion.
 */
function withoutSetlocaleWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/warning: setlocale/.test(line))
    .join("\n");
}

function shellReaderVerdict(
  policyContents: string,
  requested: string,
): { ok: boolean; matched: boolean; list: string; stderr: string } {
  return withPolicyFile(policyContents, (path) => shellReaderVerdictAtPath(path, requested));
}

/// The TypeScript reader's verdict in the same shape, so a case can assert that both
/// readers rejected *for the same reason* rather than merely that both rejected. "Both
/// fail" is a weaker property than this contract claims: two readers can fail the same
/// input for unrelated reasons and still disagree on the next input.
function typeScriptReaderVerdict(
  path: string,
): { ok: boolean; message: string; targets: string[] } {
  try {
    return { ok: true, message: "", targets: localOnlyApprovedTargets(path) };
  } catch (error) {
    return { ok: false, message: (error as Error).message, targets: [] };
  }
}

/// Both readers print the same sentences with a different LEADING capital ("Local-only …"
/// from the shell, "local-only …" from TypeScript), so fold that one character and compare
/// everything after it exactly, without trailing punctuation.
///
/// Deliberately NOT String.trim(): trim() strips U+000B, U+000C, U+00A0 and U+FEFF, which
/// are precisely the characters this contract is about. Both readers echo the offending
/// target name back in the message, so trim() here would silently normalise away a
/// difference confined to that name's trailing bytes — the comparison would report
/// agreement it had not checked. ASCII space and tab only, same rule as the readers.
///
/// And deliberately NOT String.toLowerCase(), for the same reason one step further. The
/// echoed target name is the only variable part of these messages, and CASE is the very axis
/// of the locale finding this suite exists to pin — a blanket toLowerCase() made
/// "…invalid target name: STATION03" and "…invalid target name: station03" compare EQUAL, so
/// a reader that upper-cased the name it echoed went undetected and the test called
/// "byte-exact" was not comparing bytes. Only the first character is folded, which is the
/// only place the two readers legitimately differ.
const normalizeReaderMessage = (message: string): string =>
  message
    .replace(/\n$/, "")
    .replace(/^[\t ]+|[\t ]+$/g, "")
    .replace(/^(.)/, (first) => first.toLowerCase())
    .replace(/\.$/, "");

describe("local-only approved target policy", () => {
  test("both shell entry points use the one sourced reader, not their own parser", () => {
    const installer = readRepositoryFile("scripts/install_macos_app.sh");
    const builder = readRepositoryFile("src/native/Recordings/build.sh");
    for (const script of [installer, builder]) {
      expect(script).toContain(policyRelativePath);
      expect(script).toContain(readerRelativePath);
      expect(script).toContain("read_local_only_targets");
      // A private loop in either script is how the three parsers drifted apart.
      expect(script).not.toContain("while IFS= read -r policy_line");
    }
    // No bare hostname literal may remain in either guard.
    expect(installer).not.toContain('"$APPROVED_TARGET" != "station06"');
    expect(builder).not.toContain('"$LOCAL_APPROVED_TARGET" != "station06"');
  });

  test("the builder requires the policy and the reader inside the archived snapshot", () => {
    const builder = readRepositoryFile("src/native/Recordings/build.sh");
    expect(builder).toContain(`"$SOURCE_PACKAGE_ROOT/${policyRelativePath}"`);
    expect(builder).toContain(`"$SOURCE_PACKAGE_ROOT/${readerRelativePath}"`);
  });

  test("the builder's gate resolves the policy and the reader from the archived snapshot", () => {
    // The assertion above is satisfied by the required-snapshot-input loop alone, and was:
    // it passed while the gate itself read ${PACKAGE_ROOT} — the mutable working tree. So
    // pin the gate's own two assignments, and forbid $PACKAGE_ROOT in either of them.
    const builder = readRepositoryFile("src/native/Recordings/build.sh");
    expect(builder).toContain(
      `LOCAL_TARGET_POLICY="\${SOURCE_PACKAGE_ROOT}/${policyRelativePath}"`,
    );
    expect(builder).toContain(
      `LOCAL_TARGET_READER="\${SOURCE_PACKAGE_ROOT}/${readerRelativePath}"`,
    );
    expect(builder).not.toContain(`LOCAL_TARGET_POLICY="\${PACKAGE_ROOT}`);
    expect(builder).not.toContain(`LOCAL_TARGET_READER="\${PACKAGE_ROOT}`);
  });

  test("actually ships the policy and the reader in the published tarball", () => {
    // --ignore-scripts: `prepack` is a full native macOS build and is not what this
    // contract is about; the tarball file list is resolved from `files` regardless.
    const packed = Bun.spawnSync(
      ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repositoryRoot },
    );
    expect(packed.exitCode).toBe(0);
    const files = (JSON.parse(packed.stdout.toString()) as { files: { path: string }[] }[])[0]
      ?.files.map((entry) => entry.path) ?? [];
    expect(files).toContain(policyRelativePath);
    expect(files).toContain(readerRelativePath);
  }, 120_000);

  test("declares both approved local-only targets", () => {
    const targets = localOnlyApprovedTargets();
    expect(targets).toContain("station03");
    expect(targets).toContain("station06");
    expect(isLocalOnlyApprovedTarget("station03")).toBeTrue();
    expect(isLocalOnlyApprovedTarget("station06")).toBeTrue();
  });

  test("rejects targets that are not declared in the policy", () => {
    expect(isLocalOnlyApprovedTarget("station05")).toBeFalse();
    expect(isLocalOnlyApprovedTarget(undefined)).toBeFalse();
    expect(isLocalOnlyApprovedTarget("")).toBeFalse();
  });

  test("never accepts the release fleet target as a local-only target", () => {
    expect(isLocalOnlyApprovedTarget(RELEASE_APPROVED_TARGET)).toBeFalse();
    withPolicyFile(`${RELEASE_APPROVED_TARGET}\n`, (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("must not list the release fleet target");
    });
  });

  test("fails closed on an empty, duplicated, or malformed policy", () => {
    withPolicyFile("# only comments\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("lists no targets");
    });
    withPolicyFile("station03\nstation03\n", (path) => {
      expect(() => localOnlyApprovedTargets(path)).toThrow("duplicate targets");
    });
    for (const malformed of ["Station03", "station 03", "-station03", "station03-", "s", "*", "a".repeat(64)]) {
      withPolicyFile(`${malformed}\n`, (path) => {
        expect(() => localOnlyApprovedTargets(path)).toThrow("invalid target name");
      });
    }
  });

  test("the shell reader and the TypeScript reader agree on every policy shape", () => {
    const accepted = [
      "station03\nstation06\n",
      "station03\r\nstation06\r\n",
      "\ufeffstation03\nstation06\n",
      "  station03  \n\tstation06\t\n",
      "# comment\n\n  # indented comment\nstation03\n",
      "station03",
    ];
    for (const contents of accepted) {
      const shell = shellReaderVerdict(contents, "station03");
      expect(shell.ok, JSON.stringify(contents)).toBeTrue();
      expect(shell.matched, JSON.stringify(contents)).toBeTrue();
      const typeScript = withPolicyFile(contents, (path) => typeScriptReaderVerdict(path));
      expect(typeScript.ok, JSON.stringify(contents)).toBeTrue();
      // Compare the RESOLVED ALLOWLISTS, not just that both accepted and both mention
      // station03. Two readers can accept the same file and still disagree about what is
      // in it — a dropped or extra target is the whole risk here — and asserting only
      // `toContain("station03")` cannot see that.
      expect(shell.list, JSON.stringify(contents)).toBe(typeScript.targets.join(", "));
    }

    const rejected = [
      "fleet\nstation06\n",
      "station03\nstation03\n",
      "STATION07\n",
      "station 03\n",
      "../../../etc/passwd\n",
      "*\n",
      "-station03\n",
      "station03-\n",
      "s\n",
      // Both length bounds, from both sides. The corpus held a 1-character target and a
      // 64-character one, and 64 lived only in a TypeScript-only test — so nothing here
      // constrained the SHARED verdict anywhere near the limits, and widening either
      // reader's bound in isolation went unnoticed: shell `-lt 3`->`-lt 2` accepted "st",
      // shell `-gt 32`->`-gt 64` accepted 33 characters, and the TypeScript
      // `{1,30}`->`{1,60}` accepted 33 too. Each of those is the divergence direction this
      // contract exists to close, with the build gate open and the install validator shut.
      // Both readers bound a target to 3..32 characters, so 2 and 33 are the first
      // rejected value on each side.
      "st\n",
      `${"a".repeat(33)}\n`,
      "# only comments\n",
      "   \n\t\n",
      // Non-ASCII whitespace and NUL. These five diverged before: JS trim() strips
      // U+FEFF and U+00A0 (both ECMAScript WhiteSpace) while bash's [[:space:]] under
      // LC_ALL=C does not, and bash `read` silently discards NUL — so
      // "station03\0station99" parsed as the single target "station03station99",
      // quietly dropping station03 from the allowlist. Both readers must now reject.
      "station03\u00a0\n",
      "\u00a0station03\n",
      "station03\ufeff\n",
      "station03\u0000station99\n",
      "station03\u0000\n",
    ];
    // ASCII control whitespace that is inside [[:space:]] but outside /[\t ]/, and a BOM
    // anywhere but offset 0. These are the shapes on which the two readers actually
    // disagreed while the matrix above passed, which is why they are called out here:
    //   * VT (U+000B) and FF (U+000C): the shell reader trimmed them and ACCEPTED
    //     "station03\v"; the TypeScript reader trims /[\t ]/ only and rejected it.
    //   * A BOM on any line after the first: the shell reader stripped one per line and
    //     accepted it; the TypeScript reader strips only at offset 0 and rejected it.
    // Neither reader trims or strips them now, so the hostname shape refuses both ends.
    const divergentByteShapes = [
      "station03\u000b\nstation06\n",
      "\u000bstation03\nstation06\n",
      "station03\u000c\nstation06\n",
      "\u000cstation03\nstation06\n",
      "station03\n\ufeffstation06\n",
      "# comment\n\ufeffstation03\n",
      // A NUL on a COMMENT line. The TypeScript reader had no NUL scan at all and only
      // ever refused one that happened to land inside a would-be hostname, so it dropped
      // "# comment\u0000" as a comment and ACCEPTED a file the shell gate refuses to read.
      // The old matrix missed this because it only placed NUL inside hostnames, where both
      // readers rejected — for different reasons, which is why this loop compares reasons.
      "# comment\u0000\nstation03\nstation06\n",
      "\u0000\nstation03\n",
    ];

    // Policies that break TWO rules at once. These are where the readers disagreed on the
    // REASON while agreeing on the verdict: the shell used to finish validating each line
    // before reading the next, so it reported whichever rule broke first by LINE, while
    // TypeScript reports whichever breaks first by RULE (names, then duplicates, then
    // fleet). "fleet\nfleet\n" was "must not list the release fleet target" here and "has
    // duplicate targets" there. No gate ever opened on these -- both readers always refused
    // -- but a contract that compares reasons has to actually hold, and over 1500 generated
    // multi-violation policies this class produced 160 reason divergences before the shell
    // reader was restructured into the same four phases as the TypeScript one.
    const multipleViolations = [
      "fleet\nfleet\n",
      "fleet\nBAD\n",
      "BAD\nfleet\n",
      "station03\nstation03\nBAD\n",
      "station03\nfleet\nstation03\n",
      "station03\nstation03\nfleet\n",
      "fleet\ns\n",
    ];

    for (const contents of [...rejected, ...divergentByteShapes, ...multipleViolations]) {
      const shell = shellReaderVerdict(contents, "station03");
      expect(shell.ok).toBeFalse();
      expect(shell.matched).toBeFalse();
      expect(shell.stderr).not.toBe("");
      const typeScript = withPolicyFile(contents, (path) => typeScriptReaderVerdict(path));
      expect(typeScript.ok).toBeFalse();
      // Same refusal, not merely two refusals. "Both threw" is weaker than this contract
      // claims: two parsers can reject one input for unrelated reasons and still diverge
      // on the next. Comparing the reason is what makes this one policy.
      expect(normalizeReaderMessage(typeScript.message)).toBe(
        normalizeReaderMessage(shell.stderr),
      );
    }
  }, 120_000);

  test("the two readers trim exactly ASCII space and tab, and agree on every whitespace codepoint", () => {
    // An enumerated table rather than a handful of cases, because the hand-picked corpus
    // was what let this drift: on the unpinned [[:space:]] reader, 21 of these 36 rows
    // diverged, and the shell side ACCEPTED a target the TypeScript validator rejects in
    // every one of them. Most were Unicode whitespace that bash's [[:space:]] matches in
    // the caller's ambient UTF-8 locale (U+1680, U+2000, U+2002, U+2009, U+205F, U+2028,
    // U+2029, U+3000), and none were reachable from a corpus that only tried NBSP and BOM.
    //
    // Attribution, measured rather than assumed: the ASCII-only trim closes all 21 rows by
    // itself, and removing the reader's LC_ALL=C pin changes no verdict in this table. So
    // this table is not evidence for that pin and does not claim to be.
    //
    // Only U+0020 and U+0009 may be trimmed. U+000D is trimmed at end of line only, as a
    // CRLF line ending, so it is the one row whose two positions legitimately differ.
    const trimmable = new Set(["\u0020", "\u0009"]);
    const whitespaceCodepoints = [
      "\u0020", "\u0009", "\u000b", "\u000c", "\u000d", "\u0000",
      "\u0085", "\u00a0", "\u1680", "\u2000", "\u2002", "\u2009",
      "\u202f", "\u205f", "\u2028", "\u2029", "\u3000", "\ufeff",
    ];

    for (const codepoint of whitespaceCodepoints) {
      const positions: [string, string][] = [
        ["leading", `${codepoint}station06\n`],
        ["trailing", `station06${codepoint}\n`],
      ];
      for (const [position, contents] of positions) {
        const shell = shellReaderVerdict(contents, "station06");
        const typeScript = withPolicyFile(contents, (path) => typeScriptReaderVerdict(path));
        const where = `U+${codepoint.codePointAt(0)!.toString(16).padStart(4, "0")} ${position}`;
        // The property under test is agreement, asserted first so a divergence names itself.
        expect(shell.ok, where).toBe(typeScript.ok);

        const acceptable =
          trimmable.has(codepoint) ||
          (codepoint === "\u000d" && position === "trailing") ||
          (codepoint === "\ufeff" && position === "leading");
        expect(shell.ok, where).toBe(acceptable);
      }
    }
  }, 120_000);

  test("the shell reader stays byte-exact under a hostile locale", () => {
    // This is the guard for `local LC_ALL=C LANG=C` in the reader, and it is not vacuous —
    // but it only bites if you first defeat the thing that hides the problem on Linux.
    //
    // `[a-z0-9-]` and `[!a-z]` are bracket RANGES, and range endpoints are resolved by
    // COLLATION. Under a UTF-8 locale collation interleaves case (a A b B c C …), so
    // `[a-z]` matches uppercase and "STATION07" parses as a valid target — while the
    // TypeScript reader rejects it unconditionally. Build gate open, install validator
    // closed: this PR's entire failure mode.
    //
    // The `globasciiranges` shopt forces ASCII range semantics whatever the locale, and it is
    // what hides this on this box. Which bash matters, and the obvious summary is wrong: per
    // bash's NEWS the option was INTRODUCED in 4.3 (§4.3 e.) but only became ENABLED BY
    // DEFAULT in 5.0 (§5.0 hh.) — so 4.3 and 4.4 are exposed just as 3.2 is. macOS ships
    // /bin/bash 3.2.57, which has no such option at all,
    // and src/native/Recordings/build.sh is `#!/bin/bash` and exports no
    // locale of its own — so on the Mac that actually builds artifacts, the reader's
    // function-local pin is the only thing between the caller's LANG and the allowlist.
    // `shopt -u globasciiranges` reproduces those pre-4.3 semantics on the bash we have.
    //
    // Without this preamble the test passes with the pin deleted, which is exactly how an
    // earlier revision of this branch talked itself into calling the pin unguarded.
    const hostile = {
      preamble: "shopt -u globasciiranges",
      env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
    };
    // One input is not the hole; the hole is a CLASS. A change that special-cased uppercase
    // while deleting the pin would keep a STATION07-only test green, so the corpus spans the
    // range behaviours that actually differ under collation:
    //   * "STATION07" — the reported case: A-Y interleave into `[a-z]`.
    //   * "Station03" — uppercase away from the range endpoints.
    //   * "stationé"  — NON-ASCII, and the reason this list is not "the uppercase test".
    //                   Collated `[a-z0-9-]` admits it; the TypeScript regex never does.
    //   * "ZEBRA07"   — `Z` does NOT collate into `[a-z]` the way A-Y do. Pinning the
    //                   asymmetry stops someone "simplifying" the corpus to one endpoint.
    const hostileTargets = ["STATION07", "Station03", "stationé", "ZEBRA07"];

    // Collected rather than asserted in the loop so a regression names the exact target and
    // the exact property, instead of failing on whichever one happens to run first.
    const observed = hostileTargets.map((target) => {
      const policy = `${target}\n`;
      const shell = withPolicyFile(policy, (path) =>
        shellReaderVerdictAtPath(path, target, hostile),
      );
      // The TypeScript reader has no locale to pin, so it is the fixed reference: whatever
      // the shell does under a hostile locale, it must match this.
      const typeScript = withPolicyFile(policy, (path) => typeScriptReaderVerdict(path));
      return {
        target,
        shellRefused: !shell.ok && !shell.matched,
        shellSaysInvalidName: shell.stderr.includes("invalid target name"),
        typeScriptRefused: !typeScript.ok,
        readersAgree:
          normalizeReaderMessage(typeScript.message) === normalizeReaderMessage(shell.stderr),
      };
    });

    expect(observed).toEqual(
      hostileTargets.map((target) => ({
        target,
        shellRefused: true,
        shellSaysInvalidName: true,
        typeScriptRefused: true,
        readersAgree: true,
      })),
    );

    // A legitimate policy must still parse identically under the same hostile locale, so
    // the assertion above is about byte-exactness and not about refusing everything.
    const legitimate = withPolicyFile("station03\nstation06\n", (path) =>
      shellReaderVerdictAtPath(path, "station03", hostile),
    );
    expect(legitimate.ok).toBeTrue();
    expect(legitimate.matched).toBeTrue();
    expect(legitimate.list).toBe("station03, station06");
    // Same 120 s budget as the eight other subprocess-spawning tests in this file. This one
    // spawns bash three times and measured 163-283 ms at loadavg 66-87, so the headroom is
    // ~20x — but bun's 5 s default aborts under load and reports `Received: ""`, which reads
    // exactly like a reader divergence. This box has been at loadavg 161 today.
  }, 120_000);

  test("both readers refuse a symlinked policy instead of following it", () => {
    // The chosen semantics is REJECT in both, and the direction matters: `[ -L ]` already
    // refused here while readFileSync() followed the link there, so a policy symlinked at
    // a widened allowlist was blocked by the shell gate and silently honoured by the
    // TypeScript validator that re-checks the target at install time. A symlink is never a
    // legitimate shape for package-local policy data shipped inside the tarball, and the
    // policy file's own header already documented "regular file, not a symlink" — so the
    // TypeScript reader was the side that had broken the stated rule.
    withPolicySymlink("station03\nstation06\nattacker\n", (link, target) => {
      const shell = shellReaderVerdictAtPath(link, "attacker");
      expect(shell.ok).toBeFalse();
      expect(shell.matched).toBeFalse();
      expect(shell.stderr).toContain("policy is missing");

      const typeScript = typeScriptReaderVerdict(link);
      expect(typeScript.ok).toBeFalse();
      expect(typeScript.message).toContain("policy is missing");
      expect(normalizeReaderMessage(typeScript.message)).toBe(
        normalizeReaderMessage(shell.stderr),
      );

      // The link target is a perfectly readable regular file listing "attacker", so the
      // refusal is about the symlink and not about unreadable content. Without this the
      // assertions above would also pass on a simply broken fixture — and it pins what
      // the old TypeScript reader returned, which was this widened list.
      expect(typeScriptReaderVerdict(target).ok).toBeTrue();
      expect(localOnlyApprovedTargets(target)).toContain("attacker");
      expect(shellReaderVerdictAtPath(target, "attacker").matched).toBeTrue();
    });
  }, 120_000);

  test("refusing symlinks applies to the policy file itself, not to symlinked ancestors", () => {
    // The granularity is the whole point of the previous test being safe to ship. `[ -L ]`
    // and lstat() both inspect only the FINAL component, so a policy reached through a
    // symlinked package root or a symlinked scripts/ directory still resolves — which is
    // what pnpm and yarn do to every installed package. Tightening this to "no symlink
    // anywhere on the path" (realpath comparison, say) would refuse a perfectly normal
    // install, so pin the distinction rather than leaving it to be rediscovered.
    const root = mkdtempSync(join(tmpdir(), "recordings-policy-ancestor-"));
    try {
      const real = join(root, "real");
      mkdirSync(join(real, "scripts", "policy"), { recursive: true });
      const policy = join(real, "scripts", "policy", "local-only-approved-targets.txt");
      writeFileSync(policy, "station03\nstation06\n");

      const linkedRoot = join(root, "linked-package-root");
      const linkedScripts = join(root, "linked-scripts");
      symlinkSync(real, linkedRoot);
      symlinkSync(join(real, "scripts"), linkedScripts);

      const reachedThroughSymlinkedAncestors = [
        policy,
        join(linkedRoot, "scripts", "policy", "local-only-approved-targets.txt"),
        join(linkedScripts, "policy", "local-only-approved-targets.txt"),
      ];
      for (const path of reachedThroughSymlinkedAncestors) {
        const shell = shellReaderVerdictAtPath(path, "station03");
        expect(shell.ok, path).toBeTrue();
        expect(shell.matched, path).toBeTrue();
        expect(typeScriptReaderVerdict(path).ok, path).toBeTrue();
        expect(localOnlyApprovedTargets(path)).toEqual(["station03", "station06"]);
      }

      // ...and the final component being a link is still refused, in the same directory,
      // so the two outcomes are separated by exactly one thing.
      const finalComponentLink = join(root, "policy-as-link.txt");
      symlinkSync(policy, finalComponentLink);
      expect(shellReaderVerdictAtPath(finalComponentLink, "station03").ok).toBeFalse();
      expect(typeScriptReaderVerdict(finalComponentLink).ok).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("the shell reader does not silently succeed when the requested target is last", () => {
    // A trailing `&& VAR=1` inside the loop makes the compound return non-zero under
    // `set -e` whenever the final line is not the requested target; assert both ends.
    for (const requested of ["station03", "station06"]) {
      const shell = shellReaderVerdict("station03\nstation06\n", requested);
      expect(shell.ok).toBeTrue();
      expect(shell.matched).toBeTrue();
      expect(shell.list).toBe("station03, station06");
    }
    const unapproved = shellReaderVerdict("station03\nstation06\n", "station05");
    expect(unapproved.ok).toBeTrue();
    expect(unapproved.matched).toBeFalse();
  }, 120_000);

  test("the shell reader rejects a missing, symlinked, or non-regular policy", () => {
    // This test's name promised symlink coverage and asserted only the missing case, so
    // the `[ -L ]` arm of the reader's first guard was never executed by anything. It is
    // the arm the TypeScript reader disagreed with, so "unexercised" was not harmless.
    const missing = shellReaderVerdictAtPath("/nonexistent/policy.txt", "station03");
    expect(missing.ok).toBeFalse();
    expect(missing.stderr).toContain("policy is missing");

    withPolicySymlink("station03\nstation06\n", (link) => {
      const symlinked = shellReaderVerdictAtPath(link, "station03");
      expect(symlinked.ok).toBeFalse();
      expect(symlinked.matched).toBeFalse();
      expect(symlinked.stderr).toContain("policy is missing");
    });

    // A directory and a dangling link are also not regular files; both readers refuse
    // them by the same rule rather than by whatever error reading them would raise.
    const directory = mkdtempSync(join(tmpdir(), "recordings-target-policy-dir-"));
    try {
      const asDirectory = shellReaderVerdictAtPath(directory, "station03");
      expect(asDirectory.ok).toBeFalse();
      expect(asDirectory.stderr).toContain("policy is missing");
      expect(typeScriptReaderVerdict(directory).message).toContain("policy is missing");

      // Mode 000: readable by lstat, unreadable by read. The shell reader used to fall
      // through to bash's own "Permission denied" with no reader message, and the
      // TypeScript reader raised a raw EACCES out of readFileSync — same fail-closed
      // outcome, two unrecognizable errors. Both now name the condition, identically.
      const unreadable = join(directory, "unreadable.txt");
      writeFileSync(unreadable, "station03\n");
      chmodSync(unreadable, 0o000);
      try {
        const shellUnreadable = shellReaderVerdictAtPath(unreadable, "station03");
        expect(shellUnreadable.ok).toBeFalse();
        expect(shellUnreadable.stderr).toContain("policy is not readable");
        const typeScriptUnreadable = typeScriptReaderVerdict(unreadable);
        expect(typeScriptUnreadable.ok).toBeFalse();
        expect(normalizeReaderMessage(typeScriptUnreadable.message)).toBe(
          normalizeReaderMessage(shellUnreadable.stderr),
        );
      } finally {
        chmodSync(unreadable, 0o600);
      }

      const dangling = join(directory, "dangling.txt");
      symlinkSync(join(directory, "does-not-exist.txt"), dangling);
      const asDangling = shellReaderVerdictAtPath(dangling, "station03");
      expect(asDangling.ok).toBeFalse();
      expect(asDangling.stderr).toContain("policy is missing");
      expect(typeScriptReaderVerdict(dangling).message).toContain("policy is missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  // The installer's own gate, actually executed. The macOS-only tool set is stubbed
  // and HOME is placed outside the world-writable /tmp that makes the existing
  // lifecycle fixtures fail on Linux, so the run reaches the local-only target check.
  // Everything here is pre-mutation: the gate is at install_macos_app.sh:341 and the
  // first user-data mutation is the `mv` far below it.
  const installerToolOverrides = [
    "AWK", "BASENAME", "CHMOD", "CODESIGN", "CP", "DATE", "DD", "DF", "DIFF", "DIRNAME",
    "DITTO", "DU", "GREP", "HEAD", "HOSTNAME", "ID", "IOREG", "LS", "LSOF", "MDFIND",
    "MKDIR", "MKTEMP", "MV", "OPEN", "PS", "RM", "RMDIR", "SED", "SHASUM", "SLEEP",
    "SPCTL", "STAT", "SW_VERS", "SYSPOLICY_CHECK", "TAIL", "TR", "XCRUN",
  ];

  function runInstallerTargetGate(
    approvedTarget: string,
    options: { policyContents?: string | null; removeReader?: boolean } = {},
  ): { exitCode: number; stderr: string } {
    const root = mkdtempSync(join(process.env["HOME"] ?? tmpdir(), ".rec-gate-"));
    try {
      const bin = join(root, "bin");
      const home = join(root, "home");
      const packageRoot = join(root, "pkg");
      mkdirSync(bin, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(join(packageRoot, "scripts", "policy"), { recursive: true });

      writeFileSync(join(bin, "stub"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
      // The only stat format the script uses before the target gate is BSD `-f '%u'`
      // (owner uid), which GNU stat spells `-c '%u'`. Translating just that is what
      // lets the home-ancestor check pass on Linux and the run reach the gate.
      writeFileSync(
        join(bin, "stat"),
        '#!/bin/sh\n[ "$1" = "-f" ] && [ "$2" = "%u" ] && exec /usr/bin/stat -c "%u" "$3"\nexec /usr/bin/stat "$@"\n',
        { mode: 0o755 },
      );

      const scripts = join(packageRoot, "scripts");
      writeFileSync(
        join(scripts, "install_macos_app.sh"),
        readRepositoryFile("scripts/install_macos_app.sh"),
        { mode: 0o755 },
      );
      if (!options.removeReader) {
        writeFileSync(
          join(scripts, "read_local_only_targets.sh"),
          readRepositoryFile(readerRelativePath),
          { mode: 0o644 },
        );
      }
      // The installer sources the identity-migration guard and fails closed on
      // "Packaged identity-migration guard is missing." before it reaches the target gate,
      // so a fixture without this file makes every assertion in this harness compare
      // against the wrong failure. Both installer-gate tests here went red on exactly that
      // message when the guard landed, which is the whole reason the gate is fail-closed.
      writeFileSync(
        join(scripts, "enforce_identity_migration.sh"),
        readRepositoryFile("scripts/enforce_identity_migration.sh"),
        { mode: 0o644 },
      );
      const policy = join(scripts, "policy", "local-only-approved-targets.txt");
      if (options.policyContents !== null) {
        writeFileSync(
          policy,
          options.policyContents ?? readRepositoryFile(policyRelativePath),
        );
      }
      const artifact = join(root, "artifact.zip");
      const manifest = join(root, "manifest.json");
      writeFileSync(artifact, "");
      writeFileSync(manifest, "{}");

      const environment: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        RECORDINGS_BUN_EXECUTABLE: process.execPath,
        RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE: join(bin, "uname"),
      };
      for (const tool of installerToolOverrides) {
        // The script derives PACKAGE_ROOT from `dirname`, so tools whose OUTPUT it
        // consumes must be real; only the macOS-only ones get the no-op stub.
        const shimmed = tool === "STAT" ? join(bin, "stat") : null;
        const real = shimmed ?? Bun.which(tool.toLowerCase());
        environment[`RECORDINGS_TEST_INSTALL_${tool}_EXECUTABLE`] = real ?? join(bin, "stub");
      }

      const result = Bun.spawnSync(
        [
          "bash", join(scripts, "install_macos_app.sh"),
          "--artifact", artifact,
          "--manifest", manifest,
          "--manifest-sha256", "a".repeat(64),
          "--expected-source-sha", "b".repeat(40),
          "--expected-version", "0.2.14",
          "--artifact-policy", "local-only",
          "--approved-target", approvedTarget,
          "--approved-target-identity-kind", "tailscale_node_id_sha256",
          "--approved-target-identity-sha256", "c".repeat(64),
          "--acknowledge-local-signing-and-permissions",
        ],
        { env: environment },
      );
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("the installer gate accepts approved targets and rejects everything else", () => {
    for (const approved of ["station03", "station06"]) {
      const result = runInstallerTargetGate(approved);
      // Past the target gate, so it must fail later and for a different reason.
      expect(result.stderr).not.toContain("approved --approved-target");
      expect(result.stderr).not.toContain("policy is missing");
    }
    for (const rejected of ["station05", "fleet", "../../etc/passwd", "*", "Station03", "attacker"]) {
      const result = runInstallerTargetGate(rejected);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("approved --approved-target");
    }
  }, 120_000);

  test("the installer gate fails closed on an unusable policy or a missing reader", () => {
    const missingPolicy = runInstallerTargetGate("station03", { policyContents: null });
    expect(missingPolicy.exitCode).toBe(2);
    expect(missingPolicy.stderr).toContain("policy is missing");

    const emptyPolicy = runInstallerTargetGate("station03", { policyContents: "# nothing\n" });
    expect(emptyPolicy.exitCode).toBe(2);
    expect(emptyPolicy.stderr).toContain("lists no targets");

    const fleetPolicy = runInstallerTargetGate("station03", { policyContents: "fleet\n" });
    expect(fleetPolicy.exitCode).toBe(2);
    expect(fleetPolicy.stderr).toContain("must not list the release fleet target");

    const nulPolicy = runInstallerTargetGate("station03", { policyContents: "station03\0station99\n" });
    expect(nulPolicy.exitCode).toBe(2);
    expect(nulPolicy.stderr).toContain("NUL byte");

    const missingReader = runInstallerTargetGate("station03", { removeReader: true });
    expect(missingReader.exitCode).toBe(2);
    expect(missingReader.stderr).toContain("target reader is missing");
  }, 120_000);

  test("resolves the policy path independently of the working directory", () => {
    expect(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH.endsWith(policyRelativePath)).toBeTrue();
    expect(localOnlyApprovedTargets(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH).length).toBeGreaterThan(0);

    // This test never changed the working directory, which is the one thing its name
    // promises. `bun test` always runs from the repository root, so a
    // `join(process.cwd(), …)` implementation would have satisfied both assertions above
    // and the test would have reported a property it had not observed — the same defect
    // class as the symlink test that asserted only the missing-file case.
    //
    // Resolve it in a child process whose cwd is somewhere else entirely, and additionally
    // one whose cwd does not exist on the path at all, so a cwd-relative implementation
    // cannot accidentally still find the file.
    const elsewhere = mkdtempSync(join(tmpdir(), "recordings-policy-cwd-"));
    try {
      for (const cwd of [elsewhere, "/"]) {
        const probe = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `const m = await import(${JSON.stringify(join(repositoryRoot, "scripts/macos_artifact.ts"))});` +
              `process.stdout.write(m.localOnlyApprovedTargets().join(","));`,
          ],
          { cwd },
        );
        expect(probe.exitCode, cwd).toBe(0);
        expect(probe.stdout.toString(), cwd).toBe(
          localOnlyApprovedTargets(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH).join(","),
        );
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  // The builder's own gate, actually executed, against a fixture whose working tree and
  // whose archived source disagree about the policy. Everything here is pre-compilation:
  // `build.sh local` reaches this gate before it invokes swift, codesign or ditto, all of
  // which are stubbed, so no Darwin toolchain is required.
  //
  // Making the two roots differ is the whole point and it is not free. build.sh forces
  // SOURCE_PACKAGE_ROOT="$PACKAGE_ROOT" whenever RECORDINGS_TEST_GIT_EXECUTABLE is set on
  // a non-Darwin host, so this fixture deliberately does NOT set it: the run performs a
  // real `git archive` of the fixture repository and the two roots are genuinely distinct.
  // A fixture that sets the git override cannot observe this defect at all.
  //
  // The divergence itself uses `git update-index --skip-worktree`, which is the only way
  // to hold a tracked file's on-disk content different from HEAD while `git status
  // --porcelain --untracked-files=all` still reports clean — and build.sh's
  // require_clean_source refuses to build a dirty tree, so nothing weaker survives it.
  // It is also a realistic shape: skip-worktree is exactly how a local policy edit hides
  // from `git status`.
  const requiredSnapshotInputs = [
    "src/native/Recordings/Package.swift",
    "src/native/Recordings/RecordingsLib/Info.plist",
    "src/native/Recordings/RecordingsLib/Recordings.entitlements",
    "src/native/Recordings/RecordingsLib/RecordingsCLI.entitlements",
    "scripts/build_companion_cli.sh",
    "scripts/smoke_macos_app.sh",
    "scripts/macos_artifact.ts",
    "scripts/native_fs_guard.ts",
    "scripts/build_native_fs_guard.sh",
    "scripts/native/recordings_fs_guard.c",
    "packaging/macos/build_release_pkg.sh",
    "packaging/macos/release_lifecycle.ts",
    "packaging/macos/Verifier.entitlements",
    "packaging/macos/Empty.entitlements",
    "packaging/macos/artifact-verifier.sb",
    "packaging/macos/Library/LaunchDaemons/com.hasna.recordings.updater.plist",
    "packaging/macos/scripts/preinstall",
    "packaging/macos/scripts/postinstall",
    "bun.lock",
    "bunfig.toml",
  ];

  // A working-tree reader that approves every requested target regardless of what the
  // policy file says. It exists so the gate's choice of reader is observable: see the
  // comment on `tamperWorkingTreeReader` below.
  const tamperedWorkingTreeReader = [
    "# shellcheck shell=bash",
    "# Fixture-only tampered reader. Approves everything, ignores the policy file.",
    "read_local_only_targets() {",
    '  local list_var="$2"',
    '  local match_var="$3"',
    "  printf -v \"$list_var\" '%s' 'tampered'",
    "  printf -v \"$match_var\" '%s' '1'",
    "}",
    "",
  ].join("\n");

  function runBuilderTargetGate(
    approvedTarget: string,
    policy: { archived: string; workingTree: string },
    options: { tamperWorkingTreeReader?: boolean } = {},
  ): { exitCode: number; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), "recordings-builder-gate-"));
    try {
      const packageRoot = join(root, "pkg");
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      for (const relativePath of requiredSnapshotInputs) {
        const destination = join(packageRoot, relativePath);
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "fixture\n");
      }
      // Real JSON: build.sh runs bun against the package root, and a non-JSON
      // package.json makes it print a parse error that has nothing to do with the gate.
      writeFileSync(join(packageRoot, "package.json"), '{ "name": "fixture" }\n');
      for (const relativePath of [
        "src/native/Recordings/build.sh",
        readerRelativePath,
        "scripts/resolve_tailscale_cli.sh",
      ]) {
        const destination = join(packageRoot, relativePath);
        mkdirSync(join(destination, ".."), { recursive: true });
        cpSync(join(repositoryRoot, relativePath), destination);
      }
      chmodSync(join(packageRoot, "src", "native", "Recordings", "build.sh"), 0o755);

      const policyPath = join(packageRoot, policyRelativePath);
      mkdirSync(join(policyPath, ".."), { recursive: true });
      writeFileSync(policyPath, policy.archived);

      const git = (...args: string[]): void => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        });
        if (result.exitCode !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
        }
      };
      git("init", "-q", "-b", "main", ".");
      git("add", "-A");
      git("commit", "-q", "-m", "fixture");
      git("update-index", "--skip-worktree", policyRelativePath);
      writeFileSync(policyPath, policy.workingTree);
      // The reader is diverged exactly like the policy, and for the same reason. This
      // fixture used to copy ONE reader into the package root, so the archived and the
      // working-tree copies were byte-identical and a gate that resolved the reader from
      // $PACKAGE_ROOT rather than $SOURCE_PACKAGE_ROOT could not be observed here at all
      // — that half of the gate was pinned only by a `toContain` over build.sh's text,
      // which an appended override defeats while the grep still passes. A tampered reader
      // is strictly worse than a tampered policy: it approves any target regardless of
      // the policy file's contents, so this is the more important half to defend.
      if (options.tamperWorkingTreeReader === true) {
        git("update-index", "--skip-worktree", readerRelativePath);
        writeFileSync(join(packageRoot, readerRelativePath), tamperedWorkingTreeReader);
      }
      // If this ever reports changes, require_clean_source aborts the build before the
      // gate and every assertion below becomes vacuous, so prove the tree looks clean.

      // Two preconditions, and BOTH are needed. A clean status alone is not enough: an
      // unmodified tree is also clean, and then both roots hold the same bytes, and the
      // caller's assertions all still pass while proving nothing at all. So assert the
      // divergence itself — working tree here, HEAD there — and only then that git agrees
      // the tree is clean, which is what stops require_clean_source aborting before the
      // gate. Getting this wrong is not hypothetical: writing `policy.archived` instead of
      // `policy.workingTree` above leaves the behavioural test passing on a reverted gate.
      expect(readFileSync(policyPath, "utf8")).toBe(policy.workingTree);
      const archivedPolicy = Bun.spawnSync(["git", "show", `HEAD:${policyRelativePath}`], {
        cwd: packageRoot,
        env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(archivedPolicy.exitCode).toBe(0);
      expect(archivedPolicy.stdout.toString()).toBe(policy.archived);

      // At least one of the two halves must actually differ between the roots, or there is
      // nothing for the gate's choice of root to be observable through. Which half depends
      // on the caller: the policy test diverges the policy and leaves the reader alone, the
      // reader test does the reverse and passes identical policy halves. Asserting
      // "the policy differs" unconditionally would fail the reader test for the wrong
      // reason; asserting neither would let a future edit quietly remove the divergence.
      expect(
        policy.workingTree !== policy.archived || options.tamperWorkingTreeReader === true,
      ).toBeTrue();

      // Same precondition for the reader half, which is the more dangerous one.
      if (options.tamperWorkingTreeReader === true) {
        const readerPath = join(packageRoot, readerRelativePath);
        expect(readFileSync(readerPath, "utf8")).toBe(tamperedWorkingTreeReader);
        const archivedReader = Bun.spawnSync(["git", "show", `HEAD:${readerRelativePath}`], {
          cwd: packageRoot,
          env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        expect(archivedReader.exitCode).toBe(0);
        expect(archivedReader.stdout.toString()).not.toBe(tamperedWorkingTreeReader);
      }

      const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: packageRoot,
        env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(status.stdout.toString()).toBe("");

      const result = Bun.spawnSync(
        ["bash", join(packageRoot, "src", "native", "Recordings", "build.sh"), "local"],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            TMPDIR: tmpdir(),
            BUN_EXECUTABLE: process.execPath,
            RECORDINGS_LOCAL_APPROVED_TARGET: approvedTarget,
            // Only the macOS-only tools build.sh insists on before the gate. Note the
            // absence of RECORDINGS_TEST_GIT_EXECUTABLE — see the comment above.
            RECORDINGS_TEST_SWIFT_EXECUTABLE: "/bin/true",
            RECORDINGS_TEST_CODESIGN_EXECUTABLE: "/bin/true",
            RECORDINGS_TEST_DITTO_EXECUTABLE: "/bin/true",
            RECORDINGS_TEST_PLIST_BUDDY_EXECUTABLE: "/bin/true",
            RECORDINGS_TEST_PLUTIL_EXECUTABLE: "/bin/true",
          },
        },
      );
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("the builder's gate reads the archived policy, not the working tree", () => {
    const policy = { archived: "station06\n", workingTree: "attacker\n" };

    // The working tree alone approves "attacker". Reading it would let a target the
    // archived source never authorized through the gate, so the gate must refuse — and
    // must name the archived list, not the working-tree one, when it does.
    const forged = runBuilderTargetGate("attacker", policy);
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr).toContain("require an approved RECORDINGS_LOCAL_APPROVED_TARGET");
    expect(forged.stderr).toContain("(station06)");
    expect(forged.stderr).not.toContain("(attacker)");

    // ...and the converse, which is what makes this a two-sided proof rather than an
    // assertion that the build fails: the target the ARCHIVED policy authorizes must get
    // past the target gate, and then stop at the next check for a different reason.
    const archived = runBuilderTargetGate("station06", policy);
    expect(archived.stderr).not.toContain("require an approved RECORDINGS_LOCAL_APPROVED_TARGET");
    expect(archived.stderr).toContain(
      "require an authenticated RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256",
    );
  }, 120_000);

  test("the builder's gate reads the archived reader, not the working tree", () => {
    // Both roots hold the SAME policy, so the only thing that differs between the two
    // roots here is the reader itself. The archived copy is the real reader and approves
    // only station06; the working-tree copy approves everything and names its list
    // "tampered", which makes the gate's choice visible in stderr either way.
    const policy = { archived: "station06\n", workingTree: "station06\n" };
    const tampered = { tamperWorkingTreeReader: true };

    // Sourcing the working-tree reader would approve "attacker" and carry it past the
    // target gate. The gate must refuse, and must name the archived reader's list.
    const forged = runBuilderTargetGate("attacker", policy, tampered);
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr).toContain("require an approved RECORDINGS_LOCAL_APPROVED_TARGET");
    expect(forged.stderr).toContain("(station06)");
    expect(forged.stderr).not.toContain("tampered");

    // The converse, so this is a two-sided proof rather than an assertion that the build
    // fails for some unrelated reason: with the same tampered reader on disk, the target
    // the ARCHIVED policy authorizes still gets past the target gate and stops at the
    // next check. That also proves the tampered file did not simply break the sourcing.
    const archived = runBuilderTargetGate("station06", policy, tampered);
    expect(archived.stderr).not.toContain("require an approved RECORDINGS_LOCAL_APPROVED_TARGET");
    expect(archived.stderr).toContain(
      "require an authenticated RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256",
    );
  }, 120_000);
});
