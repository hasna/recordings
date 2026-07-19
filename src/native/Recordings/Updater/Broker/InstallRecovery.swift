import Darwin
import Foundation
import RecordingsUpdateProtocol

enum BrokerStartupRecovery {
    static func recoverInterruptedTransactions() throws {
        guard geteuid() == 0 else { throw InstallRecoveryError.notRoot }
        let rootState = try RootUpdateState()
        try rootState.withExclusiveTransactionLock {
            try recoverLocked(rootState: rootState)
        }
    }

    private static func recoverLocked(rootState: RootUpdateState) throws {
        let names = try FileManager.default.contentsOfDirectory(
            atPath: RecordingsUpdateConstants.stateRoot
        ).sorted()
        let stateStore = try MonotonicReleaseStateStore()
        for name in names where name.hasPrefix("transaction-") {
            guard let identifier = UUID(uuidString: String(name.dropFirst("transaction-".count))),
                  "transaction-" + identifier.uuidString.lowercased() == name
            else {
                throw InstallRecoveryError.invalidTransactionDirectory
            }
            let directory = RecordingsUpdateConstants.stateRoot + "/" + name
            try validateTransactionDirectory(directory)
            let durableJournal = DurableInstallJournal(transactionDirectory: directory)
            let current = try stateStore.currentState()
            guard var journal = try durableJournal.read() else {
                // An unjournaled transaction is inert only when there is no unresolved
                // highest-seen barrier. Never silently prune the only possible evidence
                // for a `seen` state created by an older or interrupted broker.
                guard current?.phase != "seen" else {
                    throw InstallRecoveryError.missingJournalForSeenState
                }
                try rootState.removeTransactionDirectory(id: identifier)
                continue
            }
            let terminalPhases: Set<String> = [
                "rolled-back", "committed", "bootstrap-aborted", "bootstrap-committed",
            ]
            if !terminalPhases.contains(journal.phase) {
                // A pre-hardening journal without signed minimum-OS evidence may
                // be decoded for terminal cleanup, but it can never resume mutation.
                guard let minimumOSVersion = journal.minimumOSVersion else {
                    throw InstallRecoveryError.invalidJournalPhase
                }
                try HostOSVersionPolicy.validate(
                    candidateMinimumOSVersion: minimumOSVersion,
                    hostProductVersion: try HostOSProductVersionReader.read()
                )
            }
            if journal.resolvedOperation == .bootstrapCommit {
                try recoverBootstrapCommit(
                    journal: &journal,
                    current: current,
                    durableJournal: durableJournal,
                    stateStore: stateStore
                )
                try rootState.removeTransactionDirectory(id: identifier)
                continue
            }
            if journal.phase == "rolled-back" {
                try requireRollbackTerminalState(journal)
                switch try rolledBackBarrierAction(journal: journal, current: current) {
                case .finalizeAbortThenPrune:
                    try stateStore.finalizeRecoveredAbort(journal: journal)
                case .prune:
                    break
                case .invalid:
                    throw InstallRecoveryError.monotonicStateMismatch
                }
                try rootState.removeTransactionDirectory(id: identifier)
                continue
            }
            if journal.phase == "committed" {
                try recoverCommitted(
                    journal: journal,
                    current: current,
                    stateStore: stateStore
                )
                try rootState.removeTransactionDirectory(id: identifier)
                continue
            }

            if journal.phase == "prepared" {
                switch try preparedBarrierAction(journal: journal, current: current) {
                case .recover:
                    try recoverPreparedWithSeenBarrier(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case .discard:
                    try discardPreparedBeforeSeen(
                        journal: &journal,
                        current: current,
                        durableJournal: durableJournal
                    )
                case .invalid:
                    throw InstallRecoveryError.monotonicStateMismatch
                }
            } else {
                try requireExactHighestSeen(journal: journal, current: current)
                switch journal.phase {
                case "launch-barrier-pending", "launch-barrier-held":
                    try recoverLaunchBarrierAndCommit(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "swap-pending":
                    try recoverSwapPending(journal: &journal, durableJournal: durableJournal)
                    try releaseCommittedLaunchBarrier(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try finishCommitted(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "swapped", "previous-retaining":
                    try recoverPreviousRetention(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try releaseCommittedLaunchBarrier(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try finishCommitted(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "previous-retained", "first-installed", "launch-barrier-releasing":
                    try releaseCommittedLaunchBarrier(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try finishCommitted(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "launch-barrier-released", "activated":
                    try finishCommitted(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "first-install-pending":
                    try recoverFirstInstallPending(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try releaseCommittedLaunchBarrier(
                        journal: &journal,
                        durableJournal: durableJournal
                    )
                    try finishCommitted(
                        journal: &journal,
                        durableJournal: durableJournal,
                        stateStore: stateStore
                    )
                case "rollback-started":
                    try finishRollback(journal: journal)
                    journal.phase = "rolled-back"
                    try durableJournal.write(journal)
                    try stateStore.finalizeRecoveredAbort(journal: journal)
                default:
                    throw InstallRecoveryError.invalidJournalPhase
                }
            }
            guard journal.phase == "rolled-back" || journal.phase == "committed" else {
                throw InstallRecoveryError.invalidJournalPhase
            }
            try rootState.removeTransactionDirectory(id: identifier)
        }
    }

    private static func recoverBootstrapCommit(
        journal: inout BrokerInstallJournal,
        current: PersistedReleaseState?,
        durableJournal: DurableInstallJournal,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        let journalPhase: BootstrapJournalPhase
        switch journal.phase {
        case "bootstrap-prepared": journalPhase = .prepared
        case "bootstrap-commit-pending": journalPhase = .commitPending
        case "bootstrap-aborted": journalPhase = .aborted
        case "bootstrap-committed": journalPhase = .committed
        default: throw InstallRecoveryError.invalidJournalPhase
        }

        let candidateMatches: Bool
        if current == nil {
            // Before `seen`, the broker has not performed a bootstrap state mutation.
            // The exact root-owned journal may therefore be closed without trusting
            // or re-reading a candidate that an administrator changed meanwhile.
            candidateMatches = true
        } else {
            do {
                candidateMatches = try CanonicalTree.digest(at: journal.applicationPath) ==
                    journal.candidateTreeSHA256
            } catch {
                candidateMatches = false
            }
        }

        switch BootstrapRecoveryPolicy.action(
            journalPhase: journalPhase,
            currentPhase: try monotonicBarrierPhase(current),
            exactBinding: exactReleaseBinding(journal: journal, current: current),
            priorMonotonicStateWasAbsent: journal.bootstrapPriorMonotonicState == "absent",
            candidateMatches: candidateMatches
        ) {
        case .discardBeforeSeen:
            journal.phase = "bootstrap-aborted"
            try durableJournal.write(journal)
        case .finalizeCommit:
            if journal.phase == "bootstrap-prepared" {
                journal.phase = "bootstrap-commit-pending"
                try durableJournal.write(journal)
            }
            try stateStore.finalizeRecoveredCommit(journal: journal)
            journal.phase = "bootstrap-committed"
            try durableJournal.write(journal)
        case .validateCommitted:
            guard current?.phase == "committed" else {
                throw InstallRecoveryError.monotonicStateMismatch
            }
            journal.phase = "bootstrap-committed"
            try durableJournal.write(journal)
        case .prune:
            break
        case .invalid:
            throw InstallRecoveryError.monotonicStateMismatch
        }
    }

    private static func recoverPreparedWithSeenBarrier(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        journal.phase = "launch-barrier-pending"
        try durableJournal.write(journal)
        try recoverLaunchBarrierAndCommit(
            journal: &journal,
            durableJournal: durableJournal,
            stateStore: stateStore
        )
    }

    private static func recoverLaunchBarrierAndCommit(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        let namespace = try applicationNamespace(journal)
        try mapNamespaceMutation { try namespace.engageLaunchBarrier(journal: journal) }
        journal.phase = "launch-barrier-held"
        try durableJournal.write(journal)
        try requireQuiescence()
        if journal.previousTreeSHA256 == nil {
            journal.phase = "first-install-pending"
            try durableJournal.write(journal)
            try recoverFirstInstallPending(journal: &journal, durableJournal: durableJournal)
        } else {
            journal.phase = "swap-pending"
            try durableJournal.write(journal)
            try recoverSwapPending(journal: &journal, durableJournal: durableJournal)
        }
        try releaseCommittedLaunchBarrier(
            journal: &journal,
            durableJournal: durableJournal
        )
        try finishCommitted(
            journal: &journal,
            durableJournal: durableJournal,
            stateStore: stateStore
        )
    }

    private static func recoverSwapPending(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal
    ) throws {
        guard let previousDigest = journal.previousTreeSHA256 else {
            throw InstallRecoveryError.invalidJournalPhase
        }
        let namespace = try applicationNamespace(journal)
        switch ActivationRecoveryPolicy.commitAction(
            snapshot: try namespaceSnapshot(journal),
            previousDigest: previousDigest,
            candidateDigest: journal.candidateTreeSHA256
        ) {
        case .exchangeCandidateAndLive:
            try requireQuiescence()
            try mapNamespaceMutation { try namespace.exchangeCandidateAndLive() }
        case .retainPrevious, .ready:
            // The exchange or subsequent retain completed before its phase write.
            break
        case .installCandidateExclusively, .invalid:
            throw InstallRecoveryError.ambiguousApplicationState
        }
        journal.phase = "swapped"
        try durableJournal.write(journal)
        try recoverPreviousRetention(journal: &journal, durableJournal: durableJournal)
    }

    private static func recoverPreviousRetention(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal
    ) throws {
        guard let previousDigest = journal.previousTreeSHA256 else {
            throw InstallRecoveryError.ambiguousApplicationState
        }
        let namespace = try applicationNamespace(journal)
        switch ActivationRecoveryPolicy.commitAction(
            snapshot: try namespaceSnapshot(journal),
            previousDigest: previousDigest,
            candidateDigest: journal.candidateTreeSHA256
        ) {
        case .retainPrevious:
            journal.phase = "previous-retaining"
            try durableJournal.write(journal)
            try mapNamespaceMutation { try namespace.retainSwappedPreviousExclusively() }
        case .ready:
            // Retain completed before the durable phase update.
            break
        case .exchangeCandidateAndLive, .installCandidateExclusively, .invalid:
            throw InstallRecoveryError.ambiguousApplicationState
        }
        try requireBarrierHeldCommittedNamespaceState(journal)
        journal.phase = "previous-retained"
        try durableJournal.write(journal)
    }

    private static func recoverFirstInstallPending(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal
    ) throws {
        guard journal.previousTreeSHA256 == nil else {
            throw InstallRecoveryError.invalidJournalPhase
        }
        let namespace = try applicationNamespace(journal)
        switch ActivationRecoveryPolicy.commitAction(
            snapshot: try namespaceSnapshot(journal),
            previousDigest: nil,
            candidateDigest: journal.candidateTreeSHA256
        ) {
        case .installCandidateExclusively:
            try requireQuiescence()
            try mapNamespaceMutation { try namespace.installCandidateExclusively() }
        case .ready:
            // Exclusive install completed before its phase write.
            break
        case .exchangeCandidateAndLive, .retainPrevious, .invalid:
            throw InstallRecoveryError.ambiguousApplicationState
        }
        try requireBarrierHeldCommittedNamespaceState(journal)
        journal.phase = "first-installed"
        try durableJournal.write(journal)
    }

    private static func discardPreparedBeforeSeen(
        journal: inout BrokerInstallJournal,
        current: PersistedReleaseState?,
        durableJournal: DurableInstallJournal
    ) throws {
        if let current {
            let exactAborted = current.phase == "aborted" &&
                current.keyEpoch == journal.keyEpoch &&
                current.releaseSequence == journal.releaseSequence &&
                current.releaseID == journal.releaseID &&
                current.envelopePayloadSHA256 == journal.envelopePayloadSHA256
            let olderTerminal = (current.phase == "committed" || current.phase == "aborted") &&
                current.keyEpoch == journal.keyEpoch &&
                current.cohortPackageSHA256 == journal.cohortPackageSHA256 &&
                current.releaseSequence < journal.releaseSequence
            guard exactAborted || olderTerminal else {
                throw InstallRecoveryError.monotonicStateMismatch
            }
        }
        guard try digestIfPresent(journal.applicationPath) == journal.previousTreeSHA256,
              try digestIfPresent(journal.candidateApplicationPath) == journal.candidateTreeSHA256,
              try digestIfPresent(journal.previousApplicationPath) == nil,
              try digestIfPresent(failedCandidatePath(journal)) == nil
        else {
            throw InstallRecoveryError.ambiguousApplicationState
        }
        journal.phase = "rolled-back"
        try durableJournal.write(journal)
    }

    private static func finishRollback(journal: BrokerInstallJournal) throws {
        let namespace = try applicationNamespace(journal)
        do {
            try AtomicActivator.restoreRollbackTerminal(journal: journal, namespace: namespace)
            try namespace.releaseRolledBackLaunchBarrier(journal: journal)
            try AtomicActivator.requireRollbackTerminalState(journal: journal)
        } catch {
            throw InstallRecoveryError.rollbackFailed
        }
    }

    private static func requireRollbackTerminalState(_ journal: BrokerInstallJournal) throws {
        do {
            try AtomicActivator.requireRollbackTerminalState(journal: journal)
        } catch {
            throw InstallRecoveryError.rollbackFailed
        }
    }

    private static func requireCommittedNamespaceState(_ journal: BrokerInstallJournal) throws {
        do { try AtomicActivator.requireCommittedNamespaceState(journal: journal) }
        catch { throw InstallRecoveryError.ambiguousApplicationState }
    }

    private static func requireBarrierHeldCommittedNamespaceState(
        _ journal: BrokerInstallJournal
    ) throws {
        let action = ActivationRecoveryPolicy.commitAction(
            snapshot: try namespaceSnapshot(journal),
            previousDigest: journal.previousTreeSHA256,
            candidateDigest: journal.candidateTreeSHA256
        )
        guard action == .ready else {
            throw InstallRecoveryError.ambiguousApplicationState
        }
    }

    private static func releaseCommittedLaunchBarrier(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal
    ) throws {
        journal.phase = "launch-barrier-releasing"
        try durableJournal.write(journal)
        let namespace = try applicationNamespace(journal)
        try mapNamespaceMutation {
            try namespace.releaseCommittedLaunchBarrier(journal: journal)
        }
        try requireCommittedNamespaceState(journal)
        journal.phase = "launch-barrier-released"
        try durableJournal.write(journal)
    }

    private static func validateTransactionDirectory(_ path: String) throws {
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(to: path) else {
            throw InstallRecoveryError.invalidTransactionDirectory
        }
        var metadata = stat()
        guard lstat(path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0
        else {
            throw InstallRecoveryError.invalidTransactionDirectory
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw InstallRecoveryError.invalidTransactionDirectory }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0,
              opened.st_dev == metadata.st_dev,
              opened.st_ino == metadata.st_ino,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw InstallRecoveryError.invalidTransactionDirectory
        }
    }

    private static func preparedBarrierAction(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) throws -> PreparedBarrierRecoveryAction {
        ActivationRecoveryPolicy.preparedBarrierAction(
            currentPhase: try monotonicBarrierPhase(current),
            currentSequence: current?.releaseSequence,
            journalSequence: journal.releaseSequence,
            exactBinding: exactReleaseBinding(journal: journal, current: current),
            sameCohort: sameCohort(journal: journal, current: current)
        )
    }

    private static func rolledBackBarrierAction(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) throws -> RolledBackBarrierRecoveryAction {
        ActivationRecoveryPolicy.rolledBackBarrierAction(
            currentPhase: try monotonicBarrierPhase(current),
            currentSequence: current?.releaseSequence,
            journalSequence: journal.releaseSequence,
            exactBinding: exactReleaseBinding(journal: journal, current: current),
            sameCohort: sameCohort(journal: journal, current: current)
        )
    }

    private static func monotonicBarrierPhase(
        _ current: PersistedReleaseState?
    ) throws -> MonotonicBarrierPhase? {
        guard let current else { return nil }
        switch current.phase {
        case "seen": return .seen
        case "aborted": return .aborted
        case "committed": return .committed
        default: throw InstallRecoveryError.monotonicStateMismatch
        }
    }

    private static func exactReleaseBinding(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) -> Bool {
        guard let current else { return false }
        return current.purpose == journal.expectedPurpose &&
            current.keyEpoch == journal.keyEpoch &&
            current.releaseSequence == journal.releaseSequence &&
            current.releaseID == journal.releaseID &&
            current.cohortPackageSHA256 == journal.cohortPackageSHA256 &&
            current.envelopePayloadSHA256 == journal.envelopePayloadSHA256
    }

    private static func sameCohort(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) -> Bool {
        guard let current else { return false }
        return current.keyEpoch == journal.keyEpoch &&
            current.cohortPackageSHA256 == journal.cohortPackageSHA256
    }

    private static func recoverCommitted(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        guard let current,
              current.releaseSequence >= journal.releaseSequence
        else {
            throw InstallRecoveryError.monotonicStateMismatch
        }
        if current.releaseSequence > journal.releaseSequence { return }
        try requireExactReleaseBinding(journal: journal, current: current)
        try requireCommittedNamespaceState(journal)
        try stateStore.finalizeRecoveredCommit(journal: journal)
    }

    private static func exactHighestSeen(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) -> Bool {
        guard let current, current.phase == "seen" else { return false }
        return current.purpose == journal.expectedPurpose &&
            current.keyEpoch == journal.keyEpoch &&
            current.releaseSequence == journal.releaseSequence &&
            current.releaseID == journal.releaseID &&
            current.cohortPackageSHA256 == journal.cohortPackageSHA256 &&
            current.envelopePayloadSHA256 == journal.envelopePayloadSHA256
    }

    private static func requireExactHighestSeen(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState?
    ) throws {
        guard exactHighestSeen(journal: journal, current: current) else {
            throw InstallRecoveryError.monotonicStateMismatch
        }
    }

    private static func requireExactReleaseBinding(
        journal: BrokerInstallJournal,
        current: PersistedReleaseState
    ) throws {
        guard current.purpose == journal.expectedPurpose,
              current.keyEpoch == journal.keyEpoch,
              current.releaseSequence == journal.releaseSequence,
              current.releaseID == journal.releaseID,
              current.cohortPackageSHA256 == journal.cohortPackageSHA256,
              current.envelopePayloadSHA256 == journal.envelopePayloadSHA256
        else {
            throw InstallRecoveryError.monotonicStateMismatch
        }
    }

    private static func finishCommitted(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        try requireCommittedNamespaceState(journal)
        journal.phase = "committed"
        try durableJournal.write(journal)
        try stateStore.finalizeRecoveredCommit(journal: journal)
    }

    private static func applicationNamespace(_ journal: BrokerInstallJournal) throws -> ApplicationNamespace {
        do { return try ApplicationNamespace(journal: journal) }
        catch { throw InstallRecoveryError.invalidTransactionDirectory }
    }

    private static func mapNamespaceMutation(_ operation: () throws -> Void) throws {
        do { try operation() }
        catch { throw InstallRecoveryError.namespaceMutationFailed }
    }

    private static func requireQuiescence() throws {
        do {
            try ApplicationProcessQuiescence.requireQuiescence(
                excludingAuthenticatedClientPID: nil
            )
        } catch {
            throw InstallRecoveryError.activationDeferred
        }
    }

    private static func digestIfPresent(_ path: String?) throws -> String? {
        do { return try AtomicActivator.digestIfPresent(path) }
        catch { throw InstallRecoveryError.ambiguousApplicationState }
    }

    private static func namespaceSnapshot(
        _ journal: BrokerInstallJournal
    ) throws -> ApplicationNamespaceSnapshot {
        do { return try AtomicActivator.namespaceSnapshot(journal) }
        catch { throw InstallRecoveryError.ambiguousApplicationState }
    }

    private static func failedCandidatePath(_ journal: BrokerInstallJournal) -> String {
        AtomicActivator.failedCandidatePath(journal)
    }
}

enum InstallRecoveryError: Error, CustomStringConvertible {
    case notRoot
    case invalidTransactionDirectory
    case invalidJournalPhase
    case missingJournalForSeenState
    case monotonicStateMismatch
    case ambiguousApplicationState
    case activationDeferred
    case namespaceMutationFailed
    case rollbackFailed

    var description: String {
        switch self {
        case .notRoot: "The update broker is not running as root during recovery"
        case .invalidTransactionDirectory: "A protected update transaction directory is unsafe"
        case .invalidJournalPhase: "An install journal has an unsupported recovery phase"
        case .missingJournalForSeenState: "Highest-seen state has no recoverable transaction journal"
        case .monotonicStateMismatch: "An interrupted transaction does not match highest-seen state"
        case .ambiguousApplicationState: "Interrupted recovery found an ambiguous application namespace"
        case .activationDeferred: "Recovery is deferred until live-bundle processes exit"
        case .namespaceMutationFailed: "Recovery could not mutate the application namespace atomically"
        case .rollbackFailed: "Interrupted recovery could not restore the exact previous tree"
        }
    }
}
