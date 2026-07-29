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
import { RecoveryCapabilities, assertNativeBinding, nativeRegularTreeDigest, openProvenRegularAt, quarantineRemoveRetainedAt, recoveryTestBarrier } from "./recovery-capabilities";

export function originalDestinationCapability(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
  path: string,
): { parent: NativeHandle; leaf: string } {
  const resolved = resolve(path);
  if (resolved === resolve(journal.app_destination)) {
    return { parent: capabilities.applications, leaf: "Recordings.app" };
  }
  if (resolved === resolve(join(journal.data_dir, "Recordings.app"))) {
    return { parent: capabilities.data, leaf: "Recordings.app" };
  }
  if (
    dirname(resolved) === resolve(journal.app_parent) &&
    /^Recordings\.app\.[A-Za-z0-9._-]+$/.test(basename(resolved))
  ) {
    return { parent: capabilities.applications, leaf: basename(resolved) };
  }
  throw new Error("install transaction journal has an unsafe original app destination");
}

export const PRESERVED_DATABASE_ENTRIES = new Set([
  "recordings.db",
  "recordings.db-wal",
  "recordings.db-shm",
]);

export function assertInstallerOwnedStateEvidenceNative(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  const { guard, data, stateBackup } = capabilities;
  if (!stateBackup) throw new Error("state recovery capability is unavailable");
  for (const entry of PRESERVED_DATABASE_ENTRIES) {
    const details = guard.statAt(data, entry);
    if (details !== null && details.type !== "file") {
      throw new Error("state recovery found an unsafe canonical database entry");
    }
  }
  const rollbackEntries = journal.installer_owned_state ?? [];
  if (rollbackEntries.length === 0) return;
  const backupRollbacksMetadata = guard.statAt(stateBackup, "rollbacks");
  if (backupRollbacksMetadata?.type === "directory") {
    const backupRollbacks = guard.openDirAt(stateBackup, "rollbacks");
    try {
      for (const entry of rollbackEntries) {
        if (guard.statAt(backupRollbacks, basename(entry.path)) !== null) {
          throw new Error("installer-owned state path already existed in the stopped snapshot");
        }
      }
    } finally {
      guard.close(backupRollbacks);
    }
  } else if (backupRollbacksMetadata !== null) {
    throw new Error("state backup contains an unsafe rollback path");
  }
  const liveRollbacksMetadata = guard.statAt(data, "rollbacks");
  if (liveRollbacksMetadata === null && journal.phase === "state-restored") return;
  if (liveRollbacksMetadata?.type !== "directory") {
    throw new Error("installer-owned state rollback parent is missing or unsafe");
  }
  const rollbacks = guard.openDirAt(data, "rollbacks");
  try {
    assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
    for (const entry of rollbackEntries) {
      if (resolve(dirname(entry.path)) !== resolve(join(journal.data_dir, "rollbacks"))) {
        throw new Error("installer-owned state path is outside the rollback capability");
      }
      const leaf = basename(entry.path);
      const details = guard.statAt(rollbacks, leaf);
      if (!details && journal.phase === "state-restored") continue;
      if (!details || nativeRegularTreeDigest(guard, rollbacks, leaf, details) !== entry.sha256) {
        throw new Error("installer-owned state artifact changed before rollback");
      }
    }
  } finally {
    guard.close(rollbacks);
  }
}

export function removeInstallerOwnedStateArchivesNative(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  const { guard, data } = capabilities;
  const rollbackEntries = journal.installer_owned_state ?? [];
  if (rollbackEntries.length === 0) return;
  const rollbackParent = guard.statAt(data, "rollbacks");
  if (rollbackParent === null) return;
  if (rollbackParent.type !== "directory") {
    throw new Error("installer-owned state rollback parent is unsafe");
  }
  const rollbacks = guard.openDirAt(data, "rollbacks");
  let removedParent = false;
  try {
    assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
    for (const entry of rollbackEntries) {
      if (resolve(dirname(entry.path)) !== resolve(join(journal.data_dir, "rollbacks"))) {
        throw new Error("installer-owned state path is outside the rollback capability");
      }
      const leaf = basename(entry.path);
      const details = guard.statAt(rollbacks, leaf);
      if (!details) continue;
      if (details.type !== "file") {
        throw new Error("installer-owned state artifact changed before rollback");
      }
      const archive = openProvenRegularAt(
        guard,
        rollbacks,
        leaf,
        entry.sha256,
        "installer-owned state artifact",
      );
      recoveryTestBarrier("before-archive-unlink", leaf);
      try {
        assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        assertNativeBinding(guard, data, "rollbacks", rollbacks, "rollback archive parent");
        quarantineRemoveRetainedAt(
          guard,
          rollbacks,
          leaf,
          archive,
          "installer-owned state artifact",
        );
      } finally {
        guard.close(archive);
      }
    }
    if (
      capabilities.stateBackup &&
      guard.statAt(capabilities.stateBackup, "rollbacks") === null &&
      guard.readDir(rollbacks).length === 0
    ) {
      quarantineRemoveRetainedAt(
        guard,
        data,
        "rollbacks",
        rollbacks,
        "empty installer rollback directory",
      );
      removedParent = true;
    }
  } finally {
    guard.close(rollbacks);
  }
  if (!removedParent) guard.fsyncHandle(data);
}

export function restoreStatePreservingDatabase(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  if (journal.non_database_rollback !== "preserve-safe-live-writes") {
    throw new Error("legacy destructive state restore is disabled");
  }
  const { guard, data, stateBackup } = capabilities;
  if (!stateBackup) throw new Error("state recovery capability is unavailable");
  const recoveryScope = sha256(
    `${resolve(journal.state_backup)}\0${resolve(journal.data_dir)}`,
  ).slice(0, 16);
  const hooksEnabled = process.platform !== "darwin" &&
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1";

  const isRecoveryTemporary = (entry: string, destinationLeaf: string): boolean => {
    const prefix = `.${destinationLeaf}.recordings-recovery.${recoveryScope}.`;
    return entry.startsWith(prefix) && entry.endsWith(".tmp") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(entry.slice(prefix.length, -4));
  };
  const removeRecoveryTemporaries = (directory: NativeHandle, destinationLeaf: string): void => {
    let removed = false;
    for (const entry of guard.readDir(directory)) {
      if (!isRecoveryTemporary(entry, destinationLeaf)) continue;
      const details = guard.statAt(directory, entry);
      if (!details || details.type !== "file" || details.uid !== process.getuid?.()) {
        throw new Error("state recovery found an unsafe recovery temporary");
      }
      const temporary = openProvenRegularAt(
        guard,
        directory,
        entry,
        nativeRegularTreeDigest(guard, directory, entry, details),
        "state recovery temporary",
      );
      try {
        quarantineRemoveRetainedAt(
          guard,
          directory,
          entry,
          temporary,
          "state recovery temporary",
        );
      } finally {
        guard.close(temporary);
      }
      removed = true;
    }
    if (removed) guard.fsyncHandle(directory);
  };

  const restoreMissingEntries = (
    backupDirectory: NativeHandle,
    liveDirectory: NativeHandle,
    relativeDirectory: string,
    liveBindings: Array<{ parent: NativeHandle; leaf: string; child: NativeHandle }> = [],
  ): void => {
    assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
    for (const entry of sortUnsignedUtf8(guard.readDir(backupDirectory))) {
      if (!relativeDirectory && PRESERVED_DATABASE_ENTRIES.has(entry)) continue;
      const source = guard.statAt(backupDirectory, entry);
      if (!source) throw new Error("state backup changed during recovery");
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const destination = guard.statAt(liveDirectory, entry);
      if (source.type === "file") {
        removeRecoveryTemporaries(liveDirectory, entry);
        if (destination !== null) continue;
        recoveryTestBarrier("before-file-publish", relativePath);
        assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        for (const binding of liveBindings) {
          assertNativeBinding(
            guard,
            binding.parent,
            binding.leaf,
            binding.child,
            "live state ancestor",
          );
        }
        if (
          hooksEnabled &&
          process.env.RECORDINGS_TEST_RECOVERY_BEFORE_FILE_PUBLISH === relativePath
        ) {
          const ready = process.env.RECORDINGS_TEST_RECOVERY_PUBLISH_READY_FIFO;
          const resume = process.env.RECORDINGS_TEST_RECOVERY_PUBLISH_RESUME_FIFO;
          if (!ready || !resume) {
            throw new Error("recovery publish test barrier requires ready and resume FIFOs");
          }
          writeFileSync(ready, `${relativePath}\n`);
          readFileSync(resume);
          assertNativeBinding(guard, capabilities.hasna, "recordings", data, "state root");
        }
        const temporary = `.${entry}.recordings-recovery.${recoveryScope}.${randomUUID()}.tmp`;
        guard.copyRegularNoReplaceAt(
          backupDirectory,
          entry,
          liveDirectory,
          entry,
          temporary,
          hooksEnabled &&
            process.env.RECORDINGS_TEST_CRASH_RECOVERY_DURING_FILE_COPY === relativePath,
          hooksEnabled &&
            process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_FILE_PUBLISH === relativePath,
        );
        continue;
      }
      if (source.type !== "directory") {
        throw new Error(`state recovery refuses special backup entry: ${relativePath}`);
      }
      if (destination !== null && destination.type !== "directory") continue;
      let liveChild: NativeHandle;
      if (destination === null) {
        liveChild = guard.mkdirAt(liveDirectory, entry, source.mode & 0o777);
        guard.fsyncHandle(liveChild);
        guard.fsyncHandle(liveDirectory);
      } else {
        recoveryTestBarrier("before-nested-open", relativePath);
        liveChild = guard.openDirAt(liveDirectory, entry);
      }
      const backupChild = guard.openDirAt(backupDirectory, entry);
      try {
        assertNativeBinding(guard, backupDirectory, entry, backupChild, "state backup directory");
        assertNativeBinding(guard, liveDirectory, entry, liveChild, "live state directory");
        restoreMissingEntries(
          backupChild,
          liveChild,
          relativePath,
          [...liveBindings, { parent: liveDirectory, leaf: entry, child: liveChild }],
        );
      } finally {
        guard.close(backupChild);
        guard.close(liveChild);
      }
    }
  };
  restoreMissingEntries(stateBackup, data, "");

  for (const entry of ["audio", "rollbacks"]) {
    if (guard.statAt(stateBackup, entry) !== null) continue;
    const live = guard.statAt(data, entry);
    if (!live || live.type !== "directory") continue;
    const directory = guard.openDirAt(data, entry);
    try {
      assertNativeBinding(guard, data, entry, directory, "installer-created state directory");
      if (guard.readDir(directory).length === 0) {
        quarantineRemoveRetainedAt(
          guard,
          data,
          entry,
          directory,
          "empty installer-created state directory",
        );
        continue;
      }
    } finally {
      try {
        guard.close(directory);
      } catch {
        // The empty-directory path closes before unlinking.
      }
    }
  }
  guard.fsyncHandle(data);
}


