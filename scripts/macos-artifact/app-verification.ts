import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type BigIntStats,
  closeSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import {
  nativeFsGuard,
  type NativeFsGuard,
  type NativeHandle,
  type NativeMetadata,
} from "../native_fs_guard";

import { APP_ENTITLEMENTS, AppVerificationEvidence, ArtifactPolicy, BUNDLE_ID, BuildProvenance, HELPER_ENTITLEMENTS, JSON_INPUT_LIMIT_BYTES, LEGACY_LOCAL_TARGET_IDENTITY_KIND, LOCAL_ARTIFACT_SCHEMA_VERSION, MacOSArtifactManifest, OperatorTargetIdentityKind, RELEASE_APPROVED_TARGET, RELEASE_ARTIFACT_SCHEMA_VERSION, SPCTL_EXECUTABLE, SYSPOLICY_CHECK_EXECUTABLE, XCRUN_EXECUTABLE, isLocalOnlyApprovedTarget, localOnlyApprovedTargetsMessage, readRegularFileBounded, sha256, sha256File, sortUnsignedUtf8 } from "./common";
import { architectures, assertCurrentSourceRevision, canonicalJson, companionVersion, plistValue, provenancePath, readAuthenticatedManifest, readJson, run, sha256ArchiveFile, signingEvidence, writeJson, writeManifestAtomically } from "./artifacts";
import { assertExpectedCodeLayout, isHex, manifestPolicy, manifestTargetIdentityKind, nestedItems, nestedPolicyDigest } from "./layout";
import { withPrivatelyExtractedArchiveApp } from "./archive";
import { assertManifestShape, assertProvenanceMatchesManifest, sameStrings } from "./manifest";
import { assertAcceptedNotaryLog } from "./release";
import { treeDigest } from "./publication";

export function verifyAppAgainstManifest(
  appPath: string,
  manifest: MacOSArtifactManifest,
  expectedTeamId: string,
  expectedPolicy: ArtifactPolicy = "release",
  expectedApprovedTarget: string = RELEASE_APPROVED_TARGET,
  expectedApprovedTargetIdentitySha256: string = "none",
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind = LEGACY_LOCAL_TARGET_IDENTITY_KIND,
): AppVerificationEvidence {
  assertManifestShape(manifest);
  if (manifestPolicy(manifest) !== expectedPolicy) throw new Error("manifest artifact policy mismatch");
  if ((manifest.approved_target ?? RELEASE_APPROVED_TARGET) !== expectedApprovedTarget) {
    throw new Error("manifest approved target mismatch");
  }
  if (
    expectedPolicy === "local_only" &&
    manifestTargetIdentityKind(manifest) !== expectedApprovedTargetIdentityKind
  ) {
    throw new Error("manifest approved target identity kind mismatch");
  }
  if (
    expectedPolicy === "local_only" &&
    manifest.approved_target_identity_sha256 !== expectedApprovedTargetIdentitySha256
  ) {
    throw new Error("manifest approved target machine identity mismatch");
  }
  if (manifest.team_id !== expectedTeamId) throw new Error("manifest Team ID mismatch");

  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  assertExpectedCodeLayout(appPath);
  const outerSigning = signingEvidence(
    appPath,
    expectedTeamId,
    APP_ENTITLEMENTS,
    executablePath,
    expectedPolicy,
  );
  const helperSigning = signingEvidence(
    helperPath,
    expectedTeamId,
    HELPER_ENTITLEMENTS,
    helperPath,
    expectedPolicy,
  );

  if (plistValue(appPath, "CFBundleIdentifier") !== manifest.bundle_id) {
    throw new Error("installed bundle identifier does not match the manifest");
  }
  if (plistValue(appPath, "CFBundleShortVersionString") !== manifest.bundle_version) {
    throw new Error("installed bundle version does not match the manifest");
  }
  if (plistValue(appPath, "CFBundleVersion") !== manifest.bundle_build_version) {
    throw new Error("installed bundle build version does not match the manifest");
  }
  if (plistValue(appPath, "LSMinimumSystemVersion") !== manifest.minimum_macos) {
    throw new Error("installed minimum macOS does not match the manifest");
  }
  if (!sameStrings(architectures(executablePath), sortUnsignedUtf8([...manifest.architectures]))) {
    throw new Error("installed app architectures do not match the manifest");
  }
  if (sha256File(executablePath) !== manifest.app_sha256) throw new Error("app hash mismatch");
  if (treeDigest(appPath) !== manifest.binding.bundle_tree_sha256) {
    throw new Error("app bundle tree hash mismatch");
  }
  if (sha256File(helperPath) !== manifest.companion.sha256) throw new Error("companion hash mismatch");
  if (!sameStrings(
    architectures(helperPath),
    sortUnsignedUtf8([...manifest.companion.architectures]),
  )) {
    throw new Error("companion architectures do not match the manifest");
  }
  if (sha256File(embeddedPath) !== manifest.provenance_sha256) {
    throw new Error("signed provenance checksum mismatch");
  }
  assertProvenanceMatchesManifest(provenance, manifest);

  const requirementHash = sha256(outerSigning.designatedRequirement);
  if (requirementHash !== manifest.signing.designated_requirement_sha256) {
    throw new Error("designated requirement mismatch");
  }
  if (sha256(helperSigning.designatedRequirement) !== manifest.signing.helper_designated_requirement_sha256) {
    throw new Error("helper designated requirement mismatch");
  }
  if (
    outerSigning.entitlementsSha256 !== manifest.signing.entitlements_sha256 ||
    helperSigning.entitlementsSha256 !== manifest.signing.helper_entitlements_sha256
  ) {
    throw new Error("signed entitlements provenance mismatch");
  }
  if (
    outerSigning.authority !== manifest.signing.authority ||
    outerSigning.teamId !== manifest.signing.team_id ||
    outerSigning.timestamp !== manifest.signing.trusted_timestamp
  ) {
    throw new Error("outer signing provenance mismatch");
  }
  if (
    helperSigning.authority !== manifest.signing.helper_authority ||
    helperSigning.teamId !== manifest.signing.helper_team_id ||
    helperSigning.timestamp !== manifest.signing.helper_trusted_timestamp
  ) {
    throw new Error("helper signing provenance mismatch");
  }
  if (
    outerSigning.mode !== (expectedPolicy === "release" ? "developer_id" : manifest.signing.mode) ||
    helperSigning.mode !== (expectedPolicy === "release" ? "developer_id" : manifest.signing.mode)
  ) {
    throw new Error("signing mode provenance mismatch");
  }
  const actualNestedItems = nestedItems(
    appPath,
    expectedTeamId,
    expectedPolicy,
    outerSigning,
    helperSigning,
  );
  if (JSON.stringify(actualNestedItems) !== JSON.stringify(manifest.nested_code_policy.items)) {
    throw new Error("nested-code policy does not match the extracted app");
  }
  return {
    bundleTreeSha256: treeDigest(appPath),
    executableSha256: sha256File(executablePath),
    provenanceSha256: sha256File(embeddedPath),
    companionSha256: sha256File(helperPath),
    outerSigning,
    helperSigning,
  };
}

export function verifyExtractedApp(
  appPath: string,
  manifestPath: string,
  expectedManifestSha256: string,
  expectedTeamId: string,
  expectedPolicy: ArtifactPolicy = "release",
  expectedApprovedTarget: string = RELEASE_APPROVED_TARGET,
  expectedApprovedTargetIdentitySha256: string = "none",
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind = LEGACY_LOCAL_TARGET_IDENTITY_KIND,
): MacOSArtifactManifest {
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    manifestPath,
    expectedManifestSha256,
  );
  verifyAppAgainstManifest(
    appPath,
    manifest,
    expectedTeamId,
    expectedPolicy,
    expectedApprovedTarget,
    expectedApprovedTargetIdentitySha256,
    expectedApprovedTargetIdentityKind,
  );
  return manifest;
}

export function assertMatchingAppEvidence(
  supplied: AppVerificationEvidence,
  extracted: AppVerificationEvidence,
): void {
  if (canonicalJson(supplied) !== canonicalJson(extracted)) {
    throw new Error(
      "archive-extracted app digest, provenance, or signing evidence differs from the supplied app",
    );
  }
}

export function verifyReleaseDistributionPolicy(appPath: string): void {
  run(XCRUN_EXECUTABLE, ["stapler", "validate", appPath]);
  run(SPCTL_EXECUTABLE, ["--assess", "--type", "execute", "--verbose=2", appPath]);
  run(SYSPOLICY_CHECK_EXECUTABLE, ["distribution", appPath]);
}

export function verifySuppliedAndArchivedApps(
  suppliedAppPath: string,
  archivePath: string,
  manifest: MacOSArtifactManifest,
  expectedTeamId: string,
  expectedPolicy: ArtifactPolicy,
  expectedApprovedTarget: string,
  expectedApprovedTargetIdentitySha256: string = "none",
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind = LEGACY_LOCAL_TARGET_IDENTITY_KIND,
): void {
  if (sha256ArchiveFile(archivePath) !== manifest.archive.sha256) {
    throw new Error("release archive changed before exact-byte verification");
  }
  const suppliedEvidence = verifyAppAgainstManifest(
    suppliedAppPath,
    manifest,
    expectedTeamId,
    expectedPolicy,
    expectedApprovedTarget,
    expectedApprovedTargetIdentitySha256,
    expectedApprovedTargetIdentityKind,
  );
  if (expectedPolicy === "release") verifyReleaseDistributionPolicy(suppliedAppPath);
  withPrivatelyExtractedArchiveApp(
    archivePath,
    (extractedAppPath) => {
      const extractedEvidence = verifyAppAgainstManifest(
        extractedAppPath,
        manifest,
        expectedTeamId,
        expectedPolicy,
        expectedApprovedTarget,
        expectedApprovedTargetIdentitySha256,
        expectedApprovedTargetIdentityKind,
      );
      if (expectedPolicy === "release") verifyReleaseDistributionPolicy(extractedAppPath);
      assertMatchingAppEvidence(suppliedEvidence, extractedEvidence);
    },
    "/usr/bin/ditto",
    manifest.archive.sha256,
  );
  if (sha256ArchiveFile(archivePath) !== manifest.archive.sha256) {
    throw new Error("release archive changed during exact-byte verification");
  }
}

export function writeProvenance(
  appPath: string,
  expectedTeamId: string,
  packageRoot: string,
  expectedSourceSha: string,
  artifactPolicy: ArtifactPolicy,
  approvedTarget: string,
  approvedTargetIdentityKind: OperatorTargetIdentityKind,
  approvedTargetIdentitySha256: string,
  builderIdentityKind: OperatorTargetIdentityKind,
  builderIdentitySha256: string,
): void {
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  const provenance: BuildProvenance = {
    schema_version:
      artifactPolicy === "release"
        ? RELEASE_ARTIFACT_SCHEMA_VERSION
        : LOCAL_ARTIFACT_SCHEMA_VERSION,
    bundle_id: plistValue(appPath, "CFBundleIdentifier"),
    bundle_version: plistValue(appPath, "CFBundleShortVersionString"),
    bundle_build_version: plistValue(appPath, "CFBundleVersion"),
    git_sha: expectedSourceSha,
    architectures: architectures(executablePath),
    team_id: expectedTeamId,
    minimum_macos: plistValue(appPath, "LSMinimumSystemVersion"),
    companion: {
      version: companionVersion(helperPath),
      sha256: sha256File(helperPath),
      architectures: architectures(helperPath),
    },
  };
  if (provenance.bundle_id !== BUNDLE_ID) throw new Error("unexpected bundle identifier");
  if (artifactPolicy === "release") {
    if (
      approvedTarget !== RELEASE_APPROVED_TARGET ||
      approvedTargetIdentityKind !== "none" ||
      approvedTargetIdentitySha256 !== "none" ||
      builderIdentityKind !== "none" ||
      builderIdentitySha256 !== "none" ||
      expectedTeamId === "ADHOC"
    ) {
      throw new Error("release provenance has an invalid target or Team ID");
    }
  } else if (
    expectedTeamId !== "ADHOC" ||
    !isLocalOnlyApprovedTarget(approvedTarget) ||
    approvedTargetIdentityKind !== "tailscale_node_id_sha256" ||
    builderIdentityKind !== "tailscale_node_id_sha256" ||
    !isHex(approvedTargetIdentitySha256, 64) ||
    !isHex(builderIdentitySha256, 64) ||
    approvedTargetIdentitySha256 === builderIdentitySha256
  ) {
    throw new Error(
      "new local-only provenance requires ADHOC and a Tailscale node-bound approved-target identity " +
        `(${localOnlyApprovedTargetsMessage()})`,
    );
  } else {
    provenance.artifact_policy = "local_only";
    provenance.approved_target = approvedTarget;
    provenance.approved_target_identity_kind = approvedTargetIdentityKind;
    provenance.approved_target_identity_sha256 = approvedTargetIdentitySha256;
    provenance.builder_identity_kind = builderIdentityKind;
    provenance.builder_identity_sha256 = builderIdentitySha256;
    provenance.non_notarized = true;
  }
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  writeJson(provenancePath(appPath), provenance);
}

export function finalizeArtifact(
  appPath: string,
  archivePath: string,
  manifestPath: string,
  packageRoot: string,
  expectedSourceSha: string,
  expectedTeamId: string,
  notaryLogPath: string,
  notarySubmissionId: string,
  submittedArchiveSha256: string,
): void {
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  if (provenance.git_sha !== expectedSourceSha) {
    throw new Error("embedded provenance does not match the pinned source SHA");
  }
  assertExpectedCodeLayout(appPath);
  const outerSigning = signingEvidence(appPath, expectedTeamId, APP_ENTITLEMENTS, executablePath);
  const helperSigning = signingEvidence(helperPath, expectedTeamId, HELPER_ENTITLEMENTS);
  const notaryLogSnapshot = readRegularFileBounded(
    notaryLogPath,
    JSON_INPUT_LIMIT_BYTES,
    "notary log",
    "notary log exceeds the supported size limit",
  );
  const notaryLog = JSON.parse(notaryLogSnapshot.toString("utf8")) as unknown;
  assertAcceptedNotaryLog(notaryLog, notarySubmissionId, submittedArchiveSha256);
  const items = nestedItems(appPath, expectedTeamId, "release", outerSigning, helperSigning);
  const manifest: MacOSArtifactManifest = {
    ...provenance,
    artifact_type: "recordings-macos-app",
    app_sha256: sha256File(executablePath),
    binding: { bundle_tree_sha256: treeDigest(appPath) },
    provenance_sha256: sha256File(embeddedPath),
    signing: {
      authority: outerSigning.authority,
      team_id: outerSigning.teamId,
      trusted_timestamp: outerSigning.timestamp,
      helper_authority: helperSigning.authority,
      helper_team_id: helperSigning.teamId,
      helper_trusted_timestamp: helperSigning.timestamp,
      entitlements_sha256: outerSigning.entitlementsSha256,
      helper_entitlements_sha256: helperSigning.entitlementsSha256,
      designated_requirement_sha256: sha256(outerSigning.designatedRequirement),
      helper_designated_requirement_sha256: sha256(helperSigning.designatedRequirement),
    },
    notarization: {
      submission_id: notarySubmissionId,
      status: "Accepted",
      log_sha256: sha256(notaryLogSnapshot),
      issue_count: 0,
      submitted_archive_sha256: submittedArchiveSha256,
      stapled: true,
      distribution_check: true,
    },
    container: {
      type: "zip",
      install_locations: ["/Applications/Recordings.app"],
    },
    nested_code_policy: {
      allowlist_sha256: nestedPolicyDigest(items),
      items,
    },
    external_state: {
      paths: ["~/.hasna/recordings"],
      classification: "user-private",
      rollback: "database-preserving-transactional-restore",
    },
    archive: {
      filename: basename(archivePath),
      sha256: sha256ArchiveFile(archivePath),
    },
  };
  assertManifestShape(manifest);
  verifySuppliedAndArchivedApps(
    appPath,
    archivePath,
    manifest,
    expectedTeamId,
    "release",
    RELEASE_APPROVED_TARGET,
  );
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  if (sha256ArchiveFile(archivePath) !== manifest.archive.sha256) {
    throw new Error("release archive changed before manifest publication");
  }
  writeManifestAtomically(manifestPath, manifest);
}


