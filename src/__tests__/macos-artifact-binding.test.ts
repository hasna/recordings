import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  assertCanonicalZipEntryListing,
  assertPinnedSourceRevision,
  assertRegularZipEntryTypes,
  HASH_IO_CHUNK_BYTES,
  inspectZipArchive,
  parseAuthenticatedManifestSnapshot,
  readAuthenticatedManifest,
  sha256File,
  ZIP_EXTRACTION_LIMITS,
  withPrivatelyExtractedArchiveApp,
  verifyAndExtractArchiveDescriptors,
  writeManifestAtomically,
} from "../../scripts/macos_artifact";

const temporaryDirectories: string[] = [];

type MinimalZipEntry = {
  name: string;
  type?: "file" | "directory" | "symlink" | "fifo";
  compressedBytes?: number;
  uncompressedBytes?: number;
  method?: 0 | 8;
};

function writeMinimalZip(entries: MinimalZipEntry[]): string {
  const root = mkdtempSync(join(tmpdir(), "recordings-minimal-zip-test-"));
  temporaryDirectories.push(root);
  const archivePath = join(root, "Recordings.zip");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const type = entry.type ?? (entry.name.endsWith("/") ? "directory" : "file");
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 0;
    const compressedBytes = entry.compressedBytes ?? 0;
    const uncompressedBytes = entry.uncompressedBytes ?? compressedBytes;
    const local = Buffer.alloc(30 + name.length + compressedBytes);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressedBytes, 18);
    local.writeUInt32LE(uncompressedBytes, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressedBytes, 20);
    central.writeUInt32LE(uncompressedBytes, 24);
    central.writeUInt16LE(name.length, 28);
    const modes = { file: 0o100644, directory: 0o040755, symlink: 0o120777, fifo: 0o010644 };
    central.writeUInt32LE((modes[type] << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralSize = centrals.reduce((size, value) => size + value.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  writeFileSync(archivePath, Buffer.concat([...locals, ...centrals, eocd]));
  return archivePath;
}

type GeneratedPayloadZipOptions = {
  corruptDataDescriptor?: boolean;
  compressedPayloadTransform?: (payload: Buffer) => Buffer;
  declaredCrc32?: number;
  declaredUncompressedBytes?: number;
  trailingCompressedBytes?: Buffer;
  useDataDescriptor?: boolean;
};

function writeGeneratedPayloadZip(
  payload: Buffer,
  options: GeneratedPayloadZipOptions = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "recordings-generated-zip-test-"));
  temporaryDirectories.push(root);
  const archivePath = join(root, "Recordings.zip");
  const records = [
    {
      name: "Recordings.app/",
      type: "directory" as const,
      compressedPayload: Buffer.alloc(0),
      crc: 0,
      uncompressedBytes: 0,
    },
    {
      name: "Recordings.app/Contents/payload",
      type: "file" as const,
      compressedPayload: Buffer.concat([
        options.compressedPayloadTransform?.(deflateRawSync(payload)) ?? deflateRawSync(payload),
        options.trailingCompressedBytes ?? Buffer.alloc(0),
      ]),
      crc: options.declaredCrc32 ?? crc32(payload),
      uncompressedBytes: options.declaredUncompressedBytes ?? payload.length,
      useDataDescriptor: options.useDataDescriptor ?? false,
      corruptDataDescriptor: options.corruptDataDescriptor ?? false,
    },
  ];
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const record of records) {
    const name = Buffer.from(record.name, "utf8");
    const method = record.type === "directory" ? 0 : 8;
    const useDataDescriptor = "useDataDescriptor" in record && record.useDataDescriptor;
    const descriptor = Buffer.alloc(useDataDescriptor ? 16 : 0);
    if (useDataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(
        (("corruptDataDescriptor" in record && record.corruptDataDescriptor) ? record.crc + 1 : record.crc) >>> 0,
        4,
      );
      descriptor.writeUInt32LE(record.compressedPayload.length, 8);
      descriptor.writeUInt32LE(record.uncompressedBytes, 12);
    }
    const local = Buffer.alloc(30 + name.length + record.compressedPayload.length + descriptor.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800 | (useDataDescriptor ? 0x0008 : 0), 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(useDataDescriptor ? 0 : record.crc >>> 0, 14);
    local.writeUInt32LE(useDataDescriptor ? 0 : record.compressedPayload.length, 18);
    local.writeUInt32LE(useDataDescriptor ? 0 : record.uncompressedBytes, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    record.compressedPayload.copy(local, 30 + name.length);
    descriptor.copy(local, 30 + name.length + record.compressedPayload.length);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800 | (useDataDescriptor ? 0x0008 : 0), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(record.crc >>> 0, 16);
    central.writeUInt32LE(record.compressedPayload.length, 20);
    central.writeUInt32LE(record.uncompressedBytes, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = record.type === "directory" ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);

    localRecords.push(local);
    centralRecords.push(central);
    localOffset += local.length;
  }
  const centralSize = centralRecords.reduce((size, value) => size + value.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  writeFileSync(archivePath, Buffer.concat([...localRecords, ...centralRecords, eocd]));
  return archivePath;
}

function writeOverlappingGeneratedZip(): string {
  const archivePath = writeGeneratedPayloadZip(Buffer.from("overlap-bound payload"));
  const archive = readFileSync(archivePath);
  const eocdOffset = archive.length - 22;
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  // Stretch the first (directory) record one byte into the second local
  // record, while keeping its local and central declarations consistent.
  archive.writeUInt32LE(1, 18);
  archive.writeUInt32LE(1, 22);
  archive.writeUInt32LE(1, centralOffset + 20);
  archive.writeUInt32LE(1, centralOffset + 24);
  writeFileSync(archivePath, archive);
  return archivePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function archiveFixture(mutation = ""): {
  archivePath: string;
  archiveTool: string;
} {
  const root = mkdtempSync(join(tmpdir(), "recordings-artifact-binding-test-"));
  temporaryDirectories.push(root);
  const archivePath = join(root, "Recordings.zip");
  const archiveTool = join(root, "ditto");
  const sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "Recordings.app", "Contents"), { recursive: true });
  writeFileSync(join(sourceRoot, "Recordings.app", "Contents", "payload"), "payload");
  const zipResult = Bun.spawnSync(
    ["/usr/bin/zip", "-q", "-r", archivePath, "Recordings.app"],
    { cwd: sourceRoot },
  );
  if (zipResult.exitCode !== 0) throw new Error(zipResult.stderr.toString());
  writeFileSync(
    archiveTool,
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "-x" ] && [ "\${2:-}" = "-k" ]
destination="\${4}"
mkdir -p "$destination/Recordings.app/Contents"
printf payload > "$destination/Recordings.app/Contents/payload"
${mutation}
`,
  );
  chmodSync(archiveTool, 0o755);
  return { archivePath, archiveTool };
}

describe("macOS release artifact binding", () => {
  test("verifies and extracts through inherited archive/output descriptors without spawning tools", () => {
    const { archivePath } = archiveFixture();
    const output = mkdtempSync(join(tmpdir(), "recordings-verifier-output-"));
    temporaryDirectories.push(output);
    chmodSync(output, 0o700);
    const archiveDescriptor = openSync(archivePath, constants.O_RDONLY);
    const outputDescriptor = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      verifyAndExtractArchiveDescriptors(
        archiveDescriptor,
        outputDescriptor,
        sha256File(archivePath),
      );
    } finally {
      closeSync(outputDescriptor);
      closeSync(archiveDescriptor);
    }
    expect(readFileSync(join(output, "Recordings.app", "Contents", "payload"), "utf8")).toBe("payload");
  });

  test("rejects an over-limit sparse ZIP before allocating or reading its contents", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-over-limit-zip-test-"));
    temporaryDirectories.push(root);
    const archivePath = join(root, "Recordings.zip");
    writeFileSync(archivePath, "not a ZIP");
    truncateSync(archivePath, ZIP_EXTRACTION_LIMITS.archiveBytes + 1);

    expect(() => inspectZipArchive(archivePath)).toThrow(
      "compressed archive size limit",
    );

    const source = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "utf8",
    );
    const boundedReaderSource = source.slice(
      source.indexOf("function readRegularFileBounded"),
      source.indexOf("export function sha256File"),
    );
    expect(boundedReaderSource.indexOf("openRegularFile")).toBeGreaterThanOrEqual(0);
    expect(boundedReaderSource.indexOf("snapshot.size > maximumBytes")).toBeGreaterThan(
      boundedReaderSource.indexOf("openRegularFile"),
    );
    expect(boundedReaderSource.indexOf("Buffer.allocUnsafe")).toBeGreaterThan(
      boundedReaderSource.indexOf("snapshot.size > maximumBytes"),
    );
    const inspectSource = source.slice(
      source.indexOf("export function inspectZipArchive"),
      source.indexOf("export function withPrivatelyExtractedArchiveApp"),
    );
    expect(inspectSource).toContain("readRegularFileBounded");
    expect(inspectSource).not.toContain("readFileSync(archivePath)");
  });

  test("hashes a large state tree deterministically with fixed-size reads", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-large-tree-digest-test-"));
    temporaryDirectories.push(root);
    const statePath = join(root, "recordings.db");
    const stateBytes = HASH_IO_CHUNK_BYTES * 5 + 137;
    writeFileSync(statePath, "");
    truncateSync(statePath, stateBytes);

    const zeroChunk = Buffer.alloc(HASH_IO_CHUNK_BYTES);
    const fileHasher = new Bun.CryptoHasher("sha256");
    for (let remaining = stateBytes; remaining > 0;) {
      const count = Math.min(remaining, zeroChunk.length);
      fileHasher.update(zeroChunk.subarray(0, count));
      remaining -= count;
    }
    const fileDigest = fileHasher.digest("hex");
    expect(sha256File(statePath)).toBe(fileDigest);

    const rootMode = (lstatSync(root).mode & 0o777).toString(8);
    const fileMode = (lstatSync(statePath).mode & 0o777).toString(8);
    const expectedTreeDigest = Bun.CryptoHasher.hash(
      "sha256",
      `d\0.\0${rootMode}\nf\0recordings.db\0${fileMode}\0${stateBytes}\0${fileDigest}`,
      "hex",
    );
    const artifactTool = join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts");
    const result = Bun.spawnSync([
      process.execPath,
      artifactTool,
      "tree-digest",
      "--path",
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expectedTreeDigest);

    const source = readFileSync(artifactTool, "utf8");
    expect(HASH_IO_CHUNK_BYTES).toBeLessThan(stateBytes);
    expect(source).not.toContain("return sha256(readFileSync(path))");
    expect(source).toMatch(/readSync\(\s*descriptor,\s*buffer/u);
  });

  test("refuses to hash through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-hash-symlink-test-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "trusted bytes");
    symlinkSync(target, link);
    expect(() => sha256File(link)).toThrow("regular file");
  });

  test("requires a clean HEAD that exactly matches the pinned pre-build SHA", () => {
    const sourceSha = "a".repeat(40);
    expect(() => assertPinnedSourceRevision(sourceSha, "\n", sourceSha)).not.toThrow();
    expect(() => assertPinnedSourceRevision(sourceSha, " M tracked.ts\n", sourceSha)).toThrow(
      "dirty source worktree",
    );
    expect(() => assertPinnedSourceRevision(sourceSha, "", "b".repeat(40))).toThrow(
      "does not match the pinned source SHA",
    );
    expect(() => assertPinnedSourceRevision("A".repeat(40), "", "A".repeat(40))).toThrow(
      "full lowercase commit SHA",
    );
  });

  test("rejects duplicate, colliding, and noncanonical ZIP entry listings", () => {
    expect(() =>
      assertCanonicalZipEntryListing(
        "Recordings.app/\nRecordings.app/Contents/\nRecordings.app/Contents/payload\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalZipEntryListing(
        "Recordings.app/\nRecordings.app/Contents/payload\nRecordings.app/Contents/payload\n",
      ),
    ).toThrow("duplicate");
    expect(() =>
      assertCanonicalZipEntryListing(
        "Recordings.app/\nRecordings.app/Contents/../outside\n",
      ),
    ).toThrow("canonical Recordings.app tree");
    expect(() => assertCanonicalZipEntryListing("Other.app/\n")).toThrow(
      "canonical Recordings.app tree",
    );
    expect(() =>
      assertRegularZipEntryTypes(
        "drwxr-xr-x  entry\n-rw-r--r--  entry\n",
        2,
      ),
    ).not.toThrow();
    expect(() => assertRegularZipEntryTypes("lrwxr-xr-x  entry\n", 1)).toThrow(
      "symlink or special",
    );
    expect(() => assertRegularZipEntryTypes("prw-r--r--  entry\n", 1)).toThrow(
      "symlink or special",
    );
  });

  test.each([
    ["absolute path", ["Recordings.app/", "/Recordings.app/Contents/payload"], "noncanonical"],
    ["traversal", ["Recordings.app/", "Recordings.app/../payload"], "canonical Recordings.app tree"],
    ["duplicate", ["Recordings.app/", "Recordings.app/payload", "Recordings.app/payload"], "duplicate"],
    ["case-fold collision", ["Recordings.app/", "Recordings.app/Payload", "Recordings.app/payload"], "case-fold"],
    ["Unicode collision", ["Recordings.app/", "Recordings.app/Ｋey", "Recordings.app/Key"], "Unicode-colliding"],
    ["file/directory collision", ["Recordings.app/", "Recordings.app/item", "Recordings.app/item/"], "file/directory"],
  ])("rejects a ZIP with a canonical-name %s", (_label, names, message) => {
    const archivePath = writeMinimalZip((names as string[]).map((name) => ({ name })));
    expect(() => inspectZipArchive(archivePath)).toThrow(message as string);
  });

  test.each([
    ["symlink", "symlink"],
    ["special FIFO", "fifo"],
  ] as const)("rejects a ZIP with a %s entry before extraction", (_label, type) => {
    const archivePath = writeMinimalZip([
      { name: "Recordings.app/", type: "directory" },
      { name: "Recordings.app/payload", type },
    ]);
    expect(() => inspectZipArchive(archivePath)).toThrow("symlink, special");
  });

  test("rejects conservative entry-count and expansion limits before extraction", () => {
    const tooManyEntries = [
      { name: "Recordings.app/", type: "directory" as const },
      ...Array.from({ length: 8192 }, (_, index) => ({
        name: `Recordings.app/d${index}/`,
        type: "directory" as const,
      })),
    ];
    expect(() => inspectZipArchive(writeMinimalZip(tooManyEntries))).toThrow("entry count");
    expect(() =>
      inspectZipArchive(
        writeMinimalZip([
          { name: "Recordings.app/", type: "directory" },
          {
            name: "Recordings.app/bomb",
            compressedBytes: 1,
            uncompressedBytes: 201,
            method: 8,
          },
        ]),
      ),
    ).toThrow("compression ratio");
    expect(() =>
      inspectZipArchive(
        writeMinimalZip([
          { name: "Recordings.app/", type: "directory" },
          {
            name: "Recordings.app/huge",
            compressedBytes: 2 * 1024 * 1024,
            uncompressedBytes: 256 * 1024 * 1024 + 1,
            method: 8,
          },
        ]),
      ),
    ).toThrow("uncompressed size");
  });

  test("validates every exact stored and deflated payload before extraction", () => {
    const payload = Buffer.from("exact release archive payload\n".repeat(32));
    const entries = inspectZipArchive(writeGeneratedPayloadZip(payload));
    expect(entries.map(({ name, compressedBytes, uncompressedBytes }) => ({
      name,
      compressedBytes,
      uncompressedBytes,
    }))).toEqual([
      { name: "Recordings.app/", compressedBytes: 0, uncompressedBytes: 0 },
      {
        name: "Recordings.app/Contents/payload",
        compressedBytes: deflateRawSync(payload).length,
        uncompressedBytes: payload.length,
      },
    ]);
  });

  test("rejects a real deflated payload with a corrupted CRC32 declaration", () => {
    const payload = Buffer.from("crc-bound payload");
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(payload, {
          declaredCrc32: (crc32(payload) + 1) >>> 0,
        }),
      ),
    ).toThrow("payload CRC32");
  });

  test("rejects a real deflated payload whose declared size does not match", () => {
    const payload = Buffer.from("size-bound payload");
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(payload, {
          declaredUncompressedBytes: payload.length + 1,
        }),
      ),
    ).toThrow("declared uncompressed size");
  });

  test("bounds real deflate expansion by the declared output size", () => {
    const expandingPayload = Buffer.alloc(1024 * 1024, 0x41);
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(expandingPayload, {
          declaredUncompressedBytes: 1,
        }),
      ),
    ).toThrow("malformed or exceeds its declared size");
  });

  test("rejects trailing bytes after an otherwise valid deflate stream", () => {
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(Buffer.from("exact compressed stream"), {
          trailingCompressedBytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
        }),
      ),
    ).toThrow("trailing or unconsumed payload bytes");
  });

  test("rejects a malformed real deflate stream", () => {
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(Buffer.from("malformed compressed stream"), {
          compressedPayloadTransform: (payload) => payload.subarray(0, payload.length - 2),
        }),
      ),
    ).toThrow("payload is malformed");
  });

  test("accepts a valid data descriptor and rejects a corrupted one", () => {
    const payload = Buffer.from("descriptor-bound payload");
    expect(() =>
      inspectZipArchive(writeGeneratedPayloadZip(payload, { useDataDescriptor: true })),
    ).not.toThrow();
    expect(() =>
      inspectZipArchive(
        writeGeneratedPayloadZip(payload, {
          useDataDescriptor: true,
          corruptDataDescriptor: true,
        }),
      ),
    ).toThrow("data descriptor disagrees");
  });

  test("rejects overlapping local records before inflating payloads", () => {
    expect(() => inspectZipArchive(writeOverlappingGeneratedZip())).toThrow(
      "overlapping or unaccounted local entry data",
    );
  });

  test("extracts the exact archive into a private temporary directory and removes it", () => {
    const { archivePath, archiveTool } = archiveFixture();
    let extractedAppPath = "";
    const result = withPrivatelyExtractedArchiveApp(
      archivePath,
      (appPath) => {
        extractedAppPath = appPath;
        expect((lstatSync(dirname(appPath)).mode & 0o777).toString(8)).toBe("700");
        expect(readFileSync(join(appPath, "Contents", "payload"), "utf8")).toBe("payload");
        return "verified";
      },
      archiveTool,
    );
    expect(result).toBe("verified");
    expect(existsSync(extractedAppPath)).toBeFalse();
    expect(() =>
      withPrivatelyExtractedArchiveApp(
        archivePath,
        () => undefined,
        archiveTool,
        "0".repeat(64),
      ),
    ).toThrow("pinned release archive bytes do not match");
  });

  test.each([
    ["an extra top-level entry", 'printf extra > "$destination/extra"', "exactly one top-level"],
    [
      "a symlink",
      'ln -s "$destination/Recordings.app/Contents/payload" "$destination/Recordings.app/Contents/link"',
      "forbidden symlink",
    ],
    ["a special entry", 'mkfifo "$destination/Recordings.app/Contents/pipe"', "forbidden special"],
  ])("rejects archives containing %s", (_label, mutation, message) => {
    const { archivePath, archiveTool } = archiveFixture(mutation);
    expect(() => withPrivatelyExtractedArchiveApp(archivePath, () => undefined, archiveTool)).toThrow(
      message,
    );
  });

  test("writes the manifest atomically and prints an external SHA-256", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-manifest-atomic-test-"));
    temporaryDirectories.push(root);
    const manifestPath = join(root, "Recordings.manifest.json");
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => messages.push(String(message));
    let digest = "";
    try {
      digest = writeManifestAtomically(manifestPath, { artifact: "Recordings", version: 1 });
    } finally {
      console.log = originalLog;
    }
    expect(digest).toBe(sha256File(manifestPath));
    expect(messages).toEqual([`manifest_sha256=${digest}`]);
    expect(readFileSync(manifestPath, "utf8")).not.toContain("manifest_sha256");
    expect(readdirSync(root)).toEqual(["Recordings.manifest.json"]);
    expect(() =>
      writeManifestAtomically(manifestPath, { artifact: "Recordings", version: 2 }),
    ).toThrow();
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual({
      artifact: "Recordings",
      version: 1,
    });
    expect(readdirSync(root)).toEqual(["Recordings.manifest.json"]);
  });

  test("binds manifest authentication and parsing to one bounded file snapshot", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "utf8",
    );
    const manifestConsumers = [
      source.slice(
        source.indexOf("export function verifyArchiveManifest("),
        source.indexOf("function assertProvenanceMatchesManifest("),
      ),
      source.slice(
        source.indexOf("function assertExpectedRelease("),
        source.indexOf("function versionParts("),
      ),
      source.slice(
        source.indexOf("export function verifyExtractedApp("),
        source.indexOf("function assertMatchingAppEvidence("),
      ),
      source.slice(
        source.indexOf("function assertInstallTransition("),
        source.indexOf("function requirementDigest("),
      ),
      source.slice(
        source.indexOf("function manifestGet("),
        source.indexOf("function argument("),
      ),
    ];

    for (const consumer of manifestConsumers) {
      expect(consumer).toContain("readAuthenticatedManifest<MacOSArtifactManifest>(");
      expect(consumer).not.toContain("sha256File(manifestPath)");
      expect(consumer).not.toContain("readJson<MacOSArtifactManifest>(manifestPath)");
    }

    const reader = source.slice(
      source.indexOf("export function readAuthenticatedManifest<"),
      source.indexOf("function writeJson("),
    );
    expect(reader.match(/readRegularFileBounded\(/g)).toHaveLength(1);
    expect(reader).toContain("JSON_INPUT_LIMIT_BYTES");
    expect(reader).toContain("parseAuthenticatedManifestSnapshot<T>(snapshot");

    const root = mkdtempSync(join(tmpdir(), "recordings-manifest-snapshot-test-"));
    temporaryDirectories.push(root);
    const manifestPath = join(root, "Recordings.manifest.json");
    const replacementPath = join(root, "replacement.json");
    writeFileSync(manifestPath, '{"snapshot":"authenticated-a"}\n');
    const authenticatedDigest = sha256File(manifestPath);
    const authenticatedSnapshot = readFileSync(manifestPath);
    writeFileSync(replacementPath, '{"snapshot":"replacement-b"}\n');
    renameSync(replacementPath, manifestPath);

    expect(
      parseAuthenticatedManifestSnapshot<{ snapshot: string }>(
        authenticatedSnapshot,
        authenticatedDigest,
      ),
    ).toEqual({ snapshot: "authenticated-a" });
    expect(() =>
      readAuthenticatedManifest<{ snapshot: string }>(manifestPath, authenticatedDigest),
    ).toThrow("manifest checksum does not match the authenticated operator value");

    const oversizedPath = join(root, "oversized.json");
    writeFileSync(oversizedPath, "{}");
    truncateSync(oversizedPath, 16 * 1024 * 1024 + 1);
    expect(() => readAuthenticatedManifest(oversizedPath, "0".repeat(64))).toThrow(
      "JSON input exceeds the supported size limit",
    );

    const symlinkPath = join(root, "manifest-link.json");
    symlinkSync(manifestPath, symlinkPath);
    expect(() => readAuthenticatedManifest(symlinkPath, authenticatedDigest)).toThrow(
      "regular file",
    );
    expect(() => readAuthenticatedManifest(join(root, "missing.json"), "invalid")).toThrow(
      "manifest checksum does not match the authenticated operator value",
    );
  });

  test("every post-preflight manifest consumer rejects a substituted snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "recordings-manifest-consumer-substitution-test-"));
    temporaryDirectories.push(root);
    const manifestPath = join(root, "Recordings.manifest.json");
    const missingApp = join(root, "Recordings.app");
    writeFileSync(manifestPath, '{"operator":"authenticated"}\n');
    const authenticatedDigest = sha256File(manifestPath);
    writeFileSync(manifestPath, '{"attacker":"substituted"}\n');
    const artifactTool = join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts");
    const commonVerificationArguments = [
      "--app",
      missingApp,
      "--manifest",
      manifestPath,
      "--manifest-sha256",
      authenticatedDigest,
      "--team-id",
      "EXAMPLE123",
      "--artifact-policy",
      "release",
      "--approved-target",
      "fleet",
      "--approved-target-identity-sha256",
      "none",
    ];
    const invocations = [
      ["verify-app", ...commonVerificationArguments],
      ["verify-active", ...commonVerificationArguments],
      [
        "assert-transition",
        "--existing-app",
        missingApp,
        "--manifest",
        manifestPath,
        "--manifest-sha256",
        authenticatedDigest,
      ],
      [
        "manifest-get",
        "--manifest",
        manifestPath,
        "--manifest-sha256",
        authenticatedDigest,
        "--field",
        "version",
      ],
    ];
    for (const invocation of invocations) {
      const result = Bun.spawnSync([process.execPath, artifactTool, ...invocation]);
      expect(result.exitCode, invocation[0]).not.toBe(0);
      expect(result.stderr.toString(), invocation[0]).toContain(
        "manifest checksum does not match the authenticated operator value",
      );
      expect(result.stderr.toString(), invocation[0]).not.toContain("ENOENT");
    }
  });

  test.each(["provenance", "finalize", "finalize-local"])(
    "%s fails closed without an explicit source SHA",
    (command) => {
      const result = Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
        command,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("missing required argument --source-sha");
    },
  );

  test("verification and durability gates precede final manifest publication", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "macos_artifact.ts"),
      "utf8",
    );
    const releaseFinalize = source.slice(
      source.indexOf("function finalizeArtifact("),
      source.indexOf("function finalizeLocalArtifact("),
    );
    const localFinalize = source.slice(
      source.indexOf("function finalizeLocalArtifact("),
      source.indexOf("function assertExpectedRelease("),
    );
    for (const finalizeSource of [releaseFinalize, localFinalize]) {
      expect(finalizeSource.indexOf("verifySuppliedAndArchivedApps(")).toBeGreaterThan(-1);
      expect(finalizeSource.indexOf("assertCurrentSourceRevision(", 1)).toBeGreaterThan(-1);
      expect(finalizeSource.indexOf("writeManifestAtomically(")).toBeGreaterThan(
        finalizeSource.indexOf("verifySuppliedAndArchivedApps("),
      );
    }
    const atomicWriter = source.slice(
      source.indexOf("export function writeManifestAtomically("),
      source.indexOf("function isHex("),
    );
    expect(atomicWriter.indexOf("fsyncSync(descriptor)")).toBeLessThan(
      atomicWriter.indexOf("linkSync(temporaryPath, path)"),
    );
    expect(atomicWriter.indexOf("fsyncDirectory(parent)")).toBeGreaterThan(
      atomicWriter.indexOf("linkSync(temporaryPath, path)"),
    );
    expect(atomicWriter).toContain("unlinkSync(temporaryPath)");
    expect(atomicWriter).toContain("console.log(`manifest_sha256=${digest}`)");
  });
});
