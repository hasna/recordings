import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MacOSArtifactManifest,
  assertCleanGitStatus,
  assertExpectedCodeLayout,
  assertVersionTransition,
  designatedRequirementForPolicy,
  parseDesignatedRequirement,
  verifyArchiveManifest,
  compareVersions,
  sha256File as fileDigest,
  tailscaleNodeIdSha256,
} from "../../scripts/macos_artifact";

const temporaryDirectories: string[] = [];
const targetIdentitySha256 = Bun.CryptoHasher.hash(
  "sha256",
  "11111111-1111-4111-8111-111111111111",
  "hex",
);
const builderIdentitySha256 = "6".repeat(64);
const strictAdHocDetails = [
  "Executable=/tmp/Recordings.app/Contents/MacOS/Recordings",
  "Identifier=com.hasna.recordings",
  "CodeDirectory v=20400 size=123 flags=0x10000(runtime)",
  "Signature=adhoc",
  "TeamIdentifier=not set",
  "Timestamp=none",
].join("\n");
const appEntitlements = JSON.stringify({
  "com.apple.security.app-sandbox": false,
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.audio-input": true,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  archivePath: string;
  manifestPath: string;
  manifest: MacOSArtifactManifest;
} {
  const root = mkdtempSync(join(tmpdir(), "recordings-artifact-"));
  temporaryDirectories.push(root);
  mkdirSync(root, { recursive: true });
  const archivePath = join(root, "Recordings-0.2.12-macos.zip");
  const manifestPath = join(root, "Recordings-0.2.12-macos.manifest.json");
  writeFileSync(archivePath, "immutable signed archive fixture");
  const manifest: MacOSArtifactManifest = {
    schema_version: 2,
    artifact_type: "recordings-macos-app",
    bundle_id: "com.hasna.recordings",
    bundle_version: "0.2.12",
    bundle_build_version: "0.2.12",
    git_sha: "a".repeat(40),
    architectures: ["arm64"],
    team_id: "EXAMPLE123",
    minimum_macos: "26.0",
    app_sha256: "b".repeat(64),
    provenance_sha256: "c".repeat(64),
    companion: { version: "0.2.12", sha256: "d".repeat(64), architectures: ["arm64"] },
    signing: {
      authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      team_id: "EXAMPLE123",
      trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      helper_authority: "Developer ID Application: Example Corp (EXAMPLE123)",
      helper_team_id: "EXAMPLE123",
      helper_trusted_timestamp: "Jul 15, 2026 at 12:00:00",
      designated_requirement_sha256: "e".repeat(64),
      helper_designated_requirement_sha256: "f".repeat(64),
      entitlements_sha256: "1".repeat(64),
      helper_entitlements_sha256: "2".repeat(64),
    },
    notarization: {
      submission_id: "11111111-1111-4111-8111-111111111111",
      status: "Accepted",
      log_sha256: "3".repeat(64),
      issue_count: 0,
      submitted_archive_sha256: "4".repeat(64),
      stapled: true,
      distribution_check: true,
    },
    container: { type: "zip", install_locations: ["~/Applications/Recordings.app"] },
    nested_code_policy: {
      allowlist_sha256: "",
      items: [
        { path: ".", team_id: "EXAMPLE123", runtime: true, timestamp_required: true, architectures: ["arm64"], entitlements_sha256: "1".repeat(64) },
        { path: "Contents/Helpers/recordings", team_id: "EXAMPLE123", runtime: true, timestamp_required: true, architectures: ["arm64"], entitlements_sha256: "2".repeat(64) },
      ],
    },
    external_state: {
      paths: ["~/.hasna/recordings"],
      classification: "user-private",
      rollback: "transactional-backup-restore",
    },
    archive: {
      filename: "Recordings-0.2.12-macos.zip",
      sha256: fileDigest(archivePath),
    },
  };
  manifest.nested_code_policy.allowlist_sha256 = Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify(manifest.nested_code_policy.items),
    "hex",
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archivePath, manifestPath, manifest };
}

function localFixture(
  approvedTarget = "station06",
  identityKind?: "hardware_uuid_sha256" | "tailscale_node_id_sha256",
) {
  const result = fixture();
  const { manifest } = result;
  manifest.schema_version = 3;
  manifest.artifact_policy = "local_only";
  manifest.approved_target = approvedTarget;
  manifest.approved_target_identity_kind = identityKind;
  manifest.approved_target_identity_sha256 = targetIdentitySha256;
  manifest.builder_identity_kind = identityKind;
  manifest.builder_identity_sha256 = builderIdentitySha256;
  manifest.non_notarized = true;
  manifest.team_id = "ADHOC";
  manifest.signing = {
    ...manifest.signing,
    mode: "ad_hoc",
    authority: "adhoc",
    team_id: "ADHOC",
    trusted_timestamp: "none",
    helper_authority: "adhoc",
    helper_team_id: "ADHOC",
    helper_trusted_timestamp: "none",
  };
  manifest.notarization = {
    submission_id: "none",
    status: "Not Submitted",
    log_sha256: "none",
    issue_count: 0,
    submitted_archive_sha256: "none",
    stapled: false,
    distribution_check: false,
  };
  manifest.nested_code_policy.items = manifest.nested_code_policy.items.map((item) => ({
    ...item,
    team_id: "ADHOC",
    timestamp_required: false,
  }));
  manifest.nested_code_policy.allowlist_sha256 = Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify(manifest.nested_code_policy.items),
    "hex",
  );
  writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}

function requirementDigestFixture() {
  const root = mkdtempSync(join(tmpdir(), "recordings-requirement-digest-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const app = join(root, "Recordings.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Recordings"), "fixture");
  for (const [name, contents] of [
    [
      "codesign",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == --verify* ]]; then
  [ "\${FAIL_CODESIGN_VERIFY:-0}" = 0 ]
elif [[ "$*" == *"--entitlements :-"* ]]; then
  printf '%s\n' "$ENTITLEMENTS_JSON"
elif [[ "$*" == *"--verbose=4"* ]]; then
  printf '%s\n' "$SIGNING_DETAILS" >&2
elif [[ "$*" == *"-d -r-"* ]]; then
  [ -z "\${DESIGNATED_REQUIREMENT:-}" ] || printf 'designated => %s\n' "$DESIGNATED_REQUIREMENT" >&2
fi
`,
    ],
    ["lipo", "#!/usr/bin/env bash\nprintf 'arm64\\n'\n"],
    ["plutil", "#!/usr/bin/env bash\ncat\n"],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  }
  return { app, bin };
}

function runRequirementDigest(
  policy: "release" | "local_only",
  environment: Record<string, string> = {},
) {
  const { app, bin } = requirementDigestFixture();
  return Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../../scripts/macos_artifact.ts"),
      "requirement-digest",
      "--app",
      app,
      "--artifact-policy",
      policy,
    ],
    {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH ?? ""}`,
        SIGNING_DETAILS: strictAdHocDetails,
        ENTITLEMENTS_JSON: appEntitlements,
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

describe("macOS artifact manifest", () => {
  test.each([
    ["thin", "feedfacf"],
    ["fat", "cafebabe"],
  ])("rejects non-executable %s Mach-O code outside the allowlist", (_label, magic) => {
    const root = mkdtempSync(join(tmpdir(), "recordings-code-layout-"));
    temporaryDirectories.push(root);
    const app = join(root, "Recordings.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "Recordings"), "app");
    writeFileSync(join(app, "Contents", "Helpers", "recordings"), "helper");
    chmodSync(join(app, "Contents", "MacOS", "Recordings"), 0o755);
    chmodSync(join(app, "Contents", "Helpers", "recordings"), 0o755);
    writeFileSync(join(app, "Contents", "Resources.dylib"), Buffer.from(`${magic}00000000`, "hex"));
    chmodSync(join(app, "Contents", "Resources.dylib"), 0o644);
    expect(() => assertExpectedCodeLayout(app)).toThrow("unexpected executable code");
  });

  test("refuses to bind a git SHA to uncommitted source", () => {
    expect(() => assertCleanGitStatus(" M src/cli/index.ts\n")).toThrow("dirty source worktree");
    expect(() => assertCleanGitStatus("?? local-source.ts\n")).toThrow("dirty source worktree");
    expect(() => assertCleanGitStatus("\n")).not.toThrow();
  });

  test("hashes only the designated requirement and ignores extraction-path diagnostics", () => {
    const requirement = 'identifier "com.hasna.recordings" and anchor apple generic';
    expect(
      parseDesignatedRequirement(
        `Executable=/tmp/build/Recordings.app\ndesignated => ${requirement}\n`,
      ),
    ).toBe(requirement);
    expect(
      parseDesignatedRequirement(
        `Executable=/Users/example/Applications/Recordings.app\ndesignated => ${requirement}\n`,
      ),
    ).toBe(requirement);
  });

  test("requires release designated requirements but records their absence for ad-hoc code", () => {
    const missing = "Executable=/tmp/build/Recordings.app\n";
    expect(() => designatedRequirementForPolicy(missing, "release")).toThrow(
      "missing a designated requirement",
    );
    expect(() => designatedRequirementForPolicy(missing, "local_only")).toThrow(
      "requires verified ad-hoc signing",
    );
    const missingLocalRequirement = designatedRequirementForPolicy(missing, "local_only", true);
    expect(missingLocalRequirement).toBe("none-ad-hoc");
    expect(Bun.CryptoHasher.hash("sha256", missingLocalRequirement, "hex")).toBe(
      Bun.CryptoHasher.hash("sha256", "none-ad-hoc", "hex"),
    );
    expect(
      designatedRequirementForPolicy(
        'designated => identifier "com.hasna.recordings"\n',
        "local_only",
        true,
      ),
    ).toBe('identifier "com.hasna.recordings"');
  });

  test("real local requirement-digest verifies strict ad-hoc evidence before hashing no requirement", () => {
    const result = runRequirementDigest("local_only");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(
      Bun.CryptoHasher.hash("sha256", "none-ad-hoc", "hex"),
    );
  });

  test.each([
    ["failed strict verification", { FAIL_CODESIGN_VERIFY: "1" }],
    ["missing ad-hoc signature", { SIGNING_DETAILS: strictAdHocDetails.replace("Signature=adhoc\n", "") }],
    ["wrong signature", { SIGNING_DETAILS: strictAdHocDetails.replace("Signature=adhoc", "Signature=CMS") }],
    ["unexpected authority", { SIGNING_DETAILS: `${strictAdHocDetails}\nAuthority=Developer ID Application: Example` }],
    ["unexpected team", { SIGNING_DETAILS: strictAdHocDetails.replace("TeamIdentifier=not set", "TeamIdentifier=EXAMPLE123") }],
    ["unexpected timestamp", { SIGNING_DETAILS: strictAdHocDetails.replace("Timestamp=none", "Timestamp=Jul 16, 2026") }],
    ["missing runtime", { SIGNING_DETAILS: strictAdHocDetails.replace("(runtime)", "(none)") }],
    ["wrong entitlements", { ENTITLEMENTS_JSON: JSON.stringify({ "com.apple.security.app-sandbox": true }) }],
  ])("real local requirement-digest rejects %s", (_label, environment) => {
    const result = runRequirementDigest("local_only", environment);
    expect(result.exitCode).not.toBe(0);
  });

  test("real release requirement-digest rejects a missing designated requirement", () => {
    const result = runRequirementDigest("release");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing a designated requirement");
  });

  test("accepts an intact archive bound to the required Team ID", () => {
    const { archivePath, manifestPath } = fixture();
    const manifest = verifyArchiveManifest(
      archivePath,
      manifestPath,
      "EXAMPLE123",
      fileDigest(manifestPath),
      "a".repeat(40),
      "0.2.12",
    );
    expect(manifest.bundle_id).toBe("com.hasna.recordings");
    expect(manifest.schema_version).toBe(2);
    expect(manifest.artifact_policy).toBeUndefined();
    expect(manifest.approved_target).toBeUndefined();
    expect(manifest.approved_target_identity_kind).toBeUndefined();
    expect(manifest.approved_target_identity_sha256).toBeUndefined();
    expect(manifest.builder_identity_kind).toBeUndefined();
    expect(manifest.builder_identity_sha256).toBeUndefined();
    expect(manifest.non_notarized).toBeUndefined();
    expect(manifest.signing.mode).toBeUndefined();
  });

  test("release schema v2 rejects every local target identity field", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    manifest.approved_target_identity_kind = "tailscale_node_id_sha256";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "EXAMPLE123",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
      ),
    ).toThrow("release schema v2");
  });

  test("manifest-get reports no target identity kind for release schema v2", () => {
    const { manifestPath } = fixture();
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "manifest-get",
      "--manifest",
      manifestPath,
      "--field",
      "approved_target_identity_kind",
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("none");
  });

  test("direct release verification CLI remains compatible without identity-kind flags", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "verify-archive",
      "--archive",
      archivePath,
      "--manifest",
      manifestPath,
      "--team-id",
      manifest.team_id,
      "--manifest-sha256",
      fileDigest(manifestPath),
      "--source-sha",
      manifest.git_sha,
      "--version",
      manifest.bundle_version,
      "--artifact-policy",
      "release",
      "--approved-target",
      "fleet",
      "--approved-target-identity-sha256",
      "none",
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("direct release provenance CLI defaults both omitted identity kinds to none", () => {
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "provenance",
      "--app",
      join(tmpdir(), "missing-release-app"),
      "--team-id",
      "EXAMPLE123",
      "--package-root",
      join(import.meta.dir, "..", ".."),
      "--artifact-policy",
      "release",
      "--approved-target",
      "fleet",
      "--approved-target-identity-sha256",
      "none",
      "--builder-identity-sha256",
      "none",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).not.toContain("identity-kind");
    expect(result.stderr.toString()).not.toContain("builder identity kind");
  });

  test("accepts local-only artifacts only with an explicit policy and exact target", () => {
    const { archivePath, manifestPath } = localFixture();
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        "a".repeat(40),
        "0.2.12",
      ),
    ).toThrow("explicit operator selection");
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        "a".repeat(40),
        "0.2.12",
        "local_only",
        "station05",
        targetIdentitySha256,
      ),
    ).toThrow("exact operator-approved target");
    const manifest = verifyArchiveManifest(
      archivePath,
      manifestPath,
      "ADHOC",
      fileDigest(manifestPath),
      "a".repeat(40),
      "0.2.12",
      "local_only",
      "station06",
      targetIdentitySha256,
    );
    expect(manifest.non_notarized).toBeTrue();
    expect(manifest.signing.mode).toBe("ad_hoc");
  });

  test("keeps old schema-v3 manifests compatible as hardware UUID hashes", () => {
    const { archivePath, manifestPath } = localFixture();
    const manifest = verifyArchiveManifest(
      archivePath,
      manifestPath,
      "ADHOC",
      fileDigest(manifestPath),
      "a".repeat(40),
      "0.2.12",
      "local_only",
      "station06",
      targetIdentitySha256,
      "hardware_uuid_sha256",
    );
    expect(manifest.approved_target_identity_kind).toBeUndefined();
  });

  test("requires an exact explicit identity kind for Tailscale-bound artifacts", () => {
    const { archivePath, manifestPath } = localFixture("station06", "tailscale_node_id_sha256");
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        "a".repeat(40),
        "0.2.12",
        "local_only",
        "station06",
        targetIdentitySha256,
      ),
    ).toThrow("identity kind");
    expect(
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        "a".repeat(40),
        "0.2.12",
        "local_only",
        "station06",
        targetIdentitySha256,
        "tailscale_node_id_sha256",
      ).approved_target_identity_kind,
    ).toBe("tailscale_node_id_sha256");
  });

  test("rejects explicit hardware identity kinds on newly written schema-v3 manifests", () => {
    const { archivePath, manifestPath, manifest } = localFixture(
      "station06",
      "hardware_uuid_sha256",
    );
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
        "local_only",
        "station06",
        targetIdentitySha256,
        "hardware_uuid_sha256",
      ),
    ).toThrow("exact station06 name and machine identity");
  });

  test("requires target and builder identities to use the same node-ID namespace", () => {
    const { archivePath, manifestPath, manifest } = localFixture(
      "station06",
      "tailscale_node_id_sha256",
    );
    manifest.builder_identity_kind = "hardware_uuid_sha256";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
        "local_only",
        "station06",
        targetIdentitySha256,
        "tailscale_node_id_sha256",
      ),
    ).toThrow("exact station06 name and machine identity");
  });

  test("hashes the live-schema online Tailscale Self.ID exactly for the approved hostname", () => {
    const nodeId = "n1234567890CNTRL";
    expect(
      tailscaleNodeIdSha256(
        JSON.stringify({
          Version: "1.98.4-tabcdef",
          TUN: true,
          BackendState: "Running",
          Self: {
            ID: nodeId,
            PublicKey: "nodekey:fixture-public-key",
            HostName: "station06",
            Online: true,
          },
        }),
        "station06",
      ),
    ).toBe(Bun.CryptoHasher.hash("sha256", nodeId, "hex"));
  });

  test.each([
    ["malformed JSON", "{"],
    ["missing Self", JSON.stringify({})],
    ["malformed Self", JSON.stringify({ Self: [] })],
    ["stale offline Self", JSON.stringify({ Self: { Online: false, HostName: "station06", ID: "nodeid:stable" } })],
    ["wrong Self hostname", JSON.stringify({ Self: { Online: true, HostName: "station05", ID: "nodeid:stable" } })],
    ["StableID-only Self", JSON.stringify({ Self: { Online: true, HostName: "station06", StableID: "nodeid:stable" } })],
    ["missing ID", JSON.stringify({ Self: { Online: true, HostName: "station06" } })],
    ["empty ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "" } })],
    ["leading whitespace ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: " nodeid:stable" } })],
    ["trailing whitespace ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:stable " } })],
    ["internal space ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:sta ble" } })],
    ["internal tab ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:\tstable" } })],
    ["CR in ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:\rstable" } })],
    ["LF in ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:\nstable" } })],
    ["NUL in ID", JSON.stringify({ Self: { Online: true, HostName: "station06", ID: "nodeid:\0stable" } })],
  ])("rejects %s", (_label, statusJson) => {
    expect(() => tailscaleNodeIdSha256(statusJson, "station06")).toThrow();
  });

  test("rejects local-only manifests that imply release trust", () => {
    const { archivePath, manifestPath, manifest } = localFixture(
      "station06",
      "tailscale_node_id_sha256",
    );
    manifest.notarization.status = "Accepted";
    manifest.notarization.stapled = true;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
        "local_only",
        "station06",
        targetIdentitySha256,
      ),
    ).toThrow("must state that it is non-notarized");
  });

  test("rejects raw or matching local machine identities", () => {
    const { archivePath, manifestPath, manifest } = localFixture(
      "station06",
      "tailscale_node_id_sha256",
    );
    manifest.approved_target_identity_sha256 = "11111111-1111-4111-8111-111111111111";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
        "local_only",
        "station06",
        targetIdentitySha256,
      ),
    ).toThrow("exact station06 name and machine identity");

    manifest.approved_target_identity_sha256 = targetIdentitySha256;
    manifest.builder_identity_sha256 = targetIdentitySha256;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "ADHOC",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
        "local_only",
        "station06",
        targetIdentitySha256,
      ),
    ).toThrow("exact station06 name and machine identity");
  });

  test("rejects malformed numeric platform and bundle versions", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    for (const field of ["minimum_macos", "bundle_version", "bundle_build_version"] as const) {
      const malformed = { ...manifest, [field]: "26.beta" };
      writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`);
      expect(() =>
        verifyArchiveManifest(
          archivePath,
          manifestPath,
          "EXAMPLE123",
          fileDigest(manifestPath),
          "a".repeat(40),
          "0.2.12",
        ),
      ).toThrow("not a numeric version");
    }
  });

  test("rejects malformed notary submission identifiers", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    manifest.notarization.submission_id = "------------------------------------";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() =>
      verifyArchiveManifest(
        archivePath,
        manifestPath,
        "EXAMPLE123",
        fileDigest(manifestPath),
        manifest.git_sha,
        manifest.bundle_version,
      ),
    ).toThrow("submission ID is invalid");
  });

  test("rejects archive tampering and checksum mismatch", () => {
    const { archivePath, manifestPath } = fixture();
    writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}tampered`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "archive checksum",
    );
  });

  test("rejects manifest signer tampering", () => {
    const { archivePath, manifestPath, manifest } = fixture();
    manifest.team_id = "OTHERTEAM";
    for (const item of manifest.nested_code_policy.items) item.team_id = "OTHERTEAM";
    manifest.nested_code_policy.allowlist_sha256 = Bun.CryptoHasher.hash(
      "sha256",
      JSON.stringify(manifest.nested_code_policy.items),
      "hex",
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "manifest Team ID",
    );
  });

  test("rejects a renamed archive not bound by the manifest", () => {
    const { archivePath, manifestPath } = fixture();
    const renamed = join(tmpdir(), `renamed-recordings-${Date.now()}.zip`);
    temporaryDirectories.push(renamed);
    writeFileSync(renamed, readFileSync(archivePath));
    expect(() => verifyArchiveManifest(renamed, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.12")).toThrow(
      "archive filename",
    );
  });

  test("rejects coordinated manifest replacement and wrong source/version", () => {
    const { archivePath, manifestPath } = fixture();
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", "0".repeat(64), "a".repeat(40), "0.2.12")).toThrow("authenticated operator value");
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "b".repeat(40), "0.2.12")).toThrow("operator-approved source");
    expect(() => verifyArchiveManifest(archivePath, manifestPath, "EXAMPLE123", fileDigest(manifestPath), "a".repeat(40), "0.2.11")).toThrow("operator-approved version");
  });

  test("compares numeric release versions without lexical downgrade mistakes", () => {
    expect(compareVersions("0.2.12", "0.2.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.9", "0.2.12")).toBe(-1);
  });

  test("rejects downgrades and unproven same-version replacements", () => {
    const { manifest } = fixture();
    expect(() => assertVersionTransition("0.2.13", manifest.git_sha, manifest)).toThrow("downgrade");
    expect(() => assertVersionTransition("0.2.12", null, manifest)).toThrow("without verifiable");
    expect(() => assertVersionTransition("0.2.12", "b".repeat(40), manifest)).toThrow(
      "different source commit",
    );
    expect(() => assertVersionTransition("0.2.12", manifest.git_sha, manifest)).not.toThrow();
    expect(() => assertVersionTransition("0.2.11", null, manifest)).not.toThrow();
  });
});

describe("macOS install journal compatibility", () => {
  test.each([
    [4, undefined, "invalid original state mode"],
    [4, "750", "invalid original state mode"],
    [4, "777", "invalid original state mode"],
    [3, "755", "unsupported state-mode fields"],
  ])("rejects untrusted schema-%i original state mode %s", (schemaVersion, originalStateMode, message) => {
    const root = mkdtempSync(join(tmpdir(), "recordings-state-mode-journal-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const appParent = join(home, "Applications");
    const transaction = join(appParent, ".Recordings-transaction.state-mode");
    const journalPath = join(appParent, ".Recordings-install-transaction.json");
    mkdirSync(appParent, { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema_version: schemaVersion,
        phase: "committed",
        transaction_dir: transaction,
        app_parent: appParent,
        app_destination: join(appParent, "Recordings.app"),
        data_dir: join(home, ".hasna", "recordings"),
        state_backup: join(transaction, "state.initial"),
        state_backup_sha256: "1".repeat(64),
        originals: [],
        was_running: false,
        expected_manifest_sha256: "2".repeat(64),
        expected_source_sha: "3".repeat(40),
        expected_version: "0.2.13",
        artifact_policy: "release",
        approved_target: "fleet",
        approved_target_identity_kind: "none",
        approved_target_identity_sha256: "none",
        builder_identity_kind: "none",
        candidate_identity_sha256: "4".repeat(64),
        previous_identity_sha256: "none",
        ...(originalStateMode === undefined ? {} : { original_state_mode: originalStateMode }),
      })}\n`,
      { mode: 0o600 },
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "journal-get",
      "--journal",
      journalPath,
      "--field",
      "phase",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(message);
  });

  test("reads a pre-policy schema-v2 release journal as release/fleet", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-legacy-journal-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const appParent = join(home, "Applications");
    const transaction = join(appParent, ".Recordings-transaction.legacy");
    const journalPath = join(appParent, ".Recordings-install-transaction.json");
    mkdirSync(appParent, { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema_version: 2,
        phase: "committed",
        transaction_dir: transaction,
        app_parent: appParent,
        app_destination: join(appParent, "Recordings.app"),
        data_dir: join(home, ".hasna", "recordings"),
        state_backup: join(transaction, "state.initial"),
        state_backup_sha256: "1".repeat(64),
        originals: [],
        was_running: false,
        expected_manifest_sha256: "2".repeat(64),
        expected_source_sha: "3".repeat(40),
        expected_version: "0.2.13",
        candidate_identity_sha256: "4".repeat(64),
        previous_identity_sha256: "none",
      })}\n`,
      { mode: 0o600 },
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "journal-get",
      "--journal",
      journalPath,
      "--field",
      "phase",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("committed");
    expect(result.stderr.toString()).toBe("");
  });

  test("reads an old schema-v3 local journal without an identity kind as hardware UUID", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-legacy-local-journal-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const appParent = join(home, "Applications");
    const transaction = join(appParent, ".Recordings-transaction.legacy-local");
    const journalPath = join(appParent, ".Recordings-install-transaction.json");
    mkdirSync(appParent, { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema_version: 3,
        phase: "committed",
        transaction_dir: transaction,
        app_parent: appParent,
        app_destination: join(appParent, "Recordings.app"),
        data_dir: join(home, ".hasna", "recordings"),
        state_backup: join(transaction, "state.initial"),
        state_backup_sha256: "1".repeat(64),
        originals: [],
        was_running: false,
        expected_manifest_sha256: "2".repeat(64),
        expected_source_sha: "3".repeat(40),
        expected_version: "0.2.13",
        artifact_policy: "local_only",
        approved_target: "station06",
        approved_target_identity_sha256: targetIdentitySha256,
        candidate_identity_sha256: "4".repeat(64),
        previous_identity_sha256: "none",
      })}\n`,
      { mode: 0o600 },
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "journal-get",
      "--journal",
      journalPath,
      "--field",
      "json",
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()).approved_target_identity_kind).toBe(
      "hardware_uuid_sha256",
    );
    expect(JSON.parse(result.stdout.toString()).builder_identity_kind).toBe(
      "hardware_uuid_sha256",
    );
  });
});
