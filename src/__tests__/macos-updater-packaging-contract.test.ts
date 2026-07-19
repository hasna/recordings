import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPATIBLE_COHORT_KEYS,
  createCompatibleCohortManifest,
  createUpdateEnvelopePayload,
  parseCompatibleCohortManifest,
} from "../../packaging/macos/release_lifecycle";

const build = readFileSync("src/native/Recordings/build.sh", "utf8");
const pkg = readFileSync("packaging/macos/build_release_pkg.sh", "utf8");
const lifecycleHelper = readFileSync("packaging/macos/release_lifecycle.ts", "utf8");
const readme = readFileSync("README.md", "utf8");
const preinstall = readFileSync("packaging/macos/scripts/preinstall", "utf8");
const postinstall = readFileSync("packaging/macos/scripts/postinstall", "utf8");
const managedBootstrap = readFileSync("packaging/macos/managed_bootstrap.sh", "utf8");
const fingerprintParser = "packaging/macos/pkgutil_fingerprint.awk";
const swiftPackage = readFileSync("src/native/Recordings/Package.swift", "utf8");
const updateProtocol = readFileSync(
  "src/native/Recordings/Updater/Protocol/UpdateProtocol.swift",
  "utf8",
);
const appInfoPlist = readFileSync(
  "src/native/Recordings/RecordingsLib/Info.plist",
  "utf8",
);
const bootstrapPreflight = readFileSync(
  "src/native/Recordings/Updater/BootstrapPreflight/BootstrapPreflightMain.swift",
  "utf8",
);
const launchd = readFileSync(
  "packaging/macos/Library/LaunchDaemons/com.hasna.recordings.updater.plist",
  "utf8",
);
const sandbox = readFileSync("packaging/macos/artifact-verifier.sb", "utf8");
const cli = readFileSync("src/cli/index.ts", "utf8");

describe("root-owned macOS updater packaging contract", () => {
  const digest = (character: string) => character.repeat(64);
  const brokerRequirement = 'identifier "com.hasna.recordings.updater" and anchor apple generic';
  const verifierRequirement =
    'identifier "com.hasna.recordings.artifact-verifier" and anchor apple generic';
  const compatibleCohort = createCompatibleCohortManifest({
    artifact_verifier_designated_requirement: verifierRequirement,
    artifact_verifier_sha256: digest("a"),
    bootstrap_marker_sha256: digest("b"),
    envelope_public_key_sha256: digest("c"),
    installer_certificate_sha256: digest("d"),
    key_epoch: 3,
    minimum_broker_version: "1.0.0",
    package_sha256: digest("e"),
    signing_team_identifier: "TEAMID1234",
    update_broker_designated_requirement: brokerRequirement,
    update_broker_sha256: digest("f"),
  });

  test("enforces the exact schema-v2 compatible-cohort key and binding contract", () => {
    expect(Object.keys(compatibleCohort).sort()).toEqual([...COMPATIBLE_COHORT_KEYS].sort());
    expect(compatibleCohort.schema_version).toBe(2);
    expect(compatibleCohort.installer_certificate_sha256).toBe(digest("d"));
    expect(() =>
      parseCompatibleCohortManifest(compatibleCohort, {
        teamIdentifier: "TEAMID1234",
        keyEpoch: 3,
        envelopePublicKeySHA256: digest("c"),
      }),
    ).not.toThrow();

    for (const invalid of [
      { ...compatibleCohort, schema_version: 1 },
      { ...compatibleCohort, protocol_version: 2 },
      { ...compatibleCohort, key_epoch: 4 },
      { ...compatibleCohort, signing_team_identifier: "OTHERID123" },
      { ...compatibleCohort, package_sha256: digest("A") },
      { ...compatibleCohort, update_broker_designated_requirement: "" },
      { ...compatibleCohort, unexpected: true },
    ]) {
      expect(() =>
        parseCompatibleCohortManifest(invalid, {
          teamIdentifier: "TEAMID1234",
          keyEpoch: 3,
          envelopePublicKeySHA256: digest("c"),
        }),
      ).toThrow();
    }
  });

  test("keeps broker and minimum-OS release constants mechanically aligned", () => {
    const brokerVersion = updateProtocol.match(/brokerVersion = "([^"]+)"/)?.[1];
    expect(brokerVersion).toBe("1.0.0");
    expect(
      pkg.match(/(?:--minimum-broker-version|-insert minimum_broker_version -string) 1\.0\.0/g)
        ?.length,
    ).toBe(2);

    const packageMinimumMajor = swiftPackage.match(/\.macOS\(\.v([0-9]+)\)/)?.[1];
    const plistMinimum = appInfoPlist.match(
      /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    expect(packageMinimumMajor).toBeDefined();
    expect(plistMinimum).toBe(`${packageMinimumMajor}.0`);
    expect(pkg).toContain(
      '-insert minimum_os_version -string "$(/usr/bin/plutil -extract minimum_macos raw -o - "$MANIFEST")"',
    );
  });

  test("carries the bootstrap Installer certificate into app-update envelopes", () => {
    const applicationRequirement = 'identifier "com.hasna.recordings"';
    const applicationRequirementSHA256 = new Bun.CryptoHasher("sha256")
      .update(applicationRequirement)
      .digest("hex");
    const payload = createUpdateEnvelopePayload({
      cohort: compatibleCohort,
      manifest: {
        archiveSHA256: digest("1"),
        build: "13",
        candidateTreeSHA256: digest("2"),
        minimumOSVersion: "26.0",
        sourceCommit: "3".repeat(40),
        teamIdentifier: "TEAMID1234",
        version: "0.2.13",
        architectures: ["arm64", "x86_64"],
        applicationDesignatedRequirementSHA256: applicationRequirementSHA256,
      },
      releaseSequence: 14,
      appArchiveSHA256: digest("1"),
      appArchiveByteCount: 1024,
      manifestSHA256: digest("4"),
      manifestByteCount: 2048,
      updateClientSHA256: digest("5"),
      applicationDesignatedRequirement: applicationRequirement,
      updateClientDesignatedRequirement: 'identifier "com.hasna.recordings.update-client"',
      expiresAtUTC: "2026-08-01T00:00:00.000Z",
      now: new Date("2026-07-19T00:00:00.000Z"),
      releaseID: "11111111-1111-4111-8111-111111111111",
    });
    expect(payload.purpose).toBe("update");
    expect(payload.package_sha256).toBe(compatibleCohort.package_sha256);
    expect(payload.installer_certificate_sha256).toBe(
      compatibleCohort.installer_certificate_sha256,
    );
    expect(payload.update_broker_sha256).toBe(compatibleCohort.update_broker_sha256);
    expect(payload.artifact_verifier_sha256).toBe(
      compatibleCohort.artifact_verifier_sha256,
    );
  });

  test("documents complete isolated-builder commands and canonical bootstrap retention", () => {
    for (const required of [
      'BUN_EXECUTABLE="/absolute/path/to/bun"',
      "./build.sh release initial-bootstrap",
      "./build.sh release app-update",
      "RECORDINGS_INSTALLER_CODESIGN_IDENTITY",
      "RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST",
      "/private/var/recordings-build",
      "recordings-isolated-builder-v1",
      "canonical onboarding artifact",
      "schema-v2 compatible-cohort manifest",
      "Installer certificate",
    ]) {
      expect(readme).toContain(required);
    }
    const initialCommand = readme.slice(
      readme.indexOf("# One-time initial bootstrap"),
      readme.indexOf("# After independent review"),
    );
    const updateCommand = readme.slice(
      readme.indexOf("# App-only update"),
      readme.indexOf("# Explicit local-only alternative"),
    );
    expect(initialCommand).toContain("RECORDINGS_INSTALLER_CODESIGN_IDENTITY");
    expect(initialCommand).not.toContain('RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST="');
    expect(updateCommand).toContain("RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST");
    expect(updateCommand).not.toContain('RECORDINGS_INSTALLER_CODESIGN_IDENTITY="');
  });

  test("ships executable package and managed-bootstrap entry points", () => {
    for (const path of [
      "packaging/macos/build_release_pkg.sh",
      "packaging/macos/managed_bootstrap.sh",
      "packaging/macos/scripts/preinstall",
      "packaging/macos/scripts/postinstall",
    ]) {
      expect(statSync(path).mode & 0o111).not.toBe(0);
    }
  });

  test("constrains the PKG to one-time managed bootstrap and routes updates through XPC", () => {
    expect(preinstall).toContain("only app-artifact updates are supported");
    expect(preinstall).toContain("managed reprovisioning");
    expect(preinstall).toContain("/var/db/com.hasna.recordings.updater");
    expect(preinstall).not.toContain("bootout system/com.hasna.recordings.updater");
    expect(cli).toContain(
      'const updateClientPath = "/Applications/Recordings.app/Contents/Helpers/recordings-update-client"',
    );
    expect(cli).toContain('"--envelope"');
    expect(cli).not.toContain("RECORDINGS_TEST_UPDATE_CLIENT");
    expect(managedBootstrap).toContain('"$PAYLOAD_CLIENT" bootstrap');
    expect(managedBootstrap).not.toContain('"$CLIENT" bootstrap');
    expect(managedBootstrap).toContain(
      'PAYLOAD_CLIENT="$PAYLOAD/Applications/Recordings.app/Contents/Helpers/recordings-update-client"',
    );
    expect(managedBootstrap).toContain('--artifact "$SNAPSHOT_PKG"');
    expect(bootstrapPreflight).toContain("payload.packageSHA256 == packageDigest");
    expect(managedBootstrap).toContain("--expected-package-sha256");
    expect(managedBootstrap).toContain("--expected-installer-team-id");
    expect(managedBootstrap).toContain("--expected-installer-certificate-sha256");
    expect(managedBootstrap).toContain("management-pinned digest");
    expect(managedBootstrap).toContain("spctl --assess --type install");
    expect(managedBootstrap).toContain("ACTUAL_INSTALLER_CERTIFICATE_SHA256");
    expect(managedBootstrap).toContain("path_exists_or_symlink");
    expect(managedBootstrap).toContain("partial or conflicting");
    expect(managedBootstrap).toContain('BOOTSTRAP_MODE="recover"');
    expect(managedBootstrap).toContain("Managed bootstrap target ancestry is missing, linked, or not root-owned");
    expect(managedBootstrap).toContain('"/Library/Application Support/Hasna/Recordings"');
    expect(managedBootstrap).toContain("root-private snapshot");
    expect(managedBootstrap).toContain("--expand-full");
    expect(managedBootstrap).toContain("--require-committed-state");
    expect(managedBootstrap.indexOf("run_preflight false")).toBeLessThan(
      managedBootstrap.indexOf("/usr/sbin/installer -pkg"),
    );
    expect(managedBootstrap.lastIndexOf("run_preflight false")).toBeLessThan(
      managedBootstrap.indexOf('"$PAYLOAD_CLIENT" bootstrap'),
    );
    expect(preinstall).toContain("path_exists_or_symlink");
    expect(preinstall).toContain("Recordings updater target ancestry is missing, linked, or not root-owned");
    expect(preinstall).toContain('"/Library/Application Support/Hasna/Recordings"');
    expect(postinstall).toContain("target ancestry is missing, linked, or not root-owned");
    expect(postinstall).toContain("interrupted package mutation root is linked or has ownership/mode drift");
    expect(postinstall.indexOf("require_root_owned_nonwritable_directory")).toBeLessThan(
      postinstall.indexOf("/bin/mkdir -p"),
    );
    expect(postinstall.indexOf("for created_directory in")).toBeLessThan(
      postinstall.indexOf("/usr/sbin/chown -R"),
    );
  });

  test("authorizes only exact-package crash repair through a durable pre-Installer journal", () => {
    const journalPath =
      'AUTHORIZATION_JOURNAL="${AUTHORIZATION_ROOT}/journal"';
    for (const script of [managedBootstrap, preinstall, postinstall]) {
      expect(script).toContain(
        'AUTHORIZATION_ROOT="/private/var/db/com.hasna.recordings.bootstrap-authorization"',
      );
      expect(script).toContain(journalPath);
      expect(script).toContain('PACKAGE_BOOTSTRAP_ID="');
      expect(script).toContain("package_bootstrap_id");
      expect(script).toContain("require_authorization_journal");
      expect(script).toContain("authorization journal");
      expect(script).toContain("stat -f '%u:%g:%Lp'");
      expect(script).toContain('require_no_extended_acl "$AUTHORIZATION_JOURNAL"');
    }

    expect(pkg).toContain('PACKAGE_BOOTSTRAP_ID="$(/usr/bin/uuidgen');
    expect(pkg).toContain("__RECORDINGS_PACKAGE_BOOTSTRAP_ID__");
    expect(pkg).toContain('"$SCRIPTS/preinstall"');
    expect(pkg).toContain('"$SCRIPTS/postinstall"');
    expect(managedBootstrap).toContain('EXPANDED_PREINSTALL="$EXPANDED/Scripts/preinstall"');
    expect(managedBootstrap).toContain('EXPANDED_POSTINSTALL="$EXPANDED/Scripts/postinstall"');
    expect(managedBootstrap).toContain("extract_package_bootstrap_id");
    expect(managedBootstrap).toContain(
      '[ "$PREINSTALL_BOOTSTRAP_ID" = "$POSTINSTALL_BOOTSTRAP_ID" ]',
    );
    expect(managedBootstrap).toContain(
      '[ "$JOURNAL_PACKAGE_SHA256" = "$ACTUAL_PKG_SHA256" ]',
    );
    expect(managedBootstrap).toContain(
      '[ "$JOURNAL_PACKAGE_BOOTSTRAP_ID" = "$PACKAGE_BOOTSTRAP_ID" ]',
    );
    expect(managedBootstrap).toContain("different authenticated package");
    expect(managedBootstrap).toContain("authorization evidence is missing or unsafe");
    const installerIndex = managedBootstrap.indexOf("/usr/sbin/installer -pkg");
    const journalWriter = managedBootstrap.match(
      /write_authorization_journal\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(journalWriter).toBeDefined();
    expect(journalWriter).toContain("phase=authorized");
    expect(journalWriter).toContain("package_sha256=%s");
    expect(journalWriter).toContain("package_bootstrap_id=%s");
    expect(journalWriter).toContain("installer_certificate_sha256=%s");
    expect(journalWriter).toContain("/bin/sync");
    expect(managedBootstrap.lastIndexOf("write_authorization_journal", installerIndex))
      .toBeLessThan(installerIndex);
    expect(managedBootstrap.lastIndexOf("write_authorization_journal", installerIndex))
      .toBeGreaterThan(managedBootstrap.indexOf("run_preflight false"));

    expect(preinstall).toContain('JOURNAL_PHASE="authorized"');
    expect(preinstall).toContain('write_authorization_phase "installer-started"');
    expect(preinstall).toContain('JOURNAL_PHASE="installer-started"');
    expect(preinstall).toContain("authorized exact-package repair");
    expect(preinstall).toContain("partial updater cohort without exact-package authorization");
    expect(preinstall).toContain('path_exists_or_symlink "$AUTHORIZATION_ROOT"');
    expect(postinstall).toContain('[ "$JOURNAL_PHASE" = "installer-started" ]');
    const firstInstallPhase = preinstall.match(
      /authorized\)\n([\s\S]*?)write_authorization_phase "installer-started"/,
    )?.[1];
    const retryPhase = preinstall.match(
      /installer-started\)\n([\s\S]*?);;\n  \*\)/,
    )?.[1];
    expect(firstInstallPhase).toContain('[ "$present_count" -eq 0 ]');
    expect(firstInstallPhase).toContain('[ "$service_present" = false ]');
    expect(firstInstallPhase).toContain('! /usr/bin/dscl . -read "/Groups/${VERIFIER_GROUP}"');
    expect(retryPhase).toContain('[ "$service_present" = false ]');
    expect(retryPhase).not.toContain('[ "$present_count" -eq 0 ]');

    expect(managedBootstrap).toContain('BOOTSTRAP_MODE="repair"');
    expect(managedBootstrap).toContain('BOOTSTRAP_MODE="recover"');
    expect(managedBootstrap).toContain("full cohort without a registered service");
    expect(managedBootstrap).toContain("partial cohort");
    expect(managedBootstrap).toContain("committed different cohort");
    const noServiceRepair = managedBootstrap.match(
      /else\n  if path_exists_or_symlink "\$STATE"; then[\s\S]*?BOOTSTRAP_MODE="repair"[\s\S]*?\nfi\n\nif \[ "\$BOOTSTRAP_MODE" = repair \]/,
    )?.[0];
    expect(noServiceRepair).toBeDefined();
    expect(noServiceRepair).toContain('[ "$present_count" -eq "${#COHORT_PATHS[@]}" ]');
    expect(noServiceRepair).toContain('[ "$present_count" -gt 0 ]');
    expect(noServiceRepair).not.toContain('[ "$present_count" -eq 0 ]');
    const journalValidator = managedBootstrap.match(
      /require_authorization_journal\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(journalValidator).toContain("authorization evidence is missing or unsafe");
    expect(journalValidator).toContain('[ "$JOURNAL_PACKAGE_SHA256" = "$ACTUAL_PKG_SHA256" ]');
    expect(journalValidator).toContain('[ "$JOURNAL_PACKAGE_BOOTSTRAP_ID" = "$PACKAGE_BOOTSTRAP_ID" ]');
    expect(managedBootstrap).toContain("run_preflight true");
    expect(managedBootstrap.lastIndexOf("run_preflight true")).toBeLessThan(
      managedBootstrap.lastIndexOf("remove_authorization_journal"),
    );
    expect(managedBootstrap).toContain('/bin/rm -f "$AUTHORIZATION_JOURNAL"');
  });

  test("makes package retry initialization and service registration idempotent", () => {
    expect(postinstall).not.toContain(
      'fail "package target mutation root already exists or is linked',
    );
    expect(postinstall).toContain("validate_existing_mutation_root");
    expect(postinstall).toContain("ensure_directory_value");
    expect(postinstall).toContain("repair interrupted verifier group initialization");
    expect(postinstall).toContain("repair interrupted verifier account initialization");
    expect(postinstall).toContain(
      "if ! /bin/launchctl print system/com.hasna.recordings.updater",
    );
    expect(postinstall).toContain('/bin/launchctl bootstrap system "$LAUNCHD_PLIST"');
    expect(postinstall).toContain('/bin/launchctl enable system/com.hasna.recordings.updater');
    expect(postinstall).toContain('/bin/launchctl kickstart -k system/com.hasna.recordings.updater');
    expect(postinstall.indexOf("require_authorization_journal")).toBeLessThan(
      postinstall.indexOf("/usr/bin/dscl . -create"),
    );
  });

  test("fails closed on extended ACLs and strips ACL inheritance only from package-owned trees", () => {
    for (const script of [preinstall, postinstall, managedBootstrap, pkg]) {
      expect(script).toContain("require_no_extended_acl");
      expect(script).toContain("/bin/ls -lade");
      expect(script).toContain("extended ACL");
      expect(script).toContain('$1 ~ /^[0-9]+:$/');
    }

    expect(preinstall).toContain('require_no_extended_acl "$directory"');
    expect(preinstall).not.toContain("/bin/chmod -RN");
    expect(preinstall).toContain(
      '"/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier:555"',
    );

    expect(postinstall).toContain("require_safe_package_tree_structure");
    expect(postinstall).toContain("package_entry_structure_is_safe");
    expect(postinstall).toContain('/usr/bin/find -x "$tree" -print0');
    expect(postinstall).toContain('[ ! -L "$entry" ]');
    expect(postinstall).toContain("[ \"$links\" = \"1\" ]");
    expect(postinstall).toContain("[ \"$owner\" = \"0\" ]");
    expect(postinstall).toContain("[ \"$device\" = \"$expected_device\" ]");
    expect(postinstall).toContain('/bin/chmod -RN "$package_owned_tree"');
    expect(postinstall).toContain('/bin/chmod -N "$package_owned_leaf"');
    expect(postinstall).toContain('require_tree_without_extended_acl "$package_owned_tree"');
    expect(postinstall).toContain('require_tree_without_extended_acl "$launch_tree"');
    expect(postinstall.lastIndexOf('require_safe_package_tree_structure "$package_owned_tree"')).toBeLessThan(
      postinstall.indexOf('/bin/chmod -RN "$package_owned_tree"'),
    );
    expect(postinstall.indexOf('/bin/chmod -RN "$package_owned_tree"')).toBeLessThan(
      postinstall.indexOf('require_tree_without_extended_acl "$package_owned_tree"'),
    );
    expect(postinstall.indexOf('/bin/chmod -RN "$package_owned_tree"')).toBeLessThan(
      postinstall.indexOf("/bin/launchctl bootstrap system"),
    );
    const recursiveAclMutation = postinstall.match(
      /for package_owned_tree in \\\n([\s\S]*?)\/bin\/chmod -RN "\$package_owned_tree"/,
    )?.[1] ?? "";
    expect(recursiveAclMutation).not.toContain('"$APP"');
    expect(postinstall).not.toContain('/usr/sbin/chown -R root:wheel "$APP"');
    expect(postinstall).not.toContain('/bin/chmod -R go-w "$APP"');
    expect(postinstall).toContain('require_tree_without_extended_acl "$APP"');
    expect(postinstall.lastIndexOf("require_root_owned_nonwritable_directory")).toBeLessThan(
      postinstall.indexOf("/bin/launchctl bootstrap system"),
    );

    expect(managedBootstrap).toContain('require_no_extended_acl "$input"');
    expect(managedBootstrap).toContain('/bin/chmod -RN "$EXPANDED"');
    expect(managedBootstrap).toContain('require_tree_without_extended_acl "$EXPANDED"');
    expect(managedBootstrap.lastIndexOf("validate_target_ancestry")).toBeLessThan(
      managedBootstrap.indexOf('"$PAYLOAD_CLIENT" bootstrap'),
    );
    expect(managedBootstrap.lastIndexOf('require_tree_without_extended_acl "$EXPANDED"')).toBeLessThan(
      managedBootstrap.indexOf('"$PAYLOAD_CLIENT" bootstrap'),
    );

    expect(pkg).toContain('require_no_extended_acl "$release_input"');
    expect(pkg).toContain('require_tree_without_extended_acl "$APP"');
    expect(pkg).toContain('/bin/chmod -RN "$ROOT" "$SCRIPTS"');
    expect(pkg).toContain('require_tree_without_extended_acl "$ROOT"');
    expect(pkg.indexOf('/bin/chmod -RN "$ROOT" "$SCRIPTS"')).toBeLessThan(
      pkg.indexOf("/usr/bin/pkgbuild"),
    );

    for (const installerScript of [preinstall, postinstall, managedBootstrap]) {
      expect(installerScript).toContain("require_expected_var_link");
      expect(installerScript).toContain('/usr/bin/readlink "/var"');
      expect(installerScript).toContain('"/private/var/db"');
      expect(installerScript).toContain("require_managed_applications_directory");
      expect(installerScript).toContain("stat -f '%u' \"/Applications\"");
      expect(installerScript).toContain("755:*|775:80");
      expect(installerScript).toContain("stat -f '%g'");
      expect(installerScript).toContain("8#022");
      expect(installerScript).not.toContain("775:admin");
    }
    for (const recursiveScript of [postinstall, managedBootstrap, pkg]) {
      expect(recursiveScript).toContain('/bin/ls -laeR "$tree"');
      expect(recursiveScript).not.toContain('/bin/ls -ladeR "$tree"');
    }
  });

  test("parses same-line and multiline pkgutil SHA-256 fingerprints and rejects malformed output", () => {
    const digest = "A1".repeat(32);
    for (const fixture of [
      `Package "x":\n   SHA256 Fingerprint: ${digest}\n`,
      `Package "x":\n   SHA256 Fingerprint:\n       ${digest.match(/../g)!.join(" ")}\n`,
      `Package "x":\n   SHA256 Fingerprint:\n       ${digest.slice(0, 32)}\n       ${digest.slice(32)}\n`,
    ]) {
      const result = spawnSync("awk", ["-f", fingerprintParser], {
        input: fixture,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(digest.toLowerCase());
    }
    for (const fixture of [
      "Package \"x\":\n",
      "SHA256 Fingerprint: not-a-fingerprint\n",
      `SHA256 Fingerprint: ${"A1".repeat(31)}\n`,
    ]) {
      expect(spawnSync("awk", ["-f", fingerprintParser], { input: fixture }).status).not.toBe(0);
    }
  });

  test("ships a scripts-only cryptographic bootstrap preflight verifier", () => {
    expect(swiftPackage).toContain('name: "recordings-bootstrap-preflight"');
    expect(swiftPackage).toContain('path: "Updater/BootstrapPreflight"');
    expect(pkg).toContain("--bootstrap-preflight-verifier");
    expect(pkg).toContain('"$SCRIPTS/recordings-bootstrap-preflight"');
    expect(pkg).not.toContain(
      '$ROOT/Library/PrivilegedHelperTools/recordings-bootstrap-preflight',
    );
    for (const binding of [
      "envelope.verify(publicKeyData:",
      "payload.packageSHA256 == packageDigest",
      "payload.manifestSHA256 == sha256(manifestData)",
      "payload.installerCertificateSHA256",
      "validateStaticCode(",
      "payload.candidateTreeSHA256",
      "validateBootstrapMarker",
      "validateReleaseState",
    ]) {
      expect(bootstrapPreflight).toContain(binding);
    }
  });

  test("installs a root launchd broker and a locked no-login verifier account", () => {
    expect(launchd).toContain("com.hasna.recordings.updater");
    expect(launchd).toContain("/Library/PrivilegedHelperTools/com.hasna.recordings.updater");
    expect(launchd).toContain("<string>root</string>");
    expect(postinstall).toContain('VERIFIER_USER="_recordingsverify"');
    expect(postinstall).toContain('UserShell "/usr/bin/false"');
    expect(postinstall).toContain('NFSHomeDirectory "/var/empty"');
    expect(postinstall).toContain("validate_verifier_group");
    expect(postinstall).toContain("verifier group must not grant supplementary membership");
    expect(postinstall).toContain("reserved verifier range");
  });

  test("binds exact Developer ID component identities and entitlement allowlists", () => {
    for (const identifier of [
      "com.hasna.recordings.updater",
      "com.hasna.recordings.update-client",
      "com.hasna.recordings.artifact-verifier",
      "com.hasna.recordings",
    ]) {
      expect(postinstall).toContain(identifier);
    }
    expect(postinstall).toContain('[[ "$authority" == "Developer ID Application:"* ]]');
    expect(postinstall).toContain('case ",$flags," in *,runtime,*)');
    expect(postinstall).toContain("verify_entitlement_allowlist");
    expect(postinstall).toContain("entitlements outside its allowlist");
    expect(postinstall).toContain(
      '[ "$(/usr/bin/stat -f \'%Lp\' "$CLIENT")" = "755" ]',
    );
    expect(build).toContain('"$CHMOD_EXECUTABLE" 0755 "$UPDATE_CLIENT"');
  });

  test("rejects malformed signed app and executable payload modes without repairing them", () => {
    const exactFileModeValidator = pkg.match(
      /require_exact_regular_file_mode\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    const appModeValidator = pkg.match(
      /require_safe_signed_app_bundle_modes\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(exactFileModeValidator).toBeDefined();
    expect(appModeValidator).toBeDefined();

    const root = mkdtempSync(join(tmpdir(), "recordings-pkg-modes-"));
    const app = join(root, "Recordings.app");
    const main = join(app, "Contents", "MacOS", "Recordings");
    const companion = join(app, "Contents", "Helpers", "recordings");
    const client = join(app, "Contents", "Helpers", "recordings-update-client");
    const resource = join(app, "Contents", "Resources", "fixture.json");
    const validate = () =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            exactFileModeValidator!,
            appModeValidator!,
            'require_safe_signed_app_bundle_modes "$1"',
          ].join("\n"),
          "package-mode-test",
          app,
        ],
        { encoding: "utf8" },
      );
    const validateRegularFile = (path: string, expectedMode: "0755" | "0555") =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            exactFileModeValidator!,
            `require_exact_regular_file_mode "$1" ${expectedMode} "Fixture executable"`,
          ].join("\n"),
          "package-executable-mode-test",
          path,
        ],
        { encoding: "utf8" },
      );

    try {
      for (const directory of [
        app,
        join(app, "Contents"),
        join(app, "Contents", "MacOS"),
        join(app, "Contents", "Helpers"),
        join(app, "Contents", "Resources"),
      ]) {
        mkdirSync(directory, { recursive: true, mode: 0o755 });
        chmodSync(directory, 0o755);
      }
      for (const executable of [main, companion, client]) {
        writeFileSync(executable, "fixture", { mode: 0o755 });
        chmodSync(executable, 0o755);
      }
      writeFileSync(resource, "fixture", { mode: 0o644 });
      chmodSync(resource, 0o644);

      expect(validate().status).toBe(0);

      chmodSync(app, 0o700);
      expect(validate().status).not.toBe(0);
      chmodSync(app, 0o755);

      chmodSync(main, 0o644);
      expect(validate().status).not.toBe(0);
      chmodSync(main, 0o755);

      chmodSync(resource, 0o666);
      expect(validate().status).not.toBe(0);
      expect(statSync(resource).mode & 0o777).toBe(0o666);
      chmodSync(resource, 0o644);

      const linkedResource = join(app, "Contents", "Resources", "linked-resource");
      symlinkSync(resource, linkedResource);
      expect(validate().status).not.toBe(0);
      rmSync(linkedResource);

      const hardlinkedResource = join(app, "Contents", "Resources", "hardlinked-resource");
      linkSync(resource, hardlinkedResource);
      expect(validate().status).not.toBe(0);
      rmSync(hardlinkedResource);

      const standaloneExecutable = join(root, "standalone-executable");
      writeFileSync(standaloneExecutable, "fixture", { mode: 0o755 });
      chmodSync(standaloneExecutable, 0o755);
      expect(validateRegularFile(standaloneExecutable, "0755").status).toBe(0);
      chmodSync(standaloneExecutable, 0o644);
      expect(validateRegularFile(standaloneExecutable, "0755").status).not.toBe(0);
      chmodSync(standaloneExecutable, 0o555);
      expect(validateRegularFile(standaloneExecutable, "0555").status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(pkg).not.toContain('/bin/chmod -R 0755 "$APP"');
    expect(pkg).not.toContain('/bin/chmod -R 0644 "$APP"');
    expect(pkg.indexOf('require_safe_signed_app_bundle_modes "$APP"')).toBeLessThan(
      pkg.indexOf('/usr/bin/ditto "$APP" "$ROOT/Applications/Recordings.app"'),
    );
    expect(pkg.indexOf('require_safe_signed_app_bundle_modes "$STAGED_APP"')).toBeLessThan(
      pkg.indexOf('/usr/bin/pkgbuild'),
    );
  });

  test("isolates bootstrap PKG production from app-update envelope production", () => {
    expect(build).toContain('BUILD_ROOT="/private/var/recordings-build"');
    expect(build).toContain('OUTPUT_BUILD_DIR="$BUILD_ROOT/release-output"');
    expect(build).toContain("Managed release output must be an isolated builder-owned 0700 directory");
    expect(build).toContain('"_recordingsbuild"');
    expect(build).toContain("recordings-isolated-builder-v1");
    expect(pkg).toContain('SOURCE_ROOT/.git');
    expect(pkg).toContain("Package builder is not executing from the pinned archived source tree");
    expect(pkg).toContain("--timestamp");
    expect(pkg).toContain('"$STAGED_VERIFIER" assert-notary-log');
    expect(pkg).toContain('--submitted-archive-sha256 "$SUBMITTED_PKG_SHA256"');
    expect(pkg).toContain("Developer ID Installer:");
    expect(pkg).toContain("installer_certificate_sha256");
    expect(pkg).toContain("bootstrap_marker_sha256");
    expect(pkg).toContain("binding.bundle_tree_sha256");
    expect(pkg).toContain('ACTUAL_STAGED_APP_TREE_SHA256="$("$STAGED_VERIFIER" tree-digest --path "$STAGED_APP")"');
    expect(pkg).toContain("Staged PKG application tree does not match the finalized manifest binding");
    expect(postinstall).toContain("bootstrap-marker.json");
    expect(postinstall).toContain("broker policy must disable root maintenance");
    expect(postinstall).toContain("broker policy must disable key rotation");
    expect(postinstall).toContain("broker policy does not pin the bootstrap key epoch");
    expect(postinstall).toContain("broker policy authorizes unsupported key-epoch transitions");
    expect(pkg).toContain("package_sha256");
    expect(pkg).toContain('"allowed_key_epochs":[%s]');
    expect(pkg).toContain('"lifecycle":"bootstrap-v1-app-updates-only"');
    expect(pkg).toContain('"root_maintenance_supported":false');
    expect(pkg).toContain('"key_rotation_supported":false');
    expect(pkg).toContain('/usr/bin/plutil -insert artifact_sha256 -string "$PKG_DIGEST"');
    expect(pkg).toContain('/usr/bin/plutil -insert candidate_tree_sha256 -string "$STAGED_APP_TREE_SHA256"');
    expect(pkg).toContain('write-compatible-cohort');
    expect(pkg).toContain('--installer-certificate-sha256 "$INSTALLER_CERTIFICATE_SHA256"');
    expect(pkg).toContain('COMPATIBLE_COHORT_SHA256');
    expect(pkg).not.toContain("compatible-cohort-manifest");
    expect(pkg).not.toContain("UPDATE_ENVELOPE");
    expect(pkg).not.toContain("Built signed external app update envelope");
    expect(build).toContain("RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST");
    expect(build).toContain('--compatible-cohort-manifest "$COMPATIBLE_COHORT_SNAPSHOT"');
    expect(build).toContain('validate-compatible-cohort');
    expect(build).toContain('write-update-payload');
    expect(pkg).toContain('"$ENVELOPE_SIGNER"');
    expect(pkg).toContain("--private-key");
    expect(pkg).toContain("--public-key");
    expect(pkg).toContain("Built signed external bootstrap envelope");
    const updateFunction = build.match(
      /build_app_update_envelope\(\) \{[\s\S]*?\n\}\n\nverify_source_unchanged/,
    )?.[0];
    expect(updateFunction).toBeDefined();
    expect(updateFunction!.match(/run_release_sensitive_tool "\$ENVELOPE_SIGNER"/g)).toHaveLength(1);
    expect(build.match(/^\s*build_app_update_envelope$/gm)).toHaveLength(1);
    expect(updateFunction).not.toContain("build_release_pkg.sh");
    expect(updateFunction).not.toContain("INSTALLER_IDENTITY");
    expect(lifecycleHelper).toContain("COMPATIBLE_COHORT_KEYS");
    expect(lifecycleHelper).toContain("installer_certificate_sha256");
  });

  test("package assembly independently enforces the exact universal executable cohort", () => {
    expect(pkg).toContain("require_exact_binary_architectures() {");
    expect(pkg).toContain('actual_architectures="$(/usr/bin/lipo -archs "$binary")"');
    for (const binary of [
      '"$APP/Contents/MacOS/Recordings"',
      '"$APP/Contents/Helpers/recordings"',
      '"$CLIENT"',
      '"$BROKER"',
      '"$BOOTSTRAP_PREFLIGHT_VERIFIER"',
      '"$VERIFIER"',
      '"$STAGED_APP/Contents/MacOS/Recordings"',
      '"$STAGED_APP/Contents/Helpers/recordings"',
      '"$STAGED_CLIENT"',
      '"$STAGED_BROKER"',
      '"$STAGED_BOOTSTRAP_PREFLIGHT"',
      '"$STAGED_VERIFIER"',
    ]) {
      expect(pkg).toContain(`require_exact_binary_architectures ${binary} arm64 x86_64`);
    }
    expect(pkg.indexOf('require_exact_binary_architectures "$APP/Contents/MacOS/Recordings"'))
      .toBeLessThan(pkg.indexOf("/usr/bin/pkgbuild"));
  });

  test("builds root-cohort components only for initial bootstrap", () => {
    for (const product of [
      "recordings-update-broker",
      "recordings-update-client",
      "recordings-envelope-signer",
      "recordings-bootstrap-preflight",
    ]) {
      expect(build).toContain(product);
    }
    expect(build).toContain('com.hasna.recordings.update-client');
    expect(build).toContain('com.hasna.recordings.artifact-verifier');
    expect(build).toContain('packaging/macos/build_release_pkg.sh');
    expect(build).toContain('--app-archive "$FINAL_ARCHIVE"');
    expect(build).toContain('RELEASE_UPDATER_PRODUCTS=(recordings-update-client recordings-envelope-signer)');
    expect(build).toContain('if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then');
    expect(build).toContain('RELEASE_UPDATER_PRODUCTS+=(recordings-update-broker recordings-bootstrap-preflight)');
    expect(build).toContain('App-update staging contains a forbidden bootstrap or root-cohort output');
  });

  test("ships an explicit kernel sandbox policy for the unprivileged verifier", () => {
    expect(sandbox).toContain("(deny default)");
    expect(sandbox).toContain("(deny network*)");
    expect(sandbox).toContain('(allow file-read* (subpath (param "OUTPUT_DIR")))');
    expect(sandbox).toContain('(allow file-write* (subpath (param "OUTPUT_DIR")))');
    expect(sandbox).toContain('/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier');
    expect(cli).not.toContain("--archive-fd");
    expect(readFileSync("scripts/macos_artifact.ts", "utf8")).toContain("verifyAndExtractArchiveDescriptors");
    expect(postinstall).toContain("artifact-verifier.sb");
  });
});
