import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol

struct PersistedReleaseState: Codable, Sendable {
    let schemaVersion: Int
    let purpose: String
    let phase: String
    let keyEpoch: UInt64
    let releaseSequence: UInt64
    let releaseID: String
    let version: String
    let build: String
    let cohortPackageSHA256: String
    let envelopePayloadSHA256: String
    let updatedAtUTC: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case purpose
        case phase
        case keyEpoch = "key_epoch"
        case releaseSequence = "release_sequence"
        case releaseID = "release_id"
        case version
        case build
        case cohortPackageSHA256 = "cohort_package_sha256"
        case envelopePayloadSHA256 = "envelope_payload_sha256"
        case updatedAtUTC = "updated_at_utc"
    }
}

enum ReleaseStateDecision: Sendable {
    case advance
    case resumeSeen
    case alreadyCommitted
}

final class MonotonicReleaseStateStore {
    private let directoryDescriptor: Int32

    init(directory: String = RecordingsUpdateConstants.monotonicStateDirectory) throws {
        guard geteuid() == 0 else { throw MonotonicStateError.notRoot }
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(to: directory) else {
            throw MonotonicStateError.unsafeDirectory
        }
        var pathMetadata = stat()
        guard lstat(directory, &pathMetadata) == 0,
              (pathMetadata.st_mode & S_IFMT) == S_IFDIR,
              pathMetadata.st_uid == 0,
              (pathMetadata.st_mode & 0o077) == 0
        else {
            throw MonotonicStateError.unsafeDirectory
        }
        directoryDescriptor = Darwin.open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard directoryDescriptor >= 0 else { throw MonotonicStateError.unsafeDirectory }
        var openedMetadata = stat()
        guard fstat(directoryDescriptor, &openedMetadata) == 0,
              openedMetadata.st_dev == pathMetadata.st_dev,
              openedMetadata.st_ino == pathMetadata.st_ino,
              DarwinACLValidator.descriptorHasNoExtendedACL(directoryDescriptor)
        else {
            Darwin.close(directoryDescriptor)
            throw MonotonicStateError.unsafeDirectory
        }
    }

    deinit { Darwin.close(directoryDescriptor) }

    /// Holds a process-independent root-owned lock across assessment, activation, and
    /// durable sequence advancement. Exact replays are idempotent; every conflicting
    /// equal or lower sequence and every root-cohort/key change fails closed.
    func perform<T>(
        payload: ReleaseEnvelopePayload,
        policy: BrokerPolicy,
        prepare: (ReleaseStateDecision) throws -> Void = { _ in },
        operation: (ReleaseStateDecision) throws -> T
    ) throws -> T {
        let lock = openat(
            directoryDescriptor,
            "release-state.lock",
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard lock >= 0 else { throw MonotonicStateError.lockUnavailable }
        defer { Darwin.close(lock) }
        var lockMetadata = stat()
        guard fstat(lock, &lockMetadata) == 0,
              (lockMetadata.st_mode & S_IFMT) == S_IFREG,
              lockMetadata.st_uid == 0,
              (lockMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(lock),
              flock(lock, LOCK_EX) == 0
        else {
            throw MonotonicStateError.lockUnavailable
        }
        defer { flock(lock, LOCK_UN) }

        let payloadDigest = try SHA256.hash(data: payload.canonicalData())
            .map { String(format: "%02x", $0) }
            .joined()
        let current = try readCurrentState()
        let decision = try assess(payload: payload, digest: payloadDigest, current: current, policy: policy)
        // Preparation must durably bind the exact transaction before `seen` is
        // persisted. Recovery can then finish or roll back without replaying an
        // envelope that may have expired while the broker was unavailable.
        try prepare(decision)
        if case .advance = decision {
            try writeState(payload: payload, payloadDigest: payloadDigest, phase: "seen")
        }
        let result: T
        do {
            result = try operation(decision)
        } catch {
            if Self.mayDurablyAbortSeenBarrier(after: error) {
                switch decision {
                case .advance, .resumeSeen:
                    try writeState(payload: payload, payloadDigest: payloadDigest, phase: "aborted")
                case .alreadyCommitted:
                    break
                }
            }
            throw error
        }
        if case .alreadyCommitted = decision {
            return result
        }
        try writeState(payload: payload, payloadDigest: payloadDigest, phase: "committed")
        return result
    }

    func currentState() throws -> PersistedReleaseState? {
        let lock = openat(
            directoryDescriptor,
            "release-state.lock",
            O_RDONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard lock >= 0 else { throw MonotonicStateError.lockUnavailable }
        defer { Darwin.close(lock) }
        var lockMetadata = stat()
        guard fstat(lock, &lockMetadata) == 0,
              (lockMetadata.st_mode & S_IFMT) == S_IFREG,
              lockMetadata.st_uid == 0,
              (lockMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(lock),
              flock(lock, LOCK_SH) == 0
        else {
            throw MonotonicStateError.lockUnavailable
        }
        defer { flock(lock, LOCK_UN) }
        return try readCurrentState()
    }

    /// Startup recovery may finalize only the exact release whose durable `seen`
    /// state and install journal both bind the application tree now installed.
    /// This never lowers or replaces the highest-seen key epoch or sequence.
    func finalizeRecoveredCommit(journal: BrokerInstallJournal) throws {
        let lock = openat(
            directoryDescriptor,
            "release-state.lock",
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard lock >= 0 else { throw MonotonicStateError.lockUnavailable }
        defer { Darwin.close(lock) }
        var lockMetadata = stat()
        guard fstat(lock, &lockMetadata) == 0,
              (lockMetadata.st_mode & S_IFMT) == S_IFREG,
              lockMetadata.st_uid == 0,
              (lockMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(lock),
              flock(lock, LOCK_EX) == 0
        else {
            throw MonotonicStateError.lockUnavailable
        }
        defer { flock(lock, LOCK_UN) }
        guard let current = try readCurrentState(),
              current.purpose == journal.expectedPurpose,
              current.keyEpoch == journal.keyEpoch,
              current.releaseSequence == journal.releaseSequence,
              current.releaseID == journal.releaseID,
              current.cohortPackageSHA256 == journal.cohortPackageSHA256,
              current.envelopePayloadSHA256 == journal.envelopePayloadSHA256,
              current.phase == "seen" || current.phase == "committed"
        else {
            throw MonotonicStateError.recoveryStateMismatch
        }
        if current.phase == "committed" { return }
        try writePersistedState(PersistedReleaseState(
            schemaVersion: current.schemaVersion,
            purpose: current.purpose,
            phase: "committed",
            keyEpoch: current.keyEpoch,
            releaseSequence: current.releaseSequence,
            releaseID: current.releaseID,
            version: current.version,
            build: current.build,
            cohortPackageSHA256: current.cohortPackageSHA256,
            envelopePayloadSHA256: current.envelopePayloadSHA256,
            updatedAtUTC: Self.timestamp()
        ))
    }

    /// Recovery may close an exact `seen` barrier only after the activation journal
    /// proves the previous tree is live and the candidate is retained in one protected
    /// transaction slot. The aborted sequence remains monotonic and blocks replay.
    func finalizeRecoveredAbort(journal: BrokerInstallJournal) throws {
        let lock = openat(
            directoryDescriptor,
            "release-state.lock",
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard lock >= 0 else { throw MonotonicStateError.lockUnavailable }
        defer { Darwin.close(lock) }
        var lockMetadata = stat()
        guard fstat(lock, &lockMetadata) == 0,
              (lockMetadata.st_mode & S_IFMT) == S_IFREG,
              lockMetadata.st_uid == 0,
              (lockMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(lock),
              flock(lock, LOCK_EX) == 0
        else {
            throw MonotonicStateError.lockUnavailable
        }
        defer { flock(lock, LOCK_UN) }
        guard let current = try readCurrentState(),
              current.purpose == journal.expectedPurpose,
              current.keyEpoch == journal.keyEpoch,
              current.releaseSequence == journal.releaseSequence,
              current.releaseID == journal.releaseID,
              current.cohortPackageSHA256 == journal.cohortPackageSHA256,
              current.envelopePayloadSHA256 == journal.envelopePayloadSHA256,
              current.phase == "seen" || current.phase == "aborted"
        else {
            throw MonotonicStateError.recoveryStateMismatch
        }
        if current.phase == "aborted" { return }
        try writePersistedState(PersistedReleaseState(
            schemaVersion: current.schemaVersion,
            purpose: current.purpose,
            phase: "aborted",
            keyEpoch: current.keyEpoch,
            releaseSequence: current.releaseSequence,
            releaseID: current.releaseID,
            version: current.version,
            build: current.build,
            cohortPackageSHA256: current.cohortPackageSHA256,
            envelopePayloadSHA256: current.envelopePayloadSHA256,
            updatedAtUTC: Self.timestamp()
        ))
    }

    private func assess(
        payload: ReleaseEnvelopePayload,
        digest: String,
        current: PersistedReleaseState?,
        policy: BrokerPolicy
    ) throws -> ReleaseStateDecision {
        let candidate = MonotonicReleaseCandidate(
            purpose: payload.purpose,
            keyEpoch: payload.keyEpoch,
            releaseSequence: payload.releaseSequence,
            releaseID: payload.releaseID,
            cohortPackageSHA256: payload.packageSHA256,
            envelopePayloadSHA256: digest
        )
        let currentSnapshot: MonotonicReleaseStateSnapshot?
        if let current {
            guard let phase = MonotonicReleasePhase(rawValue: current.phase) else {
                throw MonotonicStateError.invalidState
            }
            currentSnapshot = MonotonicReleaseStateSnapshot(
                purpose: current.purpose,
                phase: phase,
                keyEpoch: current.keyEpoch,
                releaseSequence: current.releaseSequence,
                releaseID: current.releaseID,
                cohortPackageSHA256: current.cohortPackageSHA256,
                envelopePayloadSHA256: current.envelopePayloadSHA256
            )
        } else {
            currentSnapshot = nil
        }

        do {
            switch try MonotonicReleasePolicy.assess(
                candidate: candidate,
                current: currentSnapshot,
                initialKeyEpoch: policy.initialKeyEpoch,
                allowedKeyEpochs: policy.allowedKeyEpochs
            ) {
            case .advance: return .advance
            case .resumeSeen: return .resumeSeen
            case .alreadyCommitted: return .alreadyCommitted
            }
        } catch let error as MonotonicReleasePolicyError {
            switch error {
            case .immutableCohortChange: throw MonotonicStateError.immutableCohortChange
            case .bootstrapRequired: throw MonotonicStateError.bootstrapRequired
            case .bootstrapAlreadyInitialized: throw MonotonicStateError.bootstrapAlreadyInitialized
            case .sequenceRollbackOrConflict: throw MonotonicStateError.sequenceRollbackOrConflict
            case .pendingSeenRecoveryRequired: throw MonotonicStateError.pendingSeenRecoveryRequired
            }
        }
    }

    private func readCurrentState() throws -> PersistedReleaseState? {
        let descriptor = openat(directoryDescriptor, "release-state.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        if descriptor < 0, errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw MonotonicStateError.invalidState }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              metadata.st_size > 0,
              metadata.st_size <= 64 * 1024
        else {
            throw MonotonicStateError.invalidState
        }
        var data = Data(count: Int(metadata.st_size))
        var offset: off_t = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < metadata.st_size {
                let count = pread(descriptor, base.advanced(by: Int(offset)), Int(metadata.st_size - offset), offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw MonotonicStateError.invalidState }
                offset += off_t(count)
            }
        }
        guard DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              let state = try? JSONDecoder().decode(PersistedReleaseState.self, from: data),
              state.schemaVersion == RecordingsUpdateConstants.protocolVersion,
              (state.purpose == "bootstrap" || state.purpose == "update"),
              (state.phase == "seen" || state.phase == "aborted" || state.phase == "committed"),
              state.keyEpoch > 0,
              state.releaseSequence > 0,
              UUID(uuidString: state.releaseID) != nil,
              state.cohortPackageSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              state.envelopePayloadSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else {
            throw MonotonicStateError.invalidState
        }
        return state
    }

    private func writeState(payload: ReleaseEnvelopePayload, payloadDigest: String, phase: String) throws {
        let state = PersistedReleaseState(
            schemaVersion: RecordingsUpdateConstants.protocolVersion,
            purpose: payload.purpose,
            phase: phase,
            keyEpoch: payload.keyEpoch,
            releaseSequence: payload.releaseSequence,
            releaseID: payload.releaseID,
            version: payload.version,
            build: payload.build,
            cohortPackageSHA256: payload.packageSHA256,
            envelopePayloadSHA256: payloadDigest,
            updatedAtUTC: Self.timestamp()
        )
        try writePersistedState(state)
    }

    private func writePersistedState(_ state: PersistedReleaseState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(state) + Data([0x0a])
        let temporary = ".release-state.\(UUID().uuidString.lowercased()).tmp"
        let descriptor = openat(
            directoryDescriptor,
            temporary,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard descriptor >= 0 else { throw MonotonicStateError.couldNotPersist }
        var removeTemporary = true
        defer {
            Darwin.close(descriptor)
            if removeTemporary { unlinkat(directoryDescriptor, temporary, 0) }
        }
        guard DarwinACLValidator.descriptorHasNoExtendedACL(descriptor) else {
            throw MonotonicStateError.couldNotPersist
        }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0,
              renameat(directoryDescriptor, temporary, directoryDescriptor, "release-state.json") == 0,
              fsync(directoryDescriptor) == 0
        else {
            throw MonotonicStateError.couldNotPersist
        }
        removeTemporary = false
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func mayDurablyAbortSeenBarrier(after error: Error) -> Bool {
        guard let activationError = error as? AtomicActivationError else { return false }
        if case .recoveryRequired = activationError { return false }
        return true
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw MonotonicStateError.couldNotPersist }
                offset += count
            }
        }
    }
}

enum MonotonicStateError: Error, CustomStringConvertible {
    case notRoot
    case unsafeDirectory
    case lockUnavailable
    case invalidState
    case immutableCohortChange
    case bootstrapRequired
    case bootstrapAlreadyInitialized
    case sequenceRollbackOrConflict
    case pendingSeenRecoveryRequired
    case recoveryStateMismatch
    case couldNotPersist

    var description: String {
        switch self {
        case .notRoot: "The update broker is not running as root"
        case .unsafeDirectory: "The monotonic update-state directory is missing or unsafe"
        case .lockUnavailable: "The monotonic update-state lock is unavailable"
        case .invalidState: "The monotonic update state is malformed or unsafe"
        case .immutableCohortChange:
            "The immutable updater cohort does not support root-component or key-epoch changes"
        case .bootstrapRequired: "The monotonic release state must be initialized by a bootstrap release"
        case .bootstrapAlreadyInitialized: "Bootstrap release state is already initialized"
        case .sequenceRollbackOrConflict: "The release sequence is stale or conflicts with committed state"
        case .pendingSeenRecoveryRequired:
            "The highest-seen release must be recovered or replayed exactly before another release can advance"
        case .recoveryStateMismatch: "Interrupted-install recovery does not match the highest-seen release state"
        case .couldNotPersist: "Could not durably persist monotonic update state"
        }
    }
}
