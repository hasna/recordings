import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const LIFECYCLE = "bootstrap-v1-app-updates-only" as const;
const PROTOCOL_VERSION = 1 as const;
const COMPATIBLE_COHORT_SCHEMA_VERSION = 2 as const;
const JSON_INPUT_LIMIT = 64 * 1024;
const REQUIREMENT_LIMIT = 8 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TEAM_PATTERN = /^[A-Z0-9]{10}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export const COMPATIBLE_COHORT_KEYS = [
  "artifact_verifier_designated_requirement",
  "artifact_verifier_sha256",
  "bootstrap_marker_sha256",
  "envelope_public_key_sha256",
  "installer_certificate_sha256",
  "key_epoch",
  "key_rotation_supported",
  "lifecycle",
  "minimum_broker_version",
  "package_sha256",
  "protocol_version",
  "root_maintenance_supported",
  "schema_version",
  "signing_team_identifier",
  "update_broker_designated_requirement",
  "update_broker_sha256",
] as const;

export type CompatibleCohortManifest = {
  artifact_verifier_designated_requirement: string;
  artifact_verifier_sha256: string;
  bootstrap_marker_sha256: string;
  envelope_public_key_sha256: string;
  installer_certificate_sha256: string;
  key_epoch: number;
  key_rotation_supported: false;
  lifecycle: typeof LIFECYCLE;
  minimum_broker_version: string;
  package_sha256: string;
  protocol_version: typeof PROTOCOL_VERSION;
  root_maintenance_supported: false;
  schema_version: typeof COMPATIBLE_COHORT_SCHEMA_VERSION;
  signing_team_identifier: string;
  update_broker_designated_requirement: string;
  update_broker_sha256: string;
};

type CompatibleCohortExpectations = {
  teamIdentifier: string;
  keyEpoch: number;
  envelopePublicKeySHA256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  return `${JSON.stringify(sorted)}\n`;
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`compatible-cohort ${label} must be a lowercase SHA-256 digest`);
  }
}

function requireRequirement(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > REQUIREMENT_LIMIT ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(`compatible-cohort ${label} is missing or invalid`);
  }
}

export function parseCompatibleCohortManifest(
  value: unknown,
  expected: CompatibleCohortExpectations,
): CompatibleCohortManifest {
  if (!isRecord(value)) throw new Error("compatible-cohort manifest must be a JSON object");
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...COMPATIBLE_COHORT_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("compatible-cohort manifest does not have the exact schema-v2 key set");
  }
  if (value.schema_version !== COMPATIBLE_COHORT_SCHEMA_VERSION) {
    throw new Error("compatible-cohort schema_version must be 2");
  }
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error("compatible-cohort protocol_version must be 1");
  }
  if (!Number.isSafeInteger(value.key_epoch) || (value.key_epoch as number) <= 0) {
    throw new Error("compatible-cohort key_epoch must be a positive integer");
  }
  if (value.key_epoch !== expected.keyEpoch) {
    throw new Error("compatible-cohort key_epoch does not match the selected release key");
  }
  if (
    typeof value.signing_team_identifier !== "string" ||
    !TEAM_PATTERN.test(value.signing_team_identifier) ||
    value.signing_team_identifier !== expected.teamIdentifier
  ) {
    throw new Error("compatible-cohort signing TeamIdentifier is invalid or mismatched");
  }
  if (
    value.lifecycle !== LIFECYCLE ||
    value.root_maintenance_supported !== false ||
    value.key_rotation_supported !== false
  ) {
    throw new Error("compatible-cohort does not authorize the immutable app-only updater lifecycle");
  }
  for (const key of [
    "artifact_verifier_sha256",
    "bootstrap_marker_sha256",
    "envelope_public_key_sha256",
    "installer_certificate_sha256",
    "package_sha256",
    "update_broker_sha256",
  ] as const) {
    requireDigest(value[key], key);
  }
  if (value.envelope_public_key_sha256 !== expected.envelopePublicKeySHA256) {
    throw new Error("compatible-cohort does not bind the selected release-envelope public key");
  }
  requireRequirement(
    value.update_broker_designated_requirement,
    "update_broker_designated_requirement",
  );
  requireRequirement(
    value.artifact_verifier_designated_requirement,
    "artifact_verifier_designated_requirement",
  );
  if (
    typeof value.minimum_broker_version !== "string" ||
    !VERSION_PATTERN.test(value.minimum_broker_version)
  ) {
    throw new Error("compatible-cohort minimum_broker_version is invalid");
  }
  return value as CompatibleCohortManifest;
}

export function createCompatibleCohortManifest(
  values: Omit<CompatibleCohortManifest, "schema_version" | "protocol_version" | "lifecycle" |
    "root_maintenance_supported" | "key_rotation_supported">,
): CompatibleCohortManifest {
  const manifest: CompatibleCohortManifest = {
    ...values,
    schema_version: COMPATIBLE_COHORT_SCHEMA_VERSION,
    protocol_version: PROTOCOL_VERSION,
    lifecycle: LIFECYCLE,
    root_maintenance_supported: false,
    key_rotation_supported: false,
  };
  return parseCompatibleCohortManifest(manifest, {
    teamIdentifier: values.signing_team_identifier,
    keyEpoch: values.key_epoch,
    envelopePublicKeySHA256: values.envelope_public_key_sha256,
  });
}

type UpdateManifestView = {
  archiveSHA256: string;
  build: string;
  candidateTreeSHA256: string;
  minimumOSVersion: string;
  sourceCommit: string;
  teamIdentifier: string;
  version: string;
  architectures: ["arm64", "x86_64"];
  applicationDesignatedRequirementSHA256: string;
};

type UpdatePayloadInputs = {
  cohort: CompatibleCohortManifest;
  manifest: UpdateManifestView;
  releaseSequence: number;
  appArchiveSHA256: string;
  appArchiveByteCount: number;
  manifestSHA256: string;
  manifestByteCount: number;
  updateClientSHA256: string;
  applicationDesignatedRequirement: string;
  updateClientDesignatedRequirement: string;
  expiresAtUTC: string;
  now?: Date;
  releaseID?: string;
};

export function createUpdateEnvelopePayload(inputs: UpdatePayloadInputs): Record<string, unknown> {
  const { cohort, manifest } = inputs;
  if (inputs.appArchiveSHA256 !== manifest.archiveSHA256) {
    throw new Error("final app manifest does not bind the app-update archive");
  }
  for (const [label, value] of [
    ["app archive", inputs.appArchiveSHA256],
    ["manifest", inputs.manifestSHA256],
    ["update client", inputs.updateClientSHA256],
  ] as const) requireDigest(value, label);
  if (
    !Number.isSafeInteger(inputs.releaseSequence) ||
    inputs.releaseSequence <= 0 ||
    !Number.isSafeInteger(inputs.appArchiveByteCount) ||
    inputs.appArchiveByteCount <= 0 ||
    !Number.isSafeInteger(inputs.manifestByteCount) ||
    inputs.manifestByteCount <= 0
  ) {
    throw new Error("app-update sequence or artifact sizes are invalid");
  }
  requireRequirement(inputs.applicationDesignatedRequirement, "application designated requirement");
  requireRequirement(inputs.updateClientDesignatedRequirement, "update-client designated requirement");
  if (sha256(inputs.applicationDesignatedRequirement) !== manifest.applicationDesignatedRequirementSHA256) {
    throw new Error("final app manifest does not bind the app designated requirement");
  }
  if (JSON.stringify(manifest.architectures) !== '["arm64","x86_64"]') {
    throw new Error("release app manifest must bind exactly arm64 and x86_64");
  }
  const now = inputs.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("issued-at timestamp is invalid");
  return {
    schema_version: PROTOCOL_VERSION,
    purpose: "update",
    key_epoch: cohort.key_epoch,
    release_sequence: inputs.releaseSequence,
    release_id: inputs.releaseID ?? randomUUID(),
    version: manifest.version,
    build: manifest.build,
    source_commit: manifest.sourceCommit,
    artifact_sha256: inputs.appArchiveSHA256,
    artifact_byte_count: inputs.appArchiveByteCount,
    manifest_sha256: inputs.manifestSHA256,
    manifest_byte_count: inputs.manifestByteCount,
    candidate_tree_sha256: manifest.candidateTreeSHA256,
    package_sha256: cohort.package_sha256,
    update_client_sha256: inputs.updateClientSHA256,
    update_broker_sha256: cohort.update_broker_sha256,
    artifact_verifier_sha256: cohort.artifact_verifier_sha256,
    bootstrap_marker_sha256: cohort.bootstrap_marker_sha256,
    architectures: manifest.architectures,
    minimum_os_version: manifest.minimumOSVersion,
    minimum_broker_version: cohort.minimum_broker_version,
    signing_team_identifier: cohort.signing_team_identifier,
    application_designated_requirement: inputs.applicationDesignatedRequirement,
    update_client_designated_requirement: inputs.updateClientDesignatedRequirement,
    update_broker_designated_requirement: cohort.update_broker_designated_requirement,
    artifact_verifier_designated_requirement: cohort.artifact_verifier_designated_requirement,
    installer_certificate_sha256: cohort.installer_certificate_sha256,
    issued_at_utc: now.toISOString(),
    expires_at_utc: inputs.expiresAtUTC,
  };
}

function readJson(path: string, label: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > JSON_INPUT_LIMIT) {
    throw new Error(`${label} is empty or exceeds ${JSON_INPUT_LIMIT} bytes`);
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range`);
  return parsed;
}

function parseArguments(allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 3; index < Bun.argv.length; index += 2) {
    const key = Bun.argv[index];
    const value = Bun.argv[index + 1];
    if (!key || !allowed.includes(key) || !value || values.has(key)) {
      throw new Error(`unknown, duplicate, or incomplete release-lifecycle argument: ${key ?? "missing"}`);
    }
    values.set(key, value);
  }
  for (const key of allowed) {
    if (!values.has(key)) throw new Error(`missing required release-lifecycle argument ${key}`);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`missing required release-lifecycle argument ${key}`);
  return value;
}

function writeExclusiveJson(path: string, value: Record<string, unknown>): void {
  if (!isAbsolute(path)) throw new Error("release-lifecycle output path must be absolute");
  writeFileSync(path, canonicalJson(value), { encoding: "utf8", flag: "wx", mode: 0o400 });
}

function manifestView(value: unknown): UpdateManifestView {
  if (!isRecord(value)) throw new Error("final app manifest must be a JSON object");
  const archive = value.archive;
  const binding = value.binding;
  const signing = value.signing;
  if (!isRecord(archive) || !isRecord(binding) || !isRecord(signing)) {
    throw new Error("final app manifest is missing release bindings");
  }
  const architectures = value.architectures;
  const view = {
    archiveSHA256: archive.sha256,
    build: value.bundle_build_version,
    candidateTreeSHA256: binding.bundle_tree_sha256,
    minimumOSVersion: value.minimum_macos,
    sourceCommit: value.git_sha,
    teamIdentifier: value.team_id,
    version: value.bundle_version,
    architectures,
    applicationDesignatedRequirementSHA256: signing.designated_requirement_sha256,
  };
  if (
    typeof view.archiveSHA256 !== "string" || !DIGEST_PATTERN.test(view.archiveSHA256) ||
    typeof view.candidateTreeSHA256 !== "string" || !DIGEST_PATTERN.test(view.candidateTreeSHA256) ||
    typeof view.applicationDesignatedRequirementSHA256 !== "string" ||
      !DIGEST_PATTERN.test(view.applicationDesignatedRequirementSHA256) ||
    typeof view.build !== "string" || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(view.build) ||
    typeof view.minimumOSVersion !== "string" || !/^\d+(?:\.\d+){1,2}$/.test(view.minimumOSVersion) ||
    typeof view.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(view.sourceCommit) ||
    typeof view.teamIdentifier !== "string" || !TEAM_PATTERN.test(view.teamIdentifier) ||
    typeof view.version !== "string" || !VERSION_PATTERN.test(view.version) ||
    !Array.isArray(architectures) || JSON.stringify(architectures) !== '["arm64","x86_64"]'
  ) {
    throw new Error("final app manifest contains invalid release bindings");
  }
  return view as UpdateManifestView;
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (command === "write-compatible-cohort") {
    const allowed = [
      "--artifact-verifier-designated-requirement",
      "--artifact-verifier-sha256",
      "--bootstrap-marker-sha256",
      "--envelope-public-key-sha256",
      "--installer-certificate-sha256",
      "--key-epoch",
      "--minimum-broker-version",
      "--output",
      "--package-sha256",
      "--team-id",
      "--update-broker-designated-requirement",
      "--update-broker-sha256",
    ] as const;
    const values = parseArguments(allowed);
    const manifest = createCompatibleCohortManifest({
      artifact_verifier_designated_requirement: required(values, "--artifact-verifier-designated-requirement"),
      artifact_verifier_sha256: required(values, "--artifact-verifier-sha256"),
      bootstrap_marker_sha256: required(values, "--bootstrap-marker-sha256"),
      envelope_public_key_sha256: required(values, "--envelope-public-key-sha256"),
      installer_certificate_sha256: required(values, "--installer-certificate-sha256"),
      key_epoch: parsePositiveInteger(required(values, "--key-epoch"), "key epoch"),
      minimum_broker_version: required(values, "--minimum-broker-version"),
      package_sha256: required(values, "--package-sha256"),
      signing_team_identifier: required(values, "--team-id"),
      update_broker_designated_requirement: required(values, "--update-broker-designated-requirement"),
      update_broker_sha256: required(values, "--update-broker-sha256"),
    });
    writeExclusiveJson(required(values, "--output"), manifest);
    return;
  }
  if (command === "validate-compatible-cohort") {
    const allowed = ["--manifest", "--public-key", "--team-id", "--key-epoch"] as const;
    const values = parseArguments(allowed);
    parseCompatibleCohortManifest(readJson(required(values, "--manifest"), "compatible-cohort manifest"), {
      teamIdentifier: required(values, "--team-id"),
      keyEpoch: parsePositiveInteger(required(values, "--key-epoch"), "key epoch"),
      envelopePublicKeySHA256: await sha256File(required(values, "--public-key")),
    });
    return;
  }
  if (command === "write-update-payload") {
    const allowed = [
      "--app-archive",
      "--application-designated-requirement",
      "--compatible-cohort-manifest",
      "--envelope-public-key",
      "--expires-at-utc",
      "--key-epoch",
      "--manifest",
      "--output",
      "--release-sequence",
      "--source-sha",
      "--team-id",
      "--update-client",
      "--update-client-designated-requirement",
      "--version",
    ] as const;
    const values = parseArguments(allowed);
    const manifestPath = required(values, "--manifest");
    const archivePath = required(values, "--app-archive");
    const publicKeyPath = required(values, "--envelope-public-key");
    const keyEpoch = parsePositiveInteger(required(values, "--key-epoch"), "key epoch");
    const teamIdentifier = required(values, "--team-id");
    const cohort = parseCompatibleCohortManifest(
      readJson(required(values, "--compatible-cohort-manifest"), "compatible-cohort manifest"),
      {
        teamIdentifier,
        keyEpoch,
        envelopePublicKeySHA256: await sha256File(publicKeyPath),
      },
    );
    const manifestBytes = readFileSync(manifestPath);
    if (manifestBytes.length === 0 || manifestBytes.length > 16 * 1024 * 1024) {
      throw new Error("final app manifest is empty or too large");
    }
    const view = manifestView(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    if (
      view.teamIdentifier !== teamIdentifier ||
      view.sourceCommit !== required(values, "--source-sha") ||
      view.version !== required(values, "--version")
    ) {
      throw new Error("final app manifest does not match the selected release identity");
    }
    const archive = Bun.file(archivePath);
    const payload = createUpdateEnvelopePayload({
      cohort,
      manifest: view,
      releaseSequence: parsePositiveInteger(required(values, "--release-sequence"), "release sequence"),
      appArchiveSHA256: await sha256File(archivePath),
      appArchiveByteCount: archive.size,
      manifestSHA256: sha256(manifestBytes),
      manifestByteCount: manifestBytes.length,
      updateClientSHA256: await sha256File(required(values, "--update-client")),
      applicationDesignatedRequirement: required(values, "--application-designated-requirement"),
      updateClientDesignatedRequirement: required(values, "--update-client-designated-requirement"),
      expiresAtUTC: required(values, "--expires-at-utc"),
    });
    writeExclusiveJson(required(values, "--output"), payload);
    return;
  }
  throw new Error("release-lifecycle command must be write-compatible-cohort, validate-compatible-cohort, or write-update-payload");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
