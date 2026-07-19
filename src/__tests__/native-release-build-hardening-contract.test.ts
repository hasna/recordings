import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const buildScript = readFileSync("src/native/Recordings/build.sh", "utf8");
const companionScript = readFileSync("scripts/build_companion_cli.sh", "utf8");
const smokeScript = readFileSync("scripts/smoke_macos_app.sh", "utf8");
const installerScript = readFileSync("scripts/install_macos_app.sh", "utf8");
const nativeGuardLoader = readFileSync("scripts/native_fs_guard.ts", "utf8");
const nativeGuardBuild = readFileSync("scripts/build_native_fs_guard.sh", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

describe("native release build hardening contract", () => {
  test("requires an explicit supported release subtype before resolving build tools", () => {
    for (const [arguments_, expectedError] of [
      [["release"], "Release builds require an explicit subtype"],
      [["release", "combined"], "Release subtype must be initial-bootstrap or app-update"],
    ] as const) {
      const result = Bun.spawnSync([
        "/bin/bash",
        "src/native/Recordings/build.sh",
        ...arguments_,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(expectedError);
      expect(result.stderr.toString()).not.toContain("BUN_EXECUTABLE");
    }
  });

  test("ships a pinned universal descriptor guard and fails closed before installer mutation", () => {
    expect(packageJson.devDependencies["node-api-headers"]).toBe("1.9.0");
    expect(packageJson.scripts["build:native-fs-guard"]).toBe(
      "/bin/bash scripts/build_native_fs_guard.sh",
    );
    expect(packageJson.scripts.prepack).toStartWith("bun run build:native-fs-guard &&");
    expect(nativeGuardBuild).toContain('[ "$(/usr/bin/uname -s)" = "Darwin" ]');
    expect(nativeGuardBuild).toContain("/usr/bin/lipo -verify_arch arm64 x86_64");
    expect(nativeGuardBuild).toContain("node_modules/node-api-headers/include");
    expect(nativeGuardBuild).not.toContain("npm install");
    expect(nativeGuardBuild).not.toContain("bun install");

    expect(nativeGuardLoader).toContain('if (process.platform === "darwin")');
    expect(nativeGuardLoader).toContain(
      '"prebuilds",\n      "darwin-universal",\n      "recordings_fs_guard.node"',
    );
    expect(nativeGuardLoader.indexOf('if (process.platform === "darwin")')).toBeLessThan(
      nativeGuardLoader.indexOf("RECORDINGS_TEST_FS_GUARD_ADDON"),
    );
    expect(buildScript).toContain(
      '"$SOURCE_PACKAGE_ROOT/scripts/native/prebuilds/darwin-universal/recordings_fs_guard.node"',
    );
    const archivedRequirements = buildScript.slice(
      buildScript.indexOf("for required_snapshot_input in"),
      buildScript.indexOf("RUN_BUN_TEST_ENVIRONMENT"),
    );
    expect(archivedRequirements).not.toContain(
      'prebuilds/darwin-universal/recordings_fs_guard.node"; do',
    );
    expect(buildScript).toContain("generate_and_verify_native_fs_guard");
    expect(buildScript).toContain('run_bun pm pack --destination "$pack_root" --ignore-scripts');
    expect(buildScript).toContain("Native filesystem guard exports are incompatible");
    expect(buildScript).toContain("Object.getOwnPropertyNames(addon).sort()");
    expect(buildScript).toContain("/usr/bin/lipo -verify_arch arm64 x86_64");
    expect(buildScript).toContain('run_codesign --verify --strict --all-architectures');
    expect(buildScript).toContain(
      "package/scripts/native/prebuilds/darwin-universal/recordings_fs_guard.node",
    );
    expect(buildScript).toContain("Packed release tarball contains native filesystem guard intermediates");

    const preflight = installerScript.indexOf(
      '"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" native-fs-guard-check',
    );
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(installerScript.indexOf('DATA_DIR="${HOME}/.hasna/recordings"'));
    expect(preflight).toBeLessThan(installerScript.indexOf('"$MKDIR_EXECUTABLE" -m 700 "$APP_PARENT"'));
  });

  test("does not compile the Darwin descriptor guard on a non-Darwin target", () => {
    if (process.platform === "darwin") return;
    const result = Bun.spawnSync(["/bin/bash", "scripts/build_native_fs_guard.sh"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "production filesystem guard prebuild must be built on macOS",
    );
  });

  test("builds and verifies the exact universal release executable cohort", () => {
    expect(buildScript).toContain("RELEASE_ARCHITECTURES=(arm64 x86_64)");
    expect(buildScript).toContain(
      'for swift_architecture in "${RELEASE_ARCHITECTURES[@]}"; do',
    );
    expect(buildScript).toContain('--arch "$swift_architecture"');
    for (const product of [
      "App",
      "recordings-update-broker",
      "recordings-update-client",
      "recordings-envelope-signer",
      "recordings-bootstrap-preflight",
    ]) {
      expect(buildScript).toContain(`merge_release_swift_product "${product}"`);
    }
    for (const binary of [
      '"$MACOS/Recordings"',
      '"$UPDATE_BROKER"',
      '"$UPDATE_CLIENT"',
      '"$ENVELOPE_SIGNER"',
      '"$ARTIFACT_VERIFIER"',
      '"$HELPERS/recordings"',
      '"$BOOTSTRAP_PREFLIGHT_VERIFIER"',
    ]) {
      expect(buildScript).toContain(
        `verify_exact_binary_architectures ${binary} arm64 x86_64`,
      );
    }
    expect(buildScript).toContain('COMPANION_BUILD_KIND="universal"');
    expect(buildScript).toContain(
      '"$COMPANION_BUILD_SCRIPT" "$HELPERS/recordings" "$BUN_EXECUTABLE" "$COMPANION_BUILD_KIND"',
    );
    expect(buildScript).toContain(
      "--identifier com.hasna.recordings.bootstrap-preflight",
    );
    expect(buildScript).toContain(
      '--bootstrap-preflight-verifier "$BOOTSTRAP_PREFLIGHT_VERIFIER"',
    );

    expect(companionScript).toContain('BUILD_KIND="${3:-native}"');
    expect(companionScript).toContain('--target="bun-darwin-arm64"');
    expect(companionScript).toContain('--target="bun-darwin-x64"');
    expect(companionScript).toContain(
      'run_lipo -create "$COMPILED_ARM64" "$COMPILED_X86_64" -output "$COMPILED_OUTPUT"',
    );
    expect(companionScript).toContain(
      'verify_exact_binary_architectures "$COMPILED_OUTPUT" arm64 x86_64',
    );
    expect(companionScript).not.toContain("-verify_arch arm64 x86_64\n");
  });

  test("normalizes umask-077 staging before nested signing and finalizes data before app signing", () => {
    const launchFileNormalizer = buildScript.match(
      /normalize_unsigned_launch_file_mode\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    const normalizer = buildScript.match(
      /normalize_unsigned_app_bundle_modes\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(launchFileNormalizer).toBeDefined();
    expect(normalizer).toBeDefined();

    const root = mkdtempSync(join(tmpdir(), "recordings-bundle-modes-"));
    const app = join(root, "Recordings.app");
    const directories = [
      app,
      join(app, "Contents"),
      join(app, "Contents", "MacOS"),
      join(app, "Contents", "Helpers"),
      join(app, "Contents", "Resources"),
    ];
    const launchFiles = [
      join(app, "Contents", "MacOS", "Recordings"),
      join(app, "Contents", "Helpers", "recordings"),
      join(app, "Contents", "Helpers", "recordings-update-client"),
    ];
    const resource = join(app, "Contents", "Resources", "fixture.json");

    try {
      for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const file of [...launchFiles, resource]) {
        writeFileSync(file, "fixture", { mode: 0o600 });
      }

      const shell = [
        "set -euo pipefail",
        'FIND_EXECUTABLE="/usr/bin/find"',
        'CHMOD_EXECUTABLE="/bin/chmod"',
        'MACOS="$1/Contents/MacOS"',
        'HELPERS="$1/Contents/Helpers"',
        'UPDATE_CLIENT="$1/Contents/Helpers/recordings-update-client"',
        launchFileNormalizer!,
        normalizer!,
        'normalize_unsigned_app_bundle_modes "$1"',
      ].join("\n");
      const result = Bun.spawnSync(["/bin/bash", "-c", shell, "bundle-mode-test", app]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);

      for (const directory of directories) {
        expect(statSync(directory).mode & 0o777).toBe(0o755);
      }
      for (const file of launchFiles) {
        expect(statSync(file).mode & 0o777).toBe(0o755);
      }
      expect(statSync(resource).mode & 0o777).toBe(0o644);

      const linkedResource = join(app, "Contents", "Resources", "linked-resource");
      symlinkSync(resource, linkedResource);
      expect(
        Bun.spawnSync(["/bin/bash", "-c", shell, "bundle-mode-test", app]).exitCode,
      ).not.toBe(0);
      rmSync(linkedResource);

      const hardlinkedResource = join(app, "Contents", "Resources", "hardlinked-resource");
      linkSync(resource, hardlinkedResource);
      expect(
        Bun.spawnSync(["/bin/bash", "-c", shell, "bundle-mode-test", app]).exitCode,
      ).not.toBe(0);
      rmSync(hardlinkedResource);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const provenance = buildScript.indexOf(
      'run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" provenance',
    );
    const normalize = buildScript.indexOf('normalize_unsigned_app_bundle_modes "$APP_DIR"');
    const helperSign = buildScript.indexOf('run_codesign "${HELPER_SIGN_ARGUMENTS[@]}"');
    const appSign = buildScript.indexOf('run_codesign "${APP_SIGN_ARGUMENTS[@]}"');
    expect(provenance).toBeGreaterThan(-1);
    expect(normalize).toBeLessThan(helperSign);
    expect(provenance).toBeGreaterThan(helperSign);
    expect(normalize).toBeLessThan(appSign);
    expect(provenance).toBeLessThan(appSign);
    expect(buildScript).toContain(
      'normalize_unsigned_app_data_file_mode "$PROVENANCE_FILE" "App build provenance"',
    );
    expect(buildScript.indexOf('normalize_unsigned_app_data_file_mode "$PROVENANCE_FILE"')).toBeGreaterThan(
      provenance,
    );
    expect(buildScript.indexOf('verify_app_bundle_modes "$APP_DIR"')).toBeLessThan(
      appSign,
    );
    expect(buildScript).toContain('verify_app_bundle_modes "$OUTPUT_APP_DIR"');
    expect(buildScript).toContain('require_app_tree_without_extended_acl "$OUTPUT_APP_DIR"');
    expect(buildScript).toContain('"$LS_EXECUTABLE" -laeR "$tree"');
    expect(buildScript).toContain('tree-digest --path "$OUTPUT_APP_DIR"');
    expect(buildScript).toContain(
      'run_codesign --verify --deep --strict --verbose=2 "$OUTPUT_APP_DIR"',
    );
    const publishCopy = buildScript.indexOf(
      'run_sensitive_tool "$DITTO_EXECUTABLE" "$APP_DIR" "$OUTPUT_APP_DIR"',
    );
    expect(publishCopy).toBeGreaterThan(-1);
    expect(buildScript.indexOf('verify_app_bundle_modes "$OUTPUT_APP_DIR"')).toBeGreaterThan(
      publishCopy,
    );
    expect(
      buildScript.indexOf('require_app_tree_without_extended_acl "$OUTPUT_APP_DIR"'),
    ).toBeGreaterThan(publishCopy);
    expect(buildScript).toContain("App bundle tree contains a symbolic link or special file");
    expect(buildScript).toContain("App bundle tree contains a multiply-linked regular file");
  });

  test.each([
    ["canonical", "arm64 x86_64", true],
    ["reordered", "x86_64 arm64", true],
    ["missing", "arm64", false],
    ["extra", "arm64 x86_64 ppc64", false],
    ["duplicate", "arm64 arm64", false],
  ])("accepts only the exact universal architecture set: %s", (_label, output, accepted) => {
    for (const source of [buildScript, companionScript]) {
      const verifier = source.match(/verify_exact_binary_architectures\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(verifier).toBeDefined();
      const shell = [
        "set -euo pipefail",
        "run_lipo() { printf '%s\\n' \"$ARCHITECTURE_OUTPUT\"; }",
        verifier!,
        'verify_exact_binary_architectures "/tmp/test-binary" arm64 x86_64',
      ].join("\n");
      const result = Bun.spawnSync(["/bin/bash", "-c", shell], {
        env: { ARCHITECTURE_OUTPUT: output as string },
      });
      expect(result.exitCode === 0, result.stderr.toString()).toBe(accepted as boolean);
    }
  });

  test.each([
    ["failed", "exit 47\n", "Could not determine the host platform"],
    ["unknown", "printf 'Plan9\\n'\n", "Unsupported host platform"],
  ])("aborts installer and Tailscale override selection on a %s pinned uname probe", (
    _label,
    unameBody,
    expectedError,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "recordings-host-platform-"));
    try {
      const uname = join(root, "uname");
      const installer = join(root, "install_macos_app.sh");
      const resolver = join(root, "resolve_tailscale_cli.sh");
      const resolverDriver = join(root, "resolver-driver.sh");
      writeExecutable(uname, `#!/bin/bash\nset -euo pipefail\n${unameBody}`);
      writeExecutable(installer, installerScript.replaceAll("/usr/bin/uname", uname));
      writeExecutable(
        resolver,
        readFileSync("scripts/resolve_tailscale_cli.sh", "utf8").replaceAll("/usr/bin/uname", uname),
      );
      writeExecutable(
        resolverDriver,
        `#!/bin/bash\nset -euo pipefail\nsource "$1"\nrecordings_resolve_trusted_tailscale_app_cli "$2"\n`,
      );

      const environment = {
        ...Bun.env,
        RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_TRUSTED_TAILSCALE_APP: join(root, "hostile-override.app"),
      };
      const installResult = Bun.spawnSync(["/bin/bash", installer], { env: environment });
      const resolverResult = Bun.spawnSync(
        ["/bin/bash", resolverDriver, resolver, root],
        { env: environment },
      );
      expect(installResult.exitCode).not.toBe(0);
      expect(installResult.stderr.toString()).toContain(expectedError as string);
      expect(resolverResult.exitCode).not.toBe(0);
      expect(resolverResult.stderr.toString()).toContain(expectedError as string);
      expect(existsSync(join(root, "hostile-override.app"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins bootstrap path tools before deriving the source tree", () => {
    const unamePin = buildScript.indexOf('HOST_UNAME_EXECUTABLE="/usr/bin/uname"');
    const dirnamePin = buildScript.indexOf('SYSTEM_DIRNAME_EXECUTABLE="/usr/bin/dirname"');
    const pwdPin = buildScript.indexOf('SYSTEM_PWD_EXECUTABLE="/bin/pwd"');
    const scriptDirectory = buildScript.indexOf('SCRIPT_DIR="$(cd');

    expect(unamePin).toBeGreaterThan(-1);
    expect(dirnamePin).toBeGreaterThan(unamePin);
    expect(pwdPin).toBeGreaterThan(dirnamePin);
    expect(scriptDirectory).toBeGreaterThan(pwdPin);
    expect(buildScript).toContain('HOST_PLATFORM="$("$HOST_UNAME_EXECUTABLE" -s)"');
    expect(buildScript).not.toMatch(/SCRIPT_DIR=.*\$\(dirname\b/);
    expect(buildScript).not.toMatch(/SCRIPT_DIR=.*&& pwd\b/);
  });

  test("pins a clean full source revision before native compilation", () => {
    const sourcePreflight = buildScript.indexOf('SOURCE_SHA="$(read_source_sha)"');
    const swiftTest = buildScript.indexOf('run_swift test -c "$BUILD_CONFIGURATION"');
    const swiftBuild = buildScript.indexOf('run_swift build -c "$BUILD_CONFIGURATION"');

    expect(buildScript).toContain("git revision is not a full 40-character commit SHA");
    expect(buildScript).toContain("Source worktree must be clean before building");
    expect(buildScript).toContain('readonly SOURCE_SHA');
    expect(buildScript).toContain("status --porcelain=v1 --untracked-files=all");
    expect(sourcePreflight).toBeGreaterThan(-1);
    expect(swiftTest).toBeGreaterThan(sourcePreflight);
    expect(swiftBuild).toBeGreaterThan(swiftTest);
    expect(buildScript.slice(swiftTest - 300, swiftTest)).toContain('[ "$MODE" = "release" ]');
    expect(buildScript.slice(swiftTest, swiftBuild)).toContain(
      '--scratch-path "$SWIFT_SCRATCH_PATH/tests"',
    );
  });

  test("rechecks pinned source immediately before provenance and finalization", () => {
    expect(buildScript).toMatch(
      /verify_source_unchanged\n\s+run_bun "\$SOURCE_PACKAGE_ROOT\/scripts\/macos_artifact\.ts" provenance/,
    );
    expect(buildScript).toMatch(
      /verify_source_unchanged\n\s+run_bun "\$SOURCE_PACKAGE_ROOT\/scripts\/macos_artifact\.ts" finalize-local/,
    );
    expect(buildScript).toMatch(
      /verify_source_unchanged\nrun_bun "\$SOURCE_PACKAGE_ROOT\/scripts\/macos_artifact\.ts" finalize/,
    );
    expect(buildScript.match(/--source-sha "\$SOURCE_SHA"/g)).toHaveLength(5);
    expect(buildScript).toMatch(
      /verify_source_unchanged\necho "Built immutable app artifact:/,
    );
    expect(buildScript).toMatch(
      /verify_source_unchanged\n\s+echo "Built immutable local-only app artifact:/,
    );
  });

  test("ignores every dedicated executable override on a real Darwin host", () => {
    const tools = [
      ["GIT_EXECUTABLE", "/usr/bin/git"],
      ["SWIFT_EXECUTABLE", "/usr/bin/swift"],
      ["CODESIGN_EXECUTABLE", "/usr/bin/codesign"],
      ["XCRUN_EXECUTABLE", "/usr/bin/xcrun"],
      ["SPCTL_EXECUTABLE", "/usr/sbin/spctl"],
      ["SYSPOLICY_CHECK_EXECUTABLE", "/usr/bin/syspolicy_check"],
      ["DITTO_EXECUTABLE", "/usr/bin/ditto"],
      ["SHASUM_EXECUTABLE", "/usr/bin/shasum"],
      ["CHMOD_EXECUTABLE", "/bin/chmod"],
    ] as const;

    for (const [variable, defaultPath] of tools) {
      expect(buildScript).toContain(
        `${variable}="$(select_executable "${defaultPath}" "\${RECORDINGS_TEST_${variable}:-}")"`,
      );
      expect(buildScript).toContain(`require_executable "${variable}" "$${variable}"`);
    }
    expect(buildScript).toMatch(
      /select_executable\(\) \{[\s\S]*?if \[ "\$HOST_PLATFORM" = "Darwin" \] \|\| \[ -z "\$test_override" \]; then[\s\S]*?printf '%s\\n' "\$system_executable"/,
    );
    expect(buildScript).toContain(
      'HOST_PLATFORM="$("$HOST_UNAME_EXECUTABLE" -s)"',
    );
    expect(buildScript).not.toContain("RECORDINGS_TEST_HOST_PLATFORM");
    expect(buildScript).not.toMatch(/^\s*(codesign|xcrun|spctl|syspolicy_check|ditto|shasum)\b/m);
  });

  test("routes every executable test override through the non-Darwin selector", () => {
    const overrideLines = buildScript
      .split("\n")
      .filter((line) => /RECORDINGS_TEST_[A-Z0-9_]*EXECUTABLE/.test(line));

    expect(overrideLines.length).toBeGreaterThan(20);
    for (const line of overrideLines) {
      expect(
        line.includes("$(select_executable ") ||
          line.includes('[ "$HOST_PLATFORM" != "Darwin" ]'),
      ).toBeTrue();
    }
  });

  test("requires and identifies an explicitly pinned absolute Bun executable", () => {
    expect(buildScript).not.toContain("command -v bun");
    expect(buildScript).toContain('BUN_EXECUTABLE="${BUN_EXECUTABLE:-}"');
    expect(buildScript).toContain('require_bun_executable "$BUN_EXECUTABLE"');
    expect(buildScript).toContain("process.execPath");
    expect(buildScript).toContain("realpathSync");

    for (const script of [companionScript, smokeScript]) {
      expect(script).not.toContain("command -v bun");
      expect(script).toContain('BUN_EXECUTABLE="$2"');
      expect(script).toContain('require_bun_executable "$BUN_EXECUTABLE"');
      expect(script).toContain("process.execPath");
      expect(script).toContain("realpathSync");
      expect(script).not.toMatch(/^\s*bun\b/m);
    }
  });

  test("local-only builder identity uses the trusted canonical Tailscale resolver", () => {
    expect(buildScript).toContain(
      'TAILSCALE_CLI="$(recordings_resolve_trusted_tailscale_app_cli "$BUILD_WORK_DIR")"',
    );
    expect(buildScript).toContain(
      'recordings_run_trusted_tailscale_status "$TAILSCALE_CLI" "$BUILD_WORK_DIR"',
    );
    expect(buildScript).not.toContain('"$TAILSCALE_CLI" status --json');
    expect(buildScript).not.toContain(
      'TAILSCALE_CLI="$(PATH="$TAILSCALE_RESOLUTION_PATH" recordings_resolve_tailscale_cli)"',
    );
  });

  test("uses clean isolated native and companion dependency build roots", () => {
    expect(buildScript).toContain('--scratch-path "$SWIFT_SCRATCH_PATH"');
    expect(buildScript).toContain('"$RM_EXECUTABLE" -rf "$OUTPUT_BUILD_DIR"');
    expect(buildScript).not.toContain('BUILD_DIR=".build/$BUILD_CONFIGURATION"');

    expect(companionScript).toContain("--frozen-lockfile");
    expect(companionScript).toContain("--ignore-scripts");
    expect(companionScript).toContain("--minimum-release-age=604800");
    expect(companionScript).toContain('"$CP_EXECUTABLE" -R "$ROOT/src" "$STAGED_ROOT/src"');
    expect(companionScript).not.toContain("${ROOT}/node_modules");
    expect(companionScript.indexOf('ACTUAL_VERSION="$(run_output --version)"')).toBeLessThan(
      companionScript.indexOf('PUBLISH_OUTPUT="$($MKTEMP_EXECUTABLE'),
    );
    expect(companionScript).toContain('if [ -d "$OUTPUT" ]; then');
    expect(companionScript).toContain("renameSync(process.argv[1], process.argv[2]);");
    expect(companionScript).not.toContain('"$MV_EXECUTABLE" "$PUBLISH_OUTPUT" "$OUTPUT"');
    expect(companionScript).not.toContain('"$RM_EXECUTABLE" -f "$OUTPUT"');
  });

  test("sanitizes Git provenance and builds only from the archived source commit", () => {
    expect(buildScript).toMatch(
      /run_source_git\(\) \{[\s\S]*?"\$ENV_EXECUTABLE" -i[\s\S]*?GIT_CONFIG_NOSYSTEM="1"[\s\S]*?GIT_NO_REPLACE_OBJECTS="1"/,
    );
    expect(buildScript).not.toContain('"$GIT_EXECUTABLE" -C "$PACKAGE_ROOT"');
    expect(buildScript).toContain('run_source_git archive --format=tar "$SOURCE_SHA"');
    expect(buildScript).toContain('"$TAR_EXECUTABLE" -x -f - -C "$SOURCE_PACKAGE_ROOT"');
    expect(buildScript).toContain('--package-path "$SOURCE_NATIVE_DIR"');
    expect(buildScript).toContain(
      'COMPANION_BUILD_SCRIPT="$SOURCE_PACKAGE_ROOT/scripts/build_companion_cli.sh"',
    );
    expect(buildScript).toContain('SMOKE_SCRIPT="$SOURCE_PACKAGE_ROOT/scripts/smoke_macos_app.sh"');
    expect(buildScript).toContain(
      'TAILSCALE_CLI="$(recordings_resolve_trusted_tailscale_app_cli "$BUILD_WORK_DIR")"',
    );
    expect(buildScript).toContain(
      'if [ "$HOST_PLATFORM" != "Darwin" ] && [ -n "$TEST_GIT_EXECUTABLE" ]; then',
    );
    expect(buildScript).toContain(
      'APP_ENTITLEMENTS="$SOURCE_NATIVE_DIR/RecordingsLib/Recordings.entitlements"',
    );
    expect(buildScript).toContain(
      'HELPER_ENTITLEMENTS="$SOURCE_NATIVE_DIR/RecordingsLib/RecordingsCLI.entitlements"',
    );
  });

  test("launches release children through pinned bash with a sanitized environment", () => {
    const companionInvocation =
      /"\$ENV_EXECUTABLE" -i[\s\S]*?"\$BASH_EXECUTABLE" "\$COMPANION_BUILD_SCRIPT" "\$HELPERS\/recordings" "\$BUN_EXECUTABLE"/;
    const smokeInvocation =
      /"\$ENV_EXECUTABLE" -i[\s\S]*?"\$BASH_EXECUTABLE" "\$SMOKE_SCRIPT" "\$APP_DIR" "\$BUN_EXECUTABLE"/;

    expect(buildScript).toMatch(companionInvocation);
    expect(buildScript).toMatch(smokeInvocation);
    expect(buildScript).toContain('BASH_EXECUTABLE="$(select_executable "/bin/bash"');
    expect(buildScript).toContain('SANITIZED_PATH="/usr/bin:/bin:/usr/sbin:/sbin"');
    expect(buildScript).toMatch(
      /run_xcrun\(\) \{[\s\S]*?"\$ENV_EXECUTABLE" -i[\s\S]*?"\$XCRUN_EXECUTABLE" "\$@"/,
    );
    expect([...buildScript.matchAll(/^\s*"\$XCRUN_EXECUTABLE".*$/gm)]).toHaveLength(1);
    expect(buildScript.startsWith("#!/bin/bash\n")).toBeTrue();
    expect(companionScript.startsWith("#!/bin/bash\n")).toBeTrue();
    expect(smokeScript.startsWith("#!/bin/bash\n")).toBeTrue();
    expect(buildScript).toContain(
      '${RUN_BUN_TEST_ENVIRONMENT[0]+"${RUN_BUN_TEST_ENVIRONMENT[@]}"}',
    );
    expect(buildScript).toContain(
      '${COMPANION_TEST_ENVIRONMENT[0]+"${COMPANION_TEST_ENVIRONMENT[@]}"}',
    );
    expect(buildScript).toContain(
      '${SMOKE_TEST_ENVIRONMENT[0]+"${SMOKE_TEST_ENVIRONMENT[@]}"}',
    );
    expect(buildScript).toContain(
      '${XCRUN_TEST_ENVIRONMENT[0]+"${XCRUN_TEST_ENVIRONMENT[@]}"}',
    );
    expect(buildScript).not.toMatch(
      /^\s*"\$\{(?:RUN_BUN|COMPANION|SMOKE|XCRUN)_TEST_ENVIRONMENT\[@\]\}" \\/m,
    );
    expect(buildScript).not.toContain('"$PACKAGE_ROOT/scripts/build_companion_cli.sh" "$HELPERS/recordings"');
    expect(buildScript).not.toContain('"$PACKAGE_ROOT/scripts/smoke_macos_app.sh" "$APP_DIR"');
  });

  test("runs every release signing and assessment command through a clean allowlisted environment", () => {
    const releaseToolStart = buildScript.indexOf("run_release_sensitive_tool() {");
    const releaseToolEnd = buildScript.indexOf("\n}", releaseToolStart);
    const releaseTool = buildScript.slice(releaseToolStart, releaseToolEnd + 2);

    expect(releaseToolStart).toBeGreaterThan(-1);
    expect(releaseTool).toContain('"$ENV_EXECUTABLE" -i');
    expect(releaseTool).toContain('HOME="$OPERATOR_HOME"');
    expect(releaseTool).toContain('PATH="$SANITIZED_PATH"');
    expect(releaseTool).toContain('TMPDIR="$BUILD_WORK_DIR"');
    expect(releaseTool).toContain('"$executable" "$@"');

    expect(buildScript).toMatch(
      /run_codesign\(\) \{[\s\S]*?if \[ "\$MODE" = "release" \]; then[\s\S]*?run_release_sensitive_tool "\$CODESIGN_EXECUTABLE" "\$@"/,
    );
    expect(buildScript).not.toMatch(/^"\$CODESIGN_EXECUTABLE"/m);
    expect(buildScript).toContain(
      'run_release_sensitive_tool "$SPCTL_EXECUTABLE" --assess --type execute --verbose=2 "$APP_DIR"',
    );
    expect(buildScript).toContain(
      'run_release_sensitive_tool "$SYSPOLICY_CHECK_EXECUTABLE" distribution "$APP_DIR"',
    );
    expect(buildScript).toContain(
      'run_release_sensitive_tool "$DITTO_EXECUTABLE" -c -k --sequesterRsrc --keepParent "$APP_DIR" "$NOTARY_ARCHIVE"',
    );
    expect(buildScript).toContain(
      'NOTARY_SUBMISSION_JSON="$(run_release_sensitive_tool "$CAT_EXECUTABLE" "$NOTARY_SUBMISSION")"',
    );
    expect(buildScript).toContain(
      'run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" assert-notary-log',
    );
    expect(buildScript).toMatch(
      /contract_environment=\([\s\S]*?HOME="\$contract_home"[\s\S]*?PATH="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"[\s\S]*?TMPDIR="\$contract_home"/,
    );
    const directCodesignInvocations = [...buildScript.matchAll(/^\s*"\$CODESIGN_EXECUTABLE".*$/gm)];
    expect(directCodesignInvocations).toHaveLength(2);
    for (const invocation of directCodesignInvocations) {
      expect(
        buildScript.slice(Math.max(0, invocation.index! - 120), invocation.index),
      ).toMatch(/else\s*$/);
    }
  });

  test("does not forward hostile runtime or signing controls into release-sensitive children", () => {
    const releaseToolStart = buildScript.indexOf("run_release_sensitive_tool() {");
    const releaseToolEnd = buildScript.indexOf("\n}", releaseToolStart);
    const releaseTool = buildScript.slice(releaseToolStart, releaseToolEnd + 2);
    const hostileControls = [
      "CODESIGN_ALLOCATE",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BUN_OPTIONS",
      "NODE_OPTIONS",
      "NODE_PATH",
    ];

    expect(releaseTool).toContain('"$ENV_EXECUTABLE" -i');
    for (const control of hostileControls) {
      expect(releaseTool).not.toContain(`${control}=`);
      expect(buildScript).not.toContain(`${control}=\${${control}`);
    }
    expect(buildScript).toMatch(
      /if \[ "\$HOST_PLATFORM" != "Darwin" \]; then[\s\S]*?RELEASE_SENSITIVE_TEST_ENVIRONMENT\+=\(/,
    );
    const fixtureEnvironmentSetup = buildScript.slice(
      buildScript.indexOf("RUN_BUN_TEST_ENVIRONMENT=()"),
      buildScript.indexOf("\nrun_bun()"),
    );
    expect(fixtureEnvironmentSetup).not.toMatch(
      /if \[ "\$HOST_PLATFORM" = "Darwin" \]; then[\s\S]*?RELEASE_SENSITIVE_TEST_ENVIRONMENT\+=\(/,
    );
    expect(releaseTool).not.toContain("CODESIGN_IDENTITY");
    expect(releaseTool).not.toContain("NOTARY_PROFILE");
    expect(buildScript).not.toMatch(
      /(?:echo|printf)[^\n]*\$(?:CODESIGN_IDENTITY|NOTARY_PROFILE)/,
    );
  });

  test("release-sensitive runner strips hostile controls at execution time", async () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-release-env-"));
    try {
      const releaseTool = buildScript.match(
        /run_release_sensitive_tool\(\) \{[\s\S]*?\n\}/,
      )?.[0];
      expect(releaseTool).toBeDefined();
      const shell = [
        "set -euo pipefail",
        'ENV_EXECUTABLE="/usr/bin/env"',
        `OPERATOR_HOME=${JSON.stringify(root)}`,
        'SANITIZED_PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
        `BUILD_WORK_DIR=${JSON.stringify(root)}`,
        "RELEASE_SENSITIVE_TEST_ENVIRONMENT=()",
        releaseTool!,
        'run_release_sensitive_tool "/usr/bin/env"',
      ].join("\n");
      const process = Bun.spawn(["/bin/bash", "-c", shell], {
        env: {
          ...Bun.env,
          CODESIGN_ALLOCATE: "/tmp/hostile-codesign-allocate",
          DYLD_INSERT_LIBRARIES: "/tmp/hostile.dylib",
          DYLD_LIBRARY_PATH: "/tmp/hostile-library-path",
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
          SHELLOPTS: "braceexpand",
          BUN_OPTIONS: "--preload=/tmp/hostile-bun-preload.ts",
          NODE_OPTIONS: "--require=/tmp/hostile-node-preload.cjs",
          NODE_PATH: "/tmp/hostile-node-path",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);

      expect(exitCode, stderr).toBe(0);
      const childEnvironment = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(childEnvironment).toEqual({
        HOME: root,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("notary runner strips hostile controls at execution time", async () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-notary-env-"));
    try {
      const runXcrun = buildScript.match(/run_xcrun\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(runXcrun).toBeDefined();
      const shell = [
        "set -euo pipefail",
        'ENV_EXECUTABLE="/usr/bin/env"',
        `OPERATOR_HOME=${JSON.stringify(root)}`,
        'SANITIZED_PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
        `BUILD_WORK_DIR=${JSON.stringify(root)}`,
        'XCRUN_EXECUTABLE="/usr/bin/env"',
        "XCRUN_TEST_ENVIRONMENT=()",
        runXcrun!,
        "run_xcrun",
      ].join("\n");
      const process = Bun.spawn(["/bin/bash", "-c", shell], {
        env: {
          ...Bun.env,
          CODESIGN_ALLOCATE: "/tmp/hostile-codesign-allocate",
          DYLD_INSERT_LIBRARIES: "/tmp/hostile.dylib",
          DYLD_LIBRARY_PATH: "/tmp/hostile-library-path",
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
          SHELLOPTS: "braceexpand",
          BUN_OPTIONS: "--preload=/tmp/hostile-bun-preload.ts",
          NODE_OPTIONS: "--require=/tmp/hostile-node-preload.cjs",
          NODE_PATH: "/tmp/hostile-node-path",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);

      expect(exitCode, stderr).toBe(0);
      const childEnvironment = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(childEnvironment).toEqual({
        HOME: root,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins integrity-sensitive tools inside both child scripts", () => {
    const companionPins = [
      ["CHMOD_EXECUTABLE", "/bin/chmod"],
      ["CP_EXECUTABLE", "/bin/cp"],
      ["ENV_EXECUTABLE", "/usr/bin/env"],
      ["GREP_EXECUTABLE", "/usr/bin/grep"],
      ["MKDIR_EXECUTABLE", "/bin/mkdir"],
      ["MKTEMP_EXECUTABLE", "/usr/bin/mktemp"],
      ["MV_EXECUTABLE", "/bin/mv"],
      ["RM_EXECUTABLE", "/bin/rm"],
      ["LIPO_EXECUTABLE", "/usr/bin/lipo"],
    ] as const;
    const smokePins = [
      ["BASENAME_EXECUTABLE", "/usr/bin/basename"],
      ["ENV_EXECUTABLE", "/usr/bin/env"],
      ["LSOF_EXECUTABLE", "/usr/sbin/lsof"],
      ["MKTEMP_EXECUTABLE", "/usr/bin/mktemp"],
      ["OPEN_EXECUTABLE", "/usr/bin/open"],
      ["RM_EXECUTABLE", "/bin/rm"],
      ["SED_EXECUTABLE", "/usr/bin/sed"],
      ["SLEEP_EXECUTABLE", "/bin/sleep"],
    ] as const;

    for (const [variable, systemPath] of companionPins) {
      expect(companionScript).toContain(`${variable}="$(select_executable "${systemPath}"`);
    }
    for (const [variable, systemPath] of smokePins) {
      expect(smokeScript).toContain(`${variable}="$(select_executable "${systemPath}"`);
    }
    expect(companionScript).not.toMatch(/^\s*(chmod|cp|env|grep|lipo|mkdir|mktemp|mv|rm)\b/m);
    expect(smokeScript).not.toMatch(/^\s*(basename|env|head|lsof|mktemp|open|rm|sed|sleep)\b/m);
    expect(smokeScript).toContain('RECORDINGS_TEST_SMOKE_ALLOW_NON_DARWIN:-0');
  });

  test("does not execute a Bun planted on hostile PATH without an explicit pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-hostile-path-"));
    try {
      const hostileBin = join(root, "bin");
      const marker = join(root, "hostile-bun-ran");
      mkdirSync(hostileBin);
      const hostileBun = join(hostileBin, "bun");
      writeFileSync(
        hostileBun,
        `#!/bin/bash\nprintf 'executed\\n' > ${JSON.stringify(marker)}\nexit 91\n`,
      );
      chmodSync(hostileBun, 0o755);

      const pinnedFixtureTools = {
        RECORDINGS_TEST_GIT_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_SWIFT_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_CODESIGN_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_XCRUN_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_SPCTL_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_SYSPOLICY_CHECK_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_DITTO_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_SHASUM_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_PLIST_BUDDY_EXECUTABLE: "/bin/true",
        RECORDINGS_TEST_PLUTIL_EXECUTABLE: "/bin/true",
      };
      const releaseProcess = Bun.spawn(
        [
          "/bin/bash",
          "src/native/Recordings/build.sh",
          "release",
          "initial-bootstrap",
        ],
        {
          env: {
            HOME: root,
            PATH: `${hostileBin}:/usr/bin:/bin`,
            ...pinnedFixtureTools,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [releaseExitCode, releaseStderr] = await Promise.all([
        releaseProcess.exited,
        new Response(releaseProcess.stderr).text(),
      ]);
      expect(releaseExitCode).not.toBe(0);
      expect(releaseStderr).toContain("explicit absolute Bun executable path");
      expect(existsSync(marker)).toBeFalse();

      const process = Bun.spawn(
        ["/bin/bash", "scripts/build_companion_cli.sh", join(root, "recordings")],
        {
          env: { PATH: `${hostileBin}:/usr/bin:/bin` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("explicit absolute Bun executable path");
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
