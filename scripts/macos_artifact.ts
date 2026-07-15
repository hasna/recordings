#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const BUNDLE_ID = "com.hasna.recordings";
export const PROVENANCE_FILENAME = "recordings-build-provenance.json";

export type BuildProvenance = {
  schema_version: 1;
  bundle_id: string;
  bundle_version: string;
  git_sha: string;
  architectures: string[];
  team_id: string;
  companion: {
    version: string;
    sha256: string;
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
    designated_requirement_sha256: string;
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

function signingEvidence(codePath: string, expectedTeamId: string): SigningEvidence {
  run("codesign", ["--verify", "--strict", "--verbose=2", codePath]);
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
  if (!/flags=.*\(runtime\)/m.test(details)) {
    throw new Error(`${codePath} is missing hardened runtime signing`);
  }
  if (!timestamp || timestamp.toLowerCase() === "none") {
    throw new Error(`${codePath} is missing a trusted signing timestamp`);
  }
  const requirementOutput = run("codesign", ["-d", "-r-", codePath]);
  const designatedRequirement = parseDesignatedRequirement(requirementOutput);
  return { authority, teamId, timestamp, designatedRequirement };
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertManifestShape(manifest: MacOSArtifactManifest): void {
  if (manifest.schema_version !== ARTIFACT_SCHEMA_VERSION) throw new Error("unsupported manifest schema");
  if (manifest.artifact_type !== "recordings-macos-app") throw new Error("unexpected artifact type");
  if (manifest.bundle_id !== BUNDLE_ID) throw new Error("unexpected bundle identifier");
  for (const [label, value] of [
    ["bundle version", manifest.bundle_version],
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
    ["companion version", manifest.companion?.version],
    ["companion hash", manifest.companion?.sha256],
  ] as const) {
    if (!value || typeof value !== "string") throw new Error(`manifest is missing ${label}`);
  }
  if (!Array.isArray(manifest.architectures) || manifest.architectures.length === 0) {
    throw new Error("manifest is missing architectures");
  }
  if (
    !manifest.signing.authority.startsWith("Developer ID Application:") ||
    !manifest.signing.helper_authority.startsWith("Developer ID Application:")
  ) {
    throw new Error("manifest requires Developer ID Application signing authorities");
  }
}

export function verifyArchiveManifest(
  archivePath: string,
  manifestPath: string,
  expectedTeamId: string,
): MacOSArtifactManifest {
  if (!expectedTeamId) throw new Error("expected Team ID is required");
  const manifest = readJson<MacOSArtifactManifest>(manifestPath);
  assertManifestShape(manifest);
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
  if (!sameStrings([...provenance.architectures].sort(), [...manifest.architectures].sort())) {
    throw new Error("signed provenance architecture mismatch");
  }
  if (
    provenance.companion.version !== manifest.companion.version ||
    provenance.companion.sha256 !== manifest.companion.sha256
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
  const outerSigning = signingEvidence(appPath, expectedTeamId);
  const helperSigning = signingEvidence(helperPath, expectedTeamId);

  if (plistValue(appPath, "CFBundleIdentifier") !== manifest.bundle_id) {
    throw new Error("installed bundle identifier does not match the manifest");
  }
  if (plistValue(appPath, "CFBundleShortVersionString") !== manifest.bundle_version) {
    throw new Error("installed bundle version does not match the manifest");
  }
  if (!sameStrings(architectures(executablePath), [...manifest.architectures].sort())) {
    throw new Error("installed app architectures do not match the manifest");
  }
  if (sha256File(executablePath) !== manifest.app_sha256) throw new Error("app hash mismatch");
  if (sha256File(helperPath) !== manifest.companion.sha256) throw new Error("companion hash mismatch");
  if (companionVersion(helperPath) !== manifest.companion.version) {
    throw new Error("companion version mismatch");
  }
  if (sha256File(embeddedPath) !== manifest.provenance_sha256) {
    throw new Error("signed provenance checksum mismatch");
  }
  assertProvenanceMatchesManifest(provenance, manifest);

  const requirementHash = sha256(outerSigning.designatedRequirement);
  if (requirementHash !== manifest.signing.designated_requirement_sha256) {
    throw new Error("designated requirement mismatch");
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
    git_sha: run("git", ["-C", packageRoot, "rev-parse", "HEAD"]).trim(),
    architectures: architectures(executablePath),
    team_id: expectedTeamId,
    companion: {
      version: companionVersion(helperPath),
      sha256: sha256File(helperPath),
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
): void {
  const executablePath = join(appPath, "Contents", "MacOS", "Recordings");
  const helperPath = join(appPath, "Contents", "Helpers", "recordings");
  const embeddedPath = provenancePath(appPath);
  const provenance = readJson<BuildProvenance>(embeddedPath);
  const outerSigning = signingEvidence(appPath, expectedTeamId);
  const helperSigning = signingEvidence(helperPath, expectedTeamId);
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
      designated_requirement_sha256: sha256(outerSigning.designatedRequirement),
    },
    archive: {
      filename: basename(archivePath),
      sha256: sha256File(archivePath),
    },
  };
  assertManifestShape(manifest);
  writeJson(manifestPath, manifest);
  verifyArchiveManifest(archivePath, manifestPath, expectedTeamId);
  verifyExtractedApp(appPath, manifestPath, expectedTeamId);
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function main(): void {
  const command = Bun.argv[2];
  const teamId = argument("--team-id");
  if (command === "provenance") {
    writeProvenance(argument("--app"), teamId, argument("--package-root"));
  } else if (command === "finalize") {
    finalizeArtifact(
      argument("--app"),
      argument("--archive"),
      argument("--manifest"),
      teamId,
    );
  } else if (command === "verify-archive") {
    verifyArchiveManifest(argument("--archive"), argument("--manifest"), teamId);
  } else if (command === "verify-app") {
    verifyExtractedApp(argument("--app"), argument("--manifest"), teamId);
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
