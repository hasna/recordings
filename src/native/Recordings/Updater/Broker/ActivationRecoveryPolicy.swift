import Foundation

struct ApplicationNamespaceSnapshot: Equatable, Sendable {
    let live: String?
    let candidateSlot: String?
    let previousSlot: String?
    let failedSlot: String?
}

enum CommitRecoveryAction: Equatable, Sendable {
    case exchangeCandidateAndLive
    case installCandidateExclusively
    case retainPrevious
    case ready
    case invalid
}

enum RollbackRecoveryAction: Equatable, Sendable {
    case exchangeCandidateAndLive
    case exchangePreviousAndLive
    case retainFailedFromPrevious
    case retainFailedFromLive
    case ready
    case invalid
}

enum MonotonicBarrierPhase: Equatable, Sendable {
    case seen
    case aborted
    case committed
}

enum PreparedBarrierRecoveryAction: Equatable, Sendable {
    case recover
    case discard
    case invalid
}

enum RolledBackBarrierRecoveryAction: Equatable, Sendable {
    case finalizeAbortThenPrune
    case prune
    case invalid
}

enum BootstrapRecoveryAction: Equatable, Sendable {
    case discardBeforeSeen
    case finalizeCommit
    case validateCommitted
    case prune
    case invalid
}

enum BootstrapJournalPhase: Equatable, Sendable {
    case prepared
    case commitPending
    case aborted
    case committed
}

/// Pure bootstrap commit recovery. The broker performs no application namespace
/// mutation for bootstrap; recovery either closes a provably pre-seen journal or
/// commits the exact journal/state/candidate binding without envelope replay.
enum BootstrapRecoveryPolicy {
    static func action(
        journalPhase: BootstrapJournalPhase,
        currentPhase: MonotonicBarrierPhase?,
        exactBinding: Bool,
        priorMonotonicStateWasAbsent: Bool,
        candidateMatches: Bool
    ) -> BootstrapRecoveryAction {
        guard priorMonotonicStateWasAbsent else { return .invalid }

        guard let currentPhase else {
            switch journalPhase {
            case .prepared: return .discardBeforeSeen
            case .aborted: return .prune
            case .commitPending, .committed: return .invalid
            }
        }

        guard exactBinding, candidateMatches else { return .invalid }
        switch (currentPhase, journalPhase) {
        case (.seen, .prepared), (.seen, .commitPending):
            return .finalizeCommit
        case (.committed, .prepared), (.committed, .commitPending):
            return .validateCommitted
        case (.committed, .committed):
            return .prune
        default:
            return .invalid
        }
    }
}

/// Pure recovery decisions shared by live activation and startup recovery. Each
/// namespace shape corresponds to a crash/failure boundary before or after one
/// descriptor-relative rename and its directory fsync/phase-journal update.
enum ActivationRecoveryPolicy {
    static func preparedBarrierAction(
        currentPhase: MonotonicBarrierPhase?,
        currentSequence: UInt64?,
        journalSequence: UInt64,
        exactBinding: Bool,
        sameCohort: Bool
    ) -> PreparedBarrierRecoveryAction {
        guard let currentPhase, let currentSequence else { return .discard }
        if currentPhase == .seen, exactBinding { return .recover }
        if currentPhase == .aborted, exactBinding { return .discard }
        if (currentPhase == .committed || currentPhase == .aborted),
           sameCohort,
           currentSequence < journalSequence {
            return .discard
        }
        return .invalid
    }

    static func rolledBackBarrierAction(
        currentPhase: MonotonicBarrierPhase?,
        currentSequence: UInt64?,
        journalSequence: UInt64,
        exactBinding: Bool,
        sameCohort: Bool
    ) -> RolledBackBarrierRecoveryAction {
        guard let currentPhase, let currentSequence else { return .prune }
        if currentPhase == .seen, exactBinding { return .finalizeAbortThenPrune }
        if currentPhase == .aborted, exactBinding { return .prune }
        if (currentPhase == .committed || currentPhase == .aborted), sameCohort {
            if currentSequence != journalSequence { return .prune }
        }
        return .invalid
    }

    static func commitAction(
        snapshot: ApplicationNamespaceSnapshot,
        previousDigest: String?,
        candidateDigest: String
    ) -> CommitRecoveryAction {
        if let previousDigest {
            if snapshot == ApplicationNamespaceSnapshot(
                live: previousDigest,
                candidateSlot: candidateDigest,
                previousSlot: nil,
                failedSlot: nil
            ) {
                return .exchangeCandidateAndLive
            }
            if snapshot == ApplicationNamespaceSnapshot(
                live: candidateDigest,
                candidateSlot: previousDigest,
                previousSlot: nil,
                failedSlot: nil
            ) {
                return .retainPrevious
            }
            if snapshot == ApplicationNamespaceSnapshot(
                live: candidateDigest,
                candidateSlot: nil,
                previousSlot: previousDigest,
                failedSlot: nil
            ) {
                return .ready
            }
            return .invalid
        }

        if snapshot == ApplicationNamespaceSnapshot(
            live: nil,
            candidateSlot: candidateDigest,
            previousSlot: nil,
            failedSlot: nil
        ) {
            return .installCandidateExclusively
        }
        if snapshot == ApplicationNamespaceSnapshot(
            live: candidateDigest,
            candidateSlot: nil,
            previousSlot: nil,
            failedSlot: nil
        ) {
            return .ready
        }
        return .invalid
    }

    static func rollbackAction(
        snapshot: ApplicationNamespaceSnapshot,
        previousDigest: String?,
        candidateDigest: String
    ) -> RollbackRecoveryAction {
        if let previousDigest {
            if snapshot == ApplicationNamespaceSnapshot(
                live: previousDigest,
                candidateSlot: candidateDigest,
                previousSlot: nil,
                failedSlot: nil
            ) || snapshot == ApplicationNamespaceSnapshot(
                live: previousDigest,
                candidateSlot: nil,
                previousSlot: nil,
                failedSlot: candidateDigest
            ) {
                return .ready
            }
            if snapshot == ApplicationNamespaceSnapshot(
                live: previousDigest,
                candidateSlot: nil,
                previousSlot: candidateDigest,
                failedSlot: nil
            ) {
                return .retainFailedFromPrevious
            }
            if snapshot == ApplicationNamespaceSnapshot(
                live: candidateDigest,
                candidateSlot: previousDigest,
                previousSlot: nil,
                failedSlot: nil
            ) {
                return .exchangeCandidateAndLive
            }
            if snapshot == ApplicationNamespaceSnapshot(
                live: candidateDigest,
                candidateSlot: nil,
                previousSlot: previousDigest,
                failedSlot: nil
            ) {
                return .exchangePreviousAndLive
            }
            return .invalid
        }

        if snapshot == ApplicationNamespaceSnapshot(
            live: nil,
            candidateSlot: candidateDigest,
            previousSlot: nil,
            failedSlot: nil
        ) || snapshot == ApplicationNamespaceSnapshot(
            live: nil,
            candidateSlot: nil,
            previousSlot: nil,
            failedSlot: candidateDigest
        ) {
            return .ready
        }
        if snapshot == ApplicationNamespaceSnapshot(
            live: candidateDigest,
            candidateSlot: nil,
            previousSlot: nil,
            failedSlot: nil
        ) {
            return .retainFailedFromLive
        }
        return .invalid
    }
}
