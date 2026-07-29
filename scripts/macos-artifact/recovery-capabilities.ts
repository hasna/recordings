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

import { sha256, sortUnsignedUtf8 } from "./common";
import { InstallJournal } from "./journal";

export type RecoveryCapabilities = {
  guard: NativeFsGuard;
  home: NativeHandle;
  applications: NativeHandle;
  hasna: NativeHandle;
  data: NativeHandle;
  transaction?: NativeHandle;
  transactionApps?: NativeHandle;
  stateBackup?: NativeHandle;
};

export function closeRecoveryCapabilities(capabilities: RecoveryCapabilities): void {
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

export function assertNativeBinding(
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

export function recoveryTestBarrier(name: string, detail: string, readyDetail = detail): void {
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

export function quarantineRemoveRetainedAt(
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

export function openProvenDirectoryAt(
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

export function openProvenRegularAt(
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

export function openRecoveryCapabilities(
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

export function nativeTreeDigest(guard: NativeFsGuard, root: NativeHandle): string {
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

export function nativeRegularTreeDigest(
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

export function nativeTreeDigestAt(
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

export function assertInstallCapabilityBindings(
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

export function fsyncRetainedTree(
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

export function installTransitionTestPoint(
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


