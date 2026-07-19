import Foundation
import Testing
@testable import RecordingsUpdateProtocol

struct MonotonicReleasePolicyTests {
    private let epoch: UInt64 = 7
    private let cohort = String(repeating: "a", count: 64)
    private let digest = String(repeating: "b", count: 64)
    private let releaseID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    @Test("an absent state admits only the bootstrap release")
    func absentStateRequiresBootstrap() throws {
        #expect(try assess(candidate()) == .advance)
        #expect(throws: MonotonicReleasePolicyError.bootstrapRequired) {
            try assess(candidate(purpose: "update"))
        }
    }

    @Test("an exact seen bootstrap resumes without advancing")
    func exactSeenBootstrapResumes() throws {
        let bootstrap = candidate()
        #expect(try assess(bootstrap, current: state(from: bootstrap, phase: .seen)) == .resumeSeen)
    }

    @Test("an exact committed bootstrap is idempotent")
    func exactCommittedBootstrapIsIdempotent() throws {
        let bootstrap = candidate()
        #expect(
            try assess(bootstrap, current: state(from: bootstrap, phase: .committed))
                == .alreadyCommitted
        )
    }

    @Test("a higher update cannot supersede a seen release")
    func higherUpdateIsBlockedWhileSeen() {
        let pending = candidate(purpose: "update", sequence: 2)
        let next = candidate(purpose: "update", sequence: 3, releaseID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", digest: String(repeating: "c", count: 64))
        #expect(throws: MonotonicReleasePolicyError.pendingSeenRecoveryRequired) {
            try assess(next, current: state(from: pending, phase: .seen))
        }
    }

    @Test("a higher update advances after the current release commits")
    func higherUpdateAdvancesAfterCommit() throws {
        let committed = candidate(purpose: "update", sequence: 2)
        let next = candidate(purpose: "update", sequence: 3, releaseID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", digest: String(repeating: "c", count: 64))
        #expect(try assess(next, current: state(from: committed, phase: .committed)) == .advance)
    }

    @Test("a rolled-back seen release admits only a strictly newer cohort-compatible update")
    func abortedReleasePreservesMonotonicBarrier() throws {
        let abortedCandidate = candidate(purpose: "update", sequence: 2)
        let aborted = state(from: abortedCandidate, phase: .aborted)
        let next = candidate(
            purpose: "update",
            sequence: 3,
            releaseID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            digest: String(repeating: "c", count: 64)
        )
        #expect(try assess(next, current: aborted) == .advance)
        #expect(throws: MonotonicReleasePolicyError.sequenceRollbackOrConflict) {
            try assess(abortedCandidate, current: aborted)
        }
        #expect(throws: MonotonicReleasePolicyError.immutableCohortChange) {
            try assess(
                candidate(
                    purpose: "update",
                    sequence: 3,
                    cohort: String(repeating: "c", count: 64)
                ),
                current: aborted
            )
        }
    }

    @Test("an exact committed update is idempotent")
    func exactCommittedUpdateIsIdempotent() throws {
        let update = candidate(purpose: "update", sequence: 2)
        #expect(
            try assess(update, current: state(from: update, phase: .committed))
                == .alreadyCommitted
        )
    }

    @Test("seen state rejects wrong cohort, key, identity, and digest")
    func seenStateRejectsEveryNonExactReplay() {
        let pending = candidate(purpose: "update", sequence: 2)
        let seen = state(from: pending, phase: .seen)
        let conflicts = [
            candidate(purpose: "update", sequence: 2, cohort: String(repeating: "c", count: 64)),
            candidate(purpose: "update", keyEpoch: epoch + 1, sequence: 2),
            candidate(purpose: "update", sequence: 2, releaseID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
            candidate(purpose: "update", sequence: 2, digest: String(repeating: "c", count: 64)),
        ]

        for conflict in conflicts {
            let expected: MonotonicReleasePolicyError = conflict.keyEpoch == epoch
                ? .pendingSeenRecoveryRequired
                : .immutableCohortChange
            #expect(throws: expected) {
                try assess(conflict, current: seen)
            }
        }
    }

    @Test("committed state rejects cohort, key, and same-sequence digest conflicts")
    func committedStateRejectsBindingConflicts() {
        let committedCandidate = candidate(purpose: "update", sequence: 2)
        let committed = state(from: committedCandidate, phase: .committed)

        #expect(throws: MonotonicReleasePolicyError.immutableCohortChange) {
            try assess(
                candidate(purpose: "update", sequence: 3, cohort: String(repeating: "c", count: 64)),
                current: committed
            )
        }
        #expect(throws: MonotonicReleasePolicyError.immutableCohortChange) {
            try assess(candidate(purpose: "update", keyEpoch: epoch + 1, sequence: 3), current: committed)
        }
        #expect(throws: MonotonicReleasePolicyError.sequenceRollbackOrConflict) {
            try assess(
                candidate(purpose: "update", sequence: 2, digest: String(repeating: "c", count: 64)),
                current: committed
            )
        }
    }

    private func assess(
        _ value: MonotonicReleaseCandidate,
        current: MonotonicReleaseStateSnapshot? = nil
    ) throws -> MonotonicReleasePolicyDecision {
        try MonotonicReleasePolicy.assess(
            candidate: value,
            current: current,
            initialKeyEpoch: epoch,
            allowedKeyEpochs: [epoch]
        )
    }

    private func candidate(
        purpose: String = "bootstrap",
        keyEpoch: UInt64? = nil,
        sequence: UInt64 = 1,
        releaseID: String? = nil,
        cohort: String? = nil,
        digest: String? = nil
    ) -> MonotonicReleaseCandidate {
        MonotonicReleaseCandidate(
            purpose: purpose,
            keyEpoch: keyEpoch ?? epoch,
            releaseSequence: sequence,
            releaseID: releaseID ?? self.releaseID,
            cohortPackageSHA256: cohort ?? self.cohort,
            envelopePayloadSHA256: digest ?? self.digest
        )
    }

    private func state(
        from candidate: MonotonicReleaseCandidate,
        phase: MonotonicReleasePhase
    ) -> MonotonicReleaseStateSnapshot {
        MonotonicReleaseStateSnapshot(
            purpose: candidate.purpose,
            phase: phase,
            keyEpoch: candidate.keyEpoch,
            releaseSequence: candidate.releaseSequence,
            releaseID: candidate.releaseID,
            cohortPackageSHA256: candidate.cohortPackageSHA256,
            envelopePayloadSHA256: candidate.envelopePayloadSHA256
        )
    }
}
