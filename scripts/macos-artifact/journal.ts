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

import { ArtifactPolicy, JSON_INPUT_LIMIT_BYTES, LEGACY_LOCAL_TARGET_IDENTITY_KIND, RELEASE_APPROVED_TARGET, TargetIdentityKind, isLocalOnlyApprovedTarget, sha256 } from "./common";
import { isHex, isTargetIdentityKind } from "./layout";
import { nativeRegularTreeDigest, openProvenRegularAt, quarantineRemoveRetainedAt } from "./recovery-capabilities";
import { argument, optionalArgument } from "./cli";

export type InstallJournal = {
  schema_version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  phase: string;
  transaction_dir: string;
  candidate_staging?: string;
  app_parent: string;
  app_destination: string;
  data_dir: string;
  state_backup: string;
  state_backup_sha256: string;
  originals: Array<{ path: string; backup: string; sha256: string }>;
  was_running: boolean;
  prior_running_app_paths?: string[];
  expected_manifest_sha256: string;
  expected_source_sha: string;
  expected_version: string;
  artifact_policy?: ArtifactPolicy;
  approved_target?: string;
  approved_target_identity_kind?: TargetIdentityKind | "none";
  approved_target_identity_sha256?: string;
  builder_identity_kind?: TargetIdentityKind | "none";
  candidate_identity_sha256: string;
  candidate_tree_sha256?: string;
  previous_identity_sha256: string;
  original_state_mode?: "700" | "755";
  database_rollback?: "preserve-canonical-inode";
  non_database_rollback?: "preserve-safe-live-writes";
  installer_owned_state?: Array<{ path: string; sha256: string }>;
};

export const INSTALL_JOURNAL_LEAF = ".Recordings-install-transaction.json";

export function withJournalParent<T>(
  path: string,
  operation: (guard: NativeFsGuard, applications: NativeHandle, leaf: string) => T,
): T {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("could not determine journal owner identity");
  const appParent = resolve(dirname(path));
  const home = resolve(dirname(appParent));
  const leaf = basename(path);
  if (
    basename(appParent) !== "Applications" ||
    leaf !== INSTALL_JOURNAL_LEAF ||
    resolve(path) !== resolve(join(appParent, INSTALL_JOURNAL_LEAF))
  ) {
    throw new Error("install transaction journal is outside the canonical Applications parent");
  }
  const guard = nativeFsGuard();
  const homeHandle = guard.openTrustedHome(home, uid);
  let applications: NativeHandle | undefined;
  try {
    applications = guard.openDirAt(homeHandle, "Applications");
    if (!guard.sameBinding(homeHandle, "Applications", applications)) {
      throw new Error("Applications binding changed while opening the journal");
    }
    return operation(guard, applications, leaf);
  } finally {
    if (applications) guard.close(applications);
    guard.close(homeHandle);
  }
}

export function readJournalSnapshot(path: string): Buffer {
  return withJournalParent(path, (guard, applications, leaf) =>
    guard.readRegularAt(applications, leaf, JSON_INPUT_LIMIT_BYTES));
}

export function writeDurableJournalAt(
  guard: NativeFsGuard,
  applications: NativeHandle,
  leaf: string,
  journal: InstallJournal,
): void {
  const temporary = `${leaf}.tmp-${randomUUID()}`;
  guard.writeFileAt(
    applications,
    temporary,
    Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"),
    0o600,
  );
  guard.fsyncHandle(applications);
  if (
    process.platform !== "darwin" &&
    process.env.RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS === "1" &&
    process.env.RECORDINGS_TEST_CRASH_DURABLE_JOURNAL === "before-rename"
  ) {
    process.kill(process.pid, "SIGKILL");
  }
  guard.renameReplaceAt(applications, temporary, applications, leaf);
  guard.fsyncHandle(applications);
  const prefix = `${leaf}.tmp-`;
  for (const entry of guard.readDir(applications)) {
    if (!entry.startsWith(prefix) || entry === temporary) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) {
      continue;
    }
    const details = guard.statAt(applications, entry);
    if (!details || details.type !== "file" || details.uid !== process.getuid?.() || details.mode !== 0o600) {
      throw new Error("durable journal found an unsafe stale temporary");
    }
    const staleTemporary = openProvenRegularAt(
      guard,
      applications,
      entry,
      nativeRegularTreeDigest(guard, applications, entry, details),
      "durable journal stale temporary",
    );
    try {
      quarantineRemoveRetainedAt(
        guard,
        applications,
        entry,
        staleTemporary,
        "durable journal stale temporary",
      );
    } finally {
      guard.close(staleTemporary);
    }
  }
  guard.fsyncHandle(applications);
}

export function writeDurableJournal(path: string, journal: InstallJournal): void {
  if (resolve(journal.app_parent) !== resolve(dirname(path))) {
    throw new Error("install transaction journal parent does not match the durable target");
  }
  withJournalParent(path, (guard, applications, leaf) => {
    writeDurableJournalAt(guard, applications, leaf, journal);
  });
}

export function journalArgument(): InstallJournal {
  const originalStateMode = argument("--original-state-mode");
  if (originalStateMode !== "700" && originalStateMode !== "755") {
    throw new Error("install transaction journal has an invalid original state mode");
  }
  const value: InstallJournal = {
    schema_version: 9,
    phase: argument("--phase"),
    transaction_dir: argument("--transaction-dir"),
    candidate_staging: optionalArgument("--candidate-staging"),
    app_parent: argument("--app-parent"),
    app_destination: argument("--app-destination"),
    data_dir: argument("--data-dir"),
    state_backup: argument("--state-backup"),
    state_backup_sha256: argument("--state-backup-sha256"),
    originals: [],
    was_running: Bun.argv.includes("--was-running"),
    prior_running_app_paths: [],
    expected_manifest_sha256: argument("--expected-manifest-sha256"),
    expected_source_sha: argument("--expected-source-sha"),
    expected_version: argument("--expected-version"),
    artifact_policy: argument("--artifact-policy") as ArtifactPolicy,
    approved_target: argument("--approved-target"),
    approved_target_identity_kind: argument("--approved-target-identity-kind") as
      | TargetIdentityKind
      | "none",
    approved_target_identity_sha256: argument("--approved-target-identity-sha256"),
    builder_identity_kind: argument("--builder-identity-kind") as TargetIdentityKind | "none",
    candidate_identity_sha256: argument("--candidate-identity-sha256"),
    candidate_tree_sha256: argument("--candidate-tree-sha256"),
    previous_identity_sha256: argument("--previous-identity-sha256"),
    original_state_mode: originalStateMode,
    database_rollback: "preserve-canonical-inode",
    non_database_rollback: "preserve-safe-live-writes",
    installer_owned_state: [],
  };
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] === "--original") {
      const path = Bun.argv[index + 1];
      const backup = Bun.argv[index + 2];
      const digest = Bun.argv[index + 3];
      if (!path || !backup || !digest) throw new Error("--original requires path, backup, and digest");
      value.originals.push({ path, backup, sha256: digest });
    } else if (Bun.argv[index] === "--prior-running-app-path") {
      const path = Bun.argv[index + 1];
      if (!path) throw new Error("--prior-running-app-path requires a path");
      value.prior_running_app_paths?.push(path);
    } else if (Bun.argv[index] === "--installer-owned-state") {
      const path = Bun.argv[index + 1];
      const digest = Bun.argv[index + 2];
      if (!path || !digest) {
        throw new Error("--installer-owned-state requires a path and digest");
      }
      value.installer_owned_state?.push({ path, sha256: digest });
    }
  }
  return value;
}

export function readJournal(path: string): InstallJournal {
  const journal = JSON.parse(readJournalSnapshot(path).toString("utf8")) as InstallJournal;
  if (
    (journal.schema_version !== 2 && journal.schema_version !== 3 &&
      journal.schema_version !== 4 && journal.schema_version !== 5 &&
      journal.schema_version !== 6 && journal.schema_version !== 7 &&
      journal.schema_version !== 8 && journal.schema_version !== 9) ||
    !journal.transaction_dir ||
    !journal.phase
  ) {
    throw new Error("invalid install transaction journal");
  }
  const allowedPhases = new Set([
    "prepared",
    "processes-stopping",
    "processes-stopped",
    "state-mutating",
    "originals-moving",
    "originals-moved",
    "candidate-moving",
    "candidate-installed",
    "activated",
    "launching",
    "state-restored",
    "rollback-complete",
    "committed",
  ]);
  if (!allowedPhases.has(journal.phase)) throw new Error("invalid install transaction phase");
  if ((journal.phase === "state-mutating" || journal.phase === "state-restored" ||
    journal.phase === "rollback-complete") &&
    journal.schema_version !== 7 && journal.schema_version !== 8 &&
    journal.schema_version !== 9) {
    throw new Error("legacy install transaction journal contains an unsupported phase");
  }
  if (
    !isHex(journal.expected_manifest_sha256, 64) ||
    !isHex(journal.expected_source_sha, 40) ||
    !isHex(journal.state_backup_sha256, 64) ||
    !isHex(journal.candidate_identity_sha256, 64) ||
    (journal.schema_version === 9 && !isHex(journal.candidate_tree_sha256, 64)) ||
    (journal.previous_identity_sha256 !== "none" &&
      !isHex(journal.previous_identity_sha256, 64))
  ) {
    throw new Error("install transaction journal has invalid release identity fields");
  }
  if (journal.schema_version !== 9 && journal.candidate_tree_sha256 !== undefined) {
    throw new Error(
      "legacy install transaction journal contains unsupported candidate-tree evidence",
    );
  }
  if (journal.schema_version !== 4 && journal.schema_version !== 5 &&
    journal.schema_version !== 6 && journal.schema_version !== 7 &&
    journal.schema_version !== 8 && journal.schema_version !== 9 &&
    journal.original_state_mode !== undefined) {
    throw new Error("legacy install transaction journal contains unsupported state-mode fields");
  }
  if (journal.schema_version === 4 || journal.schema_version === 5 ||
    journal.schema_version === 6 || journal.schema_version === 7 ||
    journal.schema_version === 8 || journal.schema_version === 9) {
    if (journal.original_state_mode !== "700" && journal.original_state_mode !== "755") {
      throw new Error("install transaction journal has an invalid original state mode");
    }
  } else {
    journal.original_state_mode = "700";
  }
  if (journal.schema_version === 2) {
    if (
      journal.artifact_policy !== undefined ||
      journal.approved_target !== undefined ||
      journal.approved_target_identity_kind !== undefined ||
      journal.approved_target_identity_sha256 !== undefined ||
      journal.builder_identity_kind !== undefined
    ) {
      throw new Error("legacy install transaction journal contains unsupported policy fields");
    }
    journal.artifact_policy = "release";
    journal.approved_target = RELEASE_APPROVED_TARGET;
    journal.approved_target_identity_kind = "none";
    journal.approved_target_identity_sha256 = "none";
    journal.builder_identity_kind = "none";
  } else {
    journal.approved_target_identity_kind ??=
      journal.artifact_policy === "local_only" ? LEGACY_LOCAL_TARGET_IDENTITY_KIND : "none";
    journal.builder_identity_kind ??=
      journal.artifact_policy === "local_only" ? LEGACY_LOCAL_TARGET_IDENTITY_KIND : "none";
  }
  if ((journal.schema_version === 3 || journal.schema_version === 4 ||
    journal.schema_version === 5 || journal.schema_version === 6 ||
    journal.schema_version === 7 || journal.schema_version === 8 ||
    journal.schema_version === 9) && (
    (journal.artifact_policy !== "release" && journal.artifact_policy !== "local_only") ||
    !journal.approved_target ||
    (journal.artifact_policy === "release" &&
      (journal.approved_target !== RELEASE_APPROVED_TARGET ||
        journal.approved_target_identity_kind !== "none" ||
        journal.approved_target_identity_sha256 !== "none" ||
        journal.builder_identity_kind !== "none")) ||
    (journal.artifact_policy === "local_only" &&
      (!isLocalOnlyApprovedTarget(journal.approved_target) ||
        !isTargetIdentityKind(journal.approved_target_identity_kind) ||
        !isTargetIdentityKind(journal.builder_identity_kind) ||
        journal.approved_target_identity_kind !== journal.builder_identity_kind ||
        !journal.approved_target_identity_sha256 ||
        !isHex(journal.approved_target_identity_sha256, 64)))
  )) {
    throw new Error("install transaction journal has an invalid artifact policy or target");
  }
  const expectedParent = resolve(journal.app_parent);
  const transaction = resolve(journal.transaction_dir);
  if (!transaction.startsWith(`${expectedParent}/.Recordings-transaction.`)) {
    throw new Error("install transaction journal points outside the app parent");
  }
  if (journal.candidate_staging !== undefined && (
    journal.schema_version !== 9 ||
    dirname(resolve(journal.candidate_staging)) !== expectedParent ||
    !/^\.Recordings-install\.[A-Za-z0-9]+$/.test(basename(journal.candidate_staging))
  )) {
    throw new Error("install transaction journal has an unsafe candidate staging path");
  }
  if (resolve(path) !== resolve(join(expectedParent, ".Recordings-install-transaction.json"))) {
    throw new Error("install transaction journal is outside the expected app parent");
  }
  if (resolve(journal.app_destination) !== resolve(join(expectedParent, "Recordings.app"))) {
    throw new Error("install transaction journal has an unexpected app destination");
  }
  const expectedDataDir = resolve(join(dirname(expectedParent), ".hasna", "recordings"));
  if (resolve(journal.data_dir) !== expectedDataDir) {
    throw new Error("install transaction journal has an unexpected state directory");
  }
  if (!journal.originals.every((entry) => resolve(entry.backup).startsWith(`${transaction}/apps/`))) {
    throw new Error("install transaction journal has an unsafe app backup path");
  }
  if (!journal.originals.every((entry) => isHex(entry.sha256, 64))) {
    throw new Error("install transaction journal has an invalid app backup digest");
  }
  const allowedOriginal = (path: string): boolean => {
    const resolved = resolve(path);
    return (
      resolved === resolve(journal.app_destination) ||
      resolved === resolve(join(journal.data_dir, "Recordings.app")) ||
      resolved.startsWith(`${resolve(journal.app_parent)}/Recordings.app.`)
    );
  };
  if (!journal.originals.every((entry) => allowedOriginal(entry.path))) {
    throw new Error("install transaction journal has an unsafe original app path");
  }
  if (journal.schema_version !== 5 && journal.schema_version !== 6 &&
    journal.schema_version !== 7 && journal.schema_version !== 8 &&
    journal.schema_version !== 9) {
    if (journal.prior_running_app_paths !== undefined) {
      throw new Error("legacy install transaction journal contains unsupported running-path fields");
    }
    if (journal.was_running) {
      throw new Error(
        "legacy install transaction journal cannot safely restore prior running app paths",
      );
    }
    journal.prior_running_app_paths = [];
  } else {
    const paths = journal.prior_running_app_paths;
    if (!Array.isArray(paths) ||
      paths.some((entry) => typeof entry !== "string" || /[\u0000-\u001f\u007f]/.test(entry)) ||
      new Set(paths).size !== paths.length ||
      paths.some((entry) => !journal.originals.some(
        (original) => resolve(original.path) === resolve(entry),
      )) ||
      (journal.was_running ? paths.length === 0 : paths.length !== 0)) {
      throw new Error("install transaction journal has invalid prior running app paths");
    }
  }
  if (journal.schema_version === 6 || journal.schema_version === 7 ||
    journal.schema_version === 8 || journal.schema_version === 9) {
    if (journal.database_rollback !== "preserve-canonical-inode") {
      throw new Error("install transaction journal has an invalid database rollback policy");
    }
  } else if (journal.database_rollback !== undefined) {
    throw new Error("legacy install transaction journal contains an unsupported database rollback policy");
  }
  if (journal.schema_version === 7 || journal.schema_version === 8 ||
    journal.schema_version === 9) {
    if (journal.non_database_rollback !== "preserve-safe-live-writes") {
      throw new Error("install transaction journal has an invalid non-database rollback policy");
    }
    const entries = journal.installer_owned_state;
    const rollbackRoot = resolve(join(journal.data_dir, "rollbacks"));
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry.path !== "string" || !isHex(entry.sha256, 64) ||
      dirname(resolve(entry.path)) !== rollbackRoot ||
      !/^Recordings-pre-install-\d{8}T\d{6}Z-\d+-\d+\.zip$/.test(basename(entry.path))
    ) || new Set(entries.map((entry) => resolve(entry.path))).size !== entries.length) {
      throw new Error("install transaction journal has invalid installer-owned state entries");
    }
  } else if (journal.non_database_rollback !== undefined ||
    journal.installer_owned_state !== undefined) {
    throw new Error("legacy install transaction journal contains unsupported state-merge fields");
  }
  const resolvedStateBackup = resolve(journal.state_backup);
  const stateBackupName = relative(transaction, resolvedStateBackup);
  if (dirname(resolvedStateBackup) !== transaction ||
    (stateBackupName !== "state.initial" &&
      stateBackupName !== "state.stopped" &&
      !((journal.schema_version === 7 || journal.schema_version === 8 ||
        journal.schema_version === 9) &&
        /^state\.stopped\.\d+$/.test(stateBackupName)))) {
    throw new Error("install transaction journal has an unsafe state backup path");
  }
  return journal;
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function transitionStateMode(
  path: string,
  expectedUid: number,
  desiredMode: "700" | "755",
  allowedCurrentModes: ReadonlySet<string>,
): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const details = fstatSync(descriptor);
    const currentMode = (details.mode & 0o777).toString(8);
    if (!details.isDirectory() || details.uid !== expectedUid || !allowedCurrentModes.has(currentMode)) {
      throw new Error("state-mode transition found an unsafe type, owner, or mode");
    }
    if (currentMode !== desiredMode) fchmodSync(descriptor, Number.parseInt(desiredMode, 8));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

export function fsyncTree(root: string): void {
  const details = lstatSync(root);
  if (details.isSymbolicLink()) throw new Error(`refusing to fsync symlink: ${root}`);
  if (details.isDirectory()) {
    for (const entry of readdirSync(root)) fsyncTree(join(root, entry));
  } else if (!details.isFile()) {
    throw new Error(`refusing to fsync special file: ${root}`);
  }
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}


