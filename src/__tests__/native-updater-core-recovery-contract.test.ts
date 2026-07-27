import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectOrder,
  sliceBetween,
  sliceBetweenUnique,
} from "./helpers/source-assertions";

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

    // The launch order *is* the security property: the standard descriptors are pinned to
    // /dev/null, then privilege is dropped, then the sandbox closes, and only then is the fixed
    // verifier exec'd. As four bare `indexOf` comparisons the chain held only by accident — each
    // step was rescued from its own -1 by being the *second* operand of the previous comparison,
    // so deleting the exec, or appending a step, would silently reopen the hole. `expectOrder`
    // requires both operands to exist at every link and names whichever one went missing.
    expectOrder(launcher, 'open("/dev/null"', "setgroups(1, groups)");
    expectOrder(launcher, "setgroups(1, groups)", "sandbox_init_with_parameters");
    expectOrder(launcher, "sandbox_init_with_parameters", "execve(VERIFIER_PATH");
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

    // Startup recovery must finish before the listener accepts a peer. Unguarded this was the
    // purest form of the defect: with `indexOf(recovery) < indexOf(resume)`, deleting the recovery
    // call made the comparison `-1 < n`, so the single assertion protecting fail-closed startup
    // was satisfied by removing fail-closed startup.
    expectOrder(broker, "recoverInterruptedTransactions()", "listener.resume()");
    expect(broker).toContain("requiresRecoveryRestart(after: error)");
    expect(broker).toContain("error is AtomicActivationError || error is InstallJournalError");
    expect(broker).toContain("Darwin.exit(75)");
    expect(broker).toContain(
      "A state rename whose directory fsync failed is not durable proof",
    );
    // The call site and the definition of `performStagedInstall` bracket the caller's do/catch.
    // Both bounds have to exist for that to be true: as two bare `indexOf` calls, renaming the
    // function put -1 on one end, which slices from the last character or to the first and yields
    // an empty region that satisfies anything asserted about it.
    const stagedInstallCatch = sliceBetween(
      broker,
      "let result = try performStagedInstall",
      "private static func performStagedInstall",
    );
    // Inside the catch the recovery-restart check has to precede any cleanup, or a crash that
    // needs recovery gets its evidence deleted before the restart can use it. The window has to be
    // catch-relative because `try cleanupIfTerminalOrUnjournaled` also appears on the success path
    // immediately above the catch — and the old `indexOf(needle, indexOf("} catch {") + 1)` form
    // degraded to "search from 0" and matched that success-path call the moment the catch marker
    // moved, comparing the check against a cleanup that runs before it.
    const catchBeforeCleanup = sliceBetween(
      stagedInstallCatch,
      "} catch {",
      "try cleanupIfTerminalOrUnjournaled",
    );
    expect(catchBeforeCleanup).toContain("if Self.requiresRecoveryRestart(after: error)");
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

    // Only the bootstrap branch may answer for the bootstrap contract, so both bounds are required
    // and each must appear once. A missing `let verifierOutput` used to leave the end bound at -1,
    // which slices to the last character and stretched this region across the whole verifier-driven
    // update path; every `toContain` below would then have been satisfied by the update branch's
    // own journal calls, while the bootstrap branch was free of them.
    const bootstrapBranch = sliceBetweenUnique(
      broker,
      'if payload.purpose == "bootstrap"',
      "let verifierOutput",
    );
    // `prepare:` runs inside `stateStore.perform(` and before its trailing operation closure, which
    // is what journals bootstrap intent ahead of the state advance. Both closure markers occur
    // exactly once inside this region, so first-match ordering walks the same window the old
    // `indexOf(needle, fromIndex)` chain did — without that chain's dependence on the anchor index
    // never being -1 (a -1 `fromIndex` clamps to 0 and searches from the top of the region).
    expectOrder(bootstrapBranch, "stateStore.perform(", "prepare: { decision in");
    expectOrder(bootstrapBranch, "prepare: { decision in", ") { decision in");
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
    // Three absence claims follow, and an absence claim is only as good as the region it is made
    // over: an empty or misdirected region satisfies all three. `sliceBetweenUnique` requires both
    // function markers to exist exactly once and the end to follow the start, so reordering these
    // two declarations — which would have produced a start > end slice, i.e. "" — now fails loudly
    // instead of certifying that bootstrap recovery never replays an envelope.
    const bootstrapRecovery = sliceBetweenUnique(
      recovery,
      "private static func recoverBootstrapCommit(",
      "private static func recoverPreparedWithSeenBarrier(",
    );
    expect(bootstrapRecovery).not.toContain("envelope.json");
    expect(bootstrapRecovery).not.toContain("SignedReleaseEnvelope");
    expect(bootstrapRecovery).not.toContain("verify(");
    expect(state).toContain("current.purpose == journal.expectedPurpose");
    // `sliceBetween` rather than `sliceBetweenUnique`: the bootstrap-commit test occurs twice in
    // the broker (cleanup and a later guard), so only first-match is correct here. What was wrong
    // before is the end bound — a missing committed-phase branch left it at -1, widening the region
    // to the rest of the file, where both `toContain` needles exist in unrelated cleanup code.
    const bootstrapCleanup = sliceBetween(
      broker,
      "journal.resolvedOperation == .bootstrapCommit",
      'if let journal, journal.phase == "committed"',
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

    // The prepare hook runs before the seen barrier is written, so a prepared journal always
    // precedes durable proof that the release was seen. Both halves must exist: deleting the hook
    // used to leave `-1 < seenWrite`, certifying an ordering that no longer had a first term.
    expectOrder(
      state,
      "try prepare(decision)",
      'writeState(payload: payload, payloadDigest: payloadDigest, phase: "seen")',
    );
    expect(broker).toContain("prepare: { decision in");
    expect(broker).toContain("prepareActivation(");
    expect(broker).toContain("activatePrepared(");
    expect(state).toContain('phase: "aborted"');
    expect(state).toContain("mayDurablyAbortSeenBarrier");
    // Recovering a rollback journals "rolled-back" before it finalizes the abort in the state
    // store, so the durable journal never lags the state. Both needles occur twice in this file
    // (the other pair belongs to the forward rollback path), which is why the old form threaded a
    // `fromIndex` through — and why a -1 anchor, clamped to 0, would have compared the wrong pair.
    // Bounding the switch case instead makes the region carry the disambiguation.
    const rollbackStartedCase = sliceBetween(recovery, 'case "rollback-started":', "default:");
    expectOrder(
      rollbackStartedCase,
      'journal.phase = "rolled-back"',
      "stateStore.finalizeRecoveredAbort(journal: journal)",
    );
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

    // The prepared-journal guard must fail into recovery, never into `invalidPreparedState`, which
    // would treat an interrupted install as garbage and discard it. Both error cases exist
    // elsewhere in this file, so the absence claim is only meaningful over this exact guard: an
    // empty region (either bound at -1, or the two declarations reordered) would have asserted that
    // the wrong error is absent from nothing at all.
    const preparedBinding = sliceBetweenUnique(
      activation,
      "guard var journal = try durableJournal.read()",
      "let namespace: ApplicationNamespace",
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
    // The last quiescence scan has to happen with the launch barrier already held and before the
    // swap, so no process can start in the gap between the scan and the exchange. Stating that as a
    // region is what makes it real: `requireQuiescence(` appears three times here, so the old index
    // chain depended entirely on `barrierHeld` being found — a -1 there clamps `fromIndex` to 0 and
    // silently re-satisfies the test with the *first* scan, the one that runs before the barrier.
    const barrierHeldToSwap = sliceBetween(
      activation,
      'journal.phase = "launch-barrier-held"',
      "exchangeCandidateAndLive()",
    );
    expect(barrierHeldToSwap).toContain("requireQuiescence(");
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
