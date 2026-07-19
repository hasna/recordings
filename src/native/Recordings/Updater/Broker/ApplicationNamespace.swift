import Darwin
import Foundation
import RecordingsUpdateProtocol

/// Descriptor-bound namespace mutations for the live application and one protected
/// transaction. Existing installs are exchanged with the candidate in one kernel
/// operation; first installs use exclusive rename semantics and can never replace a
/// leaf created concurrently in `/Applications`.
final class ApplicationNamespace {
    private static let liveLeaf = "Recordings.app"
    private static let previousLeaf = "previous.app"
    private static let failedCandidateLeaf = "failed-candidate.app"

    private let applicationsDescriptor: Int32
    private let candidateDescriptor: Int32
    private let transactionDescriptor: Int32

    init(journal: BrokerInstallJournal) throws {
        let expectedCandidateDirectory = journal.candidateApplicationPath
            .deletingLastPathComponent
        let expectedTransactionDirectory = expectedCandidateDirectory
            .deletingLastPathComponent
        guard journal.applicationPath == RecordingsUpdateConstants.applicationPath,
              journal.candidateApplicationPath == expectedTransactionDirectory
                + "/candidate/Recordings.app",
              journal.previousApplicationPath == nil ||
                journal.previousApplicationPath == expectedTransactionDirectory + "/previous.app"
        else {
            throw ApplicationNamespaceError.invalidBinding
        }

        applicationsDescriptor = try Self.openValidatedDirectory(
            "/Applications",
            exactApplicationsDirectory: true
        )
        do {
            candidateDescriptor = try Self.openValidatedDirectory(
                expectedCandidateDirectory,
                exactApplicationsDirectory: false
            )
        } catch {
            Darwin.close(applicationsDescriptor)
            throw error
        }
        do {
            transactionDescriptor = try Self.openValidatedDirectory(
                expectedTransactionDirectory,
                exactApplicationsDirectory: false
            )
        } catch {
            Darwin.close(candidateDescriptor)
            Darwin.close(applicationsDescriptor)
            throw error
        }
    }

    deinit {
        Darwin.close(transactionDescriptor)
        Darwin.close(candidateDescriptor)
        Darwin.close(applicationsDescriptor)
    }

    func exchangeCandidateAndLive() throws {
        try renameAtX(
            from: candidateDescriptor,
            Self.liveLeaf,
            to: applicationsDescriptor,
            Self.liveLeaf,
            flags: UInt32(RENAME_SWAP)
        )
        try synchronize([candidateDescriptor, applicationsDescriptor])
    }

    func installCandidateExclusively() throws {
        try renameAtX(
            from: candidateDescriptor,
            Self.liveLeaf,
            to: applicationsDescriptor,
            Self.liveLeaf,
            flags: UInt32(RENAME_EXCL)
        )
        try synchronize([candidateDescriptor, applicationsDescriptor])
    }

    func retainSwappedPreviousExclusively() throws {
        try renameAtX(
            from: candidateDescriptor,
            Self.liveLeaf,
            to: transactionDescriptor,
            Self.previousLeaf,
            flags: UInt32(RENAME_EXCL)
        )
        try synchronize([candidateDescriptor, transactionDescriptor])
    }

    func exchangeRetainedPreviousAndLive() throws {
        try renameAtX(
            from: transactionDescriptor,
            Self.previousLeaf,
            to: applicationsDescriptor,
            Self.liveLeaf,
            flags: UInt32(RENAME_SWAP)
        )
        try synchronize([transactionDescriptor, applicationsDescriptor])
    }

    func retainFailedCandidateFromPreviousSlotExclusively() throws {
        try renameAtX(
            from: transactionDescriptor,
            Self.previousLeaf,
            to: transactionDescriptor,
            Self.failedCandidateLeaf,
            flags: UInt32(RENAME_EXCL)
        )
        try synchronize([transactionDescriptor])
    }

    func retainFailedCandidateFromLiveExclusively() throws {
        try renameAtX(
            from: applicationsDescriptor,
            Self.liveLeaf,
            to: transactionDescriptor,
            Self.failedCandidateLeaf,
            flags: UInt32(RENAME_EXCL)
        )
        try synchronize([applicationsDescriptor, transactionDescriptor])
    }

    func engageLaunchBarrier(journal: BrokerInstallJournal) throws {
        try setApplicationExecutableModes(
            parent: candidateDescriptor,
            applicationLeaf: Self.liveLeaf,
            originalModes: journal.candidateExecutableModes,
            engageBarrier: true
        )
        try setDirectoryMode(
            parent: candidateDescriptor,
            leaf: Self.liveLeaf,
            allowedCurrentModes: [mode_t(journal.candidateApplicationMode), 0],
            newMode: 0
        )
        if let previousMode = journal.previousApplicationMode {
            guard let previousExecutableModes = journal.previousExecutableModes else {
                throw ApplicationNamespaceError.invalidBinding
            }
            try setApplicationExecutableModes(
                parent: applicationsDescriptor,
                applicationLeaf: Self.liveLeaf,
                originalModes: previousExecutableModes,
                engageBarrier: true
            )
            try setDirectoryMode(
                parent: applicationsDescriptor,
                leaf: Self.liveLeaf,
                allowedCurrentModes: [mode_t(previousMode), 0],
                newMode: 0
            )
        }
    }

    func releaseCommittedLaunchBarrier(journal: BrokerInstallJournal) throws {
        try setApplicationExecutableModes(
            parent: applicationsDescriptor,
            applicationLeaf: Self.liveLeaf,
            originalModes: journal.candidateExecutableModes,
            engageBarrier: false
        )
        try setDirectoryMode(
            parent: applicationsDescriptor,
            leaf: Self.liveLeaf,
            allowedCurrentModes: [0, mode_t(journal.candidateApplicationMode)],
            newMode: mode_t(journal.candidateApplicationMode)
        )
        if let previousMode = journal.previousApplicationMode {
            guard let previousExecutableModes = journal.previousExecutableModes else {
                throw ApplicationNamespaceError.invalidBinding
            }
            try setApplicationExecutableModes(
                parent: transactionDescriptor,
                applicationLeaf: Self.previousLeaf,
                originalModes: previousExecutableModes,
                engageBarrier: false
            )
            try setDirectoryMode(
                parent: transactionDescriptor,
                leaf: Self.previousLeaf,
                allowedCurrentModes: [0, mode_t(previousMode)],
                newMode: mode_t(previousMode)
            )
        }
    }

    func releaseRolledBackLaunchBarrier(journal: BrokerInstallJournal) throws {
        if let previousMode = journal.previousApplicationMode {
            guard let previousExecutableModes = journal.previousExecutableModes else {
                throw ApplicationNamespaceError.invalidBinding
            }
            try setApplicationExecutableModes(
                parent: applicationsDescriptor,
                applicationLeaf: Self.liveLeaf,
                originalModes: previousExecutableModes,
                engageBarrier: false
            )
            try setDirectoryMode(
                parent: applicationsDescriptor,
                leaf: Self.liveLeaf,
                allowedCurrentModes: [0, mode_t(previousMode)],
                newMode: mode_t(previousMode)
            )
        }
        let candidateAtOriginalSlot = try directoryExists(
            parent: candidateDescriptor,
            leaf: Self.liveLeaf
        )
        let candidateAtFailedSlot = try directoryExists(
            parent: transactionDescriptor,
            leaf: Self.failedCandidateLeaf
        )
        guard candidateAtOriginalSlot != candidateAtFailedSlot else {
            throw ApplicationNamespaceError.invalidBinding
        }
        try setApplicationExecutableModes(
            parent: candidateAtOriginalSlot ? candidateDescriptor : transactionDescriptor,
            applicationLeaf: candidateAtOriginalSlot ? Self.liveLeaf : Self.failedCandidateLeaf,
            originalModes: journal.candidateExecutableModes,
            engageBarrier: false
        )
        try setDirectoryMode(
            parent: candidateAtOriginalSlot ? candidateDescriptor : transactionDescriptor,
            leaf: candidateAtOriginalSlot ? Self.liveLeaf : Self.failedCandidateLeaf,
            allowedCurrentModes: [0, mode_t(journal.candidateApplicationMode)],
            newMode: mode_t(journal.candidateApplicationMode)
        )
    }

    private func renameAtX(
        from sourceDescriptor: Int32,
        _ sourceLeaf: String,
        to destinationDescriptor: Int32,
        _ destinationLeaf: String,
        flags: UInt32
    ) throws {
        let status = sourceLeaf.withCString { source in
            destinationLeaf.withCString { destination in
                renameatx_np(
                    sourceDescriptor,
                    source,
                    destinationDescriptor,
                    destination,
                    flags
                )
            }
        }
        guard status == 0 else { throw ApplicationNamespaceError.mutationFailed }
    }

    private func synchronize(_ descriptors: [Int32]) throws {
        for descriptor in descriptors {
            guard DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
                  fsync(descriptor) == 0
            else {
                throw ApplicationNamespaceError.couldNotSync
            }
        }
    }

    private func setDirectoryMode(
        parent: Int32,
        leaf: String,
        allowedCurrentModes: Set<mode_t>,
        newMode: mode_t
    ) throws {
        var namedBefore = stat()
        let inspectStatus = leaf.withCString {
            fstatat(parent, $0, &namedBefore, AT_SYMLINK_NOFOLLOW)
        }
        guard inspectStatus == 0,
              (namedBefore.st_mode & S_IFMT) == S_IFDIR,
              namedBefore.st_uid == 0,
              allowedCurrentModes.contains(namedBefore.st_mode & 0o777)
        else {
            throw ApplicationNamespaceError.invalidBinding
        }
        let descriptor = leaf.withCString {
            openat(parent, $0, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw ApplicationNamespaceError.invalidBinding }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0,
              opened.st_dev == namedBefore.st_dev,
              opened.st_ino == namedBefore.st_ino,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              fchmod(descriptor, newMode) == 0,
              fsync(descriptor) == 0
        else {
            throw ApplicationNamespaceError.mutationFailed
        }
        var namedAfter = stat()
        let recheckStatus = leaf.withCString {
            fstatat(parent, $0, &namedAfter, AT_SYMLINK_NOFOLLOW)
        }
        guard recheckStatus == 0,
              namedAfter.st_dev == opened.st_dev,
              namedAfter.st_ino == opened.st_ino,
              (namedAfter.st_mode & 0o777) == newMode,
              fsync(parent) == 0
        else {
            throw ApplicationNamespaceError.mutationFailed
        }
    }

    private func setApplicationExecutableModes(
        parent: Int32,
        applicationLeaf: String,
        originalModes: [String: UInt16],
        engageBarrier: Bool
    ) throws {
        let application = try openSafeDirectoryAt(parent: parent, leaf: applicationLeaf)
        defer { Darwin.close(application) }
        for relativePath in originalModes.keys.sorted() {
            let components = relativePath.split(separator: "/").map(String.init)
            guard components.count == 3, components[0] == "Contents",
                  let originalMode = originalModes[relativePath]
            else {
                throw ApplicationNamespaceError.invalidBinding
            }
            let contents = try openSafeDirectoryAt(parent: application, leaf: components[0])
            defer { Darwin.close(contents) }
            let executableDirectory = try openSafeDirectoryAt(
                parent: contents,
                leaf: components[1]
            )
            defer { Darwin.close(executableDirectory) }
            try setRegularFileMode(
                parent: executableDirectory,
                leaf: components[2],
                allowedCurrentModes: [0, mode_t(originalMode)],
                newMode: engageBarrier ? 0 : mode_t(originalMode)
            )
        }
    }

    private func openSafeDirectoryAt(parent: Int32, leaf: String) throws -> Int32 {
        let descriptor = leaf.withCString {
            openat(parent, $0, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw ApplicationNamespaceError.invalidBinding }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            Darwin.close(descriptor)
            throw ApplicationNamespaceError.invalidBinding
        }
        return descriptor
    }

    private func setRegularFileMode(
        parent: Int32,
        leaf: String,
        allowedCurrentModes: Set<mode_t>,
        newMode: mode_t
    ) throws {
        var namedBefore = stat()
        let inspectStatus = leaf.withCString {
            fstatat(parent, $0, &namedBefore, AT_SYMLINK_NOFOLLOW)
        }
        guard inspectStatus == 0,
              (namedBefore.st_mode & S_IFMT) == S_IFREG,
              namedBefore.st_uid == 0,
              namedBefore.st_nlink == 1,
              allowedCurrentModes.contains(namedBefore.st_mode & 0o777)
        else {
            throw ApplicationNamespaceError.invalidBinding
        }
        let descriptor = leaf.withCString {
            openat(parent, $0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw ApplicationNamespaceError.invalidBinding }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0,
              opened.st_dev == namedBefore.st_dev,
              opened.st_ino == namedBefore.st_ino,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              fchmod(descriptor, newMode) == 0,
              fsync(descriptor) == 0
        else {
            throw ApplicationNamespaceError.mutationFailed
        }
        var namedAfter = stat()
        let recheckStatus = leaf.withCString {
            fstatat(parent, $0, &namedAfter, AT_SYMLINK_NOFOLLOW)
        }
        guard recheckStatus == 0,
              namedAfter.st_dev == opened.st_dev,
              namedAfter.st_ino == opened.st_ino,
              (namedAfter.st_mode & 0o777) == newMode,
              fsync(parent) == 0
        else {
            throw ApplicationNamespaceError.mutationFailed
        }
    }

    private func directoryExists(parent: Int32, leaf: String) throws -> Bool {
        var metadata = stat()
        let status = leaf.withCString {
            fstatat(parent, $0, &metadata, AT_SYMLINK_NOFOLLOW)
        }
        if status != 0, errno == ENOENT { return false }
        guard status == 0, (metadata.st_mode & S_IFMT) == S_IFDIR else {
            throw ApplicationNamespaceError.invalidBinding
        }
        return true
    }

    private static func openValidatedDirectory(
        _ path: String,
        exactApplicationsDirectory: Bool
    ) throws -> Int32 {
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(to: path) else {
            throw ApplicationNamespaceError.unsafeDirectory
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw ApplicationNamespaceError.unsafeDirectory }
        let valid: Bool
        if exactApplicationsDirectory {
            valid = DarwinACLValidator.descriptorIsSafeRootOwnedDirectory(
                descriptor,
                exactPath: "/Applications"
            )
        } else {
            var metadata = stat()
            valid = fstat(descriptor, &metadata) == 0 &&
                (metadata.st_mode & S_IFMT) == S_IFDIR &&
                metadata.st_uid == 0 &&
                (metadata.st_mode & 0o077) == 0 &&
                DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        }
        guard valid else {
            Darwin.close(descriptor)
            throw ApplicationNamespaceError.unsafeDirectory
        }
        return descriptor
    }
}

private extension String {
    var deletingLastPathComponent: String {
        URL(fileURLWithPath: self).deletingLastPathComponent().path
    }
}

enum ApplicationNamespaceError: Error {
    case invalidBinding
    case unsafeDirectory
    case mutationFailed
    case couldNotSync
}
