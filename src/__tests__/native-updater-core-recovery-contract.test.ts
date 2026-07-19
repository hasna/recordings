import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("native updater core recovery contracts", () => {
  test("launches only the fixed verifier with FD-only arguments and an empty environment", () => {
    const launcher = source(
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    );
    expect(launcher).toContain("sandbox_init_with_parameters");
    expect(launcher).toContain('"OUTPUT_DIR", output_path');
    expect(launcher).toContain("F_GETPATH");
    expect(launcher).toContain("is_valid_transaction_output_path");
    expect(launcher).toContain('(char *)"verify"');
    expect(launcher).toContain('(char *)"--archive-fd"');
    expect(launcher).toContain('(char *)"--output-dir-fd"');
    expect(launcher).toContain('(char *)"--expected-sha256"');
    expect(launcher).toContain("char *const environment[] = { NULL }");
    expect(launcher).toContain("closefrom(5)");
    expect(launcher).toContain("CLOCK_MONOTONIC");
    expect(launcher).toContain("kill_and_reap(child)");
    expect(launcher).not.toContain("--archive-path");
    expect(launcher).not.toContain("--output-dir-path");

    const nullSetup = launcher.indexOf('open("/dev/null"');
    const privilegeDrop = launcher.indexOf("setgroups(1, groups)");
    const sandbox = launcher.indexOf("sandbox_init_with_parameters");
    const execute = launcher.indexOf("execve(VERIFIER_PATH");
    expect(nullSetup).toBeGreaterThan(0);
    expect(nullSetup).toBeLessThan(privilegeDrop);
    expect(privilegeDrop).toBeLessThan(sandbox);
    expect(sandbox).toBeLessThan(execute);
    for (const limit of ["RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC"]) {
      expect(launcher).toContain(limit);
    }
  });

  test("runs fail-closed startup recovery before accepting XPC peers", () => {
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const recovery = source("src/native/Recordings/Updater/Broker/InstallRecovery.swift");
    const journal = source("src/native/Recordings/Updater/Broker/InstallJournal.swift");
    const state = source("src/native/Recordings/Updater/Broker/MonotonicState.swift");
    const activation = source("src/native/Recordings/Updater/Broker/AtomicActivation.swift");

    expect(broker.indexOf("recoverInterruptedTransactions()")).toBeLessThan(
      broker.indexOf("listener.resume()"),
    );
    expect(broker).toContain("requiresRecoveryRestart(after: error)");
    expect(broker).toContain("error is AtomicActivationError || error is InstallJournalError");
    expect(broker).toContain("Darwin.exit(75)");
    expect(broker).toContain(
      "A state rename whose directory fsync failed is not durable proof",
    );
    const stagedInstallCatch = broker.slice(
      broker.indexOf("let result = try performStagedInstall"),
      broker.indexOf("private static func performStagedInstall"),
    );
    const preserveRecoveryEvidence = stagedInstallCatch.indexOf(
      "if Self.requiresRecoveryRestart(after: error)",
    );
    const catchCleanup = stagedInstallCatch.indexOf(
      "try cleanupIfTerminalOrUnjournaled",
      stagedInstallCatch.indexOf("} catch {") + 1,
    );
    expect(preserveRecoveryEvidence).toBeGreaterThan(0);
    expect(preserveRecoveryEvidence).toBeLessThan(catchCleanup);
    expect(activation).toContain("throw AtomicActivationError.recoveryRequired");
    expect(broker).toContain("withExclusiveTransactionLock");
    expect(broker).toContain("ensureTransactionQuota");
    expect(broker).toContain("cleanupIfTerminalOrUnjournaled");
    expect(broker).toContain("Release seen; retry or recovery required");
    expect(broker).toContain("RecordingsUpdateReplyKey.lifecycle");
    expect(broker).toContain("RecordingsUpdateReplyKey.rootMaintenanceSupported");
    expect(broker).toContain("RecordingsUpdateReplyKey.keyRotationSupported");
    for (const phase of [
      "prepared", "launch-barrier-pending", "launch-barrier-held",
      "swap-pending", "swapped", "previous-retaining",
      "previous-retained", "first-install-pending", "first-installed",
      "launch-barrier-releasing", "launch-barrier-released",
      "activated", "rollback-started", "rolled-back", "committed",
    ]) expect(recovery).toContain(`\"${phase}\"`);
    for (const field of [
      "envelopePayloadSHA256", "artifactSHA256", "manifestSHA256", "candidateTreeSHA256",
      "cohortPackageSHA256", "previousTreeSHA256",
    ]) expect(journal).toContain(field);
    expect(recovery).toContain("requireExactHighestSeen");
    expect(recovery).toContain("requireExactReleaseBinding");
    expect(recovery).toContain("digestIfPresent");
    expect(recovery).toContain("finalizeRecoveredCommit");
    expect(recovery).toContain("removeTransactionDirectory(id: identifier)");
    expect(state).toContain(
      'state.phase == "seen" || state.phase == "aborted" || state.phase == "committed"',
    );
    expect(state).toContain("current.envelopePayloadSHA256 == journal.envelopePayloadSHA256");
    expect(recovery).not.toContain(".hasna/recordings");
    expect(recovery).not.toContain("homeDirectoryForCurrentUser");
  });

  test("journals bootstrap intent before seen and recovers commit-only without envelope replay", () => {
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const state = source("src/native/Recordings/Updater/Broker/MonotonicState.swift");
    const journal = source("src/native/Recordings/Updater/Broker/InstallJournal.swift");
    const recovery = source("src/native/Recordings/Updater/Broker/InstallRecovery.swift");
    const policy = source(
      "src/native/Recordings/Updater/Broker/ActivationRecoveryPolicy.swift",
    );
    const faultTests = source(
      "src/native/Recordings/Updater/BrokerTests/ActivationRecoveryPolicyTests.swift",
    );

    const bootstrapBranch = broker.slice(
      broker.indexOf('if payload.purpose == "bootstrap"'),
      broker.indexOf("let verifierOutput"),
    );
    const perform = bootstrapBranch.indexOf("stateStore.perform(");
    const prepare = bootstrapBranch.indexOf("prepare: { decision in", perform);
    const operation = bootstrapBranch.indexOf(") { decision in", prepare);
    expect(perform).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(perform);
    expect(operation).toBeGreaterThan(prepare);
    expect(bootstrapBranch).toContain("prepareBootstrapCommit(");
    expect(bootstrapBranch).toContain("requirePreparedBootstrapCommit(");
    expect(bootstrapBranch).toContain("finalizeBootstrapCommit(");

    for (const binding of [
      "operation", "transactionDirectory", "bootstrapPriorMonotonicState",
      "releaseID", "releaseSequence", "keyEpoch", "cohortPackageSHA256",
      "envelopePayloadSHA256", "candidateTreeSHA256", "artifactSHA256",
      "manifestSHA256",
    ]) expect(journal).toContain(binding);
    expect(journal).toContain('"bootstrap-commit"');
    expect(journal).toContain('"absent"');
    expect(journal).toContain('"bootstrap-prepared"');
    expect(journal).toContain('"bootstrap-commit-pending"');
    expect(journal).toContain('"bootstrap-committed"');
    expect(journal).toContain("journal.operation ?? .applicationActivation");

    expect(recovery).toContain("recoverBootstrapCommit(");
    expect(recovery).toContain("BootstrapRecoveryPolicy.action(");
    expect(recovery).toContain("stateStore.finalizeRecoveredCommit(journal: journal)");
    expect(recovery).toContain("CanonicalTree.digest(at: journal.applicationPath)");
    const bootstrapRecovery = recovery.slice(
      recovery.indexOf("private static func recoverBootstrapCommit("),
      recovery.indexOf("private static func recoverPreparedWithSeenBarrier("),
    );
    expect(bootstrapRecovery).not.toContain("envelope.json");
    expect(bootstrapRecovery).not.toContain("SignedReleaseEnvelope");
    expect(bootstrapRecovery).not.toContain("verify(");
    expect(state).toContain("current.purpose == journal.expectedPurpose");
    const bootstrapCleanup = broker.slice(
      broker.indexOf("journal.resolvedOperation == .bootstrapCommit"),
      broker.indexOf('if let journal, journal.phase == "committed"'),
    );
    expect(bootstrapCleanup).toContain("throw IngestError.couldNotCleanup");
    expect(bootstrapCleanup).toContain(
      "candidateTreeSHA256 == journal.candidateTreeSHA256",
    );

    for (const boundary of [
      "bootstrapAfterJournalFsyncBeforeSeen",
      "bootstrapAfterSeenFsyncBeforeCommit",
      "bootstrapStateRenameBeforeDirectoryFsync",
      "bootstrapSecondCrashDuringRecovery",
      "bootstrapExpiredEnvelopeAfterCrash",
      "bootstrapMismatchedJournal",
      "legacyActivationJournalSchemaMigration",
    ]) expect(faultTests).toContain(boundary);
    expect(policy).toContain("enum BootstrapRecoveryAction");
    expect(policy).toContain("case discardBeforeSeen");
    expect(policy).toContain("case finalizeCommit");
    expect(policy).toContain("case validateCommitted");
  });

  test("atomically replaces the live app and recovers every rename durability boundary", () => {
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const activation = source("src/native/Recordings/Updater/Broker/AtomicActivation.swift");
    const namespace = source(
      "src/native/Recordings/Updater/Broker/ApplicationNamespace.swift",
    );
    const recovery = source("src/native/Recordings/Updater/Broker/InstallRecovery.swift");
    const journal = source("src/native/Recordings/Updater/Broker/InstallJournal.swift");
    const state = source("src/native/Recordings/Updater/Broker/MonotonicState.swift");
    const faultTests = source(
      "src/native/Recordings/Updater/BrokerTests/ActivationRecoveryPolicyTests.swift",
    );

    expect(namespace).toContain("renameatx_np");
    expect(namespace).toContain("RENAME_SWAP");
    expect(namespace).toContain("RENAME_EXCL");
    expect(namespace).not.toMatch(/\brename\s*\(/);
    expect(activation).toContain('journal.phase = "swap-pending"');
    expect(activation).toContain('journal.phase = "swapped"');
    expect(activation).toContain('journal.phase = "previous-retaining"');
    expect(activation).toContain('journal.phase = "previous-retained"');
    expect(activation).toContain('journal.phase = "first-install-pending"');
    expect(activation).toContain('journal.phase = "first-installed"');
    expect(recovery).toContain("recoverPreparedWithSeenBarrier");
    expect(recovery).toContain("recoverSwapPending");
    expect(recovery).toContain("finishRollback");
    expect(recovery).toContain("requireRollbackTerminalState");
    expect(recovery).toContain("finalizeRecoveredAbort");
    expect(journal).toContain('"swap-pending"');
    expect(journal).toContain('"previous-retaining"');
    expect(journal).toContain('"first-install-pending"');

    const prepareHook = state.indexOf("try prepare(decision)");
    const seenWrite = state.indexOf(
      'writeState(payload: payload, payloadDigest: payloadDigest, phase: "seen")',
    );
    expect(prepareHook).toBeGreaterThan(0);
    expect(prepareHook).toBeLessThan(seenWrite);
    expect(broker).toContain("prepare: { decision in");
    expect(broker).toContain("prepareActivation(");
    expect(broker).toContain("activatePrepared(");
    expect(state).toContain('phase: "aborted"');
    expect(state).toContain("mayDurablyAbortSeenBarrier");
    const rollbackRecovery = recovery.indexOf('case "rollback-started":');
    const rollbackJournal = recovery.indexOf(
      'journal.phase = "rolled-back"',
      rollbackRecovery,
    );
    const rollbackAbort = recovery.indexOf(
      "stateStore.finalizeRecoveredAbort(journal: journal)",
      rollbackJournal,
    );
    expect(rollbackRecovery).toBeGreaterThan(0);
    expect(rollbackJournal).toBeGreaterThan(rollbackRecovery);
    expect(rollbackAbort).toBeGreaterThan(rollbackJournal);
    expect(recovery).toContain(
      '(current.phase == "committed" || current.phase == "aborted")',
    );
    expect(recovery).toContain(
      "current.cohortPackageSHA256 == journal.cohortPackageSHA256",
    );
    for (const boundary of [
      "afterRenameBeforeFsync",
      "afterFsyncBeforeSwappedJournal",
      "afterRetainBeforeJournal",
      "rollbackFailureInjectionBoundaries",
      "firstInstallFailureInjectionBoundaries",
      "preparedOverOlderAbortedBarrier",
      "rolledBackSeenBarrierSecondCrash",
    ]) expect(faultTests).toContain(boundary);

    const preparedBinding = activation.slice(
      activation.indexOf("guard var journal = try durableJournal.read()"),
      activation.indexOf("let namespace: ApplicationNamespace"),
    );
    expect(preparedBinding).toContain("AtomicActivationError.recoveryRequired");
    expect(preparedBinding).not.toContain("AtomicActivationError.invalidPreparedState");
  });

  test("defers activation until exact live-bundle processes are quiescent", () => {
    const activation = source("src/native/Recordings/Updater/Broker/AtomicActivation.swift");
    const namespace = source(
      "src/native/Recordings/Updater/Broker/ApplicationNamespace.swift",
    );
    const journal = source("src/native/Recordings/Updater/Broker/InstallJournal.swift");
    const tree = source("src/native/Recordings/Updater/Broker/CodeValidation.swift");
    const quiescence = source(
      "src/native/Recordings/Updater/Broker/ApplicationProcessQuiescence.swift",
    );
    expect(quiescence).toContain("proc_listallpids");
    expect(quiescence).toContain("proc_pidpath");
    expect(quiescence).toContain("RecordingsUpdateConstants.updateClientRelativePath");
    expect(quiescence).toContain("excludingAuthenticatedClientPID");
    expect(activation.match(/requireQuiescence/g)?.length).toBeGreaterThanOrEqual(2);
    expect(activation).toContain("AtomicActivationError.activationDeferred");
    expect(namespace).toContain("fchmod(descriptor, newMode)");
    expect(namespace).toContain("opened.st_dev == namedBefore.st_dev");
    expect(namespace).toContain("opened.st_ino == namedBefore.st_ino");
    expect(namespace).toContain("engageLaunchBarrier");
    expect(namespace).toContain("releaseCommittedLaunchBarrier");
    expect(namespace).toContain("releaseRolledBackLaunchBarrier");
    expect(journal).toContain("candidateApplicationMode");
    expect(journal).toContain("previousApplicationMode");
    expect(tree).toContain("modeOverrides");
    expect(journal).toContain("candidateExecutableModes");
    expect(journal).toContain("previousExecutableModes");
    expect(namespace).toContain("journal.candidateExecutableModes");
    expect(namespace).toContain("journal.previousExecutableModes");
    expect(namespace).not.toMatch(/\.candidateExecutableMode\b/);
    expect(namespace).not.toMatch(/\.previousExecutableMode\b/);
    expect(activation).toContain("requiresCommitRecovery(phase: journal.phase)");
    const barrierHeld = activation.indexOf('journal.phase = "launch-barrier-held"');
    const finalScan = activation.indexOf("requireQuiescence(", barrierHeld);
    const swap = activation.indexOf("exchangeCandidateAndLive()", finalScan);
    expect(barrierHeld).toBeGreaterThan(0);
    expect(finalScan).toBeGreaterThan(barrierHeld);
    expect(swap).toBeGreaterThan(finalScan);
  });

  test("bounds staging and prunes only descriptor-relative protected transactions", () => {
    const ingest = source("src/native/Recordings/Updater/Broker/ArtifactIngest.swift");
    const launcher = source(
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    );
    expect(ingest).toContain("maximumArchiveBytes: Int64 = 256 * 1024 * 1024");
    expect(ingest).toContain("maximumTransactionFootprintBytes: UInt64 = 2 * 1024 * 1024 * 1024");
    expect(ingest).toContain("safetyReserve: UInt64 = 2 * 1024 * 1024 * 1024");
    expect(ingest).toContain(".transactions.lock");
    expect(ingest).toContain("recordings_remove_directory_tree_at(rootDescriptor");
    expect(ingest.match(/try writeAll\(data, to: output\)/g)?.length).toBe(1);
    expect(launcher).toContain("is_valid_transaction_name");
    expect(launcher).toContain("unlinkat(parent_descriptor, name, AT_REMOVEDIR)");
    expect(launcher).toContain("AT_SYMLINK_NOFOLLOW");
    expect(launcher).toContain("!recordings_descriptor_has_no_extended_acl(root_directory_descriptor)");
    expect(launcher).toContain("!recordings_descriptor_has_no_extended_acl(directory)");
  });

  test("rejects dangerous dynamic-peer entitlements and missing hardened runtime", () => {
    const peer = source("src/native/Recordings/Updater/Broker/PeerIdentity.swift");
    expect(peer).toContain("connection.auditToken");
    expect(peer).toContain("kSecGuestAttributeAudit");
    expect(peer).toContain('.map { "identifier \\(Self.requirementQuoted($0))" }');
    expect(peer).not.toContain('identifier "\\#(Self.requirementQuoted($0))"');
    expect(peer).toContain("kSecCodeSignatureRuntime");
    expect(peer).toContain("kSecCSRequirementInformation");
    expect(peer).toContain("kSecCodeInfoEntitlements as String");
    expect(peer).toContain("kSecCodeInfoEntitlementsDict");
    expect(peer).toContain("com.apple.security.get-task-allow");
    expect(peer).toContain("com.apple.security.cs.disable-library-validation");
    expect(peer).toContain("com.apple.security.cs.allow-dyld-environment-variables");
    expect(peer).toContain("forbidden.allSatisfy { entitlements[$0] == nil }");
  });
});
