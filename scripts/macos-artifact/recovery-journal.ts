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

import { sha256 } from "./common";
import { INSTALL_JOURNAL_LEAF, InstallJournal, readJournal, writeDurableJournalAt } from "./journal";
import { assertNativeBinding, closeRecoveryCapabilities, nativeTreeDigest, nativeTreeDigestAt, openProvenDirectoryAt, openProvenRegularAt, openRecoveryCapabilities, quarantineRemoveRetainedAt, recoveryTestBarrier } from "./recovery-capabilities";
import { cleanupInstallCandidateStaging, copyNativeDirectoryTree } from "./recovery-install";
import { assertInstallerOwnedStateEvidenceNative, originalDestinationCapability, removeInstallerOwnedStateArchivesNative, restoreStatePreservingDatabase } from "./recovery-state";

export function recoverJournal(path: string): void {
  const journal = readJournal(path);
  const mutationPhases = new Set([
    "processes-stopped",
    "state-mutating",
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
    "state-restored",
  ]);
  const cleanupOnly = journal.phase === "committed" || journal.phase === "rollback-complete";
  if (mutationPhases.has(journal.phase) &&
    journal.database_rollback !== "preserve-canonical-inode") {
    throw new Error(
      "legacy install transaction cannot safely restore state without replacing the canonical database",
    );
  }
  if (mutationPhases.has(journal.phase) &&
    journal.non_database_rollback !== "preserve-safe-live-writes") {
    throw new Error(
      "legacy install transaction cannot safely merge post-snapshot non-database writes",
    );
  }
  const capabilities = openRecoveryCapabilities(journal, cleanupOnly);
  const { guard, applications } = capabilities;
  const transactionLeaf = basename(journal.transaction_dir);
  const originalBackupHandles = new Map<string, NativeHandle>();
  try {
    if (cleanupOnly) {
      cleanupInstallCandidateStaging(journal, capabilities);
      if (guard.statAt(applications, transactionLeaf) !== null) {
        if (!capabilities.transaction) {
          throw new Error("install transaction cleanup capability is missing");
        }
        recoveryTestBarrier("before-transaction-cleanup", transactionLeaf);
        assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        assertNativeBinding(
          guard,
          applications,
          transactionLeaf,
          capabilities.transaction,
          "transaction root",
        );
        quarantineRemoveRetainedAt(
          guard,
          applications,
          transactionLeaf,
          capabilities.transaction,
          "transaction root",
        );
        guard.close(capabilities.transaction);
        capabilities.transaction = undefined;
      }
      recoveryTestBarrier("after-transaction-remove", transactionLeaf);
      if (guard.statAt(applications, INSTALL_JOURNAL_LEAF) !== null) {
        if (journal.schema_version !== 9) {
          throw new Error("legacy cleanup journal lacks retained deletion evidence");
        }
        const journalDetails = guard.statAt(applications, INSTALL_JOURNAL_LEAF);
        if (!journalDetails || journalDetails.type !== "file") {
          throw new Error("cleanup journal has an unsafe type");
        }
        const journalDigest = sha256(
          `f\0.\0${journalDetails.mode.toString(8)}\0${journalDetails.size}\0${sha256(`${JSON.stringify(journal)}\n`)}`,
        );
        const retainedJournal = openProvenRegularAt(
          guard,
          applications,
          INSTALL_JOURNAL_LEAF,
          journalDigest,
          "cleanup journal",
        );
        try {
          quarantineRemoveRetainedAt(
            guard,
            applications,
            INSTALL_JOURNAL_LEAF,
            retainedJournal,
            "cleanup journal",
          );
        } finally {
          guard.close(retainedJournal);
        }
      }
      return;
    }
    if (!capabilities.transaction || !capabilities.transactionApps || !capabilities.stateBackup) {
      throw new Error("install transaction recovery evidence is missing");
    }
    if (nativeTreeDigest(guard, capabilities.stateBackup) !== journal.state_backup_sha256) {
      throw new Error("install transaction state backup integrity check failed");
    }
    cleanupInstallCandidateStaging(journal, capabilities);
    for (const entry of journal.originals) {
      if (resolve(dirname(entry.backup)) !== resolve(join(journal.transaction_dir, "apps"))) {
        throw new Error("install transaction app backup path is outside the app-backup capability");
      }
      const backupLeaf = basename(entry.backup);
      const backupDetails = guard.statAt(capabilities.transactionApps, backupLeaf);
      if (backupDetails !== null) {
        if (backupDetails.type !== "directory") {
          throw new Error("install transaction app backup has an unsafe type");
        }
        const backup = guard.openDirAt(capabilities.transactionApps, backupLeaf);
        assertNativeBinding(
          guard,
          capabilities.transactionApps,
          backupLeaf,
          backup,
          "app backup",
        );
        const backupDigest = nativeTreeDigest(guard, backup);
        if (backupDigest !== entry.sha256) {
          guard.close(backup);
          throw new Error("install transaction app backup integrity check failed");
        }
        originalBackupHandles.set(backupLeaf, backup);
        continue;
      }
      const destination = originalDestinationCapability(journal, capabilities, entry.path);
      if (nativeTreeDigestAt(guard, destination.parent, destination.leaf) !== entry.sha256) {
        throw new Error("install transaction app backup is missing");
      }
    }
    if (mutationPhases.has(journal.phase)) {
      assertInstallerOwnedStateEvidenceNative(journal, capabilities);
      const canonicalOriginal = journal.originals.find(
        (entry) => resolve(entry.path) === resolve(journal.app_destination),
      );
      const canonicalDestinationDigest = canonicalOriginal
        ? nativeTreeDigestAt(guard, applications, "Recordings.app")
        : null;
      const canonicalAlreadyRestored = canonicalOriginal !== undefined &&
        canonicalDestinationDigest === canonicalOriginal.sha256;
      if (
        ["candidate-moving", "candidate-installed", "activated", "launching"].includes(journal.phase) &&
        !canonicalAlreadyRestored && guard.statAt(applications, "Recordings.app") !== null
      ) {
        if (journal.schema_version !== 9 || !journal.candidate_tree_sha256) {
          throw new Error("legacy recovery journal cannot prove the uncommitted candidate tree");
        }
        recoveryTestBarrier("before-candidate-remove", "Recordings.app");
        assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        const candidate = openProvenDirectoryAt(
          guard,
          applications,
          "Recordings.app",
          journal.candidate_tree_sha256,
          "uncommitted candidate",
        );
        try {
          quarantineRemoveRetainedAt(
            guard,
            applications,
            "Recordings.app",
            candidate,
            "uncommitted candidate",
          );
        } finally {
          guard.close(candidate);
        }
      }
      let restoredCount = 0;
      for (const entry of [...journal.originals].reverse()) {
        const backupLeaf = basename(entry.backup);
        const destination = originalDestinationCapability(journal, capabilities, entry.path);
        if (nativeTreeDigestAt(guard, destination.parent, destination.leaf) === entry.sha256) {
          continue;
        }
        const backup = originalBackupHandles.get(backupLeaf);
        if (!backup) throw new Error("install transaction app backup is missing");
        if (guard.statAt(destination.parent, destination.leaf) !== null) {
          throw new Error("original app destination contains an unproven concurrent replacement");
        }
        const restoredLeaf = `.Recordings-app-restore.${randomUUID()}`;
        const restored = copyNativeDirectoryTree(
          guard,
          backup,
          capabilities.transactionApps,
          restoredLeaf,
        );
        if (nativeTreeDigest(guard, restored) !== entry.sha256) {
          quarantineRemoveRetainedAt(
            guard,
            capabilities.transactionApps,
            restoredLeaf,
            restored,
            "failed restored app staging tree",
          );
          guard.close(restored);
          throw new Error("retained app backup copy failed integrity verification");
        }
        recoveryTestBarrier("before-app-publish", destination.leaf);
        assertNativeBinding(
          guard,
          capabilities.transaction!,
          "apps",
          capabilities.transactionApps,
          "app backups",
        );
        assertNativeBinding(guard, capabilities.transactionApps, backupLeaf, backup, "app backup");
        assertNativeBinding(
          guard,
          capabilities.transactionApps,
          restoredLeaf,
          restored,
          "restored app staging tree",
        );
        if (destination.parent === applications) {
          assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
        } else {
          assertNativeBinding(guard, capabilities.hasna, "recordings", capabilities.data, "state root");
        }
        guard.renameHandleNoReplaceAt(
          capabilities.transactionApps,
          restoredLeaf,
          restored,
          destination.parent,
          destination.leaf,
        );
        guard.close(restored);
        guard.fsyncHandle(capabilities.transactionApps);
        guard.fsyncHandle(destination.parent);
        restoredCount += 1;
        if (
          process.platform !== "darwin" &&
          process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
          process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_APP_RESTORES === String(restoredCount)
        ) {
          process.kill(process.pid, "SIGKILL");
        }
      }
      restoreStatePreservingDatabase(journal, capabilities);
    }
    const stateMode = journal.original_state_mode ?? "700";
    const stateDetails = guard.statHandle(capabilities.data);
    if (!new Set([0o700, Number.parseInt(stateMode, 8)]).has(stateDetails.mode)) {
      throw new Error("state recovery found an unexpected state-root mode");
    }
    guard.chmodHandle(capabilities.data, Number.parseInt(stateMode, 8));
    guard.fsyncHandle(capabilities.hasna);

    const stateRestoredJournal: InstallJournal = {
      ...journal,
      schema_version: journal.schema_version === 9 ? 9 : 8,
      phase: "state-restored",
    };
    writeDurableJournalAt(guard, applications, INSTALL_JOURNAL_LEAF, stateRestoredJournal);
    if (
      process.platform !== "darwin" &&
      process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
      process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_STATE_RESTORED_JOURNAL === "1"
    ) {
      process.kill(process.pid, "SIGKILL");
    }
    removeInstallerOwnedStateArchivesNative(stateRestoredJournal, capabilities);
    if (
      process.platform !== "darwin" &&
      process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
      process.env.RECORDINGS_TEST_CRASH_RECOVERY_AFTER_ARCHIVE_UNLINK === "1"
    ) {
      process.kill(process.pid, "SIGKILL");
    }

    const completedJournal: InstallJournal = {
      ...stateRestoredJournal,
      schema_version: stateRestoredJournal.schema_version === 9 ? 9 : 8,
      phase: "rollback-complete",
    };
    writeDurableJournalAt(guard, applications, INSTALL_JOURNAL_LEAF, completedJournal);

    guard.close(capabilities.stateBackup);
    capabilities.stateBackup = undefined;
    guard.close(capabilities.transactionApps);
    capabilities.transactionApps = undefined;
    recoveryTestBarrier("before-transaction-cleanup", transactionLeaf);
    assertNativeBinding(guard, capabilities.home, "Applications", applications, "Applications");
    quarantineRemoveRetainedAt(
      guard,
      applications,
      transactionLeaf,
      capabilities.transaction,
      "transaction root",
    );
    guard.close(capabilities.transaction);
    capabilities.transaction = undefined;
    recoveryTestBarrier("after-transaction-remove", transactionLeaf);
    const completedJournalDetails = guard.statAt(applications, INSTALL_JOURNAL_LEAF);
    if (!completedJournalDetails || completedJournalDetails.type !== "file") {
      throw new Error("completed cleanup journal has an unsafe type");
    }
    const completedJournalTreeDigest = sha256(
      `f\0.\0${completedJournalDetails.mode.toString(8)}\0${completedJournalDetails.size}\0${sha256(`${JSON.stringify(completedJournal)}\n`)}`,
    );
    const retainedCompletedJournal = openProvenRegularAt(
      guard,
      applications,
      INSTALL_JOURNAL_LEAF,
      completedJournalTreeDigest,
      "completed cleanup journal",
    );
    try {
      quarantineRemoveRetainedAt(
        guard,
        applications,
        INSTALL_JOURNAL_LEAF,
        retainedCompletedJournal,
        "completed cleanup journal",
      );
    } finally {
      guard.close(retainedCompletedJournal);
    }
  } finally {
    for (const backup of originalBackupHandles.values()) {
      try {
        guard.close(backup);
      } catch {
        // A retained backup can already be closed only during exceptional cleanup.
      }
    }
    closeRecoveryCapabilities(capabilities);
  }
}

export function cleanupPreJournalTransaction(path: string, nonce: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error("pre-journal transaction nonce is invalid");
  }
  const transaction = resolve(path);
  const applicationsPath = dirname(transaction);
  const homePath = dirname(applicationsPath);
  const leaf = basename(transaction);
  if (basename(applicationsPath) !== "Applications" ||
    !/^\.Recordings-transaction\.[A-Za-z0-9._-]+$/.test(leaf)) {
    throw new Error("pre-journal transaction path is outside canonical Applications");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine transaction owner identity");
  const guard = nativeFsGuard();
  const home = guard.openTrustedHome(homePath, uid);
  let applications: NativeHandle | undefined;
  let retained: NativeHandle | undefined;
  try {
    applications = guard.openDirAt(home, "Applications");
    assertNativeBinding(guard, home, "Applications", applications, "Applications");
    retained = guard.openDirAt(applications, leaf);
    assertNativeBinding(guard, applications, leaf, retained, "pre-journal transaction");
    const details = guard.statHandle(retained);
    if (details.uid !== uid || details.mode !== 0o700) {
      throw new Error(
        `pre-journal transaction has an unsafe owner or mode (uid=${details.uid}, mode=${details.mode.toString(8)})`,
      );
    }
    const proof = guard.readRegularAt(retained, ".Recordings-transaction-owner", 128);
    if (proof.toString("utf8") !== `${nonce}\n`) {
      throw new Error("pre-journal transaction ownership evidence does not match");
    }
    quarantineRemoveRetainedAt(
      guard,
      applications,
      leaf,
      retained,
      "pre-journal transaction",
    );
  } finally {
    if (retained) guard.close(retained);
    if (applications) guard.close(applications);
    guard.close(home);
  }
}


