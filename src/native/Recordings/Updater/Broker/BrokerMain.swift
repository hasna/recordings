import Darwin
import CryptoKit
import Foundation
import RecordingsUpdateProtocol
import RecordingsVerifierLauncher

@main
enum RecordingsUpdateBrokerMain {
    static func main() {
        guard geteuid() == 0 else { Darwin.exit(78) }
        do {
            let policy = try RootTrustStore.readPolicy()
            // Recovery runs to a terminal exact-digest state before the Mach service
            // accepts any peer. Ambiguous journals keep launchd fail-closed.
            try BrokerStartupRecovery.recoverInterruptedTransactions()
            let delegate = BrokerListenerDelegate(policy: policy)
            withExtendedLifetime(delegate) {
                let listener = NSXPCListener(machServiceName: RecordingsUpdateConstants.machServiceName)
                listener.delegate = delegate
                listener.resume()
                RunLoop.current.run()
            }
        } catch {
            Darwin.exit(78)
        }
    }
}

final class BrokerListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let policy: BrokerPolicy
    private let peerPolicy: PeerIdentityPolicy

    init(policy: BrokerPolicy) {
        self.policy = policy
        peerPolicy = PeerIdentityPolicy(policy: policy)
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        do {
            let peer = try peerPolicy.authenticate(connection)
            let session = UpdateBrokerSession(peer: peer, policy: policy)
            connection.exportedInterface = makeRecordingsUpdateXPCInterface()
            connection.exportedObject = session
            connection.invalidationHandler = { _ = session }
            connection.resume()
            return true
        } catch {
            connection.invalidate()
            return false
        }
    }
}

final class UpdateBrokerSession: NSObject, RecordingsUpdateXPCProtocol {
    private let peer: AuthenticatedPeer
    private let policy: BrokerPolicy
    private let queue = DispatchQueue(label: "com.hasna.recordings.updater.transaction")

    init(peer: AuthenticatedPeer, policy: BrokerPolicy) {
        self.peer = peer
        self.policy = policy
    }

    func install(
        archive: FileHandle,
        manifest: FileHandle,
        envelope: FileHandle,
        withReply reply: @escaping (NSDictionary) -> Void
    ) {
        queue.async { [peer, policy] in
            do {
                reply(try Self.performInstall(
                    archive: archive,
                    manifest: manifest,
                    envelope: envelope,
                    peer: peer,
                    policy: policy
                ))
            } catch {
                if Self.requiresRecoveryRestart(after: error) {
                    // Never accept another release after an activation/journal
                    // durability failure. launchd restarts the broker, whose startup
                    // gate must reconcile exact journal and highest-seen state first.
                    Darwin.exit(75)
                }
                reply(Self.failureReply(for: error))
            }
        }
    }

    func queryStatus(withReply reply: @escaping (NSDictionary) -> Void) {
        queue.async { [policy] in
            do {
                let state = try MonotonicReleaseStateStore().currentState()
                let committed = state?.phase == "committed"
                let statusMessage: String
                if state == nil {
                    statusMessage = "No release committed"
                } else if committed {
                    statusMessage = "Release committed"
                } else if state?.phase == "aborted" {
                    statusMessage = "Release rolled back; a newer release is required"
                } else {
                    statusMessage = "Release seen; retry or recovery required"
                }
                reply([
                    RecordingsUpdateReplyKey.success: true,
                    RecordingsUpdateReplyKey.code: "ok",
                    RecordingsUpdateReplyKey.message: statusMessage,
                    RecordingsUpdateReplyKey.releaseID: state?.releaseID ?? "none",
                    RecordingsUpdateReplyKey.installedVersion: committed ? (state?.version ?? "none") : "none",
                    RecordingsUpdateReplyKey.lifecycle: policy.lifecycle,
                    RecordingsUpdateReplyKey.rootMaintenanceSupported: policy.rootMaintenanceSupported,
                    RecordingsUpdateReplyKey.keyRotationSupported: policy.keyRotationSupported,
                    RecordingsUpdateReplyKey.keyEpoch: state?.keyEpoch ?? policy.initialKeyEpoch,
                ])
            } catch {
                reply(Self.failureReply(for: error))
            }
        }
    }

    private static func performInstall(
        archive: FileHandle,
        manifest: FileHandle,
        envelope: FileHandle,
        peer: AuthenticatedPeer,
        policy: BrokerPolicy
    ) throws -> NSDictionary {
        // Peer signing is admission control, not update authorization. A process running
        // as the login UID can invoke the signed client; only this independently verified,
        // monotonic signed envelope can authorize mutation.
        guard policy.allowedClientIdentifiers.contains(peer.signingIdentifier),
              peer.signingTeamIdentifier == policy.signingTeamIdentifier
        else {
            throw BrokerOperationError.unauthorizedPeer
        }
        let rootState = try RootUpdateState()
        return try rootState.withExclusiveTransactionLock {
            try rootState.ensureTransactionQuota()
            let staged = try ArtifactIngestor(state: rootState).stage(
                archive: archive,
                manifest: manifest,
                envelope: envelope
            )
            do {
                let result = try performStagedInstall(staged: staged, policy: policy)
                try cleanupIfTerminalOrUnjournaled(staged: staged, rootState: rootState)
                return result
            } catch {
                if Self.requiresRecoveryRestart(after: error) {
                    // A state rename whose directory fsync failed is not durable proof
                    // of commit or abort even when an immediate reread sees the new
                    // phase. Preserve the exact journal for startup reconciliation.
                    throw error
                }
                do {
                    try cleanupIfTerminalOrUnjournaled(staged: staged, rootState: rootState)
                } catch {
                    throw error
                }
                throw error
            }
        }
    }

    private static func performStagedInstall(
        staged: StagedUpdate,
        policy: BrokerPolicy
    ) throws -> NSDictionary {
        guard let envelopeData = staged.envelope.data,
              let signedEnvelope = try? JSONDecoder().decode(SignedReleaseEnvelope.self, from: envelopeData)
        else {
            throw BrokerOperationError.invalidEnvelope
        }
        // The envelope may request only the key pinned by the immutable installed
        // cohort. Never select a root trust file from an unverified payload field.
        let publicKey = try RootTrustStore.readEnvelopePublicKey(epoch: policy.initialKeyEpoch)
        let payload: ReleaseEnvelopePayload
        do {
            payload = try signedEnvelope.verify(publicKeyData: publicKey)
        } catch let validationError as ReleaseEnvelopeValidationError {
            if case .brokerTooOld = validationError {
                throw BrokerOperationError.unsupportedLifecycle
            }
            throw BrokerOperationError.signatureRejected
        } catch {
            throw BrokerOperationError.signatureRejected
        }
        let hostProductVersion = try HostOSProductVersionReader.read()
        try HostOSVersionPolicy.validate(
            candidateMinimumOSVersion: payload.minimumOSVersion,
            hostProductVersion: hostProductVersion
        )
        guard payload.keyEpoch == policy.initialKeyEpoch else {
            throw MonotonicStateError.immutableCohortChange
        }
        guard payload.signingTeamIdentifier == policy.signingTeamIdentifier,
              payload.artifactSHA256 == staged.archive.sha256,
              payload.artifactByteCount == UInt64(staged.archive.byteCount),
              payload.manifestSHA256 == staged.manifest.sha256,
              payload.manifestByteCount == UInt64(staged.manifest.byteCount)
        else {
            throw BrokerOperationError.artifactMismatch
        }
        do {
            try ReleaseCodeValidator.validateProtectedComponents(payload: payload)
        } catch {
            guard payload.purpose == "bootstrap" else {
                throw BrokerOperationError.unsupportedLifecycle
            }
            throw error
        }
        let marker = try RootTrustStore.readBootstrapMarker()
        let markerDigest = SHA256.hash(data: marker)
            .map { String(format: "%02x", $0) }
            .joined()
        guard markerDigest == payload.bootstrapMarkerSHA256 else {
            if payload.purpose == "update" {
                throw BrokerOperationError.unsupportedLifecycle
            }
            throw BrokerOperationError.artifactMismatch
        }
        if payload.purpose == "bootstrap" {
            _ = try ReleaseCodeValidator.validateCandidate(
                at: RecordingsUpdateConstants.applicationPath,
                payload: payload,
                policy: policy
            )
            let stateStore = try MonotonicReleaseStateStore()
            var requiresJournalFinalization = false
            let result = try stateStore.perform(
                payload: payload,
                policy: policy,
                prepare: { decision in
                    switch decision {
                    case .advance:
                        try prepareBootstrapCommit(staged: staged, payload: payload)
                        requiresJournalFinalization = true
                    case .resumeSeen:
                        _ = try requirePreparedBootstrapCommit(staged: staged, payload: payload)
                        requiresJournalFinalization = true
                    case .alreadyCommitted:
                        break
                    }
                }
            ) { decision in
                switch decision {
                case .advance, .resumeSeen, .alreadyCommitted:
                    if requiresJournalFinalization {
                        var journal = try requirePreparedBootstrapCommit(
                            staged: staged,
                            payload: payload
                        )
                        journal.phase = "bootstrap-commit-pending"
                        try DurableInstallJournal(transactionDirectory: staged.directory).write(journal)
                    }
                }
                return updateSuccessReply(
                    transactionID: staged.transactionID.uuidString.lowercased(),
                    releaseID: payload.releaseID,
                    installedVersion: payload.version
                )
            }
            if requiresJournalFinalization {
                try finalizeBootstrapCommit(staged: staged, payload: payload, stateStore: stateStore)
            }
            return result
        }
        let verifierOutput = try ArtifactVerifierRunner().materialize(stagedUpdate: staged)
        let candidateRoot = staged.directory + "/candidate"
        guard mkdir(candidateRoot, 0o700) == 0 else {
            throw BrokerOperationError.candidateRejected
        }
        let candidateApplication = candidateRoot + "/Recordings.app"
        let verifierIDs = try verifierAccountIDs()
        try CanonicalTreeCopier.copyApplication(
            from: verifierOutput,
            to: candidateApplication,
            verifierUserID: verifierIDs.user
        )
        _ = try ReleaseCodeValidator.validateCandidate(
            at: candidateApplication,
            payload: payload,
            policy: policy
        )
        let activator = AtomicActivator()
        return try MonotonicReleaseStateStore().perform(
            payload: payload,
            policy: policy,
            prepare: { decision in
                switch decision {
                case .advance:
                    try activator.prepareActivation(
                        candidatePath: candidateApplication,
                        stagedUpdate: staged,
                        payload: payload,
                        excludingAuthenticatedClientPID: peer.processIdentifier
                    )
                case .resumeSeen:
                    try activator.prepareActivation(
                        candidatePath: candidateApplication,
                        stagedUpdate: staged,
                        payload: payload,
                        excludingAuthenticatedClientPID: peer.processIdentifier
                    )
                case .alreadyCommitted:
                    break
                }
            }
        ) { decision in
            switch decision {
            case .alreadyCommitted:
                _ = try ReleaseCodeValidator.validateCandidate(
                    at: RecordingsUpdateConstants.applicationPath,
                    payload: payload,
                    policy: policy
                )
            case .advance:
                try activator.activatePrepared(
                    stagedUpdate: staged,
                    payload: payload,
                    excludingAuthenticatedClientPID: peer.processIdentifier
                )
            case .resumeSeen:
                try activator.activatePrepared(
                    stagedUpdate: staged,
                    payload: payload,
                    excludingAuthenticatedClientPID: peer.processIdentifier
                )
            }
            return updateSuccessReply(
                transactionID: staged.transactionID.uuidString.lowercased(),
                releaseID: payload.releaseID,
                installedVersion: payload.version
            )
        }
    }

    private static func cleanupIfTerminalOrUnjournaled(
        staged: StagedUpdate,
        rootState: RootUpdateState
    ) throws {
        let journal = try DurableInstallJournal(transactionDirectory: staged.directory).read()
        if let journal, journal.resolvedOperation == .bootstrapCommit {
            guard journal.phase == "bootstrap-committed" else { return }
            let state: PersistedReleaseState?
            do {
                state = try MonotonicReleaseStateStore().currentState()
            } catch {
                throw IngestError.couldNotCleanup
            }
            let candidateTreeSHA256: String
            do {
                candidateTreeSHA256 = try CanonicalTree.digest(at: journal.applicationPath)
            } catch {
                throw IngestError.couldNotCleanup
            }
            guard let state,
                  state.purpose == journal.expectedPurpose,
                  state.phase == "committed",
                  state.keyEpoch == journal.keyEpoch,
                  state.releaseSequence == journal.releaseSequence,
                  state.releaseID == journal.releaseID,
                  state.cohortPackageSHA256 == journal.cohortPackageSHA256,
                  state.envelopePayloadSHA256 == journal.envelopePayloadSHA256
            else {
                throw IngestError.couldNotCleanup
            }
            guard candidateTreeSHA256 == journal.candidateTreeSHA256 else {
                throw IngestError.couldNotCleanup
            }
            try rootState.removeTransactionDirectory(id: staged.transactionID)
            return
        }
        if let journal, journal.phase == "committed" {
            let state: PersistedReleaseState?
            do {
                state = try MonotonicReleaseStateStore().currentState()
            } catch {
                throw IngestError.couldNotCleanup
            }
            guard let state,
                  state.phase == "committed",
                  state.keyEpoch == journal.keyEpoch,
                  state.releaseSequence == journal.releaseSequence,
                  state.releaseID == journal.releaseID,
                  state.cohortPackageSHA256 == journal.cohortPackageSHA256,
                  state.envelopePayloadSHA256 == journal.envelopePayloadSHA256
            else {
                // A committed physical journal with only highest-seen state is
                // still required by startup recovery and must not be pruned.
                return
            }
        } else if let journal {
            if journal.phase != "rolled-back" { return }
            let state: PersistedReleaseState?
            do {
                state = try MonotonicReleaseStateStore().currentState()
            } catch {
                throw IngestError.couldNotCleanup
            }
            if let state,
               state.phase == "seen",
               state.keyEpoch == journal.keyEpoch,
               state.releaseSequence == journal.releaseSequence,
               state.releaseID == journal.releaseID,
               state.cohortPackageSHA256 == journal.cohortPackageSHA256,
               state.envelopePayloadSHA256 == journal.envelopePayloadSHA256 {
                // Recovery needs this exact rollback proof to close the seen barrier
                // as aborted before the protected transaction can be pruned.
                return
            }
        }
        try rootState.removeTransactionDirectory(id: staged.transactionID)
    }

    private static func prepareBootstrapCommit(
        staged: StagedUpdate,
        payload: ReleaseEnvelopePayload
    ) throws {
        let durableJournal = DurableInstallJournal(transactionDirectory: staged.directory)
        if let _ = try durableJournal.read() {
            throw InstallJournalError.invalidJournal
        }
        let binding = try bootstrapApplicationBinding(expectedTreeSHA256: payload.candidateTreeSHA256)
        let journal = BrokerInstallJournal(
            schemaVersion: RecordingsUpdateConstants.protocolVersion,
            transactionID: staged.transactionID.uuidString.lowercased(),
            phase: "bootstrap-prepared",
            releaseID: payload.releaseID,
            releaseSequence: payload.releaseSequence,
            keyEpoch: payload.keyEpoch,
            envelopePayloadSHA256: try envelopeDigest(payload),
            artifactSHA256: staged.archive.sha256,
            manifestSHA256: staged.manifest.sha256,
            cohortPackageSHA256: payload.packageSHA256,
            candidateTreeSHA256: binding.treeSHA256,
            minimumOSVersion: payload.minimumOSVersion,
            candidateApplicationMode: binding.applicationMode,
            candidateExecutableModes: binding.executableModes,
            previousTreeSHA256: nil,
            previousApplicationMode: nil,
            previousExecutableModes: nil,
            previousApplicationPath: nil,
            candidateApplicationPath: RecordingsUpdateConstants.applicationPath,
            applicationPath: RecordingsUpdateConstants.applicationPath,
            operation: .bootstrapCommit,
            transactionDirectory: staged.directory,
            bootstrapPriorMonotonicState: "absent"
        )
        try durableJournal.write(journal)
    }

    private static func requirePreparedBootstrapCommit(
        staged: StagedUpdate,
        payload: ReleaseEnvelopePayload
    ) throws -> BrokerInstallJournal {
        let durableJournal = DurableInstallJournal(transactionDirectory: staged.directory)
        let expectedEnvelopeDigest = try envelopeDigest(payload)
        guard let journal = try durableJournal.read(),
              journal.resolvedOperation == .bootstrapCommit,
              journal.phase == "bootstrap-prepared" ||
                journal.phase == "bootstrap-commit-pending",
              journal.transactionID == staged.transactionID.uuidString.lowercased(),
              journal.transactionDirectory == staged.directory,
              journal.bootstrapPriorMonotonicState == "absent",
              journal.expectedPurpose == payload.purpose,
              journal.releaseID == payload.releaseID,
              journal.releaseSequence == payload.releaseSequence,
              journal.keyEpoch == payload.keyEpoch,
              journal.artifactSHA256 == staged.archive.sha256,
              journal.manifestSHA256 == staged.manifest.sha256,
              journal.cohortPackageSHA256 == payload.packageSHA256,
              journal.candidateTreeSHA256 == payload.candidateTreeSHA256,
              journal.minimumOSVersion == payload.minimumOSVersion,
              journal.envelopePayloadSHA256 == expectedEnvelopeDigest
        else {
            throw InstallJournalError.invalidJournal
        }
        let binding = try bootstrapApplicationBinding(expectedTreeSHA256: payload.candidateTreeSHA256)
        guard journal.candidateApplicationMode == binding.applicationMode,
              journal.candidateExecutableModes == binding.executableModes
        else {
            throw InstallJournalError.invalidJournal
        }
        return journal
    }

    private static func finalizeBootstrapCommit(
        staged: StagedUpdate,
        payload: ReleaseEnvelopePayload,
        stateStore: MonotonicReleaseStateStore
    ) throws {
        var journal = try requirePreparedBootstrapCommit(staged: staged, payload: payload)
        guard let current = try stateStore.currentState(),
              current.purpose == journal.expectedPurpose,
              current.phase == "committed",
              current.keyEpoch == journal.keyEpoch,
              current.releaseSequence == journal.releaseSequence,
              current.releaseID == journal.releaseID,
              current.cohortPackageSHA256 == journal.cohortPackageSHA256,
              current.envelopePayloadSHA256 == journal.envelopePayloadSHA256
        else {
            throw MonotonicStateError.recoveryStateMismatch
        }
        journal.phase = "bootstrap-committed"
        try DurableInstallJournal(transactionDirectory: staged.directory).write(journal)
    }

    private static func bootstrapApplicationBinding(
        expectedTreeSHA256: String
    ) throws -> (treeSHA256: String, applicationMode: UInt16, executableModes: [String: UInt16]) {
        let applicationPath = RecordingsUpdateConstants.applicationPath
        let before = try CanonicalTree.digest(at: applicationPath)
        guard before == expectedTreeSHA256 else { throw InstallJournalError.invalidJournal }
        let applicationMode = try bootstrapMode(
            at: applicationPath,
            expectedType: mode_t(S_IFDIR),
            requireExecutable: true
        )
        let relativeExecutables = [
            "Contents/MacOS/Recordings",
            "Contents/Helpers/recordings",
            "Contents/Helpers/recordings-update-client",
        ]
        var executableModes: [String: UInt16] = [:]
        for relativePath in relativeExecutables {
            executableModes[relativePath] = try bootstrapMode(
                at: applicationPath + "/" + relativePath,
                expectedType: mode_t(S_IFREG),
                requireExecutable: true
            )
        }
        let after = try CanonicalTree.digest(at: applicationPath)
        guard before == after else { throw InstallJournalError.invalidJournal }
        return (after, applicationMode, executableModes)
    }

    private static func bootstrapMode(
        at path: String,
        expectedType: mode_t,
        requireExecutable: Bool
    ) throws -> UInt16 {
        var metadata = stat()
        guard lstat(path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == expectedType,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0,
              (!requireExecutable || (metadata.st_mode & 0o500) == 0o500),
              DarwinACLValidator.pathHasNoExtendedACL(path, directory: expectedType == S_IFDIR)
        else {
            throw InstallJournalError.invalidJournal
        }
        return UInt16(metadata.st_mode & 0o777)
    }

    private static func envelopeDigest(_ payload: ReleaseEnvelopePayload) throws -> String {
        try SHA256.hash(data: payload.canonicalData())
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func verifierAccountIDs() throws -> (user: uid_t, group: gid_t) {
        var user: uid_t = 0
        var group: gid_t = 0
        let status = RecordingsUpdateConstants.artifactVerifierAccount.withCString {
            recordings_lookup_verifier_account($0, &user, &group)
        }
        guard status == 0 else { throw BrokerOperationError.candidateRejected }
        return (user, group)
    }

    private static func failureReply(for error: Error) -> NSDictionary {
        switch error {
        case is BrokerSecurityError, BrokerOperationError.unauthorizedPeer:
            updateFailureReply(.unauthorizedPeer, message: "The update request is unauthorized")
        case is ReleaseEnvelopeValidationError, BrokerOperationError.invalidEnvelope:
            updateFailureReply(.invalidEnvelope, message: "The signed release envelope is invalid")
        case BrokerOperationError.signatureRejected:
            updateFailureReply(.signatureRejected, message: "The signed release envelope was rejected")
        case MonotonicStateError.immutableCohortChange, BrokerOperationError.unsupportedLifecycle:
            updateFailureReply(
                .unsupportedLifecycle,
                message: "This installation uses an immutable updater cohort. Only app-artifact updates are supported. Root updater or key changes require managed reprovisioning; no files were changed."
            )
        case is MonotonicStateError, BrokerOperationError.invalidBootstrapState:
            updateFailureReply(.rollbackRejected, message: "The release would violate monotonic update policy")
        case is CodeValidationError:
            updateFailureReply(.codeIdentityRejected, message: "A signed release component was rejected")
        case is IngestError:
            updateFailureReply(.invalidDescriptor, message: "A retained update input was rejected")
        case is HostOSVersionPolicyError, is HostOSProductVersionQueryError,
             is VerifierRunnerError, is CanonicalCopyError, BrokerOperationError.candidateRejected:
            updateFailureReply(.candidateRejected, message: "The isolated release candidate was rejected")
        case is AtomicActivationError, is InstallJournalError:
            updateFailureReply(.activationFailed, message: "The transactional application activation failed")
        default:
            updateFailureReply(.internalFailure, message: "The update broker failed closed")
        }
    }

    private static func requiresRecoveryRestart(after error: Error) -> Bool {
        if error is AtomicActivationError || error is InstallJournalError {
            return true
        }
        if let ingestError = error as? IngestError, case .couldNotCleanup = ingestError {
            return true
        }
        guard let stateError = error as? MonotonicStateError else { return false }
        if case .couldNotPersist = stateError { return true }
        return false
    }
}

enum BrokerOperationError: Error {
    case unauthorizedPeer
    case invalidEnvelope
    case signatureRejected
    case artifactMismatch
    case candidateRejected
    case invalidBootstrapState
    case unsupportedLifecycle
}
