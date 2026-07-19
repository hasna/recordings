#!/usr/bin/env bun

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
import { crc32, inflateRawSync } from "node:zlib";
import {
  nativeFsGuard,
  type NativeFsGuard,
  type NativeHandle,
  type NativeMetadata,
} from "./native_fs_guard";

const GIT_EXECUTABLE = "/usr/bin/git";
// Production macOS never honors an environment override; the non-Darwin branch
// lets fixture-only CI execute the real artifact CLI on hosts without codesign.
const CODESIGN_EXECUTABLE = process.platform === "darwin"
  ? "/usr/bin/codesign"
  : process.env.RECORDINGS_TEST_MACOS_ARTIFACT_CODESIGN_EXECUTABLE ?? "codesign";
const LIPO_EXECUTABLE = process.platform === "darwin" ? "/usr/bin/lipo" : "lipo";
const PLUTIL_EXECUTABLE = process.platform === "darwin" ? "/usr/bin/plutil" : "plutil";
const XCRUN_EXECUTABLE = "/usr/bin/xcrun";
const SPCTL_EXECUTABLE = "/usr/sbin/spctl";
const SYSPOLICY_CHECK_EXECUTABLE = "/usr/bin/syspolicy_check";

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 4;
export const LOCAL_ARTIFACT_SCHEMA_VERSION = 3;
export const BUNDLE_ID = "com.hasna.recordings";
export const PROVENANCE_FILENAME = "recordings-build-provenance.json";
export const RELEASE_APPROVED_TARGET = "fleet";
export const LEGACY_LOCAL_TARGET_IDENTITY_KIND = "hardware_uuid_sha256";

export type ArtifactPolicy = "release" | "local_only";
export type TargetIdentityKind =
  | typeof LEGACY_LOCAL_TARGET_IDENTITY_KIND
  | "tailscale_node_id_sha256";
type OperatorTargetIdentityKind = TargetIdentityKind | "none";

export type BuildProvenance = {
  schema_version: 3 | 4;
  artifact_policy?: "local_only";
  approved_target?: string;
  approved_target_identity_kind?: TargetIdentityKind;
  approved_target_identity_sha256?: string;
  builder_identity_kind?: TargetIdentityKind;
  builder_identity_sha256?: string;
  non_notarized?: true;
  bundle_id: string;
  bundle_version: string;
  bundle_build_version: string;
  git_sha: string;
  architectures: string[];
  team_id: string;
  minimum_macos: string;
  companion: {
    version: string;
    sha256: string;
    architectures: string[];
  };
};

export type MacOSArtifactManifest = BuildProvenance & {
  artifact_type: "recordings-macos-app";
  app_sha256: string;
  binding: {
    bundle_tree_sha256: string;
  };
  provenance_sha256: string;
  signing: {
    mode?: "ad_hoc";
    authority: string;
    team_id: string;
    trusted_timestamp: string;
    helper_authority: string;
    helper_team_id: string;
    helper_trusted_timestamp: string;
    entitlements_sha256: string;
    helper_entitlements_sha256: string;
    designated_requirement_sha256: string;
    helper_designated_requirement_sha256: string;
  };
  notarization: {
    submission_id: string;
    status: "Accepted" | "Not Submitted";
    log_sha256: string;
    issue_count: 0;
    submitted_archive_sha256: string;
    stapled: boolean;
    distribution_check: boolean;
  };
  container: {
    type: "zip";
    install_locations: ["/Applications/Recordings.app"] | ["~/Applications/Recordings.app"];
  };
  nested_code_policy: {
    allowlist_sha256: string;
    items: NestedCodeItem[];
  };
  external_state: {
    paths: ["~/.hasna/recordings"];
    classification: "user-private";
    rollback: "database-preserving-transactional-restore";
  };
  archive: {
    filename: string;
    sha256: string;
  };
};

type SigningEvidence = {
  mode: "developer_id" | "ad_hoc";
  authority: string;
  teamId: string;
  timestamp: string;
  designatedRequirement: string;
  architectures: string[];
  entitlementsSha256: string;
};

type AppVerificationEvidence = {
  bundleTreeSha256: string;
  executableSha256: string;
  provenanceSha256: string;
  companionSha256: string;
  outerSigning: SigningEvidence;
  helperSigning: SigningEvidence;
};

const APP_ENTITLEMENTS = {
  "com.apple.security.app-sandbox": false,
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.audio-input": true,
} as const;

const HELPER_ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
} as const;

const UPDATE_CLIENT_ENTITLEMENTS = {} as const;

export type NestedCodeItem = {
  path: string;
  team_id: string;
  runtime: true;
  timestamp_required: boolean;
  architectures: string[];
  entitlements_sha256: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical release ordering is the lexicographic order of unsigned UTF-8
 * bytes. Do not use the host locale or JavaScript's UTF-16 code-unit order for
 * material that is hashed or compared across runtimes.
 */
export function compareUnsignedUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortUnsignedUtf8(values: string[]): string[] {
  return values.sort(compareUnsignedUtf8);
}

export const HASH_IO_CHUNK_BYTES = 1024 * 1024;
const JSON_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

type RegularFileSnapshot = {
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function snapshotOpenRegularFile(descriptor: number, label: string): RegularFileSnapshot {
  const details = fstatSync(descriptor, { bigint: true });
  if (!details.isFile() || details.size < 0n || details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a regular file with a supported size`);
  }
  return {
    dev: details.dev,
    ino: details.ino,
    size: Number(details.size),
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

function openRegularFile(path: string, label: string): {
  descriptor: number;
  snapshot: RegularFileSnapshot;
} {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a regular file, not a symlink or special entry`, {
      cause: error,
    });
  }
  try {
    return { descriptor, snapshot: snapshotOpenRegularFile(descriptor, label) };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertRegularFileUnchanged(
  path: string,
  descriptor: number,
  before: RegularFileSnapshot,
  label: string,
): void {
  const after = snapshotOpenRegularFile(descriptor, label);
  let pathDetails: BigIntStats;
  try {
    pathDetails = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} changed or was replaced while being read`, { cause: error });
  }
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    !pathDetails.isFile() ||
    pathDetails.dev !== before.dev ||
    pathDetails.ino !== before.ino
  ) {
    throw new Error(`${label} changed or was replaced while being read`);
  }
}

function readRegularFileBounded(
  path: string,
  maximumBytes: number,
  label: string,
  maximumSizeError: string,
): Buffer {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    if (snapshot.size > maximumBytes) throw new Error(maximumSizeError);
    const contents = Buffer.allocUnsafe(snapshot.size);
    let offset = 0;
    while (offset < snapshot.size) {
      const count = readSync(
        descriptor,
        contents,
        offset,
        Math.min(HASH_IO_CHUNK_BYTES, snapshot.size - offset),
        offset,
      );
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFilePrefix(path: string, bytes: number, label: string): Buffer {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    const contents = Buffer.allocUnsafe(Math.min(snapshot.size, bytes));
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function sha256RegularFile(
  path: string,
  label: string,
  maximumBytes?: number,
  maximumSizeError?: string,
): string {
  const { descriptor, snapshot } = openRegularFile(path, label);
  try {
    if (maximumBytes !== undefined && snapshot.size > maximumBytes) {
      throw new Error(maximumSizeError ?? `${label} exceeds the supported size limit`);
    }
    const hasher = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(HASH_IO_CHUNK_BYTES, Math.max(snapshot.size, 1)),
    );
    let offset = 0;
    while (offset < snapshot.size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, snapshot.size - offset),
        offset,
      );
      if (count === 0) throw new Error(`${label} changed while being read`);
      hasher.update(buffer.subarray(0, count));
      offset += count;
    }
    assertRegularFileUnchanged(path, descriptor, snapshot, label);
    return hasher.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function sha256File(path: string): string {
  return sha256RegularFile(path, "hash input");
}

export function snapshotRegularFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  expectedBytes?: number,
): string {
  if (!sourcePath.startsWith("/") || !destinationPath.startsWith("/")) {
    throw new Error("regular-file snapshot paths must be absolute");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("regular-file snapshot maximum bytes must be a positive integer");
  }
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) ||
      expectedBytes <= 0 ||
      expectedBytes > maximumBytes)
  ) {
    throw new Error(
      "regular-file snapshot expected bytes must be a positive integer no larger than the maximum",
    );
  }
  const contents = readRegularFileBounded(
    sourcePath,
    maximumBytes,
    "regular-file snapshot source",
    "regular-file snapshot source exceeds the configured size limit",
  );
  if (expectedBytes !== undefined && contents.length !== expectedBytes) {
    throw new Error(
      `regular-file snapshot source must contain exactly ${expectedBytes} bytes`,
    );
  }
  const descriptor = openSync(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    let offset = 0;
    while (offset < contents.length) {
      offset += writeSync(descriptor, contents, offset, contents.length - offset);
    }
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(destinationPath));
  return sha256(contents);
}

function sha256ArchiveFile(path: string): string {
  return sha256RegularFile(
    path,
    "release ZIP",
    ZIP_EXTRACTION_LIMITS.archiveBytes,
    "release ZIP exceeds the compressed archive size limit",
  );
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function runWithEnvironment(command: string, args: string[], environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function plistValue(appPath: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist"),
  ]).trim();
}

function architectures(executablePath: string): string[] {
  return sortUnsignedUtf8(
    run(LIPO_EXECUTABLE, ["-archs", executablePath]).trim().split(/\s+/).filter(Boolean),
  );
}

function signingDetails(codePath: string): string {
  return run(CODESIGN_EXECUTABLE, ["-d", "--verbose=4", codePath]);
}

function lineValue(details: string, key: string): string {
  const match = details.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function parseDesignatedRequirement(output: string): string {
  const prefix = "designated =>";
  const line = output.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(prefix));
  const requirement = line?.trimStart().slice(prefix.length).trim() ?? "";
  if (!requirement) throw new Error("code signature is missing a designated requirement");
  return requirement;
}

export function designatedRequirementForPolicy(
  output: string,
  artifactPolicy: ArtifactPolicy,
  adHocSignatureVerified = false,
): string {
  if (artifactPolicy === "release") return parseDesignatedRequirement(output);
  if (!adHocSignatureVerified) {
    throw new Error("local-only designated requirement evidence requires verified ad-hoc signing");
  }
  try {
    return parseDesignatedRequirement(output);
  } catch {
    return "none-ad-hoc";
  }
}

export function assertCleanGitStatus(status: string): void {
  if (status.trim()) {
    throw new Error("refusing to claim a git SHA for a dirty source worktree");
  }
}

export function assertPinnedSourceRevision(
  expectedSourceSha: string,
  status: string,
  currentHead: string,
): void {
  if (!isHex(expectedSourceSha, 40)) {
    throw new Error("pinned source SHA must be a full lowercase commit SHA");
  }
  assertCleanGitStatus(status);
  if (currentHead.trim() !== expectedSourceSha) {
    throw new Error("current clean HEAD does not match the pinned source SHA");
  }
}

function assertCurrentSourceRevision(packageRoot: string, expectedSourceSha: string): void {
  assertPinnedSourceRevision(
    expectedSourceSha,
    run(GIT_EXECUTABLE, ["-C", packageRoot, "status", "--porcelain=v1", "--untracked-files=all"]),
    run(GIT_EXECUTABLE, ["-C", packageRoot, "rev-parse", "HEAD"]),
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUnsignedUtf8(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalEntitlements(codePath: string): string {
  const readback = spawnSync(CODESIGN_EXECUTABLE, ["-d", "--entitlements", ":-", codePath], {
    encoding: "utf8",
  });
  if (readback.error) throw readback.error;
  if (readback.status !== 0) throw new Error(`could not read signed entitlements for ${codePath}`);
  const raw = readback.stdout;
  if (!raw.trim()) throw new Error(`signed entitlements are empty for ${codePath}`);
  const result = spawnSync(PLUTIL_EXECUTABLE, ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: raw,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not parse signed entitlements for ${codePath}`);
  return canonicalJson(JSON.parse(result.stdout));
}

function signingEvidence(
  codePath: string,
  expectedTeamId: string,
  expectedEntitlements: object,
  architecturePath = codePath,
  artifactPolicy: ArtifactPolicy = "release",
): SigningEvidence {
  run(CODESIGN_EXECUTABLE, ["--verify", "--strict", "--all-architectures", "--verbose=2", codePath]);
  const details = signingDetails(codePath);
  let authority = lineValue(details, "Authority");
  const rawTeamId = lineValue(details, "TeamIdentifier");
  const rawTimestamp = lineValue(details, "Timestamp");
  const rawSignature = lineValue(details, "Signature");
  let teamId = rawTeamId;
  let timestamp = rawTimestamp;
  let mode: SigningEvidence["mode"] = "developer_id";
  if (artifactPolicy === "release") {
    if (!authority.startsWith("Developer ID Application:")) {
      throw new Error(`${codePath} is not signed by a Developer ID Application authority`);
    }
    if (teamId !== expectedTeamId) {
      throw new Error(`${codePath} TeamIdentifier ${teamId || "missing"} does not match ${expectedTeamId}`);
    }
    if (!timestamp || timestamp.toLowerCase() === "none") {
      throw new Error(`${codePath} is missing a trusted signing timestamp`);
    }
  } else {
    mode = "ad_hoc";
    if (expectedTeamId !== "ADHOC") {
      throw new Error("local-only code verification requires the ADHOC signing identity");
    }
    if (rawSignature.toLowerCase() !== "adhoc" || authority) {
      throw new Error(`${codePath} is not consistently ad-hoc signed for local-only use`);
    }
    if (rawTeamId && rawTeamId.toLowerCase() !== "not set") {
      throw new Error(`${codePath} unexpectedly carries a TeamIdentifier in local-only mode`);
    }
    if (rawTimestamp && rawTimestamp.toLowerCase() !== "none") {
      throw new Error(`${codePath} unexpectedly carries a trusted timestamp in local-only mode`);
    }
    teamId = "ADHOC";
    timestamp = "none";
    authority = "adhoc";
  }
  const flagList = details.match(/^CodeDirectory .*flags=[^(]*\(([^)]*)\)/m)?.[1]
    ?.split(",")
    .map((value) => value.trim());
  if (!flagList?.includes("runtime")) {
    throw new Error(`${codePath} is missing hardened runtime signing`);
  }
  const requirementOutput = run(CODESIGN_EXECUTABLE, ["-d", "-r-", codePath]);
  const designatedRequirement = designatedRequirementForPolicy(
    requirementOutput,
    artifactPolicy,
    mode === "ad_hoc",
  );
  const entitlements = canonicalEntitlements(codePath);
  if (entitlements !== canonicalJson(expectedEntitlements)) {
    throw new Error(`${codePath} has unexpected signed entitlements`);
  }
  return {
    mode,
    authority,
    teamId,
    timestamp,
    designatedRequirement,
    architectures: architectures(architecturePath),
    entitlementsSha256: sha256(entitlements),
  };
}

function companionVersion(companionPath: string): string {
  return run(companionPath, ["--version"]).trim().split(/\s+/).at(-1) ?? "";
}

function provenancePath(appPath: string): string {
  return join(appPath, "Contents", "Resources", PROVENANCE_FILENAME);
}

function readJson<T>(path: string): T {
  return JSON.parse(
    readRegularFileBounded(
      path,
      JSON_INPUT_LIMIT_BYTES,
      "JSON input",
      "JSON input exceeds the supported size limit",
    ).toString("utf8"),
  ) as T;
}

export function parseAuthenticatedManifestSnapshot<T>(
  snapshot: Buffer,
  expectedSha256: string,
): T {
  if (!isHex(expectedSha256, 64) || sha256(snapshot) !== expectedSha256) {
    throw new Error("manifest checksum does not match the authenticated operator value");
  }
  return JSON.parse(snapshot.toString("utf8")) as T;
}

export function readAuthenticatedManifest<T>(path: string, expectedSha256: string): T {
  if (!isHex(expectedSha256, 64)) {
    throw new Error("manifest checksum does not match the authenticated operator value");
  }
  const snapshot = readRegularFileBounded(
    path,
    JSON_INPUT_LIMIT_BYTES,
    "JSON input",
    "JSON input exceeds the supported size limit",
  );
  return parseAuthenticatedManifestSnapshot<T>(snapshot, expectedSha256);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeManifestAtomically(path: string, value: unknown): string {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const parent = dirname(path);
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // A hard-link publication is atomic and fails with EEXIST instead of
    // replacing an already published manifest. The temporary and destination
    // are necessarily on the same filesystem because they share a parent.
    linkSync(temporaryPath, path);
    fsyncDirectory(parent);
    unlinkSync(temporaryPath);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  const digest = sha256(contents);
  console.log(`manifest_sha256=${digest}`);
  return digest;
}

function isHex(value: string, length: number): boolean {
  return new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function manifestPolicy(manifest: MacOSArtifactManifest): ArtifactPolicy {
  return manifest.schema_version === LOCAL_ARTIFACT_SCHEMA_VERSION ? "local_only" : "release";
}

function manifestTargetIdentityKind(manifest: MacOSArtifactManifest): OperatorTargetIdentityKind {
  if (manifestPolicy(manifest) === "release") return "none";
  return manifest.approved_target_identity_kind ?? LEGACY_LOCAL_TARGET_IDENTITY_KIND;
}

function manifestBuilderIdentityKind(manifest: MacOSArtifactManifest): OperatorTargetIdentityKind {
  if (manifestPolicy(manifest) === "release") return "none";
  return manifest.builder_identity_kind ?? LEGACY_LOCAL_TARGET_IDENTITY_KIND;
}

function isTargetIdentityKind(value: unknown): value is TargetIdentityKind {
  return value === LEGACY_LOCAL_TARGET_IDENTITY_KIND || value === "tailscale_node_id_sha256";
}

export function tailscaleNodeIdSha256(statusJson: string, expectedHostname: string): string {
  if (!expectedHostname) throw new Error("expected Tailscale hostname is required");
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    throw new Error("Tailscale status is not valid JSON");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Tailscale status is missing Self");
  }
  const self = (status as Record<string, unknown>).Self;
  if (!self || typeof self !== "object" || Array.isArray(self)) {
    throw new Error("Tailscale status is missing Self");
  }
  const record = self as Record<string, unknown>;
  if (record.Online !== true) throw new Error("Tailscale Self is not online");
  if (record.HostName !== expectedHostname) {
    throw new Error("Tailscale Self hostname does not match the approved target");
  }
  if (typeof record.ID !== "string") {
    throw new Error("Tailscale Self has no ID");
  }
  const nodeId = record.ID;
  if (!nodeId || /[\s\0]/u.test(nodeId)) {
    throw new Error("Tailscale Self ID is empty or malformed");
  }
  return sha256(nodeId);
}

function nestedItems(
  appPath: string,
  expectedTeamId: string,
  artifactPolicy: ArtifactPolicy = "release",
  outerSigning?: SigningEvidence,
  helperSigning?: SigningEvidence,
): NestedCodeItem[] {
  const evidence: Array<{ path: string; value: SigningEvidence }> = [
    {
      path: ".",
      value:
        outerSigning ??
        signingEvidence(
          appPath,
          expectedTeamId,
          APP_ENTITLEMENTS,
          join(appPath, "Contents", "MacOS", "Recordings"),
          artifactPolicy,
        ),
    },
    {
      path: "Contents/Helpers/recordings",
      value:
        helperSigning ??
        signingEvidence(
          join(appPath, "Contents", "Helpers", "recordings"),
          expectedTeamId,
          HELPER_ENTITLEMENTS,
          undefined,
          artifactPolicy,
        ),
    },
  ];
  const updateClientPath = join(appPath, "Contents", "Helpers", "recordings-update-client");
  if (existsSync(updateClientPath)) {
    evidence.push({
      path: "Contents/Helpers/recordings-update-client",
      value: signingEvidence(
        updateClientPath,
        expectedTeamId,
        UPDATE_CLIENT_ENTITLEMENTS,
        undefined,
        artifactPolicy,
      ),
    });
  }
  return evidence
    .sort((left, right) => compareUnsignedUtf8(left.path, right.path))
    .map(({ path, value }) => ({
      path,
      team_id: value.teamId,
      runtime: true,
      timestamp_required: artifactPolicy === "release",
      architectures: value.architectures,
      entitlements_sha256: value.entitlementsSha256,
    }));
}

function nestedPolicyDigest(items: NestedCodeItem[]): string {
  return sha256(JSON.stringify(items));
}

export function assertExpectedCodeLayout(appPath: string): void {
  const allowedExecutables = new Set([
    join(appPath, "Contents", "MacOS", "Recordings"),
    join(appPath, "Contents", "Helpers", "recordings"),
  ]);
  const updateClientPath = join(appPath, "Contents", "Helpers", "recordings-update-client");
  if (existsSync(updateClientPath)) allowedExecutables.add(updateClientPath);
  const machOMagic = new Set([
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);
  const visit = (path: string): void => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error(`app bundle contains an unexpected symlink: ${path}`);
    if (details.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!details.isFile()) throw new Error(`app bundle contains a special file: ${path}`);
    const magic = readRegularFilePrefix(path, 4, "app bundle code candidate").toString("hex");
    if (((details.mode & 0o111) !== 0 || machOMagic.has(magic)) && !allowedExecutables.has(path)) {
      throw new Error(`app bundle contains unexpected executable code: ${path}`);
    }
  };
  visit(appPath);
  for (const path of allowedExecutables) {
    if (!statSync(path).isFile()) throw new Error(`app bundle is missing expected code: ${path}`);
  }
}

function assertRegularArchiveTree(root: string): void {
  const visit = (path: string): void => {
    const details = lstatSync(path);
    const entryName = relative(root, path);
    if (entryName && /[\\\0\x00-\x1f\x7f]/u.test(entryName)) {
      throw new Error(`archive contains a noncanonical extracted path: ${entryName}`);
    }
    if (details.isSymbolicLink()) {
      throw new Error(`archive contains a forbidden symlink: ${relative(root, path) || "."}`);
    }
    if (details.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!details.isFile()) {
      throw new Error(`archive contains a forbidden special entry: ${relative(root, path) || "."}`);
    }
  };
  visit(root);
}

export const ZIP_EXTRACTION_LIMITS = {
  archiveBytes: 256 * 1024 * 1024,
  entryCount: 8192,
  entryUncompressedBytes: 256 * 1024 * 1024,
  totalUncompressedBytes: 512 * 1024 * 1024,
  compressionRatio: 200,
} as const;

type ZipEntry = {
  name: string;
  isDirectory: boolean;
  compressionMethod: 0 | 8;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
  dataStartOffset: number;
  dataEndOffset: number;
  localHeaderOffset: number;
  localRecordEndOffset: number;
  unixMode: number;
};

function zipEntryPayload(archive: Buffer, entry: ZipEntry): Buffer {
  const compressedPayload = archive.subarray(entry.dataStartOffset, entry.dataEndOffset);
  let uncompressedPayload: Buffer;
  if (entry.compressionMethod === 0) {
    uncompressedPayload = compressedPayload;
  } else {
    try {
      const inflated = inflateRawSync(compressedPayload, {
        info: true,
        // Permit one byte beyond the declaration so a dishonest size is
        // reported as a mismatch, while still stopping expansion immediately.
        maxOutputLength: entry.uncompressedBytes + 1,
      });
      if (inflated.engine.bytesWritten !== compressedPayload.length) {
        throw new Error("release ZIP compressed entry contains trailing or unconsumed payload bytes");
      }
      uncompressedPayload = inflated.buffer;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("release ZIP compressed entry")) {
        throw error;
      }
      throw new Error("release ZIP compressed entry payload is malformed or exceeds its declared size", {
        cause: error,
      });
    }
  }
  if (uncompressedPayload.length !== entry.uncompressedBytes) {
    throw new Error("release ZIP entry payload does not match its declared uncompressed size");
  }
  if ((crc32(uncompressedPayload) >>> 0) !== entry.crc32) {
    throw new Error("release ZIP entry payload CRC32 does not match its declaration");
  }
  return uncompressedPayload;
}

function canonicalZipCollisionKey(value: string): string {
  // NFKC catches compatibility-equivalent spellings. The two replacements are
  // the most common differences between lower-casing and Unicode case-folding.
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
}

function assertCanonicalZipEntries(entries: Array<{ name: string; isDirectory: boolean }>): void {
  const logicalPaths = new Map<string, { name: string; isDirectory: boolean }>();
  let rootDirectoryCount = 0;
  for (const entry of entries) {
    const rawName = entry.name;
    if (/[\\\0\x00-\x1f\x7f]/u.test(rawName) || rawName.startsWith("/")) {
      throw new Error("release ZIP contains a noncanonical entry name");
    }
    if (rawName.normalize("NFC") !== rawName) {
      throw new Error("release ZIP contains a non-normalized Unicode entry name");
    }
    if (entry.isDirectory !== rawName.endsWith("/")) {
      throw new Error("release ZIP contains an inconsistent file/directory entry");
    }
    const logicalPath = entry.isDirectory ? rawName.slice(0, -1) : rawName;
    const components = logicalPath.split("/");
    if (
      !logicalPath ||
      components[0] !== "Recordings.app" ||
      components.some((component) => !component || component === "." || component === "..")
    ) {
      throw new Error("release ZIP contains an entry outside the canonical Recordings.app tree");
    }
    const collisionKey = canonicalZipCollisionKey(logicalPath);
    if (logicalPaths.has(collisionKey)) {
      throw new Error("release ZIP contains duplicate, file/directory, case-fold, or Unicode-colliding entries");
    }
    logicalPaths.set(collisionKey, { name: logicalPath, isDirectory: entry.isDirectory });
    if (logicalPath === "Recordings.app") {
      if (!entry.isDirectory) throw new Error("release ZIP Recordings.app root is not a directory entry");
      rootDirectoryCount += 1;
    }
  }
  if (rootDirectoryCount !== 1) {
      throw new Error("release ZIP must contain exactly one canonical Recordings.app root entry");
  }
  for (const { name } of logicalPaths.values()) {
    const components = name.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const ancestor = logicalPaths.get(canonicalZipCollisionKey(components.slice(0, index).join("/")));
      if (ancestor && !ancestor.isDirectory) {
        throw new Error("release ZIP contains a file/directory ancestor collision");
      }
    }
  }
}

export function assertCanonicalZipEntryListing(listing: string): void {
  assertCanonicalZipEntries(
    listing
      .split(/\r?\n/u)
      .filter((name) => name.length > 0)
      .map((name) => ({ name, isDirectory: name.endsWith("/") })),
  );
}

export function assertRegularZipEntryTypes(listing: string, expectedEntryCount: number): void {
  const lines = listing.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== expectedEntryCount) {
    throw new Error("could not account for every release ZIP entry type");
  }
  const kinds = lines.map((line) => line.match(/^([bcdlps-])\S{9}\s/u)?.[1]);
  if (kinds.some((kind) => kind === undefined)) throw new Error("could not account for every release ZIP entry type");
  if (kinds.some((kind) => kind !== "d" && kind !== "-")) {
    throw new Error("release ZIP contains a symlink or special entry");
  }
}

function decodeCanonicalZipName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    throw new Error("release ZIP uses an ambiguous legacy filename encoding");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("release ZIP contains an invalid UTF-8 entry name");
  }
}

function assertZipExtraFields(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new Error("release ZIP contains a malformed extra field");
    const identifier = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) throw new Error("release ZIP contains a malformed extra field");
    if (identifier === 0x0001) throw new Error("release ZIP64 archives are not accepted");
    if (identifier === 0x7075) {
      throw new Error("release ZIP contains an ambiguous Unicode path override");
    }
    offset += size;
  }
}

export function inspectZipArchive(archivePath: string): ZipEntry[] {
  const archive = readRegularFileBounded(
    archivePath,
    ZIP_EXTRACTION_LIMITS.archiveBytes,
    "release ZIP",
    "release ZIP exceeds the compressed archive size limit",
  );
  return inspectZipArchiveBytes(archive);
}

function inspectZipArchiveBytes(archive: Buffer): ZipEntry[] {
  if (archive.length > ZIP_EXTRACTION_LIMITS.archiveBytes) {
    throw new Error("release ZIP exceeds the compressed archive size limit");
  }
  const minimumEocdOffset = Math.max(0, archive.length - 65_557);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new Error("release ZIP has no canonical end-of-central-directory record");
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("release ZIP must be a single-disk archive");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("release ZIP64 archives are not accepted");
  }
  if (entryCount === 0 || entryCount > ZIP_EXTRACTION_LIMITS.entryCount) {
    throw new Error("release ZIP entry count exceeds the conservative limit");
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error("release ZIP central directory is not canonical");
  }

  const entries: ZipEntry[] = [];
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("release ZIP central directory is malformed");
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const uncompressedBytes = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocdOffset || startDisk !== 0) throw new Error("release ZIP central entry is malformed");
    if ((flags & ~0x080e) !== 0 || (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new Error("release ZIP contains encrypted or unsupported entry flags");
    }
    if (method !== 0 && method !== 8) throw new Error("release ZIP uses an unsupported compression method");
    if (method === 0 && (flags & 0x0006) !== 0) throw new Error("stored ZIP entries have invalid compression flags");
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("release ZIP64 archives are not accepted");
    }
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeCanonicalZipName(nameBytes, (flags & 0x0800) !== 0);
    assertZipExtraFields(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    const isDirectory = name.endsWith("/");
    const creator = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (creator !== 3 && creator !== 19) {
      throw new Error("release ZIP entries require unambiguous Unix file types");
    }
    if (
      (isDirectory && fileType !== 0x4000) ||
      (!isDirectory && fileType !== 0x8000)
    ) {
      throw new Error("release ZIP contains a symlink, special, or inconsistent entry type");
    }
    if (uncompressedBytes > ZIP_EXTRACTION_LIMITS.entryUncompressedBytes) {
      throw new Error("release ZIP entry exceeds the uncompressed size limit");
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > ZIP_EXTRACTION_LIMITS.totalUncompressedBytes) {
      throw new Error("release ZIP exceeds the total uncompressed size limit");
    }
    if (uncompressedBytes > 0 && compressedBytes === 0) {
      throw new Error("release ZIP entry has an impossible compression ratio");
    }
    if (compressedBytes > 0 && uncompressedBytes / compressedBytes > ZIP_EXTRACTION_LIMITS.compressionRatio) {
      throw new Error("release ZIP entry exceeds the compression ratio limit");
    }
    if (method === 0 && compressedBytes !== uncompressedBytes) {
      throw new Error("stored ZIP entry has inconsistent sizes");
    }

    if (localHeaderOffset + 30 > centralOffset || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("release ZIP local entry header is malformed");
    }
    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localCrc = archive.readUInt32LE(localHeaderOffset + 14);
    const localCompressedBytes = archive.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedBytes = archive.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEndOffset = dataStart + compressedBytes;
    if (dataEndOffset > centralOffset) throw new Error("release ZIP entry data overlaps the central directory");
    const localNameBytes = archive.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
    if (!localNameBytes.equals(nameBytes) || localFlags !== flags || localMethod !== method) {
      throw new Error("release ZIP local and central entry metadata disagree");
    }
    assertZipExtraFields(archive.subarray(localHeaderOffset + 30 + localNameLength, dataStart));
    if (
      (flags & 0x0008) === 0 &&
      (localCrc !== crc || localCompressedBytes !== compressedBytes || localUncompressedBytes !== uncompressedBytes)
    ) {
      throw new Error("release ZIP local and central entry sizes disagree");
    }
    if (
      (flags & 0x0008) !== 0 &&
      ((localCrc !== 0 && localCrc !== crc) ||
        (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes) ||
        (localUncompressedBytes !== 0 && localUncompressedBytes !== uncompressedBytes))
    ) {
      throw new Error("release ZIP data-descriptor entry metadata disagree");
    }
    let localRecordEndOffset = dataEndOffset;
    if ((flags & 0x0008) !== 0) {
      const hasSignature =
        localRecordEndOffset + 4 <= centralOffset &&
        archive.readUInt32LE(localRecordEndOffset) === 0x08074b50;
      if (hasSignature) localRecordEndOffset += 4;
      if (localRecordEndOffset + 12 > centralOffset) {
        throw new Error("release ZIP data descriptor is truncated");
      }
      if (
        archive.readUInt32LE(localRecordEndOffset) !== crc ||
        archive.readUInt32LE(localRecordEndOffset + 4) !== compressedBytes ||
        archive.readUInt32LE(localRecordEndOffset + 8) !== uncompressedBytes
      ) {
        throw new Error("release ZIP data descriptor disagrees with the central directory");
      }
      localRecordEndOffset += 12;
    }
    entries.push({
      name,
      isDirectory,
      compressionMethod: method,
      crc32: crc,
      compressedBytes,
      uncompressedBytes,
      dataStartOffset: dataStart,
      dataEndOffset,
      localHeaderOffset,
      localRecordEndOffset,
      unixMode: unixMode & 0o777,
    });
    cursor = end;
  }
  if (cursor !== eocdOffset) throw new Error("release ZIP has unaccounted central-directory bytes");
  assertCanonicalZipEntries(entries);
  const intervals = entries
    .map((entry) => [entry.localHeaderOffset, entry.localRecordEndOffset] as const)
    .sort(([left], [right]) => left - right);
  if (intervals[0]?.[0] !== 0 || intervals.at(-1)?.[1] !== centralOffset) {
    throw new Error("release ZIP contains unaccounted data outside canonical entries");
  }
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]![0] !== intervals[index - 1]![1]) {
      throw new Error("release ZIP contains overlapping or unaccounted local entry data");
    }
  }
  for (const entry of entries) zipEntryPayload(archive, entry);
  return entries;
}

export function verifyAndExtractArchiveDescriptors(
  archiveDescriptor: number,
  outputDirectoryDescriptor: number,
  expectedArchiveSHA256: string,
): void {
  if (!Number.isInteger(archiveDescriptor) || archiveDescriptor < 0 ||
      !Number.isInteger(outputDirectoryDescriptor) || outputDirectoryDescriptor < 0 ||
      !/^[a-f0-9]{64}$/.test(expectedArchiveSHA256)) {
    throw new Error("artifact verifier received invalid descriptor arguments");
  }
  const archiveDetails = fstatSync(archiveDescriptor);
  const outputDetails = fstatSync(outputDirectoryDescriptor);
  if (!archiveDetails.isFile() || archiveDetails.size > ZIP_EXTRACTION_LIMITS.archiveBytes) {
    throw new Error("artifact verifier archive descriptor is unsafe or oversized");
  }
  if (!outputDetails.isDirectory() || (outputDetails.mode & 0o777) !== 0o700 ||
      outputDetails.uid !== process.getuid?.()) {
    throw new Error("artifact verifier output descriptor is unsafe");
  }
  const archive = readFileSync(archiveDescriptor);
  if (archive.length !== archiveDetails.size || sha256(archive) !== expectedArchiveSHA256) {
    throw new Error("artifact verifier archive digest mismatch");
  }
  const entries = inspectZipArchiveBytes(archive);
  const outputRoot = `/dev/fd/${outputDirectoryDescriptor}`;
  if (readdirSync(outputRoot).length !== 0) {
    throw new Error("artifact verifier output directory must be empty");
  }
  const ordered = [...entries].sort((left, right) => {
    const depth = left.name.split("/").length - right.name.split("/").length;
    if (depth !== 0) return depth;
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return compareUnsignedUtf8(left.name, right.name);
  });
  for (const entry of ordered) {
    const leaf = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
    const target = join(outputRoot, ...leaf.split("/"));
    const mode = entry.unixMode & 0o777;
    if (entry.isDirectory) {
      mkdirSync(target, { mode });
      chmodSync(target, mode);
      continue;
    }
    const descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      const payload = zipEntryPayload(archive, entry);
      let offset = 0;
      while (offset < payload.length) offset += writeSync(descriptor, payload, offset);
      fchmodSync(descriptor, mode);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  fsyncSync(outputDirectoryDescriptor);
}

export function withPrivatelyExtractedArchiveApp<T>(
  archivePath: string,
  operation: (appPath: string) => T,
  platformArchiveTool = "/usr/bin/ditto",
  expectedArchiveSha256?: string,
): T {
  const privateRoot = mkdtempSync(join(tmpdir(), "recordings-artifact-extract-"));
  chmodSync(privateRoot, 0o700);
  const extractionRoot = join(privateRoot, "extracted");
  const pinnedArchivePath = join(privateRoot, "archive.zip");
  mkdirSync(extractionRoot, { mode: 0o700 });
  let sourceDescriptor: number | undefined;
  let snapshotDescriptor: number | undefined;
  try {
    const source = openRegularFile(archivePath, "release archive");
    sourceDescriptor = source.descriptor;
    const sourceDetails = source.snapshot;
    if (sourceDetails.size > ZIP_EXTRACTION_LIMITS.archiveBytes) {
      throw new Error("release ZIP exceeds the compressed archive size limit");
    }
    snapshotDescriptor = openSync(
      pinnedArchivePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copiedBytes = 0;
    while (true) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        offset += writeSync(snapshotDescriptor, buffer, offset, count - offset);
      }
      copiedBytes += count;
    }
    if (copiedBytes !== sourceDetails.size) throw new Error("release archive changed while pinning bytes");
    assertRegularFileUnchanged(archivePath, sourceDescriptor, sourceDetails, "release archive");
    fsyncSync(snapshotDescriptor);
    closeSync(snapshotDescriptor);
    snapshotDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    if (expectedArchiveSha256 && sha256ArchiveFile(pinnedArchivePath) !== expectedArchiveSha256) {
      throw new Error("pinned release archive bytes do not match the manifest digest");
    }
    inspectZipArchive(pinnedArchivePath);
    run(platformArchiveTool, ["-x", "-k", pinnedArchivePath, extractionRoot]);
    const rootEntries = readdirSync(extractionRoot);
    if (rootEntries.length !== 1 || rootEntries[0] !== "Recordings.app") {
      throw new Error("release archive must contain exactly one top-level Recordings.app");
    }
    const extractedAppPath = join(extractionRoot, "Recordings.app");
    const appDetails = lstatSync(extractedAppPath);
    if (appDetails.isSymbolicLink() || !appDetails.isDirectory()) {
      throw new Error("release archive top-level Recordings.app must be a regular directory");
    }
    assertRegularArchiveTree(extractedAppPath);
    return operation(extractedAppPath);
  } finally {
    if (snapshotDescriptor !== undefined) closeSync(snapshotDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

export function extractVerifiedArchiveToStaging(
  archivePath: string,
  manifestPath: string,
  stagingTarget: string,
  expectedTeamId: string,
  expectedManifestSha256: string,
  expectedSourceSha: string,
  expectedVersion: string,
  expectedPolicy: ArtifactPolicy,
  expectedApprovedTarget: string,
  expectedApprovedTargetIdentitySha256: string,
  expectedApprovedTargetIdentityKind: OperatorTargetIdentityKind,
  platformArchiveTool = "/usr/bin/ditto",
): void {
  if (resolve(stagingTarget) !== stagingTarget) {
    throw new Error("archive staging target must be an absolute canonical path");
  }
  const targetDetails = lstatSync(stagingTarget);
  if (
    targetDetails.isSymbolicLink() ||
    !targetDetails.isDirectory() ||
    (targetDetails.mode & 0o777) !== 0o700 ||
    targetDetails.uid !== process.getuid?.()
  ) {
    throw new Error("archive staging target must be an owned private 0700 directory");
  }
  if (readdirSync(stagingTarget).length !== 0) {
    throw new Error("archive staging target must be empty");
  }
  const manifest = verifyArchiveManifest(
    archivePath,
    manifestPath,
    expectedTeamId,
    expectedManifestSha256,
    expectedSourceSha,
    expectedVersion,
    expectedPolicy,
    expectedApprovedTarget,
    expectedApprovedTargetIdentitySha256,
    expectedApprovedTargetIdentityKind,
  );
  withPrivatelyExtractedArchiveApp(
    archivePath,
    (appPath) => {
      const targetAppPath = join(stagingTarget, "Recordings.app");
      renameSync(appPath, targetAppPath);
      assertRegularArchiveTree(targetAppPath);
      const entries = readdirSync(stagingTarget);
      if (entries.length !== 1 || entries[0] !== "Recordings.app") {
        throw new Error("archive extraction did not produce exactly Recordings.app in staging");
      }
    },
    platformArchiveTool,
    manifest.archive.sha256,
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertArchitectures(values: string[], label: string): void {
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
      manifest.approved_target !== "station06" ||
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
      throw new Error("local-only schema v3 requires exact station06 name and machine identity");
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

function assertProvenanceMatchesManifest(
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

function verifyAppAgainstManifest(
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

function assertMatchingAppEvidence(
  supplied: AppVerificationEvidence,
  extracted: AppVerificationEvidence,
): void {
  if (canonicalJson(supplied) !== canonicalJson(extracted)) {
    throw new Error(
      "archive-extracted app digest, provenance, or signing evidence differs from the supplied app",
    );
  }
}

function verifyReleaseDistributionPolicy(appPath: string): void {
  run(XCRUN_EXECUTABLE, ["stapler", "validate", appPath]);
  run(SPCTL_EXECUTABLE, ["--assess", "--type", "execute", "--verbose=2", appPath]);
  run(SYSPOLICY_CHECK_EXECUTABLE, ["distribution", appPath]);
}

function verifySuppliedAndArchivedApps(
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

function writeProvenance(
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
    approvedTarget !== "station06" ||
    approvedTargetIdentityKind !== "tailscale_node_id_sha256" ||
    builderIdentityKind !== "tailscale_node_id_sha256" ||
    !isHex(approvedTargetIdentitySha256, 64) ||
    !isHex(builderIdentitySha256, 64) ||
    approvedTargetIdentitySha256 === builderIdentitySha256
  ) {
    throw new Error("new local-only provenance requires ADHOC and a Tailscale node-bound station06 identity");
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

function finalizeArtifact(
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

function finalizeLocalArtifact(
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

function assertExpectedRelease(
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

function versionParts(value: string): number[] {
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

function assertInstallTransition(
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

function requirementDigest(appPath: string, artifactPolicy: ArtifactPolicy): void {
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

function assertFilesystemTree(root: string, expectedUid: number): void {
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

function verifyActiveApp(
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

export type InstallJournal = {
  schema_version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  phase: string;
  transaction_dir: string;
  candidate_staging?: string;
  app_parent: string;
  app_destination: string;
  data_dir: string;
  state_backup: string;
  state_backup_sha256: string;
  originals: Array<{ path: string; backup: string; sha256: string }>;
  was_running: boolean;
  prior_running_app_paths?: string[];
  expected_manifest_sha256: string;
  expected_source_sha: string;
  expected_version: string;
  artifact_policy?: ArtifactPolicy;
  approved_target?: string;
  approved_target_identity_kind?: TargetIdentityKind | "none";
  approved_target_identity_sha256?: string;
  builder_identity_kind?: TargetIdentityKind | "none";
  candidate_identity_sha256: string;
  candidate_tree_sha256?: string;
  previous_identity_sha256: string;
  original_state_mode?: "700" | "755";
  database_rollback?: "preserve-canonical-inode";
  non_database_rollback?: "preserve-safe-live-writes";
  installer_owned_state?: Array<{ path: string; sha256: string }>;
};

const INSTALL_JOURNAL_LEAF = ".Recordings-install-transaction.json";

function withJournalParent<T>(
  path: string,
  operation: (guard: NativeFsGuard, applications: NativeHandle, leaf: string) => T,
): T {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine journal owner identity");
  const appParent = resolve(dirname(path));
  const home = resolve(dirname(appParent));
  const leaf = basename(path);
  if (
    basename(appParent) !== "Applications" ||
    leaf !== INSTALL_JOURNAL_LEAF ||
    resolve(path) !== resolve(join(appParent, INSTALL_JOURNAL_LEAF))
  ) {
    throw new Error("install transaction journal is outside the canonical Applications parent");
  }
  const guard = nativeFsGuard();
  const homeHandle = guard.openTrustedHome(home, uid);
  let applications: NativeHandle | undefined;
  try {
    applications = guard.openDirAt(homeHandle, "Applications");
    if (!guard.sameBinding(homeHandle, "Applications", applications)) {
      throw new Error("Applications binding changed while opening the journal");
    }
    return operation(guard, applications, leaf);
  } finally {
    if (applications) guard.close(applications);
    guard.close(homeHandle);
  }
}

function readJournalSnapshot(path: string): Buffer {
  return withJournalParent(path, (guard, applications, leaf) =>
    guard.readRegularAt(applications, leaf, JSON_INPUT_LIMIT_BYTES));
}

function writeDurableJournalAt(
  guard: NativeFsGuard,
  applications: NativeHandle,
  leaf: string,
  journal: InstallJournal,
): void {
  const temporary = `${leaf}.tmp-${randomUUID()}`;
  guard.writeFileAt(
    applications,
    temporary,
    Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"),
    0o600,
  );
  guard.fsyncHandle(applications);
  if (
    process.platform !== "darwin" &&
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
    process.env.RECORDINGS_TEST_CRASH_DURABLE_JOURNAL === "before-rename"
  ) {
    process.kill(process.pid, "SIGKILL");
  }
  guard.renameReplaceAt(applications, temporary, applications, leaf);
  guard.fsyncHandle(applications);
  const prefix = `${leaf}.tmp-`;
  for (const entry of guard.readDir(applications)) {
    if (!entry.startsWith(prefix) || entry === temporary) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) {
      continue;
    }
    const details = guard.statAt(applications, entry);
    if (!details || details.type !== "file" || details.uid !== process.getuid?.() || details.mode !== 0o600) {
      throw new Error("durable journal found an unsafe stale temporary");
    }
    const staleTemporary = openProvenRegularAt(
      guard,
      applications,
      entry,
      nativeRegularTreeDigest(guard, applications, entry, details),
      "durable journal stale temporary",
    );
    try {
      quarantineRemoveRetainedAt(
        guard,
        applications,
        entry,
        staleTemporary,
        "durable journal stale temporary",
      );
    } finally {
      guard.close(staleTemporary);
    }
  }
  guard.fsyncHandle(applications);
}

function writeDurableJournal(path: string, journal: InstallJournal): void {
  if (resolve(journal.app_parent) !== resolve(dirname(path))) {
    throw new Error("install transaction journal parent does not match the durable target");
  }
  withJournalParent(path, (guard, applications, leaf) => {
    writeDurableJournalAt(guard, applications, leaf, journal);
  });
}

function journalArgument(): InstallJournal {
  const originalStateMode = argument("--original-state-mode");
  if (originalStateMode !== "700" && originalStateMode !== "755") {
    throw new Error("install transaction journal has an invalid original state mode");
  }
  const value: InstallJournal = {
    schema_version: 9,
    phase: argument("--phase"),
    transaction_dir: argument("--transaction-dir"),
    candidate_staging: optionalArgument("--candidate-staging"),
    app_parent: argument("--app-parent"),
    app_destination: argument("--app-destination"),
    data_dir: argument("--data-dir"),
    state_backup: argument("--state-backup"),
    state_backup_sha256: argument("--state-backup-sha256"),
    originals: [],
    was_running: Bun.argv.includes("--was-running"),
    prior_running_app_paths: [],
    expected_manifest_sha256: argument("--expected-manifest-sha256"),
    expected_source_sha: argument("--expected-source-sha"),
    expected_version: argument("--expected-version"),
    artifact_policy: argument("--artifact-policy") as ArtifactPolicy,
    approved_target: argument("--approved-target"),
    approved_target_identity_kind: argument("--approved-target-identity-kind") as
      | TargetIdentityKind
      | "none",
    approved_target_identity_sha256: argument("--approved-target-identity-sha256"),
    builder_identity_kind: argument("--builder-identity-kind") as TargetIdentityKind | "none",
    candidate_identity_sha256: argument("--candidate-identity-sha256"),
    candidate_tree_sha256: argument("--candidate-tree-sha256"),
    previous_identity_sha256: argument("--previous-identity-sha256"),
    original_state_mode: originalStateMode,
    database_rollback: "preserve-canonical-inode",
    non_database_rollback: "preserve-safe-live-writes",
    installer_owned_state: [],
  };
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] === "--original") {
      const path = Bun.argv[index + 1];
      const backup = Bun.argv[index + 2];
      const digest = Bun.argv[index + 3];
      if (!path || !backup || !digest) throw new Error("--original requires path, backup, and digest");
      value.originals.push({ path, backup, sha256: digest });
    } else if (Bun.argv[index] === "--prior-running-app-path") {
      const path = Bun.argv[index + 1];
      if (!path) throw new Error("--prior-running-app-path requires a path");
      value.prior_running_app_paths?.push(path);
    } else if (Bun.argv[index] === "--installer-owned-state") {
      const path = Bun.argv[index + 1];
      const digest = Bun.argv[index + 2];
      if (!path || !digest) {
        throw new Error("--installer-owned-state requires a path and digest");
      }
      value.installer_owned_state?.push({ path, sha256: digest });
    }
  }
  return value;
}

function readJournal(path: string): InstallJournal {
  const journal = JSON.parse(readJournalSnapshot(path).toString("utf8")) as InstallJournal;
  if (
    (journal.schema_version !== 2 && journal.schema_version !== 3 &&
      journal.schema_version !== 4 && journal.schema_version !== 5 &&
      journal.schema_version !== 6 && journal.schema_version !== 7 &&
      journal.schema_version !== 8 && journal.schema_version !== 9) ||
    !journal.transaction_dir ||
    !journal.phase
  ) {
    throw new Error("invalid install transaction journal");
  }
  const allowedPhases = new Set([
    "prepared",
    "processes-stopping",
    "processes-stopped",
    "state-mutating",
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
    "state-restored",
    "rollback-complete",
    "committed",
  ]);
  if (!allowedPhases.has(journal.phase)) throw new Error("invalid install transaction phase");
  if ((journal.phase === "state-mutating" || journal.phase === "state-restored" ||
    journal.phase === "rollback-complete") &&
    journal.schema_version !== 7 && journal.schema_version !== 8 &&
    journal.schema_version !== 9) {
    throw new Error("legacy install transaction journal contains an unsupported phase");
  }
  if (
    !isHex(journal.expected_manifest_sha256, 64) ||
    !isHex(journal.expected_source_sha, 40) ||
    !isHex(journal.state_backup_sha256, 64) ||
    !isHex(journal.candidate_identity_sha256, 64) ||
    (journal.schema_version === 9 && !isHex(journal.candidate_tree_sha256, 64)) ||
    (journal.previous_identity_sha256 !== "none" &&
      !isHex(journal.previous_identity_sha256, 64))
  ) {
    throw new Error("install transaction journal has invalid release identity fields");
  }
  if (journal.schema_version !== 9 && journal.candidate_tree_sha256 !== undefined) {
    throw new Error(
      "legacy install transaction journal contains unsupported candidate-tree evidence",
    );
  }
  if (journal.schema_version !== 4 && journal.schema_version !== 5 &&
    journal.schema_version !== 6 && journal.schema_version !== 7 &&
    journal.schema_version !== 8 && journal.schema_version !== 9 &&
    journal.original_state_mode !== undefined) {
    throw new Error("legacy install transaction journal contains unsupported state-mode fields");
  }
  if (journal.schema_version === 4 || journal.schema_version === 5 ||
    journal.schema_version === 6 || journal.schema_version === 7 ||
    journal.schema_version === 8 || journal.schema_version === 9) {
    if (journal.original_state_mode !== "700" && journal.original_state_mode !== "755") {
      throw new Error("install transaction journal has an invalid original state mode");
    }
  } else {
    journal.original_state_mode = "700";
  }
  if (journal.schema_version === 2) {
    if (
      journal.artifact_policy !== undefined ||
      journal.approved_target !== undefined ||
      journal.approved_target_identity_kind !== undefined ||
      journal.approved_target_identity_sha256 !== undefined ||
      journal.builder_identity_kind !== undefined
    ) {
      throw new Error("legacy install transaction journal contains unsupported policy fields");
    }
    journal.artifact_policy = "release";
    journal.approved_target = RELEASE_APPROVED_TARGET;
    journal.approved_target_identity_kind = "none";
    journal.approved_target_identity_sha256 = "none";
    journal.builder_identity_kind = "none";
  } else {
    journal.approved_target_identity_kind ??=
      journal.artifact_policy === "local_only" ? LEGACY_LOCAL_TARGET_IDENTITY_KIND : "none";
    journal.builder_identity_kind ??=
      journal.artifact_policy === "local_only" ? LEGACY_LOCAL_TARGET_IDENTITY_KIND : "none";
  }
  if ((journal.schema_version === 3 || journal.schema_version === 4 ||
    journal.schema_version === 5 || journal.schema_version === 6 ||
    journal.schema_version === 7 || journal.schema_version === 8 ||
    journal.schema_version === 9) && (
    (journal.artifact_policy !== "release" && journal.artifact_policy !== "local_only") ||
    !journal.approved_target ||
    (journal.artifact_policy === "release" &&
      (journal.approved_target !== RELEASE_APPROVED_TARGET ||
        journal.approved_target_identity_kind !== "none" ||
        journal.approved_target_identity_sha256 !== "none" ||
        journal.builder_identity_kind !== "none")) ||
    (journal.artifact_policy === "local_only" &&
      (journal.approved_target !== "station06" ||
        !isTargetIdentityKind(journal.approved_target_identity_kind) ||
        !isTargetIdentityKind(journal.builder_identity_kind) ||
        journal.approved_target_identity_kind !== journal.builder_identity_kind ||
        !journal.approved_target_identity_sha256 ||
        !isHex(journal.approved_target_identity_sha256, 64)))
  )) {
    throw new Error("install transaction journal has an invalid artifact policy or target");
  }
  const expectedParent = resolve(journal.app_parent);
  const transaction = resolve(journal.transaction_dir);
  if (!transaction.startsWith(`${expectedParent}/.Recordings-transaction.`)) {
    throw new Error("install transaction journal points outside the app parent");
  }
  if (journal.candidate_staging !== undefined && (
    journal.schema_version !== 9 ||
    dirname(resolve(journal.candidate_staging)) !== expectedParent ||
    !/^\.Recordings-install\.[A-Za-z0-9]+$/.test(basename(journal.candidate_staging))
  )) {
    throw new Error("install transaction journal has an unsafe candidate staging path");
  }
  if (resolve(path) !== resolve(join(expectedParent, ".Recordings-install-transaction.json"))) {
    throw new Error("install transaction journal is outside the expected app parent");
  }
  if (resolve(journal.app_destination) !== resolve(join(expectedParent, "Recordings.app"))) {
    throw new Error("install transaction journal has an unexpected app destination");
  }
  const expectedDataDir = resolve(join(dirname(expectedParent), ".hasna", "recordings"));
  if (resolve(journal.data_dir) !== expectedDataDir) {
    throw new Error("install transaction journal has an unexpected state directory");
  }
  if (!journal.originals.every((entry) => resolve(entry.backup).startsWith(`${transaction}/apps/`))) {
    throw new Error("install transaction journal has an unsafe app backup path");
  }
  if (!journal.originals.every((entry) => isHex(entry.sha256, 64))) {
    throw new Error("install transaction journal has an invalid app backup digest");
  }
  const allowedOriginal = (path: string): boolean => {
    const resolved = resolve(path);
    return (
      resolved === resolve(journal.app_destination) ||
      resolved === resolve(join(journal.data_dir, "Recordings.app")) ||
      resolved.startsWith(`${resolve(journal.app_parent)}/Recordings.app.`)
    );
  };
  if (!journal.originals.every((entry) => allowedOriginal(entry.path))) {
    throw new Error("install transaction journal has an unsafe original app path");
  }
  if (journal.schema_version !== 5 && journal.schema_version !== 6 &&
    journal.schema_version !== 7 && journal.schema_version !== 8 &&
    journal.schema_version !== 9) {
    if (journal.prior_running_app_paths !== undefined) {
      throw new Error("legacy install transaction journal contains unsupported running-path fields");
    }
    if (journal.was_running) {
      throw new Error(
        "legacy install transaction journal cannot safely restore prior running app paths",
      );
    }
    journal.prior_running_app_paths = [];
  } else {
    const paths = journal.prior_running_app_paths;
    if (!Array.isArray(paths) ||
      paths.some((entry) => typeof entry !== "string" || /[\u0000-\u001f\u007f]/.test(entry)) ||
      new Set(paths).size !== paths.length ||
      paths.some((entry) => !journal.originals.some(
        (original) => resolve(original.path) === resolve(entry),
      )) ||
      (journal.was_running ? paths.length === 0 : paths.length !== 0)) {
      throw new Error("install transaction journal has invalid prior running app paths");
    }
  }
  if (journal.schema_version === 6 || journal.schema_version === 7 ||
    journal.schema_version === 8 || journal.schema_version === 9) {
    if (journal.database_rollback !== "preserve-canonical-inode") {
      throw new Error("install transaction journal has an invalid database rollback policy");
    }
  } else if (journal.database_rollback !== undefined) {
    throw new Error("legacy install transaction journal contains an unsupported database rollback policy");
  }
  if (journal.schema_version === 7 || journal.schema_version === 8 ||
    journal.schema_version === 9) {
    if (journal.non_database_rollback !== "preserve-safe-live-writes") {
      throw new Error("install transaction journal has an invalid non-database rollback policy");
    }
    const entries = journal.installer_owned_state;
    const rollbackRoot = resolve(join(journal.data_dir, "rollbacks"));
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry.path !== "string" || !isHex(entry.sha256, 64) ||
      dirname(resolve(entry.path)) !== rollbackRoot ||
      !/^Recordings-pre-install-\d{8}T\d{6}Z-\d+-\d+\.zip$/.test(basename(entry.path))
    ) || new Set(entries.map((entry) => resolve(entry.path))).size !== entries.length) {
      throw new Error("install transaction journal has invalid installer-owned state entries");
    }
  } else if (journal.non_database_rollback !== undefined ||
    journal.installer_owned_state !== undefined) {
    throw new Error("legacy install transaction journal contains unsupported state-merge fields");
  }
  const resolvedStateBackup = resolve(journal.state_backup);
  const stateBackupName = relative(transaction, resolvedStateBackup);
  if (dirname(resolvedStateBackup) !== transaction ||
    (stateBackupName !== "state.initial" &&
      stateBackupName !== "state.stopped" &&
      !((journal.schema_version === 7 || journal.schema_version === 8 ||
        journal.schema_version === 9) &&
        /^state\.stopped\.\d+$/.test(stateBackupName)))) {
    throw new Error("install transaction journal has an unsafe state backup path");
  }
  return journal;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function transitionStateMode(
  path: string,
  expectedUid: number,
  desiredMode: "700" | "755",
  allowedCurrentModes: ReadonlySet<string>,
): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const details = fstatSync(descriptor);
    const currentMode = (details.mode & 0o777).toString(8);
    if (!details.isDirectory() || details.uid !== expectedUid || !allowedCurrentModes.has(currentMode)) {
      throw new Error("state-mode transition found an unsafe type, owner, or mode");
    }
    if (currentMode !== desiredMode) fchmodSync(descriptor, Number.parseInt(desiredMode, 8));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function fsyncTree(root: string): void {
  const details = lstatSync(root);
  if (details.isSymbolicLink()) throw new Error(`refusing to fsync symlink: ${root}`);
  if (details.isDirectory()) {
    for (const entry of readdirSync(root)) fsyncTree(join(root, entry));
  } else if (!details.isFile()) {
    throw new Error(`refusing to fsync special file: ${root}`);
  }
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type ReleasePublicationState = {
  schema_version: 4;
  publication_id: string;
  publication_identity_sha256: string;
  destination: string;
  artifacts: Array<{
    alias: string;
    size: string;
    sha256: string;
  }>;
  nested_publications: Array<{
    alias: string;
    publication_identity_sha256: string;
  }>;
};

export const RELEASE_PUBLICATION_STATE_FILENAME = ".recordings-publication.json";
export const RELEASE_PUBLICATION_COMPLETE_FILENAME = ".recordings-publication-complete.json";
const RELEASE_PUBLICATION_RECORD_LIMIT = 64 * 1024;
const RELEASE_PUBLICATION_IDENTITY_COMPONENT_LIMIT = 8 * 1024;
const RELEASE_PUBLICATION_IDENTITY_COMPONENT_COUNT_LIMIT = 64;

export function releasePublicationIdentity(components: string[]): string {
  if (
    components.length === 0 ||
    components.length > RELEASE_PUBLICATION_IDENTITY_COMPONENT_COUNT_LIMIT
  ) {
    throw new Error("release publication identity requires a bounded non-empty component set");
  }
  const canonicalComponents: Record<string, string> = {};
  for (const component of components) {
    const separator = component.indexOf("=");
    const key = separator > 0 ? component.slice(0, separator) : "";
    const value = separator > 0 ? component.slice(separator + 1) : "";
    if (
      !/^[a-z][a-z0-9_]*$/.test(key) ||
      value.length === 0 ||
      Buffer.byteLength(component, "utf8") > RELEASE_PUBLICATION_IDENTITY_COMPONENT_LIMIT ||
      component.includes("\0") ||
      component.includes("\r") ||
      component.includes("\n") ||
      Object.prototype.hasOwnProperty.call(canonicalComponents, key)
    ) {
      throw new Error("release publication identity component is invalid or duplicated");
    }
    canonicalComponents[key] = value;
  }
  return sha256(Buffer.from(canonicalJson({
    schema_version: 1,
    components: canonicalComponents,
  }), "utf8"));
}

function assertPublicationLeaf(leaf: string, label: string): void {
  if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\0")) {
    throw new Error(`${label} must be one non-dot path component`);
  }
}

function assertSecurePublicationDirectory(
  guard: NativeFsGuard,
  handle: NativeHandle,
  expectedUid: number,
  label: string,
): NativeMetadata {
  const details = guard.statHandle(handle);
  if (
    details.type !== "directory" ||
    details.uid !== expectedUid ||
    (details.mode & 0o022) !== 0 ||
    !guard.handleHasNoExtendedAcl(handle)
  ) {
    throw new Error(`${label} has an unsafe type, owner, mode, or extended ACL`);
  }
  return details;
}

function publicationParent(path: string): {
  guard: NativeFsGuard;
  parent: NativeHandle;
  uid: number;
} {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("release publication requires a numeric process uid");
  const guard = nativeFsGuard();
  const parent = guard.openTrustedHome(path, uid);
  try {
    assertSecurePublicationDirectory(guard, parent, uid, "release publication parent");
    return { guard, parent, uid };
  } catch (error) {
    guard.close(parent);
    throw error;
  }
}

function publicationStateBytes(state: ReleasePublicationState): Buffer {
  return Buffer.from(`${canonicalJson(state)}\n`, "utf8");
}

function readPublicationRecord(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  expectedUid: number,
  expectedMode: number,
  label: string,
): Buffer {
  const handle = guard.openRegularAt(parent, leaf, "read");
  try {
    const details = guard.statHandle(handle);
    if (details.type !== "file" || details.uid !== expectedUid ||
        (details.mode & 0o777) !== expectedMode || details.nlink !== 1 ||
        !guard.handleHasNoExtendedAcl(handle) || !guard.sameBinding(parent, leaf, handle)) {
      throw new Error(`${label} has an unsafe type, owner, mode, link count, ACL, or binding`);
    }
    const contents = guard.readRegularAt(parent, leaf, RELEASE_PUBLICATION_RECORD_LIMIT);
    if (guard.sha256Handle(handle) !== sha256(contents) || !guard.sameBinding(parent, leaf, handle)) {
      throw new Error(`${label} changed while it was authenticated`);
    }
    return contents;
  } finally {
    guard.close(handle);
  }
}

function parsePublicationState(
  contents: Buffer,
  destinationLeaf: string,
  expectedPublicationIdentitySHA256: string,
): ReleasePublicationState {
  const value = JSON.parse(contents.toString("utf8")) as Partial<ReleasePublicationState>;
  if (
    !isHex(expectedPublicationIdentitySHA256, 64) ||
    value.schema_version !== 4 ||
    typeof value.publication_id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.publication_id) ||
    value.publication_identity_sha256 !== expectedPublicationIdentitySHA256 ||
    value.destination !== destinationLeaf ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.nested_publications) ||
    Object.keys(value).sort().join(",") !==
      "artifacts,destination,nested_publications,publication_id,publication_identity_sha256,schema_version" ||
    value.artifacts.some((artifact) =>
      !artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      typeof (artifact as { alias?: unknown }).alias !== "string" ||
      typeof (artifact as { size?: unknown }).size !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test((artifact as { size: string }).size) ||
      typeof (artifact as { sha256?: unknown }).sha256 !== "string" ||
      !isHex((artifact as { sha256: string }).sha256, 64)
    )
  ) {
    throw new Error("release publication state is invalid or names another destination");
  }
  const artifacts = value.artifacts as ReleasePublicationState["artifacts"];
  const aliases = artifacts.map((artifact) => artifact.alias);
  for (const alias of aliases) assertPublicationLeaf(alias, "release compatibility alias");
  if (
    aliases.includes(destinationLeaf) ||
    aliases.includes(RELEASE_PUBLICATION_STATE_FILENAME) ||
    aliases.includes(RELEASE_PUBLICATION_COMPLETE_FILENAME) ||
    new Set(aliases).size !== aliases.length ||
    !sameStrings(aliases, sortUnsignedUtf8([...aliases])) ||
    artifacts.some((artifact) => Object.keys(artifact).sort().join(",") !== "alias,sha256,size")
  ) {
    throw new Error("release publication state has unsafe, duplicate, or unsorted aliases");
  }
  const nestedPublications =
    value.nested_publications as ReleasePublicationState["nested_publications"];
  const nestedAliases = nestedPublications.map((publication) => publication?.alias);
  if (
    nestedPublications.some((publication) =>
      !publication || typeof publication !== "object" || Array.isArray(publication) ||
      typeof publication.alias !== "string" ||
      typeof publication.publication_identity_sha256 !== "string" ||
      !isHex(publication.publication_identity_sha256, 64) ||
      Object.keys(publication).sort().join(",") !==
        "alias,publication_identity_sha256"
    ) ||
    nestedAliases.some((alias) => typeof alias !== "string") ||
    nestedAliases.some((alias) => {
      assertPublicationLeaf(alias, "nested release publication alias");
      return false;
    }) ||
    nestedAliases.includes(destinationLeaf) ||
    nestedAliases.includes(RELEASE_PUBLICATION_STATE_FILENAME) ||
    nestedAliases.includes(RELEASE_PUBLICATION_COMPLETE_FILENAME) ||
    new Set(nestedAliases).size !== nestedAliases.length ||
    !sameStrings(nestedAliases, sortUnsignedUtf8([...nestedAliases])) ||
    nestedAliases.some((alias) => aliases.includes(alias))
  ) {
    throw new Error("release publication state has unsafe or duplicate nested publications");
  }
  const state = value as ReleasePublicationState;
  if (!publicationStateBytes(state).equals(contents)) {
    throw new Error("release publication state is not canonically encoded");
  }
  return state;
}

function parseNestedPublicationBindings(
  bindings: string[],
): ReleasePublicationState["nested_publications"] {
  const publications = bindings.map((binding) => {
    const separator = binding.indexOf("=");
    const alias = separator > 0 ? binding.slice(0, separator) : "";
    const publicationIdentitySHA256 = separator > 0 ? binding.slice(separator + 1) : "";
    assertPublicationLeaf(alias, "nested release publication alias");
    if (!isHex(publicationIdentitySHA256, 64)) {
      throw new Error("nested release publication identity SHA-256 is invalid");
    }
    return {
      alias,
      publication_identity_sha256: publicationIdentitySHA256,
    };
  }).sort((left, right) => compareUnsignedUtf8(left.alias, right.alias));
  if (new Set(publications.map((publication) => publication.alias)).size !== publications.length) {
    throw new Error("nested release publication aliases must be unique");
  }
  return publications;
}

function assertPublicationContentsComplete(
  guard: NativeFsGuard,
  directoryHandle: NativeHandle,
  aliasParentHandle: NativeHandle,
  state: ReleasePublicationState,
  expectedUid: number,
  label: string,
  depth = 0,
): void {
  if (depth > 8) throw new Error("nested release publication depth exceeds the supported limit");
  for (const artifact of state.artifacts) {
    const alias = artifact.alias;
    const sourceHandle = guard.openRegularAt(directoryHandle, alias, "read");
    try {
      const source = guard.statHandle(sourceHandle);
      const published = guard.statAt(aliasParentHandle, alias);
      if (source.type !== "file" || source.uid !== expectedUid || (source.mode & 0o022) !== 0 ||
          source.size.toString() !== artifact.size ||
          !guard.handleHasNoExtendedAcl(sourceHandle) ||
          guard.sha256Handle(sourceHandle) !== artifact.sha256 ||
          !guard.sameBinding(directoryHandle, alias, sourceHandle) ||
          !published || published.type !== "file" ||
          source.dev !== published.dev || source.ino !== published.ino) {
        throw new Error(`${label} compatibility alias is missing or unauthenticated: ${alias}`);
      }
    } finally {
      guard.close(sourceHandle);
    }
  }
  for (const nested of state.nested_publications) {
    const nestedHandle = guard.openDirAt(directoryHandle, nested.alias);
    try {
      assertSecurePublicationDirectory(
        guard,
        nestedHandle,
        expectedUid,
        `${label} nested publication directory`,
      );
      if (!guard.sameBinding(directoryHandle, nested.alias, nestedHandle)) {
        throw new Error(`${label} nested publication directory binding changed`);
      }
      const nestedStateContents = readPublicationRecord(
        guard,
        nestedHandle,
        RELEASE_PUBLICATION_STATE_FILENAME,
        expectedUid,
        0o444,
        `${label} nested publication state`,
      );
      const nestedState = parsePublicationState(
        nestedStateContents,
        nested.alias,
        nested.publication_identity_sha256,
      );
      const nestedCompletion = readPublicationRecord(
        guard,
        nestedHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        expectedUid,
        0o444,
        `${label} nested publication completion marker`,
      );
      if (!nestedCompletion.equals(releaseCompletionBytes(nestedStateContents))) {
        throw new Error(`${label} nested completion marker does not authenticate publication state`);
      }
      assertPublicationContentsComplete(
        guard,
        nestedHandle,
        directoryHandle,
        nestedState,
        expectedUid,
        `${label} nested publication`,
        depth + 1,
      );
    } finally {
      guard.close(nestedHandle);
    }
  }
}

export function prepareReleasePublication(
  stagingPath: string,
  destinationPath: string,
  reservationPath: string,
  aliases: string[],
  publicationIdentitySHA256: string,
  nestedPublicationBindings: string[] = [],
): void {
  if (!isHex(publicationIdentitySHA256, 64)) {
    throw new Error("release publication identity SHA-256 is invalid");
  }
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const reservation = resolve(reservationPath);
  const parentPath = dirname(staging);
  if (dirname(destination) !== parentPath || dirname(reservation) !== parentPath) {
    throw new Error("release staging, destination, and reservation must be siblings");
  }
  const stagingLeaf = basename(staging);
  const destinationLeaf = basename(destination);
  const reservationLeaf = basename(reservation);
  assertPublicationLeaf(stagingLeaf, "release staging leaf");
  assertPublicationLeaf(destinationLeaf, "release destination leaf");
  assertPublicationLeaf(reservationLeaf, "release reservation leaf");
  const canonicalAliases = sortUnsignedUtf8([...aliases]);
  for (const alias of canonicalAliases) assertPublicationLeaf(alias, "release compatibility alias");
  if (new Set(canonicalAliases).size !== canonicalAliases.length) {
    throw new Error("release compatibility aliases must be unique");
  }
  const nestedPublications = parseNestedPublicationBindings(nestedPublicationBindings);
  if (nestedPublications.some((publication) => canonicalAliases.includes(publication.alias))) {
    throw new Error("release compatibility aliases and nested publications must be distinct");
  }
  const { guard, parent, uid } = publicationParent(parentPath);
  let stagingHandle: NativeHandle | undefined;
  let reservationHandle: NativeHandle | undefined;
  try {
    stagingHandle = guard.openDirAt(parent, stagingLeaf);
    reservationHandle = guard.openDirAt(parent, reservationLeaf);
    assertSecurePublicationDirectory(guard, stagingHandle, uid, "release staging directory");
    assertSecurePublicationDirectory(guard, reservationHandle, uid, "release reservation directory");
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle) ||
        !guard.sameBinding(parent, reservationLeaf, reservationHandle)) {
      throw new Error("release publication directory binding changed during preparation");
    }
    const artifacts = canonicalAliases.map((alias) => {
      const sourceHandle = guard.openRegularAt(stagingHandle!, alias, "read");
      try {
        const source = guard.statHandle(sourceHandle);
        if (source.type !== "file" || source.uid !== uid || (source.mode & 0o022) !== 0 ||
            !guard.handleHasNoExtendedAcl(sourceHandle)) {
          throw new Error(`release publication source has an unsafe type, owner, mode, or ACL: ${alias}`);
        }
        return {
          alias,
          size: source.size.toString(),
          sha256: guard.sha256Handle(sourceHandle),
        };
      } finally {
        guard.close(sourceHandle);
      }
    });
    const state: ReleasePublicationState = {
      schema_version: 4,
      publication_id: randomUUID(),
      publication_identity_sha256: publicationIdentitySHA256,
      destination: destinationLeaf,
      artifacts,
      nested_publications: nestedPublications,
    };
    assertPublicationContentsComplete(
      guard,
      stagingHandle,
      stagingHandle,
      state,
      uid,
      "release publication",
    );
    const contents = publicationStateBytes(state);
    guard.writeFileAt(stagingHandle, RELEASE_PUBLICATION_STATE_FILENAME, contents, 0o444);
    guard.writeFileAt(reservationHandle, RELEASE_PUBLICATION_STATE_FILENAME, contents, 0o400);
    guard.fsyncHandle(stagingHandle);
    guard.fsyncHandle(reservationHandle);
    guard.fsyncHandle(parent);
  } finally {
    if (reservationHandle) guard.close(reservationHandle);
    if (stagingHandle) guard.close(stagingHandle);
    guard.close(parent);
  }
}

export function publishReleaseDirectory(
  stagingPath: string,
  destinationPath: string,
  beforeRenameForTest?: () => void,
): void {
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const parentPath = dirname(staging);
  if (dirname(destination) !== parentPath || staging === destination) {
    throw new Error("release staging and destination must be distinct siblings");
  }
  const stagingLeaf = basename(staging);
  const destinationLeaf = basename(destination);
  assertPublicationLeaf(stagingLeaf, "release staging leaf");
  assertPublicationLeaf(destinationLeaf, "release destination leaf");
  const { guard, parent, uid } = publicationParent(parentPath);
  let stagingHandle: NativeHandle | undefined;
  try {
    stagingHandle = guard.openDirAt(parent, stagingLeaf);
    assertSecurePublicationDirectory(guard, stagingHandle, uid, "release staging directory");
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle)) {
      throw new Error("release staging binding changed before publication");
    }
    if (guard.statAt(parent, destinationLeaf) !== null) {
      throw new Error("release destination already exists and is immutable");
    }
    fsyncTree(staging);
    if (!guard.sameBinding(parent, stagingLeaf, stagingHandle)) {
      throw new Error("release staging binding changed while being synchronized");
    }
    beforeRenameForTest?.();
    try {
      guard.renameHandleNoReplaceAt(
        parent,
        stagingLeaf,
        stagingHandle,
        parent,
        destinationLeaf,
      );
    } catch (error) {
      if (guard.statAt(parent, destinationLeaf) !== null) {
        throw new Error("release destination already exists and is immutable", { cause: error });
      }
      throw error;
    }
    guard.fsyncHandle(parent);
  } finally {
    if (stagingHandle) guard.close(stagingHandle);
    guard.close(parent);
  }
}

function releaseCompletionBytes(stateContents: Buffer): Buffer {
  return Buffer.from(`${canonicalJson({
    schema_version: 2,
    publication_state_sha256: sha256(stateContents),
  })}\n`, "utf8");
}

export function completeReleasePublication(
  destinationPath: string,
  reservationPath: string,
  outputRootPath: string,
  expectedPublicationIdentitySHA256: string,
): void {
  const destination = resolve(destinationPath);
  const reservation = resolve(reservationPath);
  const outputRoot = resolve(outputRootPath);
  if (dirname(destination) !== outputRoot || dirname(reservation) !== outputRoot) {
    throw new Error("release destination and reservation must be direct output-root children");
  }
  const destinationLeaf = basename(destination);
  const reservationLeaf = basename(reservation);
  const { guard, parent, uid } = publicationParent(outputRoot);
  let destinationHandle: NativeHandle | undefined;
  let reservationHandle: NativeHandle | undefined;
  try {
    destinationHandle = guard.openDirAt(parent, destinationLeaf);
    assertSecurePublicationDirectory(guard, destinationHandle, uid, "published release directory");
    if (!guard.sameBinding(parent, destinationLeaf, destinationHandle)) {
      throw new Error("published release directory binding changed");
    }
    const stateContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_STATE_FILENAME,
      uid,
      0o444,
      "published release state",
    );
    const state = parsePublicationState(
      stateContents,
      destinationLeaf,
      expectedPublicationIdentitySHA256,
    );
    const completionContents = releaseCompletionBytes(stateContents);
    const existingCompletion = guard.statAt(
      destinationHandle,
      RELEASE_PUBLICATION_COMPLETE_FILENAME,
    );
    let reservationHasState = false;
    const reservationMetadata = guard.statAt(parent, reservationLeaf);
    if (reservationMetadata !== null) {
      reservationHandle = guard.openDirAt(parent, reservationLeaf);
      assertSecurePublicationDirectory(guard, reservationHandle, uid, "release reservation directory");
      if (!guard.sameBinding(parent, reservationLeaf, reservationHandle)) {
        throw new Error("release reservation binding changed");
      }
      const reservationStateMetadata = guard.statAt(
        reservationHandle,
        RELEASE_PUBLICATION_STATE_FILENAME,
      );
      if (reservationStateMetadata === null) {
        if (existingCompletion === null || guard.readDir(reservationHandle).length !== 0) {
          throw new Error("release reservation has no authenticating publication state");
        }
      } else {
        const reservationState = readPublicationRecord(
          guard,
          reservationHandle,
          RELEASE_PUBLICATION_STATE_FILENAME,
          uid,
          0o400,
          "release reservation state",
        );
        if (!reservationState.equals(stateContents)) {
          throw new Error("release reservation does not authenticate the published directory");
        }
        reservationHasState = true;
      }
    }
    if (existingCompletion === null && !reservationHandle) {
      throw new Error("incomplete release publication has no authenticating reservation");
    }
    for (const artifact of state.artifacts) {
      const alias = artifact.alias;
      const sourceHandle = guard.openRegularAt(destinationHandle, alias, "read");
      try {
        const source = guard.statHandle(sourceHandle);
        if (source.type !== "file" || source.uid !== uid || (source.mode & 0o022) !== 0 ||
            source.size.toString() !== artifact.size ||
            !guard.handleHasNoExtendedAcl(sourceHandle) ||
            guard.sha256Handle(sourceHandle) !== artifact.sha256 ||
            !guard.sameBinding(destinationHandle, alias, sourceHandle)) {
          throw new Error(`release publication source failed byte and metadata authentication: ${alias}`);
        }
        let published = guard.statAt(parent, alias);
        if (published === null) {
          if (!guard.linkNoReplaceAt(destinationHandle, alias, parent, alias)) {
            published = guard.statAt(parent, alias);
          } else {
            published = guard.statAt(parent, alias);
          }
        }
        if (!published || published.type !== "file" ||
            published.dev !== source.dev || published.ino !== source.ino) {
          throw new Error(`release compatibility alias is not the authenticated hard link: ${alias}`);
        }
      } finally {
        guard.close(sourceHandle);
      }
    }
    assertPublicationContentsComplete(
      guard,
      destinationHandle,
      parent,
      state,
      uid,
      "release publication",
    );
    guard.fsyncHandle(parent);
    if (existingCompletion === null) {
      guard.writeFileAt(
        destinationHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        completionContents,
        0o444,
      );
      guard.fsyncHandle(destinationHandle);
      guard.fsyncHandle(parent);
    } else {
      const existing = readPublicationRecord(
        guard,
        destinationHandle,
        RELEASE_PUBLICATION_COMPLETE_FILENAME,
        uid,
        0o444,
        "release completion marker",
      );
      if (!existing.equals(completionContents)) {
        throw new Error("release completion marker does not authenticate publication state");
      }
    }
    if (reservationHandle) {
      if (reservationHasState) {
        guard.unlinkFileAt(reservationHandle, RELEASE_PUBLICATION_STATE_FILENAME);
      }
      guard.fsyncHandle(reservationHandle);
      guard.close(reservationHandle);
      reservationHandle = undefined;
      guard.unlinkDirAt(parent, reservationLeaf);
      guard.fsyncHandle(parent);
    }
  } finally {
    if (reservationHandle) guard.close(reservationHandle);
    if (destinationHandle) guard.close(destinationHandle);
    guard.close(parent);
  }
}

export function assertReleasePublicationComplete(
  destinationPath: string,
  outputRootPath: string,
  expectedPublicationIdentitySHA256: string,
): void {
  const destination = resolve(destinationPath);
  const outputRoot = resolve(outputRootPath);
  if (dirname(destination) !== outputRoot) {
    throw new Error("release destination must be a direct output-root child");
  }
  const destinationLeaf = basename(destination);
  const { guard, parent, uid } = publicationParent(outputRoot);
  let destinationHandle: NativeHandle | undefined;
  try {
    destinationHandle = guard.openDirAt(parent, destinationLeaf);
    assertSecurePublicationDirectory(guard, destinationHandle, uid, "published release directory");
    if (!guard.sameBinding(parent, destinationLeaf, destinationHandle)) {
      throw new Error("published release directory binding changed");
    }
    const stateContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_STATE_FILENAME,
      uid,
      0o444,
      "published release state",
    );
    const state = parsePublicationState(
      stateContents,
      destinationLeaf,
      expectedPublicationIdentitySHA256,
    );
    const completionContents = readPublicationRecord(
      guard,
      destinationHandle,
      RELEASE_PUBLICATION_COMPLETE_FILENAME,
      uid,
      0o444,
      "release completion marker",
    );
    if (!completionContents.equals(releaseCompletionBytes(stateContents))) {
      throw new Error("release completion marker does not authenticate publication state");
    }
    assertPublicationContentsComplete(
      guard,
      destinationHandle,
      parent,
      state,
      uid,
      "release publication",
    );
  } finally {
    if (destinationHandle) guard.close(destinationHandle);
    guard.close(parent);
  }
}

function treeRecords(root: string): string[] {
  const records: string[] = [];
  const visit = (path: string): void => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error(`tree digest refuses symlink: ${path}`);
    const name = relative(root, path) || ".";
    const mode = (details.mode & 0o777).toString(8);
    if (details.isDirectory()) {
      records.push(`d\0${name}\0${mode}`);
      for (const entry of sortUnsignedUtf8(readdirSync(path))) visit(join(path, entry));
    } else if (details.isFile()) {
      records.push(`f\0${name}\0${mode}\0${details.size}\0${sha256File(path)}`);
    } else {
      throw new Error(`tree digest refuses special file: ${path}`);
    }
  };
  visit(root);
  return records;
}

function treeDigest(root: string): string {
  return sha256(treeRecords(root).join("\n"));
}

type RecoveryCapabilities = {
  guard: NativeFsGuard;
  home: NativeHandle;
  applications: NativeHandle;
  hasna: NativeHandle;
  data: NativeHandle;
  transaction?: NativeHandle;
  transactionApps?: NativeHandle;
  stateBackup?: NativeHandle;
};

function closeRecoveryCapabilities(capabilities: RecoveryCapabilities): void {
  for (const handle of [
    capabilities.stateBackup,
    capabilities.transactionApps,
    capabilities.transaction,
    capabilities.data,
    capabilities.hasna,
    capabilities.applications,
    capabilities.home,
  ]) {
    if (handle) capabilities.guard.close(handle);
  }
}

function assertNativeBinding(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  child: NativeHandle,
  label: string,
): void {
  if (!guard.sameBinding(parent, leaf, child)) {
    throw new Error(`${label} binding changed during recovery`);
  }
}

function recoveryTestBarrier(name: string, detail: string, readyDetail = detail): void {
  if (
    process.platform === "darwin" ||
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS !== "1"
  ) return;
  const prefix = `RECORDINGS_TEST_RECOVERY_${name.toUpperCase().replaceAll("-", "_")}`;
  const target = process.env[`${prefix}_TARGET`];
  if (target && target !== detail) return;
  const ready = process.env[`${prefix}_READY_FIFO`];
  const resume = process.env[`${prefix}_RESUME_FIFO`];
  if (!ready && !resume) return;
  if (!ready || !resume) throw new Error(`${name} recovery barrier requires ready and resume FIFOs`);
  writeFileSync(ready, `${readyDetail}\n`);
  readFileSync(resume);
}

function quarantineRemoveRetainedAt(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  retained: NativeHandle,
  label: string,
): void {
  const details = guard.statHandle(retained);
  if (details.type !== "directory" && details.type !== "file") {
    throw new Error(`${label} has an unsafe retained type`);
  }
  assertNativeBinding(guard, parent, leaf, retained, label);
  const quarantineLeaf = `.Recordings-recovery-quarantine.${randomUUID()}`;
  guard.renameHandleNoReplaceAt(parent, leaf, retained, parent, quarantineLeaf);
  guard.fsyncHandle(parent);
  recoveryTestBarrier("before-quarantine-remove", leaf, `${leaf}\t${quarantineLeaf}`);
  assertNativeBinding(guard, parent, quarantineLeaf, retained, `${label} quarantine`);
  if (details.type === "directory") {
    guard.removeTreeHandleAt(parent, quarantineLeaf, retained);
  } else {
    guard.unlinkFileHandleAt(parent, quarantineLeaf, retained);
  }
  guard.fsyncHandle(parent);
}

function openProvenDirectoryAt(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  expectedDigest: string,
  label: string,
): NativeHandle {
  const directory = guard.openDirAt(parent, leaf);
  try {
    assertNativeBinding(guard, parent, leaf, directory, label);
    if (nativeTreeDigest(guard, directory) !== expectedDigest) {
      throw new Error(`${label} does not match durable recovery evidence`);
    }
    assertNativeBinding(guard, parent, leaf, directory, label);
    return directory;
  } catch (error) {
    guard.close(directory);
    throw error;
  }
}

function openProvenRegularAt(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  expectedDigest: string,
  label: string,
): NativeHandle {
  const file = guard.openRegularAt(parent, leaf, "read");
  try {
    assertNativeBinding(guard, parent, leaf, file, label);
    const details = guard.statHandle(file);
    const digest = sha256(
      `f\0.\0${details.mode.toString(8)}\0${details.size}\0${guard.sha256Handle(file)}`,
    );
    if (digest !== expectedDigest) {
      throw new Error(`${label} does not match durable recovery evidence`);
    }
    assertNativeBinding(guard, parent, leaf, file, label);
    return file;
  } catch (error) {
    guard.close(file);
    throw error;
  }
}

function openRecoveryCapabilities(
  journal: InstallJournal,
  cleanupOnly = false,
): RecoveryCapabilities {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine recovery owner identity");
  const appParent = resolve(journal.app_parent);
  const homePath = resolve(dirname(appParent));
  if (
    basename(appParent) !== "Applications" ||
    resolve(journal.app_destination) !== resolve(join(appParent, "Recordings.app")) ||
    resolve(journal.data_dir) !== resolve(join(homePath, ".hasna", "recordings")) ||
    dirname(resolve(journal.transaction_dir)) !== appParent
  ) {
    throw new Error("install transaction journal does not map to canonical recovery capabilities");
  }
  const transactionLeaf = basename(journal.transaction_dir);
  const stateBackupLeaf = basename(journal.state_backup);
  if (
    !/^\.Recordings-transaction\.[A-Za-z0-9._-]+$/.test(transactionLeaf) ||
    dirname(resolve(journal.state_backup)) !== resolve(journal.transaction_dir) ||
    !/^state\.(?:initial|stopped(?:\.\d+)?)$/.test(stateBackupLeaf)
  ) {
    throw new Error("install transaction journal has unsafe capability leaves");
  }
  const guard = nativeFsGuard();
  const capabilities = {
    guard,
    home: guard.openTrustedHome(homePath, uid),
  } as RecoveryCapabilities;
  try {
    capabilities.applications = guard.openDirAt(capabilities.home, "Applications");
    capabilities.hasna = guard.openDirAt(capabilities.home, ".hasna");
    capabilities.data = guard.openDirAt(capabilities.hasna, "recordings");
    assertNativeBinding(guard, capabilities.home, "Applications", capabilities.applications, "Applications");
    assertNativeBinding(guard, capabilities.home, ".hasna", capabilities.hasna, ".hasna");
    assertNativeBinding(guard, capabilities.hasna, "recordings", capabilities.data, "state root");
    const transactionMetadata = guard.statAt(capabilities.applications, transactionLeaf);
    if (transactionMetadata === null && cleanupOnly) return capabilities;
    if (transactionMetadata === null) {
      throw new Error("install transaction recovery evidence is missing");
    }
    if (transactionMetadata.type !== "directory") {
      throw new Error("install transaction recovery evidence has an unsafe type");
    }
    capabilities.transaction = guard.openDirAt(capabilities.applications, transactionLeaf);
    if (cleanupOnly) {
      assertNativeBinding(
        guard,
        capabilities.applications,
        transactionLeaf,
        capabilities.transaction,
        "transaction root",
      );
      return capabilities;
    }
    capabilities.transactionApps = guard.openDirAt(capabilities.transaction, "apps");
    capabilities.stateBackup = guard.openDirAt(capabilities.transaction, stateBackupLeaf);
    assertNativeBinding(
      guard,
      capabilities.applications,
      transactionLeaf,
      capabilities.transaction,
      "transaction root",
    );
    assertNativeBinding(guard, capabilities.transaction, "apps", capabilities.transactionApps, "app backups");
    assertNativeBinding(
      guard,
      capabilities.transaction,
      stateBackupLeaf,
      capabilities.stateBackup,
      "state backup",
    );
    recoveryTestBarrier("after-root-pin", transactionLeaf);
    assertNativeBinding(guard, capabilities.home, "Applications", capabilities.applications, "Applications");
    assertNativeBinding(guard, capabilities.home, ".hasna", capabilities.hasna, ".hasna");
    assertNativeBinding(guard, capabilities.hasna, "recordings", capabilities.data, "state root");
    assertNativeBinding(
      guard,
      capabilities.applications,
      transactionLeaf,
      capabilities.transaction,
      "transaction root",
    );
    return capabilities;
  } catch (error) {
    closeRecoveryCapabilities(capabilities);
    throw error;
  }
}

function nativeTreeDigest(guard: NativeFsGuard, root: NativeHandle): string {
  const records: string[] = [];
  const expectedUid = process.getuid?.();
  if (expectedUid === undefined) throw new Error("could not determine recovery tree owner");
  const visit = (directory: NativeHandle, name: string): void => {
    const details = guard.statHandle(directory);
    if (details.uid !== expectedUid || (details.mode & 0o022) !== 0) {
      throw new Error("recovery tree has an unsafe owner or writable mode");
    }
    records.push(`d\0${name}\0${details.mode.toString(8)}`);
    for (const entry of sortUnsignedUtf8(guard.readDir(directory))) {
      const childName = name === "." ? entry : `${name}/${entry}`;
      const child = guard.statAt(directory, entry);
      if (!child) throw new Error("recovery tree changed during descriptor enumeration");
      if (child.uid !== expectedUid || (child.mode & 0o022) !== 0) {
        throw new Error("recovery tree has an unsafe owner or writable mode");
      }
      if (child.type === "file") {
        records.push(
          `f\0${childName}\0${child.mode.toString(8)}\0${child.size}\0${guard.sha256RegularAt(directory, entry)}`,
        );
      } else if (child.type === "directory") {
        const childDirectory = guard.openDirAt(directory, entry);
        try {
          assertNativeBinding(guard, directory, entry, childDirectory, "recovery tree directory");
          visit(childDirectory, childName);
        } finally {
          guard.close(childDirectory);
        }
      } else {
        throw new Error(`recovery tree contains a forbidden ${child.type}: ${childName}`);
      }
    }
  };
  visit(root, ".");
  return sha256(records.join("\n"));
}

function nativeRegularTreeDigest(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
  details: NativeMetadata,
): string {
  if (details.type !== "file") throw new Error("recovery expected a regular file");
  return sha256(
    `f\0.\0${details.mode.toString(8)}\0${details.size}\0${guard.sha256RegularAt(parent, leaf)}`,
  );
}

function nativeTreeDigestAt(
  guard: NativeFsGuard,
  parent: NativeHandle,
  leaf: string,
): string | null {
  const details = guard.statAt(parent, leaf);
  if (!details) return null;
  if (details.type === "file") return nativeRegularTreeDigest(guard, parent, leaf, details);
  if (details.type !== "directory") throw new Error("recovery tree evidence has an unsafe type");
  const directory = guard.openDirAt(parent, leaf);
  try {
    assertNativeBinding(guard, parent, leaf, directory, "recovery evidence tree");
    return nativeTreeDigest(guard, directory);
  } finally {
    guard.close(directory);
  }
}

function assertInstallCapabilityBindings(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
  requireTransaction = true,
): void {
  const { guard } = capabilities;
  assertNativeBinding(
    guard,
    capabilities.home,
    "Applications",
    capabilities.applications,
    "Applications",
  );
  assertNativeBinding(guard, capabilities.home, ".hasna", capabilities.hasna, ".hasna");
  assertNativeBinding(
    guard,
    capabilities.hasna,
    "recordings",
    capabilities.data,
    "state root",
  );
  if (!requireTransaction) return;
  if (!capabilities.transaction || !capabilities.transactionApps || !capabilities.stateBackup) {
    throw new Error("install transition recovery capabilities are incomplete");
  }
  assertNativeBinding(
    guard,
    capabilities.applications,
    basename(journal.transaction_dir),
    capabilities.transaction,
    "transaction root",
  );
  assertNativeBinding(
    guard,
    capabilities.transaction,
    "apps",
    capabilities.transactionApps,
    "app backups",
  );
  assertNativeBinding(
    guard,
    capabilities.transaction,
    basename(journal.state_backup),
    capabilities.stateBackup,
    "state backup",
  );
}

function fsyncRetainedTree(
  guard: NativeFsGuard,
  root: NativeHandle,
  expectedUid: number,
  label: string,
): void {
  const visit = (directory: NativeHandle): void => {
    const directoryDetails = guard.statHandle(directory);
    if (
      directoryDetails.type !== "directory" ||
      directoryDetails.uid !== expectedUid ||
      (directoryDetails.mode & 0o022) !== 0 ||
      !guard.handleHasNoExtendedAcl(directory)
    ) {
      throw new Error(`${label} has an unsafe retained directory`);
    }
    for (const entry of sortUnsignedUtf8(guard.readDir(directory))) {
      const details = guard.statAt(directory, entry);
      if (!details) throw new Error(`${label} changed during retained synchronization`);
      if (details.type === "file") {
        const file = guard.openRegularAt(directory, entry, "read");
        try {
          const retained = guard.statHandle(file);
          if (
            retained.type !== "file" ||
            retained.uid !== expectedUid ||
            (retained.mode & 0o022) !== 0 ||
            !guard.handleHasNoExtendedAcl(file) ||
            !guard.sameBinding(directory, entry, file)
          ) {
            throw new Error(`${label} has an unsafe retained file`);
          }
          guard.fsyncHandle(file);
          assertNativeBinding(guard, directory, entry, file, label);
        } finally {
          guard.close(file);
        }
        continue;
      }
      if (details.type !== "directory") {
        throw new Error(`${label} contains an unsafe special entry`);
      }
      const child = guard.openDirAt(directory, entry);
      try {
        assertNativeBinding(guard, directory, entry, child, label);
        visit(child);
        assertNativeBinding(guard, directory, entry, child, label);
      } finally {
        guard.close(child);
      }
    }
    guard.fsyncHandle(directory);
  };
  visit(root);
}

function installTransitionTestPoint(
  operation: "archive-original" | "publish-candidate",
  point: "before-rename" | "after-rename" | "after-destination-fsync" | "after-source-fsync",
  detail: string,
): void {
  if (
    process.platform === "darwin" ||
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS !== "1"
  ) return;
  const token = `${operation}:${point}`;
  if (process.env.RECORDINGS_TEST_INSTALL_TRANSITION_BARRIER === token) {
    const ready = process.env.RECORDINGS_TEST_INSTALL_TRANSITION_READY_FIFO;
    const resume = process.env.RECORDINGS_TEST_INSTALL_TRANSITION_RESUME_FIFO;
    if (!ready || !resume) {
      throw new Error("install transition test barrier requires ready and resume FIFOs");
    }
    writeFileSync(ready, `${detail}\n`);
    readFileSync(resume);
  }
  if (process.env.RECORDINGS_TEST_CRASH_INSTALL_TRANSITION !== token) return;
  const installerPid = Number(process.env.RECORDINGS_TEST_INSTALLER_PID);
  if (!Number.isSafeInteger(installerPid) || installerPid <= 1 || installerPid !== process.ppid) {
    throw new Error("install transition crash hook requires the exact installer parent PID");
  }
  process.kill(installerPid, "SIGKILL");
  process.kill(process.pid, "SIGKILL");
}

export function archiveInstallOriginal(
  journalPath: string,
  sourcePath: string,
  destinationPath: string,
  expectedDigest: string,
): void {
  const journal = readJournal(journalPath);
  if (journal.schema_version !== 9 || journal.phase !== "originals-moving") {
    throw new Error("original archival requires the durable originals-moving journal");
  }
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  const original = journal.originals.find(
    (entry) => resolve(entry.path) === source && resolve(entry.backup) === destination,
  );
  if (!original || original.sha256 !== expectedDigest || !isHex(expectedDigest, 64)) {
    throw new Error("original archival does not match durable journal evidence");
  }
  if (dirname(destination) !== resolve(join(journal.transaction_dir, "apps"))) {
    throw new Error("original archival destination is outside the app-backup capability");
  }
  const capabilities = openRecoveryCapabilities(journal);
  const { guard } = capabilities;
  let retained: NativeHandle | undefined;
  try {
    assertInstallCapabilityBindings(journal, capabilities);
    const sourceCapability = originalDestinationCapability(journal, capabilities, source);
    const destinationLeaf = basename(destination);
    if (guard.statAt(capabilities.transactionApps!, destinationLeaf) !== null) {
      throw new Error("original archival destination already exists");
    }
    retained = guard.openDirAt(sourceCapability.parent, sourceCapability.leaf);
    assertNativeBinding(
      guard,
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      "original app source",
    );
    if (nativeTreeDigest(guard, retained) !== expectedDigest) {
      throw new Error("original app source does not match durable journal evidence");
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("could not determine installer owner identity");
    fsyncRetainedTree(guard, retained, uid, "original app source");
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      "original app source",
    );
    if (guard.statAt(capabilities.transactionApps!, destinationLeaf) !== null) {
      throw new Error("original archival destination appeared before publication");
    }
    installTransitionTestPoint(
      "archive-original",
      "before-rename",
      `${source}\t${destination}`,
    );
    guard.renameHandleNoReplaceAt(
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      capabilities.transactionApps!,
      destinationLeaf,
    );
    installTransitionTestPoint(
      "archive-original",
      "after-rename",
      `${source}\t${destination}`,
    );
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.transactionApps!,
      destinationLeaf,
      retained,
      "archived original app",
    );
    if (guard.statAt(sourceCapability.parent, sourceCapability.leaf) !== null) {
      throw new Error("original app source leaf was recreated during archival");
    }
    guard.fsyncHandle(capabilities.transactionApps!);
    installTransitionTestPoint(
      "archive-original",
      "after-destination-fsync",
      `${source}\t${destination}`,
    );
    guard.fsyncHandle(sourceCapability.parent);
    installTransitionTestPoint(
      "archive-original",
      "after-source-fsync",
      `${source}\t${destination}`,
    );
  } finally {
    if (retained) guard.close(retained);
    closeRecoveryCapabilities(capabilities);
  }
}

export function publishInstallCandidate(
  journalPath: string,
  stagingPath: string,
  destinationPath: string,
  expectedDigest: string,
): void {
  const journal = readJournal(journalPath);
  if (
    journal.schema_version !== 9 ||
    journal.phase !== "candidate-moving" ||
    journal.candidate_tree_sha256 !== expectedDigest ||
    resolve(journal.candidate_staging ?? "") !== resolve(dirname(stagingPath)) ||
    !isHex(expectedDigest, 64)
  ) {
    throw new Error("candidate publication does not match durable journal evidence");
  }
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const stagingParentPath = dirname(staging);
  const stagingParentLeaf = basename(stagingParentPath);
  if (
    destination !== resolve(journal.app_destination) ||
    basename(staging) !== "Recordings.app" ||
    dirname(stagingParentPath) !== resolve(journal.app_parent) ||
    !/^\.Recordings-install\.[A-Za-z0-9]+$/.test(stagingParentLeaf)
  ) {
    throw new Error("candidate publication paths are outside canonical installer capabilities");
  }
  const capabilities = openRecoveryCapabilities(journal);
  const { guard } = capabilities;
  let stagingParent: NativeHandle | undefined;
  let retained: NativeHandle | undefined;
  try {
    assertInstallCapabilityBindings(journal, capabilities);
    stagingParent = guard.openDirAt(capabilities.applications, stagingParentLeaf);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("could not determine installer owner identity");
    assertSecurePublicationDirectory(guard, stagingParent, uid, "candidate staging parent");
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingParentLeaf,
      stagingParent,
      "candidate staging parent",
    );
    retained = guard.openDirAt(stagingParent, "Recordings.app");
    assertNativeBinding(guard, stagingParent, "Recordings.app", retained, "staged candidate");
    if (nativeTreeDigest(guard, retained) !== expectedDigest) {
      throw new Error("staged candidate does not match durable journal evidence");
    }
    if (guard.statAt(capabilities.applications, "Recordings.app") !== null) {
      throw new Error("candidate destination already exists");
    }
    fsyncRetainedTree(guard, retained, uid, "staged candidate");
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingParentLeaf,
      stagingParent,
      "candidate staging parent",
    );
    assertNativeBinding(guard, stagingParent, "Recordings.app", retained, "staged candidate");
    if (guard.statAt(capabilities.applications, "Recordings.app") !== null) {
      throw new Error("candidate destination appeared before publication");
    }
    installTransitionTestPoint(
      "publish-candidate",
      "before-rename",
      `${staging}\t${destination}`,
    );
    guard.renameHandleNoReplaceAt(
      stagingParent,
      "Recordings.app",
      retained,
      capabilities.applications,
      "Recordings.app",
    );
    installTransitionTestPoint(
      "publish-candidate",
      "after-rename",
      `${staging}\t${destination}`,
    );
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.applications,
      "Recordings.app",
      retained,
      "published candidate",
    );
    if (guard.statAt(stagingParent, "Recordings.app") !== null) {
      throw new Error("candidate staging leaf was recreated during publication");
    }
    guard.fsyncHandle(capabilities.applications);
    installTransitionTestPoint(
      "publish-candidate",
      "after-destination-fsync",
      `${staging}\t${destination}`,
    );
    guard.fsyncHandle(stagingParent);
    installTransitionTestPoint(
      "publish-candidate",
      "after-source-fsync",
      `${staging}\t${destination}`,
    );
  } finally {
    if (retained) guard.close(retained);
    if (stagingParent) guard.close(stagingParent);
    closeRecoveryCapabilities(capabilities);
  }
}

function cleanupInstallCandidateStaging(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  if (!journal.candidate_staging) return;
  const { guard } = capabilities;
  const stagingLeaf = basename(journal.candidate_staging);
  const metadata = guard.statAt(capabilities.applications, stagingLeaf);
  if (metadata === null) return;
  if (metadata.type !== "directory") {
    throw new Error("candidate staging root has an unsafe type");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine installer owner identity");
  const staging = guard.openDirAt(capabilities.applications, stagingLeaf);
  try {
    assertSecurePublicationDirectory(guard, staging, uid, "candidate staging root");
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingLeaf,
      staging,
      "candidate staging root",
    );
    const candidateMetadata = guard.statAt(staging, "Recordings.app");
    if (candidateMetadata !== null) {
      if (journal.schema_version !== 9 || !journal.candidate_tree_sha256) {
        throw new Error("legacy journal cannot authenticate candidate staging cleanup");
      }
      const candidate = openProvenDirectoryAt(
        guard,
        staging,
        "Recordings.app",
        journal.candidate_tree_sha256,
        "staged candidate",
      );
      try {
        quarantineRemoveRetainedAt(
          guard,
          staging,
          "Recordings.app",
          candidate,
          "staged candidate",
        );
      } finally {
        guard.close(candidate);
      }
    }
    if (guard.readDir(staging).length !== 0) {
      throw new Error("candidate staging root contains unauthenticated recovery evidence");
    }
    assertInstallCapabilityBindings(journal, capabilities, false);
    quarantineRemoveRetainedAt(
      guard,
      capabilities.applications,
      stagingLeaf,
      staging,
      "candidate staging root",
    );
  } finally {
    guard.close(staging);
  }
}

function copyNativeDirectoryTree(
  guard: NativeFsGuard,
  source: NativeHandle,
  destinationParent: NativeHandle,
  destinationLeaf: string,
): NativeHandle {
  const sourceRoot = guard.statHandle(source);
  if (sourceRoot.type !== "directory") throw new Error("app backup is not a directory");
  const destination = guard.mkdirAt(destinationParent, destinationLeaf, sourceRoot.mode);
  const copyContents = (sourceDirectory: NativeHandle, destinationDirectory: NativeHandle): void => {
    for (const entry of sortUnsignedUtf8(guard.readDir(sourceDirectory))) {
      const details = guard.statAt(sourceDirectory, entry);
      if (!details) throw new Error("app backup changed during retained copy");
      if (details.type === "file") {
        guard.copyRegularNoReplaceAt(
          sourceDirectory,
          entry,
          destinationDirectory,
          entry,
          `.${entry}.recordings-app-copy.${randomUUID()}.tmp`,
          false,
          false,
        );
        continue;
      }
      if (details.type !== "directory") {
        throw new Error("app backup contains an unsafe special entry");
      }
      const sourceChild = guard.openDirAt(sourceDirectory, entry);
      const destinationChild = guard.mkdirAt(destinationDirectory, entry, details.mode);
      try {
        assertNativeBinding(guard, sourceDirectory, entry, sourceChild, "app backup child");
        copyContents(sourceChild, destinationChild);
        guard.fsyncHandle(destinationChild);
      } finally {
        guard.close(destinationChild);
        guard.close(sourceChild);
      }
    }
    guard.fsyncHandle(destinationDirectory);
  };
  try {
    copyContents(source, destination);
    guard.fsyncHandle(destinationParent);
    return destination;
  } catch (error) {
    try {
      quarantineRemoveRetainedAt(
        guard,
        destinationParent,
        destinationLeaf,
        destination,
        "failed retained app staging tree",
      );
    } finally {
      guard.close(destination);
    }
    throw error;
  }
}

function originalDestinationCapability(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
  path: string,
): { parent: NativeHandle; leaf: string } {
  const resolved = resolve(path);
  if (resolved === resolve(journal.app_destination)) {
    return { parent: capabilities.applications, leaf: "Recordings.app" };
  }
  if (resolved === resolve(join(journal.data_dir, "Recordings.app"))) {
    return { parent: capabilities.data, leaf: "Recordings.app" };
  }
  if (
    dirname(resolved) === resolve(journal.app_parent) &&
    /^Recordings\.app\.[A-Za-z0-9._-]+$/.test(basename(resolved))
  ) {
    return { parent: capabilities.applications, leaf: basename(resolved) };
  }
  throw new Error("install transaction journal has an unsafe original app destination");
}

const PRESERVED_DATABASE_ENTRIES = new Set([
  "recordings.db",
  "recordings.db-wal",
  "recordings.db-shm",
]);

function assertInstallerOwnedStateEvidenceNative(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  const { guard, data, stateBackup } = capabilities;
  if (!stateBackup) throw new Error("state recovery capability is unavailable");
  for (const entry of PRESERVED_DATABASE_ENTRIES) {
    const details = guard.statAt(data, entry);
    if (details !== null && details.type !== "file") {
      throw new Error("state recovery found an unsafe canonical database entry");
    }
  }
  const rollbackEntries = journal.installer_owned_state ?? [];
  if (rollbackEntries.length === 0) return;
  const backupRollbacksMetadata = guard.statAt(stateBackup, "rollbacks");
  if (backupRollbacksMetadata?.type === "directory") {
    const backupRollbacks = guard.openDirAt(stateBackup, "rollbacks");
    try {
      for (const entry of rollbackEntries) {
        if (guard.statAt(backupRollbacks, basename(entry.path)) !== null) {
          throw new Error("installer-owned state path already existed in the stopped snapshot");
        }
      }
    } finally {
      guard.close(backupRollbacks);
    }
  } else if (backupRollbacksMetadata !== null) {
    throw new Error("state backup contains an unsafe rollback path");
  }
  const liveRollbacksMetadata = guard.statAt(data, "rollbacks");
  if (liveRollbacksMetadata === null && journal.phase === "state-restored") return;
  if (liveRollbacksMetadata?.type !== "directory") {
    throw new Error("installer-owned state rollback parent is missing or unsafe");
  }
  const rollbacks = guard.openDirAt(data, "rollbacks");
  try {
    assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
    for (const entry of rollbackEntries) {
      if (resolve(dirname(entry.path)) !== resolve(join(journal.data_dir, "rollbacks"))) {
        throw new Error("installer-owned state path is outside the rollback capability");
      }
      const leaf = basename(entry.path);
      const details = guard.statAt(rollbacks, leaf);
      if (!details && journal.phase === "state-restored") continue;
      if (!details || nativeRegularTreeDigest(guard, rollbacks, leaf, details) !== entry.sha256) {
        throw new Error("installer-owned state artifact changed before rollback");
      }
    }
  } finally {
    guard.close(rollbacks);
  }
}

function removeInstallerOwnedStateArchivesNative(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  const { guard, data } = capabilities;
  const rollbackEntries = journal.installer_owned_state ?? [];
  if (rollbackEntries.length === 0) return;
  const rollbackParent = guard.statAt(data, "rollbacks");
  if (rollbackParent === null) return;
  if (rollbackParent.type !== "directory") {
    throw new Error("installer-owned state rollback parent is unsafe");
  }
  const rollbacks = guard.openDirAt(data, "rollbacks");
  let removedParent = false;
  try {
    assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
    for (const entry of rollbackEntries) {
      if (resolve(dirname(entry.path)) !== resolve(join(journal.data_dir, "rollbacks"))) {
        throw new Error("installer-owned state path is outside the rollback capability");
      }
      const leaf = basename(entry.path);
      const details = guard.statAt(rollbacks, leaf);
      if (!details) continue;
      if (details.type !== "file") {
        throw new Error("installer-owned state artifact changed before rollback");
      }
      const archive = openProvenRegularAt(
        guard,
        rollbacks,
        leaf,
        entry.sha256,
        "installer-owned state artifact",
      );
      recoveryTestBarrier("before-archive-unlink", leaf);
      try {
        assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
        quarantineRemoveRetainedAt(
          guard,
          rollbacks,
          leaf,
          archive,
          "installer-owned state artifact",
        );
      } finally {
        guard.close(archive);
      }
    }
    if (
      capabilities.stateBackup &&
      guard.statAt(capabilities.stateBackup, "rollbacks") === null &&
      guard.readDir(rollbacks).length === 0
    ) {
      quarantineRemoveRetainedAt(
        guard,
        data,
        "rollbacks",
        rollbacks,
        "empty installer rollback directory",
      );
      removedParent = true;
    }
  } finally {
    guard.close(rollbacks);
  }
  if (!removedParent) guard.fsyncHandle(data);
}

function restoreStatePreservingDatabase(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  if (journal.non_database_rollback !== "preserve-safe-live-writes") {
    throw new Error("legacy destructive state restore is disabled");
  }
  const { guard, data, stateBackup } = capabilities;
  if (!stateBackup) throw new Error("state recovery capability is unavailable");
  const recoveryScope = sha256(
    `${resolve(journal.state_backup)}\0${resolve(journal.data_dir)}`,
  ).slice(0, 16);
  const hooksEnabled = process.platform !== "darwin" &&
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1";

  const isRecoveryTemporary = (entry: string, destinationLeaf: string): boolean => {
    const prefix = `.${destinationLeaf}.recordings-recovery.${recoveryScope}.`;
    return entry.startsWith(prefix) && entry.endsWith(".tmp") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(entry.slice(prefix.length, -4));
  };
  const removeRecoveryTemporaries = (directory: NativeHandle, destinationLeaf: string): void => {
    let removed = false;
    for (const entry of guard.readDir(directory)) {
      if (!isRecoveryTemporary(entry, destinationLeaf)) continue;
      const details = guard.statAt(directory, entry);
      if (!details || details.type !== "file" || details.uid !== process.getuid?.()) {
        throw new Error("state recovery found an unsafe recovery temporary");
      }
      const temporary = openProvenRegularAt(
        guard,
        directory,
        entry,
        nativeRegularTreeDigest(guard, directory, entry, details),
        "state recovery temporary",
      );
      try {
        quarantineRemoveRetainedAt(
          guard,
          directory,
          entry,
          temporary,
          "state recovery temporary",
        );
      } finally {
        guard.close(temporary);
      }
      removed = true;
    }
    if (removed) guard.fsyncHandle(directory);
  };

  const restoreMissingEntries = (
    backupDirectory: NativeHandle,
    liveDirectory: NativeHandle,
    relativeDirectory: string,
    liveBindings: Array<{ parent: NativeHandle; leaf: string; child: NativeHandle }> = [],
  ): void => {
    assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
    for (const entry of sortUnsignedUtf8(guard.readDir(backupDirectory))) {
      if (!relativeDirectory && PRESERVED_DATABASE_ENTRIES.has(entry)) continue;
      const source = guard.statAt(backupDirectory, entry);
      if (!source) throw new Error("state backup changed during recovery");
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const destination = guard.statAt(liveDirectory, entry);
      if (source.type === "file") {
        removeRecoveryTemporaries(liveDirectory, entry);
        if (destination !== null) continue;
        recoveryTestBarrier("before-file-publish", relativePath);
        assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        for (const binding of liveBindings) {
          assertNativeBinding(
            guard,
            binding.parent,
            binding.leaf,
            binding.child,
            "live state ancestor",
          );
        }
        if (
          hooksEnabled &&
          process.env.RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH === relativePath
        ) {
          const ready = process.env.RECORDINGS_TEST_RECOVERY_PUBLISH_READY_FIFO;
          const resume = process.env.RECORDINGS_TEST_RECOVERY_PUBLISH_RESUME_FIFO;
          if (!ready || !resume) {
            throw new Error("recovery publish test barrier requires ready and resume FIFOs");
          }
          writeFileSync(ready, `${relativePath}\n`);
          readFileSync(resume);
          assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        }
        const temporary = `.${entry}.recordings-recovery.${recoveryScope}.${randomUUID()}.tmp`;
        guard.copyRegularNoReplaceAt(
          backupDirectory,
          entry,
          liveDirectory,
          entry,
          temporary,
          hooksEnabled &&
            process.env.RECORDINGS_TEST_CRASH_RECOVERY_DURING_FILE_COPY === relativePath,
          hooksEnabled &&
            process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_FILE_PUBLISH === relativePath,
        );
        continue;
      }
      if (source.type !== "directory") {
        throw new Error(`state recovery refuses special backup entry: ${relativePath}`);
      }
      if (destination !== null && destination.type !== "directory") continue;
      let liveChild: NativeHandle;
      if (destination === null) {
        liveChild = guard.mkdirAt(liveDirectory, entry, source.mode & 0o777);
        guard.fsyncHandle(liveChild);
        guard.fsyncHandle(liveDirectory);
      } else {
        recoveryTestBarrier("before-nested-open", relativePath);
        liveChild = guard.openDirAt(liveDirectory, entry);
      }
      const backupChild = guard.openDirAt(backupDirectory, entry);
      try {
        assertNativeBinding(guard, backupDirectory, entry, backupChild, "state backup directory");
        assertNativeBinding(guard, liveDirectory, entry, liveChild, "live state directory");
        restoreMissingEntries(
          backupChild,
          liveChild,
          relativePath,
          [...liveBindings, { parent: liveDirectory, leaf: entry, child: liveChild }],
        );
      } finally {
        guard.close(backupChild);
        guard.close(liveChild);
      }
    }
  };
  restoreMissingEntries(stateBackup, data, "");

  for (const entry of ["audio", "rollbacks"]) {
    if (guard.statAt(stateBackup, entry) !== null) continue;
    const live = guard.statAt(data, entry);
    if (!live || live.type !== "directory") continue;
    const directory = guard.openDirAt(data, entry);
    try {
      assertNativeBinding(guard, data, entry, directory, "installer-created state directory");
      if (guard.readDir(directory).length === 0) {
        quarantineRemoveRetainedAt(
          guard,
          data,
          entry,
          directory,
          "empty installer-created state directory",
        );
        continue;
      }
    } finally {
      try {
        guard.close(directory);
      } catch {
        // The empty-directory path closes before unlinking.
      }
    }
  }
  guard.fsyncHandle(data);
}

function recoverJournal(path: string): void {
  const journal = readJournal(path);
  const mutationPhases = new Set([
    "processes-stopped",
    "state-mutating",
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
    "state-restored",
  ]);
  const cleanupOnly = journal.phase === "committed" || journal.phase === "rollback-complete";
  if (mutationPhases.has(journal.phase) &&
    journal.database_rollback !== "preserve-canonical-inode") {
    throw new Error(
      "legacy install transaction cannot safely restore state without replacing the canonical database",
    );
  }
  if (mutationPhases.has(journal.phase) &&
    journal.non_database_rollback !== "preserve-safe-live-writes") {
    throw new Error(
      "legacy install transaction cannot safely merge post-snapshot non-database writes",
    );
  }
  const capabilities = openRecoveryCapabilities(journal, cleanupOnly);
  const { guard, applications } = capabilities;
  const transactionLeaf = basename(journal.transaction_dir);
  const originalBackupHandles = new Map<string, NativeHandle>();
  try {
    if (cleanupOnly) {
      cleanupInstallCandidateStaging(journal, capabilities);
      if (guard.statAt(applications, transactionLeaf) !== null) {
        if (!capabilities.transaction) {
          throw new Error("install transaction cleanup capability is missing");
        }
        recoveryTestBarrier("before-transaction-cleanup", transactionLeaf);
        assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        assertNativeBinding(
          guard,
          applications,
          transactionLeaf,
          capabilities.transaction,
          "transaction root",
        );
        quarantineRemoveRetainedAt(
          guard,
          applications,
          transactionLeaf,
          capabilities.transaction,
          "transaction root",
        );
        guard.close(capabilities.transaction);
        capabilities.transaction = undefined;
      }
      recoveryTestBarrier("after-transaction-remove", transactionLeaf);
      if (guard.statAt(applications, INSTALL_JOURNAL_LEAF) !== null) {
        if (journal.schema_version !== 9) {
          throw new Error("legacy cleanup journal lacks retained deletion evidence");
        }
        const journalDetails = guard.statAt(applications, INSTALL_JOURNAL_LEAF);
        if (!journalDetails || journalDetails.type !== "file") {
          throw new Error("cleanup journal has an unsafe type");
        }
        const journalDigest = sha256(
          `f\0.\0${journalDetails.mode.toString(8)}\0${journalDetails.size}\0${sha256(`${JSON.stringify(journal)}\n`)}`,
        );
        const retainedJournal = openProvenRegularAt(
          guard,
          applications,
          INSTALL_JOURNAL_LEAF,
          journalDigest,
          "cleanup journal",
        );
        try {
          quarantineRemoveRetainedAt(
            guard,
            applications,
            INSTALL_JOURNAL_LEAF,
            retainedJournal,
            "cleanup journal",
          );
        } finally {
          guard.close(retainedJournal);
        }
      }
      return;
    }
    if (!capabilities.transaction || !capabilities.transactionApps || !capabilities.stateBackup) {
      throw new Error("install transaction recovery evidence is missing");
    }
    if (nativeTreeDigest(guard, capabilities.stateBackup) !== journal.state_backup_sha256) {
      throw new Error("install transaction state backup integrity check failed");
    }
    cleanupInstallCandidateStaging(journal, capabilities);
    for (const entry of journal.originals) {
      if (resolve(dirname(entry.backup)) !== resolve(join(journal.transaction_dir, "apps"))) {
        throw new Error("install transaction app backup path is outside the app-backup capability");
      }
      const backupLeaf = basename(entry.backup);
      const backupDetails = guard.statAt(capabilities.transactionApps, backupLeaf);
      if (backupDetails !== null) {
        if (backupDetails.type !== "directory") {
          throw new Error("install transaction app backup has an unsafe type");
        }
        const backup = guard.openDirAt(capabilities.transactionApps, backupLeaf);
        assertNativeBinding(
          guard,
          capabilities.transactionApps,
          backupLeaf,
          backup,
          "app backup",
        );
        const backupDigest = nativeTreeDigest(guard, backup);
        if (backupDigest !== entry.sha256) {
          guard.close(backup);
          throw new Error("install transaction app backup integrity check failed");
        }
        originalBackupHandles.set(backupLeaf, backup);
        continue;
      }
      const destination = originalDestinationCapability(journal, capabilities, entry.path);
      if (nativeTreeDigestAt(guard, destination.parent, destination.leaf) !== entry.sha256) {
        throw new Error("install transaction app backup is missing");
      }
    }
    if (mutationPhases.has(journal.phase)) {
      assertInstallerOwnedStateEvidenceNative(journal, capabilities);
      const canonicalOriginal = journal.originals.find(
        (entry) => resolve(entry.path) === resolve(journal.app_destination),
      );
      const canonicalDestinationDigest = canonicalOriginal
        ? nativeTreeDigestAt(guard, applications, "Recordings.app")
        : null;
      const canonicalAlreadyRestored = canonicalOriginal !== undefined &&
        canonicalDestinationDigest === canonicalOriginal.sha256;
      if (
        ["candidate-moving", "candidate-installed", "activated", "launching"].includes(journal.phase) &&
        !canonicalAlreadyRestored && guard.statAt(applications, "Recordings.app") !== null
      ) {
        if (journal.schema_version !== 9 || !journal.candidate_tree_sha256) {
          throw new Error("legacy recovery journal cannot prove the uncommitted candidate tree");
        }
        recoveryTestBarrier("before-candidate-remove", "Recordings.app");
        assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        const candidate = openProvenDirectoryAt(
          guard,
          applications,
          "Recordings.app",
          journal.candidate_tree_sha256,
          "uncommitted candidate",
        );
        try {
          quarantineRemoveRetainedAt(
            guard,
            applications,
            "Recordings.app",
            candidate,
            "uncommitted candidate",
          );
        } finally {
          guard.close(candidate);
        }
      }
      let restoredCount = 0;
      for (const entry of [...journal.originals].reverse()) {
        const backupLeaf = basename(entry.backup);
        const destination = originalDestinationCapability(journal, capabilities, entry.path);
        if (nativeTreeDigestAt(guard, destination.parent, destination.leaf) === entry.sha256) {
          continue;
        }
        const backup = originalBackupHandles.get(backupLeaf);
        if (!backup) throw new Error("install transaction app backup is missing");
        if (guard.statAt(destination.parent, destination.leaf) !== null) {
          throw new Error("original app destination contains an unproven concurrent replacement");
        }
        const restoredLeaf = `.Recordings-app-restore.${randomUUID()}`;
        const restored = copyNativeDirectoryTree(
          guard,
          backup,
          capabilities.transactionApps,
          restoredLeaf,
        );
        if (nativeTreeDigest(guard, restored) !== entry.sha256) {
          quarantineRemoveRetainedAt(
            guard,
            capabilities.transactionApps,
            restoredLeaf,
            restored,
            "failed restored app staging tree",
          );
          guard.close(restored);
          throw new Error("retained app backup copy failed integrity verification");
        }
        recoveryTestBarrier("before-app-publish", destination.leaf);
        assertNativeBinding(
          guard,
          capabilities.transaction!,
          "apps",
          capabilities.transactionApps,
          "app backups",
        );
        assertNativeBinding(guard, capabilities.transactionApps, backupLeaf, backup, "app backup");
        assertNativeBinding(
          guard,
          capabilities.transactionApps,
          restoredLeaf,
          restored,
          "restored app staging tree",
        );
        if (destination.parent === applications) {
          assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        } else {
          assertNativeBinding(guard, capabilities.hasna, "recordings", capabilities.data, "state root");
        }
        guard.renameHandleNoReplaceAt(
          capabilities.transactionApps,
          restoredLeaf,
          restored,
          destination.parent,
          destination.leaf,
        );
        guard.close(restored);
        guard.fsyncHandle(capabilities.transactionApps);
        guard.fsyncHandle(destination.parent);
        restoredCount += 1;
        if (
          process.platform !== "darwin" &&
          process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
          process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_APP_RESTORES === String(restoredCount)
        ) {
          process.kill(process.pid, "SIGKILL");
        }
      }
      restoreStatePreservingDatabase(journal, capabilities);
    }
    const stateMode = journal.original_state_mode ?? "700";
    const stateDetails = guard.statHandle(capabilities.data);
    if (!new Set([0o700, Number.parseInt(stateMode, 8)]).has(stateDetails.mode)) {
      throw new Error("state recovery found an unexpected state-root mode");
    }
    guard.chmodHandle(capabilities.data, Number.parseInt(stateMode, 8));
    guard.fsyncHandle(capabilities.hasna);

    const stateRestoredJournal: InstallJournal = {
      ...journal,
      schema_version: journal.schema_version === 9 ? 9 : 8,
      phase: "state-restored",
    };
    writeDurableJournalAt(guard, applications, INSTALL_JOURNAL_LEAF, stateRestoredJournal);
    if (
      process.platform !== "darwin" &&
      process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
      process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_STATE_RESTORED_JOURNAL === "1"
    ) {
      process.kill(process.pid, "SIGKILL");
    }
    removeInstallerOwnedStateArchivesNative(stateRestoredJournal, capabilities);
    if (
      process.platform !== "darwin" &&
      process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
      process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_ARCHIVE_UNLINK === "1"
    ) {
      process.kill(process.pid, "SIGKILL");
    }

    const completedJournal: InstallJournal = {
      ...stateRestoredJournal,
      schema_version: stateRestoredJournal.schema_version === 9 ? 9 : 8,
      phase: "rollback-complete",
    };
    writeDurableJournalAt(guard, applications, INSTALL_JOURNAL_LEAF, completedJournal);

    guard.close(capabilities.stateBackup);
    capabilities.stateBackup = undefined;
    guard.close(capabilities.transactionApps);
    capabilities.transactionApps = undefined;
    recoveryTestBarrier("before-transaction-cleanup", transactionLeaf);
    assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
    quarantineRemoveRetainedAt(
      guard,
      applications,
      transactionLeaf,
      capabilities.transaction,
      "transaction root",
    );
    guard.close(capabilities.transaction);
    capabilities.transaction = undefined;
    recoveryTestBarrier("after-transaction-remove", transactionLeaf);
    const completedJournalDetails = guard.statAt(applications, INSTALL_JOURNAL_LEAF);
    if (!completedJournalDetails || completedJournalDetails.type !== "file") {
      throw new Error("completed cleanup journal has an unsafe type");
    }
    const completedJournalTreeDigest = sha256(
      `f\0.\0${completedJournalDetails.mode.toString(8)}\0${completedJournalDetails.size}\0${sha256(`${JSON.stringify(completedJournal)}\n`)}`,
    );
    const retainedCompletedJournal = openProvenRegularAt(
      guard,
      applications,
      INSTALL_JOURNAL_LEAF,
      completedJournalTreeDigest,
      "completed cleanup journal",
    );
    try {
      quarantineRemoveRetainedAt(
        guard,
        applications,
        INSTALL_JOURNAL_LEAF,
        retainedCompletedJournal,
        "completed cleanup journal",
      );
    } finally {
      guard.close(retainedCompletedJournal);
    }
  } finally {
    for (const backup of originalBackupHandles.values()) {
      try {
        guard.close(backup);
      } catch {
        // A retained backup can already be closed only during exceptional cleanup.
      }
    }
    closeRecoveryCapabilities(capabilities);
  }
}

function cleanupPreJournalTransaction(path: string, nonce: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error("pre-journal transaction nonce is invalid");
  }
  const transaction = resolve(path);
  const applicationsPath = dirname(transaction);
  const homePath = dirname(applicationsPath);
  const leaf = basename(transaction);
  if (basename(applicationsPath) !== "Applications" ||
    !/^\.Recordings-transaction\.[A-Za-z0-9._-]+$/.test(leaf)) {
    throw new Error("pre-journal transaction path is outside canonical Applications");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine transaction owner identity");
  const guard = nativeFsGuard();
  const home = guard.openTrustedHome(homePath, uid);
  let applications: NativeHandle | undefined;
  let retained: NativeHandle | undefined;
  try {
    applications = guard.openDirAt(home, "Applications");
    assertNativeBinding(guard, home, "Applications", applications, "Applications");
    retained = guard.openDirAt(applications, leaf);
    assertNativeBinding(guard, applications, leaf, retained, "pre-journal transaction");
    const details = guard.statHandle(retained);
    if (details.uid !== uid || details.mode !== 0o700) {
      throw new Error(
        `pre-journal transaction has an unsafe owner or mode (uid=${details.uid}, mode=${details.mode.toString(8)})`,
      );
    }
    const proof = guard.readRegularAt(retained, ".Recordings-transaction-owner", 128);
    if (proof.toString("utf8") !== `${nonce}\n`) {
      throw new Error("pre-journal transaction ownership evidence does not match");
    }
    quarantineRemoveRetainedAt(
      guard,
      applications,
      leaf,
      retained,
      "pre-journal transaction",
    );
  } finally {
    if (retained) guard.close(retained);
    if (applications) guard.close(applications);
    guard.close(home);
  }
}

function journalGet(path: string, field: string): void {
  const journal = readJournal(path);
  if (field === "json") console.log(JSON.stringify(journal));
  else if (field === "phase") console.log(journal.phase);
  else if (field === "transaction_dir") console.log(journal.transaction_dir);
  else if (field === "state_backup") console.log(journal.state_backup);
  else if (field === "was_running") console.log(journal.was_running ? "1" : "0");
  else if (field === "prior_running_app_paths") {
    console.log(JSON.stringify(journal.prior_running_app_paths ?? []));
  }
  else throw new Error(`unsupported journal field: ${field}`);
}

function manifestGet(path: string, expectedManifestSha256: string, field: string): void {
  const manifest = readAuthenticatedManifest<MacOSArtifactManifest>(
    path,
    expectedManifestSha256,
  );
  assertManifestShape(manifest);
  if (field === "minimum_macos") console.log(manifest.minimum_macos);
  else if (field === "architectures") console.log(manifest.architectures.join(" "));
  else if (field === "version") console.log(manifest.bundle_version);
  else if (field === "source") console.log(manifest.git_sha);
  else if (field === "identity") console.log(manifest.signing.designated_requirement_sha256);
  else if (field === "artifact_policy") console.log(manifest.artifact_policy);
  else if (field === "approved_target") console.log(manifest.approved_target);
  else if (field === "approved_target_identity_kind") {
    console.log(manifestTargetIdentityKind(manifest));
  }
  else if (field === "approved_target_identity_sha256") console.log(manifest.approved_target_identity_sha256);
  else if (field === "builder_identity_kind") console.log(manifestBuilderIdentityKind(manifest));
  else throw new Error(`unsupported manifest field: ${field}`);
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function repeatedArguments(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] !== name) continue;
    const value = Bun.argv[index + 1];
    if (!value) throw new Error(`missing value for repeated argument ${name}`);
    values.push(value);
  }
  return values;
}

function artifactPolicyArgument(): ArtifactPolicy {
  const value = argument("--artifact-policy");
  if (value !== "release" && value !== "local_only") {
    throw new Error("artifact policy must be release or local_only");
  }
  return value;
}

function targetIdentityKindArgument(
  policy?: ArtifactPolicy,
  required = false,
): OperatorTargetIdentityKind {
  const index = Bun.argv.indexOf("--approved-target-identity-kind");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) {
    if (required) throw new Error("missing required argument --approved-target-identity-kind");
    return policy === "release" ? "none" : LEGACY_LOCAL_TARGET_IDENTITY_KIND;
  }
  if (value !== "none" && !isTargetIdentityKind(value)) {
    throw new Error("unsupported approved target identity kind");
  }
  return value;
}

function builderIdentityKindArgument(policy: ArtifactPolicy): OperatorTargetIdentityKind {
  const index = Bun.argv.indexOf("--builder-identity-kind");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) {
    if (policy === "local_only") {
      throw new Error("missing required argument --builder-identity-kind");
    }
    return "none";
  }
  if (value !== "none" && !isTargetIdentityKind(value)) {
    throw new Error("unsupported builder identity kind");
  }
  return value;
}

function main(): void {
  const command = Bun.argv[2];
  if (command === "verify" && Bun.argv.includes("--archive-fd")) {
    verifyAndExtractArchiveDescriptors(
      Number(argument("--archive-fd")),
      Number(argument("--output-dir-fd")),
      argument("--expected-sha256"),
    );
  } else if (command === "provenance") {
    const sourceSha = argument("--source-sha");
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    writeProvenance(
      argument("--app"),
      teamId,
      argument("--package-root"),
      sourceSha,
      policy,
      argument("--approved-target"),
      targetIdentityKindArgument(policy),
      argument("--approved-target-identity-sha256"),
      builderIdentityKindArgument(policy),
      argument("--builder-identity-sha256"),
    );
  } else if (command === "finalize") {
    const sourceSha = argument("--source-sha");
    const teamId = argument("--team-id");
    finalizeArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      optionalArgument("--package-root") ?? process.cwd(),
      sourceSha,
      teamId,
      argument("--notary-log"),
      argument("--notary-submission-id"),
      argument("--submitted-archive-sha256"),
    );
  } else if (command === "finalize-local") {
    const sourceSha = argument("--source-sha");
    finalizeLocalArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      optionalArgument("--package-root") ?? process.cwd(),
      sourceSha,
      argument("--approved-target"),
      targetIdentityKindArgument(undefined, true),
      argument("--approved-target-identity-sha256"),
    );
  } else if (command === "verify-archive") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyArchiveManifest(
      argument("--archive"),
      argument("--manifest"),
      teamId,
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "extract-verified-archive") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    extractVerifiedArchiveToStaging(
      argument("--archive"),
      argument("--manifest"),
      argument("--staging-target"),
      teamId,
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "verify-app") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyExtractedApp(
      argument("--app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
      teamId,
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "verify-active") {
    const teamId = argument("--team-id");
    const policy = artifactPolicyArgument();
    verifyActiveApp(
      argument("--app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
      teamId,
      policy,
      argument("--approved-target"),
      argument("--approved-target-identity-sha256"),
      targetIdentityKindArgument(policy),
    );
  } else if (command === "assert-release") {
    assertExpectedRelease(
      argument("--manifest"),
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
    );
  } else if (command === "assert-transition") {
    assertInstallTransition(
      argument("--existing-app"),
      argument("--manifest"),
      argument("--manifest-sha256"),
    );
  } else if (command === "requirement-digest") {
    requirementDigest(argument("--app"), artifactPolicyArgument());
  } else if (command === "tailscale-node-id-sha256") {
    console.log(tailscaleNodeIdSha256(readFileSync(0, "utf8"), argument("--expected-hostname")));
  } else if (command === "verify-filesystem-tree") {
    assertFilesystemTree(argument("--path"), Number(argument("--uid")));
  } else if (command === "fsync-tree") {
    fsyncTree(argument("--path"));
  } else if (command === "fsync-directory") {
    fsyncDirectory(argument("--path"));
  } else if (command === "publish-release-directory") {
    publishReleaseDirectory(
      argument("--staging"),
      argument("--destination"),
    );
  } else if (command === "release-publication-identity") {
    console.log(releasePublicationIdentity(repeatedArguments("--component")));
  } else if (command === "snapshot-regular-file") {
    const expectedBytes = optionalArgument("--expected-bytes");
    console.log(snapshotRegularFile(
      argument("--source"),
      argument("--destination"),
      Number(argument("--maximum-bytes")),
      expectedBytes === undefined ? undefined : Number(expectedBytes),
    ));
  } else if (command === "prepare-release-publication") {
    prepareReleasePublication(
      argument("--staging"),
      argument("--destination"),
      argument("--reservation"),
      repeatedArguments("--alias"),
      argument("--publication-identity-sha256"),
      repeatedArguments("--nested-publication"),
    );
  } else if (command === "complete-release-publication") {
    completeReleasePublication(
      argument("--destination"),
      argument("--reservation"),
      argument("--output-root"),
      argument("--publication-identity-sha256"),
    );
  } else if (command === "assert-release-publication-complete") {
    assertReleasePublicationComplete(
      argument("--destination"),
      argument("--output-root"),
      argument("--publication-identity-sha256"),
    );
  } else if (command === "assert-notary-log") {
    assertAcceptedNotaryLog(
      readJson<unknown>(argument("--notary-log")),
      argument("--submission-id"),
      argument("--submitted-archive-sha256"),
    );
  } else if (command === "tree-digest") {
    console.log(treeDigest(argument("--path")));
  } else if (command === "native-fs-guard-check") {
    nativeFsGuard();
  } else if (command === "journal-write") {
    writeDurableJournal(argument("--journal"), journalArgument());
  } else if (command === "journal-get") {
    journalGet(argument("--journal"), argument("--field"));
  } else if (command === "journal-recover") {
    recoverJournal(argument("--journal"));
  } else if (command === "transaction-cleanup") {
    cleanupPreJournalTransaction(
      argument("--transaction-dir"),
      argument("--nonce"),
    );
  } else if (command === "state-mode-harden") {
    transitionStateMode(
      argument("--path"),
      Number(argument("--uid")),
      "700",
      new Set(["755"]),
    );
  } else if (command === "install-archive-original") {
    archiveInstallOriginal(
      argument("--journal"),
      argument("--source"),
      argument("--destination"),
      argument("--expected-tree-sha256"),
    );
  } else if (command === "install-publish-candidate") {
    publishInstallCandidate(
      argument("--journal"),
      argument("--staging"),
      argument("--destination"),
      argument("--expected-tree-sha256"),
    );
  } else if (command === "manifest-get") {
    manifestGet(
      argument("--manifest"),
      argument("--manifest-sha256"),
      argument("--field"),
    );
  } else {
    throw new Error(`unknown command: ${command ?? "missing"}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
