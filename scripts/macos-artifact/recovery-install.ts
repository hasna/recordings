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
import { isHex } from "./layout";
import { InstallJournal, readJournal } from "./journal";
import { assertSecurePublicationDirectory } from "./publication-state";
import { RecoveryCapabilities, assertInstallCapabilityBindings, assertNativeBinding, closeRecoveryCapabilities, fsyncRetainedTree, installTransitionTestPoint, nativeTreeDigest, openProvenDirectoryAt, openRecoveryCapabilities, quarantineRemoveRetainedAt } from "./recovery-capabilities";
import { originalDestinationCapability } from "./recovery-state";

export function archiveInstallOriginal(
  journalPath: string,
  sourcePath: string,
  destinationPath: string,
  expectedDigest: string,
): void {
  const journal = readJournal(journalPath);
  if (journal.schema_version !== 9 || journal.phase !== "originals-moving") {
    throw new Error("original archival requires the durable originals-moving journal");
  }
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  const original = journal.originals.find(
    (entry) => resolve(entry.path) === source && resolve(entry.backup) === destination,
  );
  if (!original || original.sha256 !== expectedDigest || !isHex(expectedDigest, 64)) {
    throw new Error("original archival does not match durable journal evidence");
  }
  if (dirname(destination) !== resolve(join(journal.transaction_dir, "apps"))) {
    throw new Error("original archival destination is outside the app-backup capability");
  }
  const capabilities = openRecoveryCapabilities(journal);
  const { guard } = capabilities;
  let retained: NativeHandle | undefined;
  try {
    assertInstallCapabilityBindings(journal, capabilities);
    const sourceCapability = originalDestinationCapability(journal, capabilities, source);
    const destinationLeaf = basename(destination);
    if (guard.statAt(capabilities.transactionApps!, destinationLeaf) !== null) {
      throw new Error("original archival destination already exists");
    }
    retained = guard.openDirAt(sourceCapability.parent, sourceCapability.leaf);
    assertNativeBinding(
      guard,
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      "original app source",
    );
    if (nativeTreeDigest(guard, retained) !== expectedDigest) {
      throw new Error("original app source does not match durable journal evidence");
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("could not determine installer owner identity");
    fsyncRetainedTree(guard, retained, uid, "original app source");
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      "original app source",
    );
    if (guard.statAt(capabilities.transactionApps!, destinationLeaf) !== null) {
      throw new Error("original archival destination appeared before publication");
    }
    installTransitionTestPoint(
      "archive-original",
      "before-rename",
      `${source}\t${destination}`,
    );
    guard.renameHandleNoReplaceAt(
      sourceCapability.parent,
      sourceCapability.leaf,
      retained,
      capabilities.transactionApps!,
      destinationLeaf,
    );
    installTransitionTestPoint(
      "archive-original",
      "after-rename",
      `${source}\t${destination}`,
    );
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.transactionApps!,
      destinationLeaf,
      retained,
      "archived original app",
    );
    if (guard.statAt(sourceCapability.parent, sourceCapability.leaf) !== null) {
      throw new Error("original app source leaf was recreated during archival");
    }
    guard.fsyncHandle(capabilities.transactionApps!);
    installTransitionTestPoint(
      "archive-original",
      "after-destination-fsync",
      `${source}\t${destination}`,
    );
    guard.fsyncHandle(sourceCapability.parent);
    installTransitionTestPoint(
      "archive-original",
      "after-source-fsync",
      `${source}\t${destination}`,
    );
  } finally {
    if (retained) guard.close(retained);
    closeRecoveryCapabilities(capabilities);
  }
}

export function publishInstallCandidate(
  journalPath: string,
  stagingPath: string,
  destinationPath: string,
  expectedDigest: string,
): void {
  const journal = readJournal(journalPath);
  if (
    journal.schema_version !== 9 ||
    journal.phase !== "candidate-moving" ||
    journal.candidate_tree_sha256 !== expectedDigest ||
    resolve(journal.candidate_staging ?? "") !== resolve(dirname(stagingPath)) ||
    !isHex(expectedDigest, 64)
  ) {
    throw new Error("candidate publication does not match durable journal evidence");
  }
  const staging = resolve(stagingPath);
  const destination = resolve(destinationPath);
  const stagingParentPath = dirname(staging);
  const stagingParentLeaf = basename(stagingParentPath);
  if (
    destination !== resolve(journal.app_destination) ||
    basename(staging) !== "Recordings.app" ||
    dirname(stagingParentPath) !== resolve(journal.app_parent) ||
    !/^\.Recordings-install\.[A-Za-z0-9]+$/.test(stagingParentLeaf)
  ) {
    throw new Error("candidate publication paths are outside canonical installer capabilities");
  }
  const capabilities = openRecoveryCapabilities(journal);
  const { guard } = capabilities;
  let stagingParent: NativeHandle | undefined;
  let retained: NativeHandle | undefined;
  try {
    assertInstallCapabilityBindings(journal, capabilities);
    stagingParent = guard.openDirAt(capabilities.applications, stagingParentLeaf);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("could not determine installer owner identity");
    assertSecurePublicationDirectory(guard, stagingParent, uid, "candidate staging parent");
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingParentLeaf,
      stagingParent,
      "candidate staging parent",
    );
    retained = guard.openDirAt(stagingParent, "Recordings.app");
    assertNativeBinding(guard, stagingParent, "Recordings.app", retained, "staged candidate");
    if (nativeTreeDigest(guard, retained) !== expectedDigest) {
      throw new Error("staged candidate does not match durable journal evidence");
    }
    if (guard.statAt(capabilities.applications, "Recordings.app") !== null) {
      throw new Error("candidate destination already exists");
    }
    fsyncRetainedTree(guard, retained, uid, "staged candidate");
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingParentLeaf,
      stagingParent,
      "candidate staging parent",
    );
    assertNativeBinding(guard, stagingParent, "Recordings.app", retained, "staged candidate");
    if (guard.statAt(capabilities.applications, "Recordings.app") !== null) {
      throw new Error("candidate destination appeared before publication");
    }
    installTransitionTestPoint(
      "publish-candidate",
      "before-rename",
      `${staging}\t${destination}`,
    );
    guard.renameHandleNoReplaceAt(
      stagingParent,
      "Recordings.app",
      retained,
      capabilities.applications,
      "Recordings.app",
    );
    installTransitionTestPoint(
      "publish-candidate",
      "after-rename",
      `${staging}\t${destination}`,
    );
    assertInstallCapabilityBindings(journal, capabilities);
    assertNativeBinding(
      guard,
      capabilities.applications,
      "Recordings.app",
      retained,
      "published candidate",
    );
    if (guard.statAt(stagingParent, "Recordings.app") !== null) {
      throw new Error("candidate staging leaf was recreated during publication");
    }
    guard.fsyncHandle(capabilities.applications);
    installTransitionTestPoint(
      "publish-candidate",
      "after-destination-fsync",
      `${staging}\t${destination}`,
    );
    guard.fsyncHandle(stagingParent);
    installTransitionTestPoint(
      "publish-candidate",
      "after-source-fsync",
      `${staging}\t${destination}`,
    );
  } finally {
    if (retained) guard.close(retained);
    if (stagingParent) guard.close(stagingParent);
    closeRecoveryCapabilities(capabilities);
  }
}

export function cleanupInstallCandidateStaging(
  journal: InstallJournal,
  capabilities: RecoveryCapabilities,
): void {
  if (!journal.candidate_staging) return;
  const { guard } = capabilities;
  const stagingLeaf = basename(journal.candidate_staging);
  const metadata = guard.statAt(capabilities.applications, stagingLeaf);
  if (metadata === null) return;
  if (metadata.type !== "directory") {
    throw new Error("candidate staging root has an unsafe type");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine installer owner identity");
  const staging = guard.openDirAt(capabilities.applications, stagingLeaf);
  try {
    assertSecurePublicationDirectory(guard, staging, uid, "candidate staging root");
    assertNativeBinding(
      guard,
      capabilities.applications,
      stagingLeaf,
      staging,
      "candidate staging root",
    );
    const candidateMetadata = guard.statAt(staging, "Recordings.app");
    if (candidateMetadata !== null) {
      if (journal.schema_version !== 9 || !journal.candidate_tree_sha256) {
        throw new Error("legacy journal cannot authenticate candidate staging cleanup");
      }
      const candidate = openProvenDirectoryAt(
        guard,
        staging,
        "Recordings.app",
        journal.candidate_tree_sha256,
        "staged candidate",
      );
      try {
        quarantineRemoveRetainedAt(
          guard,
          staging,
          "Recordings.app",
          candidate,
          "staged candidate",
        );
      } finally {
        guard.close(candidate);
      }
    }
    if (guard.readDir(staging).length !== 0) {
      throw new Error("candidate staging root contains unauthenticated recovery evidence");
    }
    assertInstallCapabilityBindings(journal, capabilities, false);
    quarantineRemoveRetainedAt(
      guard,
      capabilities.applications,
      stagingLeaf,
      staging,
      "candidate staging root",
    );
  } finally {
    guard.close(staging);
  }
}

export function copyNativeDirectoryTree(
  guard: NativeFsGuard,
  source: NativeHandle,
  destinationParent: NativeHandle,
  destinationLeaf: string,
): NativeHandle {
  const sourceRoot = guard.statHandle(source);
  if (sourceRoot.type !== "directory") throw new Error("app backup is not a directory");
  const destination = guard.mkdirAt(destinationParent, destinationLeaf, sourceRoot.mode);
  const copyContents = (sourceDirectory: NativeHandle, destinationDirectory: NativeHandle): void => {
    for (const entry of sortUnsignedUtf8(guard.readDir(sourceDirectory))) {
      const details = guard.statAt(sourceDirectory, entry);
      if (!details) throw new Error("app backup changed during retained copy");
      if (details.type === "file") {
        guard.copyRegularNoReplaceAt(
          sourceDirectory,
          entry,
          destinationDirectory,
          entry,
          `.${entry}.recordings-app-copy.${randomUUID()}.tmp`,
          false,
          false,
        );
        continue;
      }
      if (details.type !== "directory") {
        throw new Error("app backup contains an unsafe special entry");
      }
      const sourceChild = guard.openDirAt(sourceDirectory, entry);
      const destinationChild = guard.mkdirAt(destinationDirectory, entry, details.mode);
      try {
        assertNativeBinding(guard, sourceDirectory, entry, sourceChild, "app backup child");
        copyContents(sourceChild, destinationChild);
        guard.fsyncHandle(destinationChild);
      } finally {
        guard.close(destinationChild);
        guard.close(sourceChild);
      }
    }
    guard.fsyncHandle(destinationDirectory);
  };
  try {
    copyContents(source, destination);
    guard.fsyncHandle(destinationParent);
    return destination;
  } catch (error) {
    try {
      quarantineRemoveRetainedAt(
        guard,
        destinationParent,
        destinationLeaf,
        destination,
        "failed retained app staging tree",
      );
    } finally {
      guard.close(destination);
    }
    throw error;
  }
}


