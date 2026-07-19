import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";

export type NativeMetadata = {
  dev: bigint;
  ino: bigint;
  uid: number;
  mode: number;
  nlink: number;
  size: bigint;
  type: "file" | "directory" | "symlink" | "special";
};

export type NativeHandle = object;

export type NativeFsGuard = {
  openTrustedHome(path: string, uid: number): NativeHandle;
  openDirAt(parent: NativeHandle, leaf: string): NativeHandle;
  openRegularAt(
    parent: NativeHandle,
    leaf: string,
    access: "read" | "createExclusive",
  ): NativeHandle;
  readDir(directory: NativeHandle): string[];
  statHandle(handle: NativeHandle): NativeMetadata;
  statAt(parent: NativeHandle, leaf: string): NativeMetadata | null;
  mkdirAt(parent: NativeHandle, leaf: string, mode: number): NativeHandle;
  linkNoReplaceAt(
    sourceParent: NativeHandle,
    sourceLeaf: string,
    destinationParent: NativeHandle,
    destinationLeaf: string,
  ): boolean;
  renameNoReplaceAt(
    sourceParent: NativeHandle,
    sourceLeaf: string,
    destinationParent: NativeHandle,
    destinationLeaf: string,
  ): void;
  renameHandleNoReplaceAt(
    sourceParent: NativeHandle,
    sourceLeaf: string,
    source: NativeHandle,
    destinationParent: NativeHandle,
    destinationLeaf: string,
  ): void;
  renameReplaceAt(
    sourceParent: NativeHandle,
    sourceLeaf: string,
    destinationParent: NativeHandle,
    destinationLeaf: string,
  ): void;
  unlinkFileAt(parent: NativeHandle, leaf: string): void;
  unlinkDirAt(parent: NativeHandle, leaf: string): void;
  sameBinding(parent: NativeHandle, leaf: string, child: NativeHandle): boolean;
  fsyncHandle(handle: NativeHandle): void;
  handleHasNoExtendedAcl(handle: NativeHandle): boolean;
  chmodHandle(handle: NativeHandle, mode: number): void;
  writeFileAt(parent: NativeHandle, leaf: string, contents: Buffer, mode: number): void;
  readRegularAt(parent: NativeHandle, leaf: string, maximumBytes: number): Buffer;
  sha256RegularAt(parent: NativeHandle, leaf: string): string;
  sha256Handle(handle: NativeHandle): string;
  copyRegularNoReplaceAt(
    sourceParent: NativeHandle,
    sourceLeaf: string,
    destinationParent: NativeHandle,
    destinationLeaf: string,
    temporaryLeaf: string,
    crashDuringCopy: boolean,
    crashAfterPublish: boolean,
  ): boolean;
  removeTreeAt(parent: NativeHandle, leaf: string): void;
  removeTreeHandleAt(parent: NativeHandle, leaf: string, directory: NativeHandle): void;
  unlinkFileHandleAt(parent: NativeHandle, leaf: string, file: NativeHandle): void;
  close(handle: NativeHandle): void;
};

let loadedGuard: NativeFsGuard | undefined;

function addonPath(): string {
  if (process.platform === "darwin") {
    return join(
      dirname(fileURLToPath(import.meta.url)),
      "native",
      "prebuilds",
      "darwin-universal",
      "recordings_fs_guard.node",
    );
  }
  const testOverride = process.env.RECORDINGS_TEST_FS_GUARD_ADDON;
  if (testOverride) {
    if (!isAbsolute(testOverride)) {
      throw new Error("native filesystem guard test addon path must be absolute");
    }
    return testOverride;
  }
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    ".cache",
    "recordings-native-fs-guard",
    "recordings_fs_guard.node",
  );
}

export function nativeFsGuard(): NativeFsGuard {
  if (loadedGuard) return loadedGuard;
  const path = addonPath();
  const details = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    uid === undefined ||
    details.uid !== uid ||
    (details.mode & 0o022) !== 0
  ) {
    throw new Error("native filesystem guard has an unsafe type, owner, or mode");
  }
  const loaded = createRequire(import.meta.url)(path) as Partial<NativeFsGuard>;
  for (const name of [
    "openTrustedHome",
    "openDirAt",
    "openRegularAt",
    "readDir",
    "statHandle",
    "statAt",
    "mkdirAt",
    "linkNoReplaceAt",
    "renameNoReplaceAt",
    "renameHandleNoReplaceAt",
    "renameReplaceAt",
    "unlinkFileAt",
    "unlinkDirAt",
    "sameBinding",
    "fsyncHandle",
    "handleHasNoExtendedAcl",
    "chmodHandle",
    "writeFileAt",
    "readRegularAt",
    "sha256RegularAt",
    "sha256Handle",
    "copyRegularNoReplaceAt",
    "removeTreeAt",
    "removeTreeHandleAt",
    "unlinkFileHandleAt",
    "close",
  ] as const) {
    if (typeof loaded[name] !== "function") {
      throw new Error(`native filesystem guard is missing ${name}`);
    }
  }
  loadedGuard = loaded as NativeFsGuard;
  return loadedGuard;
}
