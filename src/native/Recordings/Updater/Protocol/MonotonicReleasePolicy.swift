import Foundation

public enum MonotonicReleasePhase: String, Equatable, Sendable {
    case seen
    case aborted
    case committed
}

public struct MonotonicReleaseCandidate: Equatable, Sendable {
    public let purpose: String
    public let keyEpoch: UInt64
    public let releaseSequence: UInt64
    public let releaseID: String
    public let cohortPackageSHA256: String
    public let envelopePayloadSHA256: String

    public init(
        purpose: String,
        keyEpoch: UInt64,
        releaseSequence: UInt64,
        releaseID: String,
        cohortPackageSHA256: String,
        envelopePayloadSHA256: String
    ) {
        self.purpose = purpose
        self.keyEpoch = keyEpoch
        self.releaseSequence = releaseSequence
        self.releaseID = releaseID
        self.cohortPackageSHA256 = cohortPackageSHA256
        self.envelopePayloadSHA256 = envelopePayloadSHA256
    }
}

public struct MonotonicReleaseStateSnapshot: Equatable, Sendable {
    public let purpose: String
    public let phase: MonotonicReleasePhase
    public let keyEpoch: UInt64
    public let releaseSequence: UInt64
    public let releaseID: String
    public let cohortPackageSHA256: String
    public let envelopePayloadSHA256: String

    public init(
        purpose: String,
        phase: MonotonicReleasePhase,
        keyEpoch: UInt64,
        releaseSequence: UInt64,
        releaseID: String,
        cohortPackageSHA256: String,
        envelopePayloadSHA256: String
    ) {
        self.purpose = purpose
        self.phase = phase
        self.keyEpoch = keyEpoch
        self.releaseSequence = releaseSequence
        self.releaseID = releaseID
        self.cohortPackageSHA256 = cohortPackageSHA256
        self.envelopePayloadSHA256 = envelopePayloadSHA256
    }
}

public enum MonotonicReleasePolicyDecision: Equatable, Sendable {
    case advance
    case resumeSeen
    case alreadyCommitted
}

public enum MonotonicReleasePolicyError: Error, Equatable, Sendable {
    case immutableCohortChange
    case bootstrapRequired
    case bootstrapAlreadyInitialized
    case sequenceRollbackOrConflict
    case pendingSeenRecoveryRequired
}

/// Pure transition policy for the durable updater state machine.
///
/// A `seen` record is a recovery barrier: until its exact release commits or is
/// durably aborted after exact-tree rollback, no
/// other release may replace it, even when the other release has a higher
/// sequence. An `aborted` record preserves the highest observed sequence while
/// allowing only a strictly newer release from the same immutable cohort.
public enum MonotonicReleasePolicy {
    public static func assess(
        candidate: MonotonicReleaseCandidate,
        current: MonotonicReleaseStateSnapshot?,
        initialKeyEpoch: UInt64,
        allowedKeyEpochs: [UInt64]
    ) throws -> MonotonicReleasePolicyDecision {
        guard allowedKeyEpochs == [initialKeyEpoch],
              candidate.keyEpoch == initialKeyEpoch
        else {
            throw MonotonicReleasePolicyError.immutableCohortChange
        }

        guard let current else {
            guard candidate.purpose == "bootstrap" else {
                throw MonotonicReleasePolicyError.bootstrapRequired
            }
            return .advance
        }

        guard current.keyEpoch == initialKeyEpoch else {
            throw MonotonicReleasePolicyError.immutableCohortChange
        }

        let isExactReplay = candidate.purpose == current.purpose
            && candidate.keyEpoch == current.keyEpoch
            && candidate.releaseSequence == current.releaseSequence
            && candidate.releaseID == current.releaseID
            && candidate.cohortPackageSHA256 == current.cohortPackageSHA256
            && candidate.envelopePayloadSHA256 == current.envelopePayloadSHA256

        if current.phase == .seen {
            guard isExactReplay else {
                throw MonotonicReleasePolicyError.pendingSeenRecoveryRequired
            }
            return .resumeSeen
        }

        if current.phase == .aborted {
            guard candidate.purpose != "bootstrap" else {
                throw MonotonicReleasePolicyError.bootstrapAlreadyInitialized
            }
            guard candidate.cohortPackageSHA256 == current.cohortPackageSHA256 else {
                throw MonotonicReleasePolicyError.immutableCohortChange
            }
            guard candidate.releaseSequence > current.releaseSequence else {
                throw MonotonicReleasePolicyError.sequenceRollbackOrConflict
            }
            return .advance
        }

        if candidate.purpose == "bootstrap" {
            guard current.purpose == "bootstrap", isExactReplay else {
                throw MonotonicReleasePolicyError.bootstrapAlreadyInitialized
            }
            return .alreadyCommitted
        }

        guard candidate.cohortPackageSHA256 == current.cohortPackageSHA256 else {
            throw MonotonicReleasePolicyError.immutableCohortChange
        }
        if isExactReplay {
            return .alreadyCommitted
        }
        guard candidate.releaseSequence > current.releaseSequence else {
            throw MonotonicReleasePolicyError.sequenceRollbackOrConflict
        }
        return .advance
    }
}
