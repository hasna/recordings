import Foundation
import Testing
@testable import RecordingsUpdateBroker

struct ActivationRecoveryPolicyTests {
    private let old = String(repeating: "a", count: 64)
    private let candidate = String(repeating: "b", count: 64)

    @Test("swap recovery spans rename, fsync, and phase-journal failure boundaries")
    func swapFailureInjectionBoundaries() {
        let beforeRename = snapshot(live: old, candidate: candidate)
        #expect(commit(beforeRename) == .exchangeCandidateAndLive)

        // renameatx_np(RENAME_SWAP) succeeded, but either directory fsync failed.
        let afterRenameBeforeFsync = snapshot(live: candidate, candidate: old)
        #expect(commit(afterRenameBeforeFsync) == .retainPrevious)

        // Both directory fsyncs succeeded, but writing `swapped` failed. The exact
        // namespace shape is the same and recovery retains the old tree once.
        let afterFsyncBeforeSwappedJournal = snapshot(live: candidate, candidate: old)
        #expect(commit(afterFsyncBeforeSwappedJournal) == .retainPrevious)

        // Retaining the old app succeeded, but its fsync or `previous-retained`
        // journal write failed. Recovery recognizes the durable terminal shape.
        let afterRetainBeforeJournal = snapshot(live: candidate, previous: old)
        #expect(commit(afterRetainBeforeJournal) == .ready)
    }

    @Test("rollback recovery restores the exact old digest at every swap boundary")
    func rollbackFailureInjectionBoundaries() {
        #expect(rollback(snapshot(live: candidate, candidate: old)) == .exchangeCandidateAndLive)
        #expect(rollback(snapshot(live: candidate, previous: old)) == .exchangePreviousAndLive)

        // The rollback exchange succeeded, but fsync failed before the candidate
        // could be moved from the previous slot to its failed-candidate slot.
        #expect(rollback(snapshot(live: old, previous: candidate)) == .retainFailedFromPrevious)

        // Either rollback path is terminal only when the exact old digest is live
        // and the exact candidate survives in exactly one protected slot.
        #expect(rollback(snapshot(live: old, candidate: candidate)) == .ready)
        #expect(rollback(snapshot(live: old, failed: candidate)) == .ready)
        #expect(
            rollback(snapshot(live: old, candidate: candidate, failed: candidate)) == .invalid
        )
        #expect(
            rollback(snapshot(live: old, candidate: candidate, failed: old)) == .invalid
        )
    }

    @Test("first install is exclusive and crash recoverable")
    func firstInstallFailureInjectionBoundaries() {
        #expect(
            ActivationRecoveryPolicy.commitAction(
                snapshot: snapshot(candidate: candidate),
                previousDigest: nil,
                candidateDigest: candidate
            ) == .installCandidateExclusively
        )
        #expect(
            ActivationRecoveryPolicy.commitAction(
                snapshot: snapshot(live: candidate),
                previousDigest: nil,
                candidateDigest: candidate
            ) == .ready
        )
        #expect(
            ActivationRecoveryPolicy.commitAction(
                snapshot: snapshot(live: old, candidate: candidate),
                previousDigest: nil,
                candidateDigest: candidate
            ) == .invalid
        )
    }

    @Test("prepared newer transaction is discarded over an older aborted barrier")
    func preparedOverOlderAbortedBarrier() {
        #expect(
            ActivationRecoveryPolicy.preparedBarrierAction(
                currentPhase: .aborted,
                currentSequence: 7,
                journalSequence: 8,
                exactBinding: false,
                sameCohort: true
            ) == .discard
        )
        #expect(
            ActivationRecoveryPolicy.preparedBarrierAction(
                currentPhase: .aborted,
                currentSequence: 7,
                journalSequence: 8,
                exactBinding: false,
                sameCohort: false
            ) == .invalid
        )
    }

    @Test("rollback-started plus seen closes abort before prune across a second crash")
    func rolledBackSeenBarrierSecondCrash() {
        let afterRolledBackJournalBeforeAbort =
            ActivationRecoveryPolicy.rolledBackBarrierAction(
                currentPhase: .seen,
                currentSequence: 8,
                journalSequence: 8,
                exactBinding: true,
                sameCohort: true
            )
        #expect(afterRolledBackJournalBeforeAbort == .finalizeAbortThenPrune)

        // If the broker crashes after persisting `rolled-back` but before the abort
        // state write, startup obtains the same action and preserves the journal.
        let secondStartup = ActivationRecoveryPolicy.rolledBackBarrierAction(
            currentPhase: .seen,
            currentSequence: 8,
            journalSequence: 8,
            exactBinding: true,
            sameCohort: true
        )
        #expect(secondStartup == .finalizeAbortThenPrune)

        let afterAbort = ActivationRecoveryPolicy.rolledBackBarrierAction(
            currentPhase: .aborted,
            currentSequence: 8,
            journalSequence: 8,
            exactBinding: true,
            sameCohort: true
        )
        #expect(afterAbort == .prune)
    }

    @Test("bootstrap journal fsync before seen is safely discardable without state mutation")
    func bootstrapAfterJournalFsyncBeforeSeen() {
        #expect(
            bootstrap(phase: .prepared, current: nil, exact: false, candidateMatches: false)
                == .discardBeforeSeen
        )
        #expect(
            bootstrap(phase: .aborted, current: nil, exact: false, candidateMatches: false)
                == .prune
        )
    }

    @Test("bootstrap seen state commits from its exact durable journal")
    func bootstrapAfterSeenFsyncBeforeCommit() {
        #expect(bootstrap(phase: .prepared, current: .seen) == .finalizeCommit)
    }

    @Test("a visible seen rename remains recoverable when its directory fsync failed")
    func bootstrapStateRenameBeforeDirectoryFsync() {
        #expect(bootstrap(phase: .prepared, current: .seen) == .finalizeCommit)
        // If the rename is lost rather than visible after restart, no monotonic state
        // exists and the pre-seen journal can be closed without committing anything.
        #expect(
            bootstrap(phase: .prepared, current: nil, exact: false, candidateMatches: false)
                == .discardBeforeSeen
        )
    }

    @Test("bootstrap recovery is idempotent across a second crash")
    func bootstrapSecondCrashDuringRecovery() {
        #expect(bootstrap(phase: .commitPending, current: .seen) == .finalizeCommit)
        #expect(bootstrap(phase: .commitPending, current: .committed) == .validateCommitted)
        #expect(bootstrap(phase: .committed, current: .committed) == .prune)
    }

    @Test("bootstrap recovery does not depend on replaying an expired envelope")
    func bootstrapExpiredEnvelopeAfterCrash() {
        // Recovery uses the root-owned journal, exact highest-seen binding, and live
        // candidate digest; envelope wall-clock validity is intentionally not an input.
        #expect(bootstrap(phase: .prepared, current: .seen) == .finalizeCommit)
    }

    @Test("bootstrap recovery rejects mismatched or non-absent prior state")
    func bootstrapMismatchedJournal() {
        #expect(bootstrap(phase: .prepared, current: .seen, exact: false) == .invalid)
        #expect(
            bootstrap(phase: .prepared, current: .seen, priorWasAbsent: false) == .invalid
        )
        #expect(
            bootstrap(phase: .prepared, current: .seen, candidateMatches: false) == .invalid
        )
    }

    @Test("schema-v1 activation journals without a discriminator remain activation-only")
    func legacyActivationJournalSchemaMigration() throws {
        let legacyJSON = Data(#"""
        {
          "schema_version": 1,
          "transaction_id": "00000000-0000-0000-0000-000000000001",
          "phase": "prepared",
          "release_id": "00000000-0000-0000-0000-000000000002",
          "release_sequence": 2,
          "key_epoch": 1,
          "envelope_payload_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "artifact_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "manifest_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "cohort_package_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "candidate_tree_sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "candidate_application_mode": 493,
          "candidate_executable_modes": {
            "Contents/MacOS/Recordings": 493,
            "Contents/Helpers/recordings": 493,
            "Contents/Helpers/recordings-update-client": 493
          },
          "candidate_application_path": "/Library/Application Support/Hasna/Recordings/Updates/transaction-00000000-0000-0000-0000-000000000001/candidate/Recordings.app",
          "application_path": "/Applications/Recordings.app"
        }
        """#.utf8)
        let journal = try JSONDecoder().decode(BrokerInstallJournal.self, from: legacyJSON)
        #expect(journal.operation == nil)
        #expect(journal.resolvedOperation == .applicationActivation)
        #expect(journal.expectedPurpose == "update")
    }

    private func commit(_ value: ApplicationNamespaceSnapshot) -> CommitRecoveryAction {
        ActivationRecoveryPolicy.commitAction(
            snapshot: value,
            previousDigest: old,
            candidateDigest: candidate
        )
    }

    private func rollback(_ value: ApplicationNamespaceSnapshot) -> RollbackRecoveryAction {
        ActivationRecoveryPolicy.rollbackAction(
            snapshot: value,
            previousDigest: old,
            candidateDigest: candidate
        )
    }

    private func bootstrap(
        phase: BootstrapJournalPhase,
        current: MonotonicBarrierPhase?,
        exact: Bool = true,
        priorWasAbsent: Bool = true,
        candidateMatches: Bool = true
    ) -> BootstrapRecoveryAction {
        BootstrapRecoveryPolicy.action(
            journalPhase: phase,
            currentPhase: current,
            exactBinding: exact,
            priorMonotonicStateWasAbsent: priorWasAbsent,
            candidateMatches: candidateMatches
        )
    }

    private func snapshot(
        live: String? = nil,
        candidate: String? = nil,
        previous: String? = nil,
        failed: String? = nil
    ) -> ApplicationNamespaceSnapshot {
        ApplicationNamespaceSnapshot(
            live: live,
            candidateSlot: candidate,
            previousSlot: previous,
            failedSlot: failed
        )
    }
}
