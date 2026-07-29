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

import { APP_ENTITLEMENTS, ArtifactPolicy, BuildProvenance, CODESIGN_EXECUTABLE, HELPER_ENTITLEMENTS, MacOSArtifactManifest, OperatorTargetIdentityKind, TargetIdentityKind, sha256, sha256File } from "./common";
import { assertCurrentSourceRevision, companionVersion, parseDesignatedRequirement, plistValue, provenancePath, readAuthenticatedManifest, readJson, run, runWithEnvironment, sha256ArchiveFile, signingEvidence, writeManifestAtomically } from "./artifacts";
import { assertExpectedCodeLayout, isHex, manifestPolicy, nestedItems, nestedPolicyDigest } from "./layout";
import { assertManifestShape } from "./manifest";
import { verifyExtractedApp, verifySuppliedAndArchivedApps } from "./app-verification";
import { treeDigest } from "./publication";

export function assertAcceptedNotaryLog(
  value: unknown,
  notarySubmissionId: string,
  submittedArchiveSha256: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("notary log is not accepted and issue-free");
  }
  const notaryLog = value as {
    jobId?: unknown;
    status?: unknown;
    issues?: unknown;
    sha256?: unknown;
  };
  if (
    notaryLog.status !== "Accepted" ||
    !Object.prototype.hasOwnProperty.call(notaryLog, "issues") ||
    (notaryLog.issues !== null && !Array.isArray(notaryLog.issues)) ||
    (Array.isArray(notaryLog.issues) ? notaryLog.issues.length : 0) !== 0
  ) {
    throw new Error("notary log is not accepted and issue-free");
  }
  if (!notarySubmissionId) throw new Error("notary submission ID is required");
  if (
    typeof notaryLog.jobId !== "string" ||
    notaryLog.jobId.toLowerCase() !== notarySubmissionId.toLowerCase()
  ) {
    throw new Error("notary log job ID does not match the submission ID");
  }
  if (!isHex(submittedArchiveSha256, 64)) throw new Error("submitted archive SHA-256 is invalid");
  if (notaryLog.sha256 !== submittedArchiveSha256) {
    throw new Error("notary log archive SHA-256 does not match the submitted archive");
  }
}

export function finalizeLocalArtifact(
  appPath: string,
  archivePath: string,
  manifestPath: string,
  packageRoot: string,
  expectedSourceSha: string,
  approvedTarget: string,
  approvedTargetIdentityKind: TargetIdentityKind,
  approvedTargetIdentitySha256: string,
): void {
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  if (approvedTargetIdentityKind !== "tailscale_node_id_sha256") {
    throw new Error("new local-only artifacts require a Tailscale node ID identity hash");
  }
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  if (
    provenance.git_sha !== expectedSourceSha ||
    provenance.artifact_policy !== "local_only" ||
    provenance.approved_target !== approvedTarget ||
    provenance.approved_target_identity_kind !== approvedTargetIdentityKind ||
    provenance.approved_target_identity_sha256 !== approvedTargetIdentitySha256 ||
    provenance.builder_identity_kind !== "tailscale_node_id_sha256" ||
    provenance.non_notarized !== true ||
    provenance.team_id !== "ADHOC"
  ) {
    throw new Error("embedded provenance is not approved for this local-only target");
  }
  assertExpectedCodeLayout(appPath);
  const outerSigning = signingEvidence(
    appPath,
    "ADHOC",
    APP_ENTITLEMENTS,
    executablePath,
    "local_only",
  );
  const helperSigning = signingEvidence(
    helperPath,
    "ADHOC",
    HELPER_ENTITLEMENTS,
    helperPath,
    "local_only",
  );
  const items = nestedItems(appPath, "ADHOC", "local_only", outerSigning, helperSigning);
  const manifest: MacOSArtifactManifest = {
    ...provenance,
    artifact_type: "recordings-macos-app",
    app_sha256: sha256File(executablePath),
    binding: { bundle_tree_sha256: treeDigest(appPath) },
    provenance_sha256: sha256File(embeddedPath),
    signing: {
      mode: "ad_hoc",
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
      submission_id: "none",
      status: "Not Submitted",
      log_sha256: "none",
      issue_count: 0,
      submitted_archive_sha256: "none",
      stapled: false,
      distribution_check: false,
    },
    container: {
      type: "zip",
      install_locations: ["~/Applications/Recordings.app"],
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
    "ADHOC",
    "local_only",
    approvedTarget,
    approvedTargetIdentitySha256,
    approvedTargetIdentityKind,
  );
  assertCurrentSourceRevision(packageRoot, expectedSourceSha);
  if (sha256ArchiveFile(archivePath) !== manifest.archive.sha256) {
    throw new Error("release archive changed before manifest publication");
  }
  writeManifestAtomically(manifestPath, manifest);
}

export function assertExpectedRelease(
  manifestPath: string,
  expectedManifestSha256: string,
  expectedSourceSha: string,
  expectedVersion: string,
): void {
  if (!isHex(expectedManifestSha256, 64)) throw new Error("expected manifest SHA-256 is invalid");
  if (!isHex(expectedSourceSha, 40)) throw new Error("expected source SHA is invalid");
  if (!expectedVersion) throw new Error("expected version is required");
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    manifestPath,
    expectedManifestSha256,
  );
  assertManifestShape(manifest);
  if (manifestPolicy(manifest) !== "release") {
    throw new Error("release assertion rejects local-only artifacts");
  }
  if (manifest.git_sha !== expectedSourceSha) {
    throw new Error("manifest source SHA does not match the operator-approved source");
  }
  if (manifest.bundle_version !== expectedVersion) {
    throw new Error("manifest version does not match the operator-approved version");
  }
}

export function versionParts(value: string): number[] {
  if (!/^\d+(?:\.\d+)*$/.test(value)) throw new Error(`invalid numeric version: ${value}`);
  return value.split(".").map(Number);
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function assertVersionTransition(
  installedVersion: string,
  installedSource: string | null,
  manifest: MacOSArtifactManifest,
): void {
  assertManifestShape(manifest);
  if (compareVersions(manifest.bundle_version, installedVersion) < 0) {
    throw new Error(
      `refusing to downgrade Recordings.app from ${installedVersion} to ${manifest.bundle_version}`,
    );
  }
  if (compareVersions(manifest.bundle_version, installedVersion) === 0) {
    if (!installedSource) {
      throw new Error("refusing same-version replacement without verifiable installed provenance");
    }
    if (installedSource !== manifest.git_sha) {
      throw new Error("refusing same-version replacement from a different source commit");
    }
  }
}

export function assertInstallTransition(
  existingAppPath: string,
  manifestPath: string,
  expectedManifestSha256: string,
): void {
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    manifestPath,
    expectedManifestSha256,
  );
  const installedVersion = plistValue(existingAppPath, "CFBundleShortVersionString");
  let installedSource: string | null = null;
  try {
    installedSource = readJson<BuildProvenance>(provenancePath(existingAppPath)).git_sha;
  } catch {
    // Older installs can lack provenance; upgrades remain allowed, same-version replacement does not.
  }
  assertVersionTransition(installedVersion, installedSource, manifest);
}

export function requirementDigest(appPath: string, artifactPolicy: ArtifactPolicy): void {
  if (artifactPolicy === "local_only") {
    const evidence = signingEvidence(
      appPath,
      "ADHOC",
      APP_ENTITLEMENTS,
      join(appPath, "Contents", "MacOS", "Recordings"),
      "local_only",
    );
    console.log(sha256(evidence.designatedRequirement));
    return;
  }
  const output = run(CODESIGN_EXECUTABLE, ["-d", "-r-", appPath]);
  console.log(sha256(parseDesignatedRequirement(output)));
}

export function assertFilesystemTree(root: string, expectedUid: number): void {
  const visit = (path: string): void => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error(`filesystem tree contains a symlink: ${path}`);
    if (details.uid !== expectedUid) throw new Error(`filesystem tree has an unexpected owner: ${path}`);
    if ((details.mode & 0o022) !== 0) {
      throw new Error(`filesystem tree is group/world writable: ${path}`);
    }
    if (process.platform === "darwin") {
      const aclLines = run("/bin/ls", ["-lde", path]).split(/\r?\n/).slice(1);
      if (aclLines.some((line) => line.trim())) {
        throw new Error(`filesystem tree has an unexpected ACL: ${path}`);
      }
    }
    if (details.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (!details.isFile()) {
      throw new Error(`filesystem tree contains a special file: ${path}`);
    }
  };
  visit(root);
}

export function verifyActiveApp(
  appPath: string,
  manifestPath: string,
  expectedManifestSha256: string,
  expectedTeamId: string,
  expectedPolicy: ArtifactPolicy,
  expectedApprovedTarget: string,
  expectedApprovedTargetIdentitySha256: string,
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind,
): void {
  const manifest = verifyExtractedApp(
    appPath,
    manifestPath,
    expectedManifestSha256,
    expectedTeamId,
    expectedPolicy,
    expectedApprovedTarget,
    expectedApprovedTargetIdentitySha256,
    expectedApprovedTargetIdentityKind,
  );
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  if (companionVersion(helperPath) !== manifest.companion.version) {
    throw new Error("activated companion version mismatch");
  }
  const contractHome = mkdtempSync(join(tmpdir(), "recordings-activated-helper-"));
  try {
    const environment: NodeJS.ProcessEnv = {
      HOME: contractHome,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HASNA_RECORDINGS_STORAGE_MODE: "local",
      RECORDINGS_STORAGE_MODE: "local",
      HASNA_RECORDINGS_DB_PATH: join(contractHome, "recordings.db"),
      RECORDINGS_AUDIO_DIR: join(contractHome, "audio"),
    };
    const project = JSON.parse(
      runWithEnvironment(
        helperPath,
        [
          "--json",
          "project",
          "register",
          "--name",
          "Activated Helper Contract",
          "--path",
          "recordings-app://install/activated-helper-contract",
        ],
        environment,
      ),
    ) as { name?: string };
    const recording = JSON.parse(
      runWithEnvironment(
        helperPath,
        [
          "--json",
          "save-text",
          "Activated helper contract",
          "--source",
          "native_install_contract",
          "--post-processing",
          "off",
        ],
        environment,
      ),
    ) as { raw_text?: string };
    if (project.name !== "Activated Helper Contract" || recording.raw_text !== "Activated helper contract") {
      throw new Error("activated companion capability contract returned unexpected data");
    }
  } finally {
    rmSync(contractHome, { recursive: true, force: true });
  }
}


