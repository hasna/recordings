#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { tmpdir } from "node:os";

export const ARTIFACT_SCHEMA_VERSION = 2;
export const BUNDLE_ID = "com.hasna.recordings";
export const PROVENANCE_FILENAME = "recordings-build-provenance.json";

export type BuildProvenance = {
  schema_version: 2;
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
  provenance_sha256: string;
  signing: {
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
    status: "Accepted";
    log_sha256: string;
    issue_count: 0;
    submitted_archive_sha256: string;
    stapled: true;
    distribution_check: true;
  };
  container: {
    type: "zip";
    install_locations: ["~/Applications/Recordings.app"];
  };
  nested_code_policy: {
    allowlist_sha256: string;
    items: NestedCodeItem[];
  };
  external_state: {
    paths: ["~/.hasna/recordings"];
    classification: "user-private";
    rollback: "transactional-backup-restore";
  };
  archive: {
    filename: string;
    sha256: string;
  };
};

type SigningEvidence = {
  authority: string;
  teamId: string;
  timestamp: string;
  designatedRequirement: string;
  architectures: string[];
  entitlementsSha256: string;
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

export type NestedCodeItem = {
  path: string;
  team_id: string;
  runtime: true;
  timestamp_required: true;
  architectures: string[];
  entitlements_sha256: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
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
  return run("lipo", ["-archs", executablePath]).trim().split(/\s+/).filter(Boolean).sort();
}

function signingDetails(codePath: string): string {
  return run("codesign", ["-d", "--verbose=4", codePath]);
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

export function assertCleanGitStatus(status: string): void {
  if (status.trim()) {
    throw new Error("refusing to claim a git SHA for a dirty source worktree");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalEntitlements(codePath: string): string {
  const readback = spawnSync("codesign", ["-d", "--entitlements", ":-", codePath], {
    encoding: "utf8",
  });
  if (readback.error) throw readback.error;
  if (readback.status !== 0) throw new Error(`could not read signed entitlements for ${codePath}`);
  const raw = readback.stdout;
  if (!raw.trim()) throw new Error(`signed entitlements are empty for ${codePath}`);
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
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
): SigningEvidence {
  run("codesign", ["--verify", "--strict", "--all-architectures", "--verbose=2", codePath]);
  const details = signingDetails(codePath);
  const authority = lineValue(details, "Authority");
  const teamId = lineValue(details, "TeamIdentifier");
  const timestamp = lineValue(details, "Timestamp");
  if (!authority.startsWith("Developer ID Application:")) {
    throw new Error(`${codePath} is not signed by a Developer ID Application authority`);
  }
  if (teamId !== expectedTeamId) {
    throw new Error(`${codePath} TeamIdentifier ${teamId || "missing"} does not match ${expectedTeamId}`);
  }
  const flagList = details.match(/^CodeDirectory .*flags=[^(]*\(([^)]*)\)/m)?.[1]
    ?.split(",")
    .map((value) => value.trim());
  if (!flagList?.includes("runtime")) {
    throw new Error(`${codePath} is missing hardened runtime signing`);
  }
  if (!timestamp || timestamp.toLowerCase() === "none") {
    throw new Error(`${codePath} is missing a trusted signing timestamp`);
  }
  const requirementOutput = run("codesign", ["-d", "-r-", codePath]);
  const designatedRequirement = parseDesignatedRequirement(requirementOutput);
  const entitlements = canonicalEntitlements(codePath);
  if (entitlements !== canonicalJson(expectedEntitlements)) {
    throw new Error(`${codePath} has unexpected signed entitlements`);
  }
  return {
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
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isHex(value: string, length: number): boolean {
  return new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function nestedItems(
  appPath: string,
  expectedTeamId: string,
  outerSigning?: SigningEvidence,
  helperSigning?: SigningEvidence,
): NestedCodeItem[] {
  const evidence = [
    {
      path: ".",
      value:
        outerSigning ??
        signingEvidence(
          appPath,
          expectedTeamId,
          APP_ENTITLEMENTS,
          join(appPath, "Contents", "MacOS", "Recordings"),
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
        ),
    },
  ];
  return evidence.map(({ path, value }) => ({
    path,
    team_id: value.teamId,
    runtime: true,
    timestamp_required: true,
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
    const magic = readFileSync(path).subarray(0, 4).toString("hex");
    if (((details.mode & 0o111) !== 0 || machOMagic.has(magic)) && !allowedExecutables.has(path)) {
      throw new Error(`app bundle contains unexpected executable code: ${path}`);
    }
  };
  visit(appPath);
  for (const path of allowedExecutables) {
    if (!statSync(path).isFile()) throw new Error(`app bundle is missing expected code: ${path}`);
  }
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
  if (manifest.schema_version !== ARTIFACT_SCHEMA_VERSION) throw new Error("unsupported manifest schema");
  if (manifest.artifact_type !== "recordings-macos-app") throw new Error("unexpected artifact type");
  if (manifest.bundle_id !== BUNDLE_ID) throw new Error("unexpected bundle identifier");
  for (const [label, value] of [
    ["bundle version", manifest.bundle_version],
    ["bundle build version", manifest.bundle_build_version],
    ["git SHA", manifest.git_sha],
    ["Team ID", manifest.team_id],
    ["app hash", manifest.app_sha256],
    ["provenance hash", manifest.provenance_sha256],
    ["signing authority", manifest.signing?.authority],
    ["signing Team ID", manifest.signing?.team_id],
    ["helper signing authority", manifest.signing?.helper_authority],
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
    ["notary submission ID", manifest.notarization?.submission_id],
    ["notary log hash", manifest.notarization?.log_sha256],
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
  if (!sameStrings([...manifest.architectures].sort(), [...manifest.companion.architectures].sort())) {
    throw new Error("manifest app and helper architectures differ");
  }
  if (
    !manifest.signing.authority.startsWith("Developer ID Application:") ||
    !manifest.signing.helper_authority.startsWith("Developer ID Application:")
  ) {
    throw new Error("manifest requires Developer ID Application signing authorities");
  }
  if (!isHex(manifest.git_sha, 40)) throw new Error("manifest git SHA must be a full commit SHA");
  for (const [label, value] of [
    ["app hash", manifest.app_sha256],
    ["provenance hash", manifest.provenance_sha256],
    ["archive hash", manifest.archive.sha256],
    ["notary log hash", manifest.notarization.log_sha256],
    ["nested allowlist hash", manifest.nested_code_policy.allowlist_sha256],
    ["entitlements hash", manifest.signing.entitlements_sha256],
    ["helper entitlements hash", manifest.signing.helper_entitlements_sha256],
    ["helper designated requirement hash", manifest.signing.helper_designated_requirement_sha256],
    ["submitted archive hash", manifest.notarization.submitted_archive_sha256],
    ["companion hash", manifest.companion.sha256],
    ["designated requirement hash", manifest.signing.designated_requirement_sha256],
  ] as const) {
    if (!isHex(value, 64)) throw new Error(`manifest ${label} must be SHA-256`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(manifest.notarization.submission_id)) {
    throw new Error("manifest notary submission ID is invalid");
  }
  if (
    manifest.notarization.status !== "Accepted" ||
    manifest.notarization.stapled !== true ||
    manifest.notarization.distribution_check !== true ||
    manifest.notarization.issue_count !== 0
  ) {
    throw new Error("manifest requires accepted and stapled notarization evidence");
  }
  if (
    manifest.container?.type !== "zip" ||
    JSON.stringify(manifest.container.install_locations) !==
      JSON.stringify(["~/Applications/Recordings.app"])
  ) {
    throw new Error("manifest has an unexpected container install policy");
  }
  if (
    manifest.external_state?.classification !== "user-private" ||
    manifest.external_state?.rollback !== "transactional-backup-restore" ||
    JSON.stringify(manifest.external_state.paths) !== JSON.stringify(["~/.hasna/recordings"])
  ) {
    throw new Error("manifest has an unexpected external-state policy");
  }
  const items = manifest.nested_code_policy?.items;
  if (!Array.isArray(items) || items.length !== 2) {
    throw new Error("manifest nested-code allowlist is incomplete");
  }
  const expectedPaths = [".", "Contents/Helpers/recordings"];
  if (
    items.some(
      (item, index) =>
        item.path !== expectedPaths[index] ||
        item.team_id !== manifest.team_id ||
        item.runtime !== true ||
        item.timestamp_required !== true ||
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
): MacOSArtifactManifest {
  if (!expectedTeamId) throw new Error("expected Team ID is required");
  if (!isHex(expectedManifestSha256, 64) || sha256File(manifestPath) !== expectedManifestSha256) {
    throw new Error("manifest checksum does not match the authenticated operator value");
  }
  const manifest = readJson<MacOSArtifactManifest>(manifestPath);
  assertManifestShape(manifest);
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
  if (sha256File(archivePath) !== manifest.archive.sha256) {
    throw new Error("archive checksum does not match the manifest");
  }
  return manifest;
}

function assertProvenanceMatchesManifest(
  provenance: BuildProvenance,
  manifest: MacOSArtifactManifest,
): void {
  for (const key of ["bundle_id", "bundle_version", "git_sha", "team_id"] as const) {
    if (provenance[key] !== manifest[key]) throw new Error(`signed provenance ${key} mismatch`);
  }
  if (
    provenance.bundle_build_version !== manifest.bundle_build_version ||
    provenance.minimum_macos !== manifest.minimum_macos
  ) {
    throw new Error("signed provenance bundle policy mismatch");
  }
  if (!sameStrings([...provenance.architectures].sort(), [...manifest.architectures].sort())) {
    throw new Error("signed provenance architecture mismatch");
  }
  if (
    provenance.companion.version !== manifest.companion.version ||
    provenance.companion.sha256 !== manifest.companion.sha256 ||
    !sameStrings(
      [...provenance.companion.architectures].sort(),
      [...manifest.companion.architectures].sort(),
    )
  ) {
    throw new Error("signed provenance companion mismatch");
  }
}

export function verifyExtractedApp(
  appPath: string,
  manifestPath: string,
  expectedTeamId: string,
): MacOSArtifactManifest {
  const manifest = readJson<MacOSArtifactManifest>(manifestPath);
  assertManifestShape(manifest);
  if (manifest.team_id !== expectedTeamId) throw new Error("manifest Team ID mismatch");

  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  assertExpectedCodeLayout(appPath);
  const outerSigning = signingEvidence(appPath, expectedTeamId, APP_ENTITLEMENTS, executablePath);
  const helperSigning = signingEvidence(helperPath, expectedTeamId, HELPER_ENTITLEMENTS);

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
  if (!sameStrings(architectures(executablePath), [...manifest.architectures].sort())) {
    throw new Error("installed app architectures do not match the manifest");
  }
  if (sha256File(executablePath) !== manifest.app_sha256) throw new Error("app hash mismatch");
  if (sha256File(helperPath) !== manifest.companion.sha256) throw new Error("companion hash mismatch");
  if (!sameStrings(architectures(helperPath), [...manifest.companion.architectures].sort())) {
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
  const actualNestedItems = nestedItems(appPath, expectedTeamId, outerSigning, helperSigning);
  if (JSON.stringify(actualNestedItems) !== JSON.stringify(manifest.nested_code_policy.items)) {
    throw new Error("nested-code policy does not match the extracted app");
  }
  return manifest;
}

function writeProvenance(appPath: string, expectedTeamId: string, packageRoot: string): void {
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  assertCleanGitStatus(
    run("git", ["-C", packageRoot, "status", "--porcelain=v1", "--untracked-files=all"]),
  );
  const provenance: BuildProvenance = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    bundle_id: plistValue(appPath, "CFBundleIdentifier"),
    bundle_version: plistValue(appPath, "CFBundleShortVersionString"),
    bundle_build_version: plistValue(appPath, "CFBundleVersion"),
    git_sha: run("git", ["-C", packageRoot, "rev-parse", "HEAD"]).trim(),
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
  writeJson(provenancePath(appPath), provenance);
}

function finalizeArtifact(
  appPath: string,
  archivePath: string,
  manifestPath: string,
  expectedTeamId: string,
  notaryLogPath: string,
  notarySubmissionId: string,
  submittedArchiveSha256: string,
): void {
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  assertExpectedCodeLayout(appPath);
  const outerSigning = signingEvidence(appPath, expectedTeamId, APP_ENTITLEMENTS, executablePath);
  const helperSigning = signingEvidence(helperPath, expectedTeamId, HELPER_ENTITLEMENTS);
  const notaryLog = readJson<{ jobId?: string; status?: string; issues?: unknown[] | null }>(notaryLogPath);
  if (
    notaryLog.status !== "Accepted" ||
    (notaryLog.issues !== null && notaryLog.issues !== undefined && !Array.isArray(notaryLog.issues)) ||
    (notaryLog.issues?.length ?? 0) !== 0
  ) {
    throw new Error("notary log is not accepted and issue-free");
  }
  if (!notarySubmissionId) throw new Error("notary submission ID is required");
  if (notaryLog.jobId?.toLowerCase() !== notarySubmissionId.toLowerCase()) {
    throw new Error("notary log job ID does not match the submission ID");
  }
  if (!isHex(submittedArchiveSha256, 64)) throw new Error("submitted archive SHA-256 is invalid");
  const items = nestedItems(appPath, expectedTeamId, outerSigning, helperSigning);
  const manifest: MacOSArtifactManifest = {
    ...provenance,
    artifact_type: "recordings-macos-app",
    app_sha256: sha256File(executablePath),
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
      log_sha256: sha256File(notaryLogPath),
      issue_count: 0,
      submitted_archive_sha256: submittedArchiveSha256,
      stapled: true,
      distribution_check: true,
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
      rollback: "transactional-backup-restore",
    },
    archive: {
      filename: basename(archivePath),
      sha256: sha256File(archivePath),
    },
  };
  assertManifestShape(manifest);
  writeJson(manifestPath, manifest);
  verifyArchiveManifest(
    archivePath,
    manifestPath,
    expectedTeamId,
    sha256File(manifestPath),
    manifest.git_sha,
    manifest.bundle_version,
  );
  verifyExtractedApp(appPath, manifestPath, expectedTeamId);
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
  if (sha256File(manifestPath) !== expectedManifestSha256) {
    throw new Error("manifest checksum does not match the authenticated operator value");
  }
  const manifest = readJson<MacOSArtifactManifest>(manifestPath);
  assertManifestShape(manifest);
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

function assertInstallTransition(existingAppPath: string, manifestPath: string): void {
  const manifest = readJson<MacOSArtifactManifest>(manifestPath);
  const installedVersion = plistValue(existingAppPath, "CFBundleShortVersionString");
  let installedSource: string | null = null;
  try {
    installedSource = readJson<BuildProvenance>(provenancePath(existingAppPath)).git_sha;
  } catch {
    // Older installs can lack provenance; upgrades remain allowed, same-version replacement does not.
  }
  assertVersionTransition(installedVersion, installedSource, manifest);
}

function requirementDigest(appPath: string): void {
  const output = run("codesign", ["-d", "-r-", appPath]);
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
    const aclLines = run("/bin/ls", ["-lde", path]).split(/\r?\n/).slice(1);
    if (aclLines.some((line) => line.trim())) {
      throw new Error(`filesystem tree has an unexpected ACL: ${path}`);
    }
    if (details.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (!details.isFile()) {
      throw new Error(`filesystem tree contains a special file: ${path}`);
    }
  };
  visit(root);
}

function verifyActiveApp(appPath: string, manifestPath: string, expectedTeamId: string): void {
  const manifest = verifyExtractedApp(appPath, manifestPath, expectedTeamId);
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
  schema_version: 1;
  phase: string;
  transaction_dir: string;
  app_parent: string;
  app_destination: string;
  data_dir: string;
  state_backup: string;
  originals: Array<{ path: string; backup: string }>;
  was_running: boolean;
  expected_manifest_sha256: string;
  expected_source_sha: string;
  expected_version: string;
  candidate_identity_sha256: string;
  previous_identity_sha256: string;
};

function writeDurableJournal(path: string, journal: InstallJournal): void {
  const parent = dirname(path);
  const temporary = `${path}.tmp-${process.pid}`;
  const writeDescriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(writeDescriptor, `${JSON.stringify(journal)}\n`);
    fsyncSync(writeDescriptor);
  } finally {
    closeSync(writeDescriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(parent, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function journalArgument(): InstallJournal {
  const value: InstallJournal = {
    schema_version: 1,
    phase: argument("--phase"),
    transaction_dir: argument("--transaction-dir"),
    app_parent: argument("--app-parent"),
    app_destination: argument("--app-destination"),
    data_dir: argument("--data-dir"),
    state_backup: argument("--state-backup"),
    originals: [],
    was_running: Bun.argv.includes("--was-running"),
    expected_manifest_sha256: argument("--expected-manifest-sha256"),
    expected_source_sha: argument("--expected-source-sha"),
    expected_version: argument("--expected-version"),
    candidate_identity_sha256: argument("--candidate-identity-sha256"),
    previous_identity_sha256: argument("--previous-identity-sha256"),
  };
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] === "--original") {
      const path = Bun.argv[index + 1];
      const backup = Bun.argv[index + 2];
      if (!path || !backup) throw new Error("--original requires path and backup");
      value.originals.push({ path, backup });
    }
  }
  return value;
}

function readJournal(path: string): InstallJournal {
  const journal = readJson<InstallJournal>(path);
  if (journal.schema_version !== 1 || !journal.transaction_dir || !journal.phase) {
    throw new Error("invalid install transaction journal");
  }
  const allowedPhases = new Set([
    "prepared",
    "processes-stopping",
    "processes-stopped",
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
    "committed",
  ]);
  if (!allowedPhases.has(journal.phase)) throw new Error("invalid install transaction phase");
  if (
    !isHex(journal.expected_manifest_sha256, 64) ||
    !isHex(journal.expected_source_sha, 40) ||
    !isHex(journal.candidate_identity_sha256, 64) ||
    (journal.previous_identity_sha256 !== "none" &&
      !isHex(journal.previous_identity_sha256, 64))
  ) {
    throw new Error("install transaction journal has invalid release identity fields");
  }
  const expectedParent = resolve(journal.app_parent);
  const transaction = resolve(journal.transaction_dir);
  if (!transaction.startsWith(`${expectedParent}/.Recordings-transaction.`)) {
    throw new Error("install transaction journal points outside the app parent");
  }
  if (resolve(path) !== resolve(join(expectedParent, ".Recordings-install-transaction.json"))) {
    throw new Error("install transaction journal is outside the expected app parent");
  }
  if (resolve(journal.app_destination) !== resolve(join(expectedParent, "Recordings.app"))) {
    throw new Error("install transaction journal has an unexpected app destination");
  }
  if (!journal.originals.every((entry) => resolve(entry.backup).startsWith(`${transaction}/apps/`))) {
    throw new Error("install transaction journal has an unsafe app backup path");
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
  if (resolve(journal.state_backup) !== resolve(join(transaction, "state"))) {
    throw new Error("install transaction journal has an unsafe state backup path");
  }
  return journal;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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

function recoverJournal(path: string): void {
  const journal = readJournal(path);
  if (journal.phase === "committed") {
    rmSync(path, { force: true });
    rmSync(journal.transaction_dir, { recursive: true, force: true });
    fsyncDirectory(dirname(path));
    return;
  }

  const mutationPhases = new Set([
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
  ]);
  if (mutationPhases.has(journal.phase)) {
    if (["candidate-moving", "candidate-installed", "activated", "launching"].includes(journal.phase)) {
      rmSync(journal.app_destination, { recursive: true, force: true });
    }
    for (const entry of [...journal.originals].reverse()) {
      if (!existsSync(entry.backup)) continue;
      mkdirSync(dirname(entry.path), { recursive: true, mode: 0o700 });
      rmSync(entry.path, { recursive: true, force: true });
      renameSync(entry.backup, entry.path);
      fsyncTree(entry.path);
      fsyncDirectory(dirname(entry.path));
    }
  }
  if (mutationPhases.has(journal.phase) && existsSync(journal.state_backup)) {
    rmSync(journal.data_dir, { recursive: true, force: true });
    cpSync(journal.state_backup, journal.data_dir, { recursive: true, preserveTimestamps: true });
    fsyncTree(journal.data_dir);
    fsyncDirectory(dirname(journal.data_dir));
  }
  rmSync(path, { force: true });
  rmSync(journal.transaction_dir, { recursive: true, force: true });
  fsyncDirectory(journal.app_parent);
  fsyncDirectory(dirname(path));
}

function journalGet(path: string, field: string): void {
  const journal = readJournal(path);
  if (field === "json") console.log(JSON.stringify(journal));
  else if (field === "phase") console.log(journal.phase);
  else if (field === "transaction_dir") console.log(journal.transaction_dir);
  else if (field === "state_backup") console.log(journal.state_backup);
  else if (field === "was_running") console.log(journal.was_running ? "1" : "0");
  else throw new Error(`unsupported journal field: ${field}`);
}

function manifestGet(path: string, field: string): void {
  const manifest = readJson<MacOSArtifactManifest>(path);
  assertManifestShape(manifest);
  if (field === "minimum_macos") console.log(manifest.minimum_macos);
  else if (field === "architectures") console.log(manifest.architectures.join(" "));
  else if (field === "version") console.log(manifest.bundle_version);
  else if (field === "source") console.log(manifest.git_sha);
  else if (field === "identity") console.log(manifest.signing.designated_requirement_sha256);
  else throw new Error(`unsupported manifest field: ${field}`);
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function main(): void {
  const command = Bun.argv[2];
  if (command === "provenance") {
    const teamId = argument("--team-id");
    writeProvenance(argument("--app"), teamId, argument("--package-root"));
  } else if (command === "finalize") {
    const teamId = argument("--team-id");
    finalizeArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      teamId,
      argument("--notary-log"),
      argument("--notary-submission-id"),
      argument("--submitted-archive-sha256"),
    );
  } else if (command === "verify-archive") {
    const teamId = argument("--team-id");
    verifyArchiveManifest(
      argument("--archive"),
      argument("--manifest"),
      teamId,
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
    );
  } else if (command === "verify-app") {
    const teamId = argument("--team-id");
    verifyExtractedApp(argument("--app"), argument("--manifest"), teamId);
  } else if (command === "verify-active") {
    const teamId = argument("--team-id");
    verifyActiveApp(argument("--app"), argument("--manifest"), teamId);
  } else if (command === "assert-release") {
    assertExpectedRelease(
      argument("--manifest"),
      argument("--manifest-sha256"),
      argument("--source-sha"),
      argument("--version"),
    );
  } else if (command === "assert-transition") {
    assertInstallTransition(argument("--existing-app"), argument("--manifest"));
  } else if (command === "requirement-digest") {
    requirementDigest(argument("--app"));
  } else if (command === "verify-filesystem-tree") {
    assertFilesystemTree(argument("--path"), Number(argument("--uid")));
  } else if (command === "fsync-tree") {
    fsyncTree(argument("--path"));
  } else if (command === "fsync-directory") {
    fsyncDirectory(argument("--path"));
  } else if (command === "journal-write") {
    writeDurableJournal(argument("--journal"), journalArgument());
  } else if (command === "journal-get") {
    journalGet(argument("--journal"), argument("--field"));
  } else if (command === "journal-recover") {
    recoverJournal(argument("--journal"));
  } else if (command === "manifest-get") {
    manifestGet(argument("--manifest"), argument("--field"));
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
