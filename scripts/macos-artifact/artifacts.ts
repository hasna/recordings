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

import { ArtifactPolicy, CODESIGN_EXECUTABLE, GIT_EXECUTABLE, JSON_INPUT_LIMIT_BYTES, LIPO_EXECUTABLE, PLUTIL_EXECUTABLE, PROVENANCE_FILENAME, SigningEvidence, compareUnsignedUtf8, readRegularFileBounded, sha256, sha256RegularFile, sortUnsignedUtf8 } from "./common";
import { ZIP_EXTRACTION_LIMITS, isHex } from "./layout";
import { fsyncDirectory } from "./journal";

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

export function sha256ArchiveFile(path: string): string {
  return sha256RegularFile(
    path,
    "release ZIP",
    ZIP_EXTRACTION_LIMITS.archiveBytes,
    "release ZIP exceeds the compressed archive size limit",
  );
}

export function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function runWithEnvironment(command: string, args: string[], environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function plistValue(appPath: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist"),
  ]).trim();
}

export function architectures(executablePath: string): string[] {
  return sortUnsignedUtf8(
    run(LIPO_EXECUTABLE, ["-archs", executablePath]).trim().split(/\s+/).filter(Boolean),
  );
}

export function signingDetails(codePath: string): string {
  return run(CODESIGN_EXECUTABLE, ["-d", "--verbose=4", codePath]);
}

export function lineValue(details: string, key: string): string {
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

export function assertCurrentSourceRevision(packageRoot: string, expectedSourceSha: string): void {
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

export function canonicalEntitlements(codePath: string): string {
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

export function signingEvidence(
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

export function companionVersion(companionPath: string): string {
  return run(companionPath, ["--version"]).trim().split(/\s+/).at(-1) ?? "";
}

export function provenancePath(appPath: string): string {
  return join(appPath, "Contents", "Resources", PROVENANCE_FILENAME);
}

export function readJson<T>(path: string): T {
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

export function writeJson(path: string, value: unknown): void {
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


