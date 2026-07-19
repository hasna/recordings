import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const LOWER_SOURCE_SHA = /^[a-f0-9]{40}$/;
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const SHORT_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type ReleaseOnlyOptions = {
  approvedTarget: string;
  approvedTargetIdentityKind?: string;
  approvedTargetIdentitySha256: string;
  acknowledgeLocalSigningAndPermissions?: boolean;
  expectedOldIdentitySha256?: string;
  expectedNewIdentitySha256?: string;
  allowSigningIdentityMigration?: boolean;
  launch?: boolean;
  launchTimeout?: string;
};

export type ReleaseInstallInput = {
  artifactPath: string;
  manifestPath: string;
  envelopePath: string;
  manifestSha256: string;
  expectedSourceSha: string;
  expectedVersion: string;
  expectedTeamId?: string;
  snapshotRoot?: string;
};

export type PreparedReleaseInstall = {
  manifestPath: string;
  envelopePath: string;
  cleanup: () => void;
};

export function assertReleaseOnlyOptions(options: ReleaseOnlyOptions): void {
  if (options.approvedTarget !== "fleet") {
    throw new Error("release installs require --approved-target fleet");
  }
  if (
    options.approvedTargetIdentityKind !== undefined ||
    options.approvedTargetIdentitySha256 !== "none"
  ) {
    throw new Error("release installs reject local-only target identity controls");
  }
  if (options.acknowledgeLocalSigningAndPermissions) {
    throw new Error("release installs reject local-only signing acknowledgement controls");
  }
  if (
    options.expectedOldIdentitySha256 !== undefined ||
    options.expectedNewIdentitySha256 !== undefined ||
    options.allowSigningIdentityMigration
  ) {
    throw new Error("release installs reject local-only signing migration controls");
  }
  if (options.launch) {
    throw new Error(
      "release --launch is unsupported until the signed update client provides canonical post-install launch verification",
    );
  }
  if (options.launchTimeout !== undefined) {
    throw new Error("release --launch-timeout is unsupported without a verified release launch path");
  }
}

export function assertExpectedReleaseHostname(expected: string, actual: string): void {
  if (!SHORT_HOSTNAME.test(expected)) {
    throw new Error("expected hostname is invalid; use one exact short hostname");
  }
  if (actual !== expected) {
    throw new Error(
      `install target hostname ${actual || "<empty>"} does not match the expected hostname ${expected}`,
    );
  }
}

export function parseLaunchTimeout(value: string | undefined): string {
  const timeout = value ?? "10";
  if (!/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/.test(timeout)) {
    throw new Error("launch timeout must be an integer between 1 and 120 seconds");
  }
  return timeout;
}

export function prepareReleaseInstallInputs(input: ReleaseInstallInput): PreparedReleaseInstall {
  assertAbsolutePath(input.artifactPath, "artifact");
  assertAbsolutePath(input.manifestPath, "manifest");
  assertAbsolutePath(input.envelopePath, "envelope");
  if (!LOWER_SHA256.test(input.manifestSha256)) {
    throw new Error("manifest SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (!LOWER_SOURCE_SHA.test(input.expectedSourceSha)) {
    throw new Error("source SHA must be 40 lowercase hexadecimal characters");
  }
  if (!RELEASE_VERSION.test(input.expectedVersion)) {
    throw new Error("release version is invalid");
  }
  if (!input.expectedTeamId || !TEAM_ID.test(input.expectedTeamId)) {
    throw new Error("Team ID must be 10 uppercase alphanumeric characters");
  }

  const manifestBytes = readBoundedRegularFile(
    input.manifestPath,
    "manifest",
    MAX_MANIFEST_BYTES,
  );
  const actualManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualManifestSha256 !== input.manifestSha256) {
    throw new Error("manifest does not match the operator-approved SHA-256");
  }
  const envelopeBytes = readBoundedRegularFile(
    input.envelopePath,
    "envelope",
    MAX_ENVELOPE_BYTES,
  );
  const manifest = parseObject(manifestBytes, "manifest");
  const envelope = parseObject(envelopeBytes, "envelope");
  assertReleaseManifest(manifest, input);
  assertReleaseEnvelope(envelope, manifest, manifestBytes.byteLength, input);

  const snapshotRoot = input.snapshotRoot ?? "/private/tmp";
  if (!isAbsolute(snapshotRoot)) {
    throw new Error("release snapshot root must be absolute");
  }
  const snapshotDirectory = mkdtempSync(join(snapshotRoot, "recordings-release-install."));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      chmodSync(snapshotDirectory, 0o700);
    } catch {
      // Continue with best-effort removal if the directory was already removed.
    }
    rmSync(snapshotDirectory, { recursive: true, force: true });
  };
  try {
    const manifestSnapshot = join(snapshotDirectory, `${input.manifestSha256}.manifest.json`);
    const envelopeDigest = createHash("sha256").update(envelopeBytes).digest("hex");
    const envelopeSnapshot = join(snapshotDirectory, `${envelopeDigest}.envelope.json`);
    writeSnapshot(manifestSnapshot, manifestBytes);
    writeSnapshot(envelopeSnapshot, envelopeBytes);
    chmodSync(snapshotDirectory, 0o500);
    return { manifestPath: manifestSnapshot, envelopePath: envelopeSnapshot, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} path must be absolute`);
}

function readBoundedRegularFile(path: string, label: string, maximum: number): Buffer {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) {
      throw new Error(`${label} must be a non-empty bounded regular file`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseObject(bytes: Buffer, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function assertReleaseManifest(manifest: JsonObject, input: ReleaseInstallInput): void {
  if (
    manifest.schema_version !== 4 ||
    manifest.artifact_type !== "recordings-macos-app" ||
    manifest.bundle_id !== "com.hasna.recordings"
  ) {
    throw new Error("manifest is not a schema-v4 Recordings release artifact");
  }
  if (manifest.git_sha !== input.expectedSourceSha) {
    throw new Error("manifest source SHA does not match the operator-approved source");
  }
  if (manifest.bundle_version !== input.expectedVersion) {
    throw new Error("manifest version does not match the operator-approved version");
  }
  const signing = objectField(manifest, "signing", "manifest");
  if (
    manifest.team_id !== input.expectedTeamId ||
    signing.team_id !== input.expectedTeamId ||
    signing.helper_team_id !== input.expectedTeamId
  ) {
    throw new Error("manifest Team ID does not match the operator-approved Team ID");
  }
  for (const localOnlyField of [
    "artifact_policy",
    "approved_target",
    "approved_target_identity_kind",
    "approved_target_identity_sha256",
    "builder_identity_kind",
    "builder_identity_sha256",
    "non_notarized",
  ]) {
    if (Object.hasOwn(manifest, localOnlyField)) {
      throw new Error("release manifest contains local-only policy fields");
    }
  }
}

function assertReleaseEnvelope(
  envelope: JsonObject,
  manifest: JsonObject,
  manifestByteCount: number,
  input: ReleaseInstallInput,
): void {
  const payload = objectField(envelope, "payload", "envelope");
  if (payload.purpose !== "update") {
    throw new Error("release app install requires an update envelope");
  }
  if (
    payload.manifest_sha256 !== input.manifestSha256 ||
    payload.manifest_byte_count !== manifestByteCount
  ) {
    throw new Error("release envelope does not bind the authenticated manifest snapshot");
  }
  if (
    payload.source_commit !== input.expectedSourceSha ||
    payload.version !== input.expectedVersion ||
    payload.signing_team_identifier !== input.expectedTeamId
  ) {
    throw new Error("release envelope does not match the operator-approved provenance");
  }
  const archive = objectField(manifest, "archive", "manifest");
  const binding = objectField(manifest, "binding", "manifest");
  if (
    payload.build !== manifest.bundle_build_version ||
    !LOWER_SHA256.test(stringField(archive, "sha256", "manifest archive")) ||
    payload.artifact_sha256 !== archive.sha256 ||
    !LOWER_SHA256.test(stringField(binding, "bundle_tree_sha256", "manifest binding")) ||
    payload.candidate_tree_sha256 !== binding.bundle_tree_sha256
  ) {
    throw new Error("release envelope and manifest artifact provenance differ");
  }
  const signature = stringField(envelope, "signature", "envelope");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw new Error("release envelope signature encoding is invalid");
  }
}

function objectField(value: JsonObject, key: string, label: string): JsonObject {
  const field = value[key];
  if (!isObject(field)) throw new Error(`${label} is missing ${key}`);
  return field;
}

function stringField(value: JsonObject, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${label} is missing ${key}`);
  return field;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeSnapshot(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
