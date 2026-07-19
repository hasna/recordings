import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol

struct AtomicActivator {
    /// Persist the exact activation binding before MonotonicReleaseStateStore writes
    /// its highest-seen barrier. A crash can therefore never leave an unrecoverable
    /// `seen` state whose signed envelope must be replayed after expiry.
    func prepareActivation(
        candidatePath: String,
        stagedUpdate: StagedUpdate,
        payload: ReleaseEnvelopePayload,
        excludingAuthenticatedClientPID: pid_t
    ) throws {
        try validateApplicationsDirectory()
        do {
            try ApplicationProcessQuiescence.requireQuiescence(
                excludingAuthenticatedClientPID: excludingAuthenticatedClientPID
            )
        } catch {
            throw AtomicActivationError.activationDeferred
        }

        let applicationPath = RecordingsUpdateConstants.applicationPath
        let previousPath = stagedUpdate.directory + "/previous.app"
        let failedCandidatePath = stagedUpdate.directory + "/failed-candidate.app"
        let previousDigest = try digestIfPresent(applicationPath)
        let candidateMode = try applicationMode(candidatePath)
        let previousMode = previousDigest == nil ? nil : try applicationMode(applicationPath)
        let candidateExecutableModes = try applicationExecutableModes(candidatePath)
        let previousExecutableModes = previousDigest == nil
            ? nil
            : try applicationExecutableModes(applicationPath)
        guard try digestIfPresent(candidatePath) == payload.candidateTreeSHA256,
              try digestIfPresent(previousPath) == nil,
              try digestIfPresent(failedCandidatePath) == nil
        else {
            throw AtomicActivationError.invalidPreparedState
        }
        let envelopePayloadDigest = try SHA256.hash(data: payload.canonicalData())
            .map { String(format: "%02x", $0) }
            .joined()
        let journal = BrokerInstallJournal(
            schemaVersion: RecordingsUpdateConstants.protocolVersion,
            transactionID: stagedUpdate.transactionID.uuidString.lowercased(),
            phase: "prepared",
            releaseID: payload.releaseID,
            releaseSequence: payload.releaseSequence,
            keyEpoch: payload.keyEpoch,
            envelopePayloadSHA256: envelopePayloadDigest,
            artifactSHA256: stagedUpdate.archive.sha256,
            manifestSHA256: stagedUpdate.manifest.sha256,
            cohortPackageSHA256: payload.packageSHA256,
            candidateTreeSHA256: payload.candidateTreeSHA256,
            minimumOSVersion: payload.minimumOSVersion,
            candidateApplicationMode: candidateMode,
            candidateExecutableModes: candidateExecutableModes,
            previousTreeSHA256: previousDigest,
            previousApplicationMode: previousMode,
            previousExecutableModes: previousExecutableModes,
            previousApplicationPath: previousDigest == nil ? nil : previousPath,
            candidateApplicationPath: candidatePath,
            applicationPath: applicationPath
        )
        try DurableInstallJournal(transactionDirectory: stagedUpdate.directory).write(journal)
    }

    func activatePrepared(
        stagedUpdate: StagedUpdate,
        payload: ReleaseEnvelopePayload,
        excludingAuthenticatedClientPID: pid_t
    ) throws {
        let durableJournal = DurableInstallJournal(transactionDirectory: stagedUpdate.directory)
        guard var journal = try durableJournal.read(),
              journal.phase == "prepared",
              journal.transactionID == stagedUpdate.transactionID.uuidString.lowercased(),
              journal.releaseID == payload.releaseID,
              journal.releaseSequence == payload.releaseSequence,
              journal.keyEpoch == payload.keyEpoch,
              journal.artifactSHA256 == stagedUpdate.archive.sha256,
              journal.manifestSHA256 == stagedUpdate.manifest.sha256,
              journal.cohortPackageSHA256 == payload.packageSHA256,
              journal.candidateTreeSHA256 == payload.candidateTreeSHA256,
              journal.minimumOSVersion == payload.minimumOSVersion,
              journal.envelopePayloadSHA256 == envelopeDigest(payload)
        else {
            throw AtomicActivationError.recoveryRequired
        }

        let namespace: ApplicationNamespace
        do {
            namespace = try ApplicationNamespace(journal: journal)
            try ApplicationProcessQuiescence.requireQuiescence(
                excludingAuthenticatedClientPID: excludingAuthenticatedClientPID
            )
        } catch is ApplicationProcessQuiescenceError {
            throw AtomicActivationError.activationDeferred
        } catch {
            throw AtomicActivationError.recoveryRequired
        }

        do {
            journal.phase = "launch-barrier-pending"
            try durableJournal.write(journal)
            try namespace.engageLaunchBarrier(journal: journal)
            journal.phase = "launch-barrier-held"
            try durableJournal.write(journal)
            do {
                try ApplicationProcessQuiescence.requireQuiescence(
                    excludingAuthenticatedClientPID: excludingAuthenticatedClientPID
                )
            } catch {
                throw AtomicActivationError.activationDeferred
            }

            if let previousDigest = journal.previousTreeSHA256 {
                guard ActivationRecoveryPolicy.commitAction(
                    snapshot: try Self.namespaceSnapshot(journal),
                    previousDigest: previousDigest,
                    candidateDigest: journal.candidateTreeSHA256
                ) == .exchangeCandidateAndLive else {
                    throw AtomicActivationError.invalidPreparedState
                }
                journal.phase = "swap-pending"
                try durableJournal.write(journal)
                try namespace.exchangeCandidateAndLive()
                guard ActivationRecoveryPolicy.commitAction(
                    snapshot: try Self.namespaceSnapshot(journal),
                    previousDigest: previousDigest,
                    candidateDigest: journal.candidateTreeSHA256
                ) == .retainPrevious else {
                    throw AtomicActivationError.bindingChanged
                }
                journal.phase = "swapped"
                try durableJournal.write(journal)

                journal.phase = "previous-retaining"
                try durableJournal.write(journal)
                try namespace.retainSwappedPreviousExclusively()
                guard ActivationRecoveryPolicy.commitAction(
                    snapshot: try Self.namespaceSnapshot(journal),
                    previousDigest: previousDigest,
                    candidateDigest: journal.candidateTreeSHA256
                ) == .ready else {
                    throw AtomicActivationError.bindingChanged
                }
                journal.phase = "previous-retained"
                try durableJournal.write(journal)
            } else {
                guard ActivationRecoveryPolicy.commitAction(
                    snapshot: try Self.namespaceSnapshot(journal),
                    previousDigest: nil,
                    candidateDigest: journal.candidateTreeSHA256
                ) == .installCandidateExclusively else {
                    throw AtomicActivationError.invalidPreparedState
                }
                journal.phase = "first-install-pending"
                try durableJournal.write(journal)
                try namespace.installCandidateExclusively()
                guard ActivationRecoveryPolicy.commitAction(
                    snapshot: try Self.namespaceSnapshot(journal),
                    previousDigest: nil,
                    candidateDigest: journal.candidateTreeSHA256
                ) == .ready else {
                    throw AtomicActivationError.bindingChanged
                }
                journal.phase = "first-installed"
                try durableJournal.write(journal)
            }
            journal.phase = "launch-barrier-releasing"
            try durableJournal.write(journal)
            try namespace.releaseCommittedLaunchBarrier(journal: journal)
            try Self.requireCommittedNamespaceState(journal)
            journal.phase = "launch-barrier-released"
            try durableJournal.write(journal)
            journal.phase = "activated"
            try durableJournal.write(journal)
            journal.phase = "committed"
            try durableJournal.write(journal)
        } catch {
            if Self.requiresCommitRecovery(phase: journal.phase) {
                // Once release of the launch barrier begins, the candidate may be
                // executable. Never roll back underneath a process that could have
                // started; startup recovery completes this exact bound candidate.
                throw AtomicActivationError.recoveryRequired
            }
            do {
                try rollback(
                    journal: &journal,
                    durableJournal: durableJournal,
                    namespace: namespace
                )
            } catch {
                throw AtomicActivationError.recoveryRequired
            }
            if error is ApplicationProcessQuiescenceError {
                throw AtomicActivationError.activationDeferred
            }
            if let activationError = error as? AtomicActivationError {
                throw activationError
            }
            throw AtomicActivationError.namespaceMutationFailed
        }
    }

    private func rollback(
        journal: inout BrokerInstallJournal,
        durableJournal: DurableInstallJournal,
        namespace: ApplicationNamespace
    ) throws {
        journal.phase = "rollback-started"
        try durableJournal.write(journal)
        try Self.restoreRollbackTerminal(journal: journal, namespace: namespace)
        try namespace.releaseRolledBackLaunchBarrier(journal: journal)
        try Self.requireRollbackTerminalState(journal: journal)
        journal.phase = "rolled-back"
        try durableJournal.write(journal)
    }

    static func restoreRollbackTerminal(
        journal: BrokerInstallJournal,
        namespace: ApplicationNamespace
    ) throws {
        for _ in 0..<4 {
            let snapshot = try namespaceSnapshot(journal)
            switch ActivationRecoveryPolicy.rollbackAction(
                snapshot: snapshot,
                previousDigest: journal.previousTreeSHA256,
                candidateDigest: journal.candidateTreeSHA256
            ) {
            case .exchangeCandidateAndLive:
                try namespace.exchangeCandidateAndLive()
            case .exchangePreviousAndLive:
                try namespace.exchangeRetainedPreviousAndLive()
            case .retainFailedFromPrevious:
                try namespace.retainFailedCandidateFromPreviousSlotExclusively()
            case .retainFailedFromLive:
                try namespace.retainFailedCandidateFromLiveExclusively()
            case .ready:
                return
            case .invalid:
                throw AtomicActivationError.unprovenNamespaceDuringRollback
            }
        }
        throw AtomicActivationError.unprovenNamespaceDuringRollback
    }

    static func requireRollbackTerminalState(journal: BrokerInstallJournal) throws {
        let snapshot = try normalNamespaceSnapshot(journal)
        guard ActivationRecoveryPolicy.rollbackAction(
            snapshot: snapshot,
            previousDigest: journal.previousTreeSHA256,
            candidateDigest: journal.candidateTreeSHA256
        ) == .ready else {
            throw AtomicActivationError.unprovenNamespaceDuringRollback
        }
    }

    static func normalNamespaceSnapshot(
        _ journal: BrokerInstallJournal
    ) throws -> ApplicationNamespaceSnapshot {
        ApplicationNamespaceSnapshot(
            live: try digestIfPresent(journal.applicationPath),
            candidateSlot: try digestIfPresent(journal.candidateApplicationPath),
            previousSlot: try digestIfPresent(journal.previousApplicationPath),
            failedSlot: try digestIfPresent(failedCandidatePath(journal))
        )
    }

    static func requireCommittedNamespaceState(journal: BrokerInstallJournal) throws {
        guard try digestIfPresent(journal.applicationPath) == journal.candidateTreeSHA256,
              try digestIfPresent(journal.candidateApplicationPath) == nil,
              try digestIfPresent(journal.previousApplicationPath) == journal.previousTreeSHA256,
              try digestIfPresent(failedCandidatePath(journal)) == nil
        else {
            throw AtomicActivationError.bindingChanged
        }
    }

    static func namespaceSnapshot(
        _ journal: BrokerInstallJournal
    ) throws -> ApplicationNamespaceSnapshot {
        ApplicationNamespaceSnapshot(
            live: try barrierBoundDigestIfPresent(journal.applicationPath, journal: journal),
            candidateSlot: try barrierBoundDigestIfPresent(
                journal.candidateApplicationPath,
                journal: journal
            ),
            previousSlot: try barrierBoundDigestIfPresent(
                journal.previousApplicationPath,
                journal: journal
            ),
            failedSlot: try barrierBoundDigestIfPresent(
                failedCandidatePath(journal),
                journal: journal
            )
        )
    }

    static func barrierBoundDigestIfPresent(
        _ path: String?,
        journal: BrokerInstallJournal
    ) throws -> String? {
        guard let path else { return nil }
        var metadata = stat()
        if lstat(path, &metadata) != 0 {
            if errno == ENOENT { return nil }
            throw AtomicActivationError.bindingChanged
        }
        let applicationMode = UInt16(metadata.st_mode & 0o777)
        let allowedApplicationModes = Set(
            [0, journal.candidateApplicationMode, journal.previousApplicationMode ?? 0]
        )
        guard allowedApplicationModes.contains(applicationMode) else {
            throw AtomicActivationError.bindingChanged
        }
        var actualExecutableModes: [String: UInt16] = [:]
        for relativePath in journal.candidateExecutableModes.keys {
            var executableMetadata = stat()
            guard lstat(path + "/" + relativePath, &executableMetadata) == 0,
                  (executableMetadata.st_mode & S_IFMT) == S_IFREG
            else {
                throw AtomicActivationError.bindingChanged
            }
            let executableMode = UInt16(executableMetadata.st_mode & 0o777)
            let allowedExecutableModes = Set([
                0,
                journal.candidateExecutableModes[relativePath] ?? 0,
                journal.previousExecutableModes?[relativePath] ?? 0,
            ])
            guard allowedExecutableModes.contains(executableMode) else {
                throw AtomicActivationError.bindingChanged
            }
            actualExecutableModes[relativePath] = executableMode
        }
        if applicationMode != 0,
           actualExecutableModes.values.allSatisfy({ $0 != 0 }) {
            return try CanonicalTree.digest(at: path)
        }

        var candidateOverrides = journal.candidateExecutableModes
        candidateOverrides["."] = journal.candidateApplicationMode
        let candidateDigest = try CanonicalTree.digest(
            at: path,
            modeOverrides: candidateOverrides
        )
        if candidateDigest == journal.candidateTreeSHA256 { return candidateDigest }
        if let previousDigest = journal.previousTreeSHA256,
           let previousMode = journal.previousApplicationMode {
            guard var previousOverrides = journal.previousExecutableModes else {
                throw AtomicActivationError.bindingChanged
            }
            previousOverrides["."] = previousMode
            let restoredDigest = try CanonicalTree.digest(
                at: path,
                modeOverrides: previousOverrides
            )
            if restoredDigest == previousDigest { return restoredDigest }
        }
        throw AtomicActivationError.bindingChanged
    }

    static func digestIfPresent(_ path: String?) throws -> String? {
        guard let path else { return nil }
        var metadata = stat()
        if lstat(path, &metadata) != 0 {
            if errno == ENOENT { return nil }
            throw AtomicActivationError.bindingChanged
        }
        return try CanonicalTree.digest(at: path)
    }

    static func applicationMode(_ path: String) throws -> UInt16 {
        let descriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw AtomicActivationError.bindingChanged }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw AtomicActivationError.bindingChanged
        }
        return UInt16(metadata.st_mode & 0o777)
    }

    static func applicationExecutableModes(
        _ applicationPath: String
    ) throws -> [String: UInt16] {
        let paths = [
            "Contents/MacOS/Recordings",
            "Contents/Helpers/recordings",
            "Contents/Helpers/recordings-update-client",
        ]
        var modes: [String: UInt16] = [:]
        for relativePath in paths {
            let descriptor = Darwin.open(
                applicationPath + "/" + relativePath,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW
            )
            guard descriptor >= 0 else { throw AtomicActivationError.bindingChanged }
            var metadata = stat()
            let valid = fstat(descriptor, &metadata) == 0 &&
                (metadata.st_mode & S_IFMT) == S_IFREG &&
                metadata.st_uid == 0 &&
                (metadata.st_mode & 0o022) == 0 &&
                metadata.st_nlink == 1 &&
                DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
            Darwin.close(descriptor)
            guard valid else { throw AtomicActivationError.bindingChanged }
            modes[relativePath] = UInt16(metadata.st_mode & 0o777)
        }
        return modes
    }

    static func failedCandidatePath(_ journal: BrokerInstallJournal) -> String {
        URL(fileURLWithPath: journal.candidateApplicationPath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("failed-candidate.app").path
    }

    private func validateApplicationsDirectory() throws {
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
            to: "/Applications"
        ) else {
            throw AtomicActivationError.unsafeApplicationsDirectory
        }
        let descriptor = Darwin.open("/Applications", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw AtomicActivationError.unsafeApplicationsDirectory }
        defer { Darwin.close(descriptor) }
        guard DarwinACLValidator.descriptorIsSafeRootOwnedDirectory(
            descriptor,
            exactPath: "/Applications"
        ) else {
            throw AtomicActivationError.unsafeApplicationsDirectory
        }
    }

    private func envelopeDigest(_ payload: ReleaseEnvelopePayload) throws -> String {
        try SHA256.hash(data: payload.canonicalData())
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func requiresCommitRecovery(phase: String) -> Bool {
        phase == "launch-barrier-releasing" ||
            phase == "launch-barrier-released" ||
            phase == "activated" ||
            phase == "committed"
    }
}

enum AtomicActivationError: Error, CustomStringConvertible {
    case unsafeApplicationsDirectory
    case activationDeferred
    case invalidPreparedState
    case namespaceMutationFailed
    case bindingChanged
    case unprovenNamespaceDuringRollback
    case recoveryRequired

    var description: String {
        switch self {
        case .unsafeApplicationsDirectory: "The Applications directory is unsafe"
        case .activationDeferred: "Activation is deferred until live-bundle processes exit"
        case .invalidPreparedState: "The prepared activation namespace is invalid"
        case .namespaceMutationFailed: "The atomic application namespace mutation failed"
        case .bindingChanged: "An application tree changed across activation"
        case .unprovenNamespaceDuringRollback: "Rollback found an unproven application namespace"
        case .recoveryRequired: "Activation rollback requires broker startup recovery"
        }
    }
}
