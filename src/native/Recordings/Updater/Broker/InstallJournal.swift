import Darwin
import Foundation
import RecordingsUpdateProtocol

enum InstallJournalOperation: String, Codable, Sendable {
    case applicationActivation = "application-activation"
    case bootstrapCommit = "bootstrap-commit"
}

struct BrokerInstallJournal: Codable, Sendable {
    let schemaVersion: Int
    let transactionID: String
    var phase: String
    let releaseID: String
    let releaseSequence: UInt64
    let keyEpoch: UInt64
    let envelopePayloadSHA256: String
    let artifactSHA256: String
    let manifestSHA256: String
    let cohortPackageSHA256: String
    let candidateTreeSHA256: String
    let minimumOSVersion: String?
    let candidateApplicationMode: UInt16
    let candidateExecutableModes: [String: UInt16]
    let previousTreeSHA256: String?
    let previousApplicationMode: UInt16?
    let previousExecutableModes: [String: UInt16]?
    let previousApplicationPath: String?
    let candidateApplicationPath: String
    let applicationPath: String
    /// Optional for schema-v1 compatibility. Every journal written before this
    /// discriminator existed represented an ordinary application activation.
    let operation: InstallJournalOperation?
    /// Bootstrap journals bind the exact protected transaction path rather than
    /// relying only on a UUID-derived reconstruction during recovery.
    let transactionDirectory: String?
    /// A bootstrap advance is legal only from an absent monotonic state. Recording
    /// that fact before `seen` makes the one-time transition explicit and recoverable.
    let bootstrapPriorMonotonicState: String?

    var resolvedOperation: InstallJournalOperation {
        journalOperation
    }

    var expectedPurpose: String {
        journalOperation == .bootstrapCommit ? "bootstrap" : "update"
    }

    private var journalOperation: InstallJournalOperation {
        operation ?? .applicationActivation
    }

    init(
        schemaVersion: Int,
        transactionID: String,
        phase: String,
        releaseID: String,
        releaseSequence: UInt64,
        keyEpoch: UInt64,
        envelopePayloadSHA256: String,
        artifactSHA256: String,
        manifestSHA256: String,
        cohortPackageSHA256: String,
        candidateTreeSHA256: String,
        minimumOSVersion: String? = nil,
        candidateApplicationMode: UInt16,
        candidateExecutableModes: [String: UInt16],
        previousTreeSHA256: String?,
        previousApplicationMode: UInt16?,
        previousExecutableModes: [String: UInt16]?,
        previousApplicationPath: String?,
        candidateApplicationPath: String,
        applicationPath: String,
        operation: InstallJournalOperation? = nil,
        transactionDirectory: String? = nil,
        bootstrapPriorMonotonicState: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.transactionID = transactionID
        self.phase = phase
        self.releaseID = releaseID
        self.releaseSequence = releaseSequence
        self.keyEpoch = keyEpoch
        self.envelopePayloadSHA256 = envelopePayloadSHA256
        self.artifactSHA256 = artifactSHA256
        self.manifestSHA256 = manifestSHA256
        self.cohortPackageSHA256 = cohortPackageSHA256
        self.candidateTreeSHA256 = candidateTreeSHA256
        self.minimumOSVersion = minimumOSVersion
        self.candidateApplicationMode = candidateApplicationMode
        self.candidateExecutableModes = candidateExecutableModes
        self.previousTreeSHA256 = previousTreeSHA256
        self.previousApplicationMode = previousApplicationMode
        self.previousExecutableModes = previousExecutableModes
        self.previousApplicationPath = previousApplicationPath
        self.candidateApplicationPath = candidateApplicationPath
        self.applicationPath = applicationPath
        self.operation = operation
        self.transactionDirectory = transactionDirectory
        self.bootstrapPriorMonotonicState = bootstrapPriorMonotonicState
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case transactionID = "transaction_id"
        case phase
        case releaseID = "release_id"
        case releaseSequence = "release_sequence"
        case keyEpoch = "key_epoch"
        case envelopePayloadSHA256 = "envelope_payload_sha256"
        case artifactSHA256 = "artifact_sha256"
        case manifestSHA256 = "manifest_sha256"
        case cohortPackageSHA256 = "cohort_package_sha256"
        case candidateTreeSHA256 = "candidate_tree_sha256"
        case minimumOSVersion = "minimum_os_version"
        case candidateApplicationMode = "candidate_application_mode"
        case candidateExecutableModes = "candidate_executable_modes"
        case previousTreeSHA256 = "previous_tree_sha256"
        case previousApplicationMode = "previous_application_mode"
        case previousExecutableModes = "previous_executable_modes"
        case previousApplicationPath = "previous_application_path"
        case candidateApplicationPath = "candidate_application_path"
        case applicationPath = "application_path"
        case operation
        case transactionDirectory = "transaction_directory"
        case bootstrapPriorMonotonicState = "bootstrap_prior_monotonic_state"
    }
}

struct DurableInstallJournal {
    let transactionDirectory: String

    func read() throws -> BrokerInstallJournal? {
        let directory = try openValidatedDirectory()
        defer { Darwin.close(directory) }
        let input = openat(directory, "install-journal.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        if input < 0, errno == ENOENT { return nil }
        guard input >= 0 else { throw InstallJournalError.invalidJournal }
        defer { Darwin.close(input) }
        var metadata = stat()
        guard fstat(input, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0,
              metadata.st_nlink == 1,
              DarwinACLValidator.descriptorHasNoExtendedACL(input),
              metadata.st_size > 0,
              metadata.st_size <= 64 * 1024
        else {
            throw InstallJournalError.invalidJournal
        }
        var data = Data(count: Int(metadata.st_size))
        var offset: off_t = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < metadata.st_size {
                let count = pread(
                    input,
                    base.advanced(by: Int(offset)),
                    Int(metadata.st_size - offset),
                    offset
                )
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw InstallJournalError.invalidJournal }
                offset += off_t(count)
            }
        }
        var after = stat()
        guard fstat(input, &after) == 0,
              metadata.st_dev == after.st_dev,
              metadata.st_ino == after.st_ino,
              metadata.st_size == after.st_size,
              metadata.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              metadata.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              metadata.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              metadata.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              DarwinACLValidator.descriptorHasNoExtendedACL(input),
              let journal = try? JSONDecoder().decode(BrokerInstallJournal.self, from: data)
        else {
            throw InstallJournalError.invalidJournal
        }
        try validate(journal)
        return journal
    }

    func write(_ journal: BrokerInstallJournal) throws {
        try validate(journal)
        let directory = try openValidatedDirectory()
        defer { Darwin.close(directory) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(journal) + Data([0x0a])
        let temporary = ".install-journal.\(UUID().uuidString.lowercased()).tmp"
        let output = openat(
            directory,
            temporary,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard output >= 0 else { throw InstallJournalError.couldNotPersist }
        var removeTemporary = true
        defer {
            Darwin.close(output)
            if removeTemporary { unlinkat(directory, temporary, 0) }
        }
        guard DarwinACLValidator.descriptorHasNoExtendedACL(output) else {
            throw InstallJournalError.couldNotPersist
        }
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(output, base.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw InstallJournalError.couldNotPersist }
                offset += count
            }
        }
        guard fsync(output) == 0,
              renameat(directory, temporary, directory, "install-journal.json") == 0,
              fsync(directory) == 0
        else {
            throw InstallJournalError.couldNotPersist
        }
        removeTemporary = false
    }

    private func openValidatedDirectory() throws -> Int32 {
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
            to: transactionDirectory
        ) else {
            throw InstallJournalError.unsafeDirectory
        }
        let directory = Darwin.open(
            transactionDirectory,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard directory >= 0 else { throw InstallJournalError.unsafeDirectory }
        var metadata = stat()
        guard fstat(directory, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(directory)
        else {
            Darwin.close(directory)
            throw InstallJournalError.unsafeDirectory
        }
        return directory
    }

    private func validate(_ journal: BrokerInstallJournal) throws {
        let leaf = URL(fileURLWithPath: transactionDirectory).lastPathComponent
        guard leaf.hasPrefix("transaction-") else { throw InstallJournalError.invalidJournal }
        let transactionID = String(leaf.dropFirst("transaction-".count))
        let expectedCandidate = transactionDirectory + "/candidate/Recordings.app"
        let activationPhases: Set<String> = [
            "prepared", "launch-barrier-pending", "launch-barrier-held",
            "swap-pending", "swapped", "previous-retaining",
            "previous-retained", "first-install-pending", "first-installed",
            "launch-barrier-releasing", "launch-barrier-released",
            "activated", "rollback-started", "rolled-back", "committed",
        ]
        let bootstrapPhases: Set<String> = [
            "bootstrap-prepared", "bootstrap-commit-pending",
            "bootstrap-aborted", "bootstrap-committed",
        ]
        guard journal.schemaVersion == RecordingsUpdateConstants.protocolVersion,
              journal.transactionID == transactionID,
              UUID(uuidString: journal.transactionID)?.uuidString.lowercased() == journal.transactionID,
              UUID(uuidString: journal.releaseID) != nil,
              journal.releaseSequence > 0,
              journal.keyEpoch > 0,
              Self.isSHA256(journal.envelopePayloadSHA256),
              Self.isSHA256(journal.artifactSHA256),
              Self.isSHA256(journal.manifestSHA256),
              Self.isSHA256(journal.cohortPackageSHA256),
              Self.isSHA256(journal.candidateTreeSHA256),
              Self.isValidMinimumOSVersion(journal.minimumOSVersion),
              Self.isSafeApplicationMode(journal.candidateApplicationMode),
              Self.areSafeExecutableModes(journal.candidateExecutableModes),
              journal.applicationPath == RecordingsUpdateConstants.applicationPath
        else {
            throw InstallJournalError.invalidJournal
        }

        switch journal.operation ?? .applicationActivation {
        case .applicationActivation:
            // `operation == nil` is the only accepted legacy migration: schema-v1
            // journals predating the discriminator were all application activations.
            guard activationPhases.contains(journal.phase),
                  journal.transactionDirectory == nil ||
                    journal.transactionDirectory == transactionDirectory,
                  journal.bootstrapPriorMonotonicState == nil,
                  journal.candidateApplicationPath == expectedCandidate,
                  (journal.previousTreeSHA256 == nil) == (journal.previousApplicationPath == nil),
                  (journal.previousTreeSHA256 == nil) == (journal.previousApplicationMode == nil),
                  (journal.previousTreeSHA256 == nil) == (journal.previousExecutableModes == nil)
            else {
                throw InstallJournalError.invalidJournal
            }
            if let previousDigest = journal.previousTreeSHA256,
               (!Self.isSHA256(previousDigest) ||
                !Self.isSafeApplicationMode(journal.previousApplicationMode ?? 0) ||
                !Self.areSafeExecutableModes(journal.previousExecutableModes ?? [:]) ||
                journal.previousApplicationPath != transactionDirectory + "/previous.app") {
                throw InstallJournalError.invalidJournal
            }
        case .bootstrapCommit:
            guard bootstrapPhases.contains(journal.phase),
                  journal.transactionDirectory == transactionDirectory,
                  journal.bootstrapPriorMonotonicState == "absent",
                  journal.candidateApplicationPath == RecordingsUpdateConstants.applicationPath,
                  journal.previousTreeSHA256 == nil,
                  journal.previousApplicationMode == nil,
                  journal.previousExecutableModes == nil,
                  journal.previousApplicationPath == nil
            else {
                throw InstallJournalError.invalidJournal
            }
        }
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func isValidMinimumOSVersion(_ value: String?) -> Bool {
        guard let value else { return true }
        return HostOSVersionPolicy.isValidNumericVersion(value)
    }

    private static func isSafeApplicationMode(_ value: UInt16) -> Bool {
        value <= 0o777 && (value & 0o500) == 0o500 && (value & 0o022) == 0
    }

    private static func isSafeExecutableMode(_ value: UInt16) -> Bool {
        value <= 0o777 && (value & 0o500) == 0o500 && (value & 0o022) == 0
    }

    private static func areSafeExecutableModes(_ values: [String: UInt16]) -> Bool {
        Set(values.keys) == Set([
            "Contents/MacOS/Recordings",
            "Contents/Helpers/recordings",
            "Contents/Helpers/recordings-update-client",
        ]) && values.values.allSatisfy { Self.isSafeExecutableMode($0) }
    }
}

enum InstallJournalError: Error, CustomStringConvertible {
    case unsafeDirectory
    case invalidJournal
    case couldNotPersist

    var description: String {
        switch self {
        case .unsafeDirectory: "The install-journal directory is unsafe"
        case .invalidJournal: "The install journal is malformed, unsafe, or ambiguously bound"
        case .couldNotPersist: "Could not durably persist the install journal"
        }
    }
}
