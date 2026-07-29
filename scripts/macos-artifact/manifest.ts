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

import { ArtifactPolicy, BUNDLE_ID, BuildProvenance, LEGACY_LOCAL_TARGET_IDENTITY_KIND, LOCAL_ARTIFACT_SCHEMA_VERSION, MacOSArtifactManifest, OperatorTargetIdentityKind, RELEASE_APPROVED_TARGET, RELEASE_ARTIFACT_SCHEMA_VERSION, isLocalOnlyApprovedTarget, localOnlyApprovedTargetsMessage, sha256, sortUnsignedUtf8 } from "./common";
import { architectures, readAuthenticatedManifest, sha256ArchiveFile } from "./artifacts";
import { isHex, manifestPolicy, manifestTargetIdentityKind, nestedPolicyDigest } from "./layout";

export function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertArchitectures(values: string[], label: string): void {
  const allowed = new Set(["arm64", "x86_64"]);
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((value) => !allowed.has(value))
  ) {
    throw new Error(`${label} contains unsupported or duplicate architectures`);
  }
}

export function assertManifestShape(manifest: MacOSArtifactManifest): void {
  if (
    manifest.schema_version !== RELEASE_ARTIFACT_SCHEMA_VERSION &&
    manifest.schema_version !== LOCAL_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new Error("unsupported manifest schema");
  }
  if (manifest.artifact_type !== "recordings-macos-app") throw new Error("unexpected artifact type");
  if (manifest.bundle_id !== BUNDLE_ID) throw new Error("unexpected bundle identifier");
  const artifactPolicy = manifestPolicy(manifest);
  for (const [label, value] of [
    ["bundle version", manifest.bundle_version],
    ["bundle build version", manifest.bundle_build_version],
    ["git SHA", manifest.git_sha],
    ["Team ID", manifest.team_id],
    ["app hash", manifest.app_sha256],
    ["bundle tree hash", manifest.binding?.bundle_tree_sha256],
    ["provenance hash", manifest.provenance_sha256],
    ["signing Team ID", manifest.signing?.team_id],
    ["helper signing Team ID", manifest.signing?.helper_team_id],
    ["archive filename", manifest.archive?.filename],
    ["archive hash", manifest.archive?.sha256],
    ["designated requirement hash", manifest.signing?.designated_requirement_sha256],
    ["trusted timestamp", manifest.signing?.trusted_timestamp],
    ["helper trusted timestamp", manifest.signing?.helper_trusted_timestamp],
    ["entitlements hash", manifest.signing?.entitlements_sha256],
    ["helper entitlements hash", manifest.signing?.helper_entitlements_sha256],
    ["helper designated requirement hash", manifest.signing?.helper_designated_requirement_sha256],
    ["companion version", manifest.companion?.version],
    ["companion hash", manifest.companion?.sha256],
    ["minimum macOS", manifest.minimum_macos],
    ["nested-code allowlist hash", manifest.nested_code_policy?.allowlist_sha256],
  ] as const) {
    if (!value || typeof value !== "string") throw new Error(`manifest is missing ${label}`);
  }
  for (const [label, value] of [
    ["bundle version", manifest.bundle_version],
    ["bundle build version", manifest.bundle_build_version],
    ["minimum macOS", manifest.minimum_macos],
  ] as const) {
    if (!/^\d+(?:\.\d+)*$/.test(value)) throw new Error(`manifest ${label} is not a numeric version`);
  }
  if (!Array.isArray(manifest.architectures) || manifest.architectures.length === 0) {
    throw new Error("manifest is missing architectures");
  }
  assertArchitectures(manifest.architectures, "manifest app architecture list");
  assertArchitectures(manifest.companion.architectures, "manifest helper architecture list");
  if (!sameStrings(
    sortUnsignedUtf8([...manifest.architectures]),
    sortUnsignedUtf8([...manifest.companion.architectures]),
  )) {
    throw new Error("manifest app and helper architectures differ");
  }
  if (!isHex(manifest.git_sha, 40)) throw new Error("manifest git SHA must be a full commit SHA");
  for (const [label, value] of [
    ["app hash", manifest.app_sha256],
    ["bundle tree hash", manifest.binding.bundle_tree_sha256],
    ["provenance hash", manifest.provenance_sha256],
    ["archive hash", manifest.archive.sha256],
    ["nested allowlist hash", manifest.nested_code_policy.allowlist_sha256],
    ["entitlements hash", manifest.signing.entitlements_sha256],
    ["helper entitlements hash", manifest.signing.helper_entitlements_sha256],
    ["helper designated requirement hash", manifest.signing.helper_designated_requirement_sha256],
    ["companion hash", manifest.companion.sha256],
    ["designated requirement hash", manifest.signing.designated_requirement_sha256],
  ] as const) {
    if (!isHex(value, 64)) throw new Error(`manifest ${label} must be SHA-256`);
  }
  if (artifactPolicy === "release") {
    if (
      manifest.artifact_policy !== undefined ||
      manifest.approved_target !== undefined ||
      manifest.approved_target_identity_kind !== undefined ||
      manifest.approved_target_identity_sha256 !== undefined ||
      manifest.builder_identity_kind !== undefined ||
      manifest.builder_identity_sha256 !== undefined ||
      manifest.non_notarized !== undefined ||
      manifest.signing.mode !== undefined
    ) {
      throw new Error("release schema v4 must not contain local-only policy fields");
    }
    if (
      !manifest.signing.authority.startsWith("Developer ID Application:") ||
      !manifest.signing.helper_authority.startsWith("Developer ID Application:")
    ) {
      throw new Error("release manifest requires Developer ID Application signing authorities");
    }
    for (const [label, value] of [
      ["notary log hash", manifest.notarization.log_sha256],
      ["submitted archive hash", manifest.notarization.submitted_archive_sha256],
    ] as const) {
      if (!isHex(value, 64)) throw new Error(`manifest ${label} must be SHA-256`);
    }
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(manifest.notarization.submission_id)) {
      throw new Error("manifest notary submission ID is invalid");
    }
    if (
      manifest.notarization.status !== "Accepted" ||
      manifest.notarization.stapled !== true ||
      manifest.notarization.distribution_check !== true ||
      manifest.notarization.issue_count !== 0
    ) {
      throw new Error("release manifest requires accepted and stapled notarization evidence");
    }
  } else {
    if (
      manifest.artifact_policy !== "local_only" ||
      !isLocalOnlyApprovedTarget(manifest.approved_target) ||
      (manifest.approved_target_identity_kind !== undefined &&
        manifest.approved_target_identity_kind !== "tailscale_node_id_sha256") ||
      (manifest.approved_target_identity_kind === undefined) !==
        (manifest.builder_identity_kind === undefined) ||
      (manifest.builder_identity_kind !== undefined &&
        manifest.builder_identity_kind !== "tailscale_node_id_sha256") ||
      !manifest.approved_target_identity_sha256 ||
      !isHex(manifest.approved_target_identity_sha256, 64) ||
      !manifest.builder_identity_sha256 ||
      !isHex(manifest.builder_identity_sha256, 64) ||
      manifest.builder_identity_sha256 === manifest.approved_target_identity_sha256
    ) {
      throw new Error(
        "local-only schema v3 requires an approved target name " +
          `(${localOnlyApprovedTargetsMessage()}) and machine identity`,
      );
    }
    if (
      manifest.non_notarized !== true ||
      manifest.team_id !== "ADHOC" ||
      manifest.signing.mode !== "ad_hoc" ||
      manifest.signing.authority !== "adhoc" ||
      manifest.signing.helper_authority !== "adhoc" ||
      manifest.signing.team_id !== "ADHOC" ||
      manifest.signing.helper_team_id !== "ADHOC" ||
      manifest.signing.trusted_timestamp !== "none" ||
      manifest.signing.helper_trusted_timestamp !== "none"
    ) {
      throw new Error("local-only manifest requires consistent ad-hoc signing evidence");
    }
    if (
      manifest.notarization.status !== "Not Submitted" ||
      manifest.notarization.submission_id !== "none" ||
      manifest.notarization.log_sha256 !== "none" ||
      manifest.notarization.submitted_archive_sha256 !== "none" ||
      manifest.notarization.stapled !== false ||
      manifest.notarization.distribution_check !== false ||
      manifest.notarization.issue_count !== 0
    ) {
      throw new Error("local-only manifest must state that it is non-notarized");
    }
  }
  if (
    manifest.container?.type !== "zip" ||
    JSON.stringify(manifest.container.install_locations) !== JSON.stringify(
      artifactPolicy === "release"
        ? ["/Applications/Recordings.app"]
        : ["~/Applications/Recordings.app"],
    )
  ) {
    throw new Error("manifest has an unexpected container install policy");
  }
  if (
    manifest.external_state?.classification !== "user-private" ||
    manifest.external_state?.rollback !== "database-preserving-transactional-restore" ||
    JSON.stringify(manifest.external_state.paths) !== JSON.stringify(["~/.hasna/recordings"])
  ) {
    throw new Error("manifest has an unexpected external-state policy");
  }
  const items = manifest.nested_code_policy?.items;
  const expectedPaths = artifactPolicy === "release"
    ? [".", "Contents/Helpers/recordings", "Contents/Helpers/recordings-update-client"]
    : [".", "Contents/Helpers/recordings"];
  if (!Array.isArray(items) || items.length !== expectedPaths.length) {
    throw new Error("manifest nested-code allowlist is incomplete");
  }
  if (
    items.some(
      (item, index) =>
        item.path !== expectedPaths[index] ||
        item.team_id !== manifest.team_id ||
        item.runtime !== true ||
        item.timestamp_required !== (artifactPolicy === "release") ||
        !isHex(item.entitlements_sha256, 64),
    )
  ) {
    throw new Error("manifest nested-code allowlist entries are invalid");
  }
  if (nestedPolicyDigest(items) !== manifest.nested_code_policy.allowlist_sha256) {
    throw new Error("manifest nested-code allowlist digest mismatch");
  }
}

export function verifyArchiveManifest(
  archivePath: string,
  manifestPath: string,
  expectedTeamId: string,
  expectedManifestSha256: string,
  expectedSourceSha: string,
  expectedVersion: string,
  expectedPolicy: ArtifactPolicy = "release",
  expectedApprovedTarget: string = RELEASE_APPROVED_TARGET,
  expectedApprovedTargetIdentitySha256: string = "none",
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind = LEGACY_LOCAL_TARGET_IDENTITY_KIND,
): MacOSArtifactManifest {
  if (!expectedTeamId) throw new Error("expected Team ID is required");
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    manifestPath,
    expectedManifestSha256,
  );
  assertManifestShape(manifest);
  if (manifestPolicy(manifest) !== expectedPolicy) {
    throw new Error("manifest artifact policy does not match the explicit operator selection");
  }
  const actualApprovedTarget = manifest.approved_target ?? RELEASE_APPROVED_TARGET;
  if (actualApprovedTarget !== expectedApprovedTarget) {
    throw new Error("manifest approved target does not match the exact operator-approved target");
  }
  if (
    expectedPolicy === "local_only" &&
    manifestTargetIdentityKind(manifest) !== expectedApprovedTargetIdentityKind
  ) {
    throw new Error("manifest target identity kind does not match the explicit operator selection");
  }
  if (
    expectedPolicy === "local_only" &&
    manifest.approved_target_identity_sha256 !== expectedApprovedTargetIdentitySha256
  ) {
    throw new Error("manifest machine identity does not match the exact operator-approved target");
  }
  if (!isHex(expectedSourceSha, 40) || manifest.git_sha !== expectedSourceSha) {
    throw new Error("manifest source SHA does not match the operator-approved source");
  }
  if (!expectedVersion || manifest.bundle_version !== expectedVersion) {
    throw new Error("manifest version does not match the operator-approved version");
  }
  if (manifest.team_id !== expectedTeamId || manifest.signing.team_id !== expectedTeamId) {
    throw new Error("manifest Team ID does not match the required Team ID");
  }
  if (manifest.signing.helper_team_id !== expectedTeamId) {
    throw new Error("manifest helper Team ID does not match the required Team ID");
  }
  if (manifest.archive.filename !== basename(archivePath)) {
    throw new Error("archive filename does not match the manifest");
  }
  if (sha256ArchiveFile(archivePath) !== manifest.archive.sha256) {
    throw new Error("archive checksum does not match the manifest");
  }
  return manifest;
}

export function assertProvenanceMatchesManifest(
  provenance: BuildProvenance,
  manifest: MacOSArtifactManifest,
): void {
  if (provenance.schema_version !== manifest.schema_version) {
    throw new Error("signed provenance schema version mismatch");
  }
  for (const key of [
    "artifact_policy",
    "approved_target",
    "approved_target_identity_kind",
    "approved_target_identity_sha256",
    "builder_identity_kind",
    "builder_identity_sha256",
    "non_notarized",
    "bundle_id",
    "bundle_version",
    "git_sha",
    "team_id",
  ] as const) {
    if (provenance[key] !== manifest[key]) throw new Error(`signed provenance ${key} mismatch`);
  }
  if (
    provenance.bundle_build_version !== manifest.bundle_build_version ||
    provenance.minimum_macos !== manifest.minimum_macos
  ) {
    throw new Error("signed provenance bundle policy mismatch");
  }
  if (!sameStrings(
    sortUnsignedUtf8([...provenance.architectures]),
    sortUnsignedUtf8([...manifest.architectures]),
  )) {
    throw new Error("signed provenance architecture mismatch");
  }
  if (
    provenance.companion.version !== manifest.companion.version ||
    provenance.companion.sha256 !== manifest.companion.sha256 ||
    !sameStrings(
      sortUnsignedUtf8([...provenance.companion.architectures]),
      sortUnsignedUtf8([...manifest.companion.architectures]),
    )
  ) {
    throw new Error("signed provenance companion mismatch");
  }
}


