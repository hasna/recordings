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

import { ArtifactPolicy, OperatorTargetIdentityKind, assertRegularFileUnchanged, compareUnsignedUtf8, openRegularFile, readRegularFileBounded, sha256 } from "./common";
import { run, sha256ArchiveFile } from "./artifacts";
import { ZIP_EXTRACTION_LIMITS, ZipEntry, assertCanonicalZipEntries, assertRegularArchiveTree, assertZipExtraFields, decodeCanonicalZipName, zipEntryPayload } from "./layout";
import { verifyArchiveManifest } from "./manifest";

export function inspectZipArchive(archivePath: string): ZipEntry[] {
  const archive = readRegularFileBounded(
    archivePath,
    ZIP_EXTRACTION_LIMITS.archiveBytes,
    "release ZIP",
    "release ZIP exceeds the compressed archive size limit",
  );
  return inspectZipArchiveBytes(archive);
}

export function inspectZipArchiveBytes(archive: Buffer): ZipEntry[] {
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


