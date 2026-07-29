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

import { APP_ENTITLEMENTS, ArtifactPolicy, HELPER_ENTITLEMENTS, LEGACY_LOCAL_TARGET_IDENTITY_KIND, LOCAL_ARTIFACT_SCHEMA_VERSION, MacOSArtifactManifest, NestedCodeItem, OperatorTargetIdentityKind, SigningEvidence, TargetIdentityKind, UPDATE_CLIENT_ENTITLEMENTS, compareUnsignedUtf8, readRegularFilePrefix, sha256 } from "./common";
import { architectures, signingEvidence } from "./artifacts";

export function isHex(value: string, length: number): boolean {
  return new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

export function manifestPolicy(manifest: MacOSArtifactManifest): ArtifactPolicy {
  return manifest.schema_version === LOCAL_ARTIFACT_SCHEMA_VERSION ? "local_only" : "release";
}

export function manifestTargetIdentityKind(manifest: MacOSArtifactManifest): OperatorTargetIdentityKind {
  if (manifestPolicy(manifest) === "release") return "none";
  return manifest.approved_target_identity_kind ?? LEGACY_LOCAL_TARGET_IDENTITY_KIND;
}

export function manifestBuilderIdentityKind(manifest: MacOSArtifactManifest): OperatorTargetIdentityKind {
  if (manifestPolicy(manifest) === "release") return "none";
  return manifest.builder_identity_kind ?? LEGACY_LOCAL_TARGET_IDENTITY_KIND;
}

export function isTargetIdentityKind(value: unknown): value is TargetIdentityKind {
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

export function nestedItems(
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

export function nestedPolicyDigest(items: NestedCodeItem[]): string {
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

export function assertRegularArchiveTree(root: string): void {
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

export type ZipEntry = {
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

export function zipEntryPayload(archive: Buffer, entry: ZipEntry): Buffer {
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

export function canonicalZipCollisionKey(value: string): string {
  // NFKC catches compatibility-equivalent spellings. The two replacements are
  // the most common differences between lower-casing and Unicode case-folding.
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
}

export function assertCanonicalZipEntries(entries: Array<{ name: string; isDirectory: boolean }>): void {
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

export function decodeCanonicalZipName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    throw new Error("release ZIP uses an ambiguous legacy filename encoding");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("release ZIP contains an invalid UTF-8 entry name");
  }
}

export function assertZipExtraFields(extra: Buffer): void {
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


