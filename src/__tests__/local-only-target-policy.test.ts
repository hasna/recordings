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
): { ok: boolean; matched: boolean; list: string; stderr: string } {
  const script = `
set -euo pipefail
. ${JSON.stringify(join(repositoryRoot, readerRelativePath))}
LIST=""
MATCHED=0
read_local_only_targets ${JSON.stringify(path)} LIST MATCHED ${JSON.stringify(requested)}
printf 'LIST=%s\\nMATCHED=%s\\n' "$LIST" "$MATCHED"
`;
  const result = Bun.spawnSync(["bash", "-c", script]);
  const stdout = result.stdout.toString();
  return {
    ok: result.exitCode === 0,
    matched: /^MATCHED=1$/m.test(stdout),
    list: stdout.match(/^LIST=(.*)$/m)?.[1] ?? "",
    stderr: result.stderr.toString(),
  };
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
function typeScriptReaderVerdict(path: string): { ok: boolean; message: string } {
  try {
    localOnlyApprovedTargets(path);
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/// Both readers print the same sentences with different capitalisation, so compare them
/// case-insensitively and without trailing punctuation.
const normalizeReaderMessage = (message: string): string =>
  message.trim().toLowerCase().replace(/\.$/, "");

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
  });

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
      expect(shell.ok).toBeTrue();
      expect(shell.matched).toBeTrue();
      expect(withPolicyFile(contents, (path) => localOnlyApprovedTargets(path))).toContain("station03");
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

    for (const contents of [...rejected, ...divergentByteShapes]) {
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
  });

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
  });

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
  });

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
  });

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

      const dangling = join(directory, "dangling.txt");
      symlinkSync(join(directory, "does-not-exist.txt"), dangling);
      const asDangling = shellReaderVerdictAtPath(dangling, "station03");
      expect(asDangling.ok).toBeFalse();
      expect(asDangling.stderr).toContain("policy is missing");
      expect(typeScriptReaderVerdict(dangling).message).toContain("policy is missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
  });

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
  });

  test("resolves the policy path independently of the working directory", () => {
    expect(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH.endsWith(policyRelativePath)).toBeTrue();
    expect(localOnlyApprovedTargets(LOCAL_ONLY_APPROVED_TARGETS_POLICY_PATH).length).toBeGreaterThan(0);
  });

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

  function runBuilderTargetGate(
    approvedTarget: string,
    policy: { archived: string; workingTree: string },
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
      // If this ever reports changes, require_clean_source aborts the build before the
      // gate and every assertion below becomes vacuous, so prove the tree looks clean.
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
  });
});
