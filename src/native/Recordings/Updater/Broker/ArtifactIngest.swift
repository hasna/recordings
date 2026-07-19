import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol
import RecordingsVerifierLauncher

struct StagedFile: Sendable {
    let path: String
    let sha256: String
    let byteCount: Int64
    let data: Data?
}

struct StagedUpdate: Sendable {
    let transactionID: UUID
    let directory: String
    let archive: StagedFile
    let manifest: StagedFile
    let envelope: StagedFile
}

final class RootUpdateState {
    let rootPath: String
    private let rootDescriptor: Int32

    init(path: String = RecordingsUpdateConstants.stateRoot) throws {
        guard geteuid() == 0 else { throw IngestError.brokerNotRoot }
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(to: path) else {
            throw IngestError.unsafeStateRoot
        }
        var metadata = stat()
        guard lstat(path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0
        else {
            throw IngestError.unsafeStateRoot
        }
        rootDescriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard rootDescriptor >= 0 else { throw IngestError.unsafeStateRoot }
        var openedMetadata = stat()
        guard fstat(rootDescriptor, &openedMetadata) == 0,
              openedMetadata.st_dev == metadata.st_dev,
              openedMetadata.st_ino == metadata.st_ino,
              DarwinACLValidator.descriptorHasNoExtendedACL(rootDescriptor)
        else {
            Darwin.close(rootDescriptor)
            throw IngestError.unsafeStateRoot
        }
        rootPath = path
    }

    deinit { Darwin.close(rootDescriptor) }

    func withExclusiveTransactionLock<T>(_ operation: () throws -> T) throws -> T {
        let lock = openat(
            rootDescriptor,
            ".transactions.lock",
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard lock >= 0 else { throw IngestError.transactionLockUnavailable }
        defer { Darwin.close(lock) }
        var metadata = stat()
        guard fstat(lock, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(lock),
              flock(lock, LOCK_EX) == 0
        else {
            throw IngestError.transactionLockUnavailable
        }
        defer { flock(lock, LOCK_UN) }
        return try operation()
    }

    func ensureFreeSpace(requiredBytes: UInt64) throws {
        var filesystem = statfs()
        guard fstatfs(rootDescriptor, &filesystem) == 0,
              filesystem.f_bavail > 0,
              filesystem.f_bsize > 0
        else {
            throw IngestError.insufficientStagingCapacity
        }
        let (available, overflow) = UInt64(filesystem.f_bavail)
            .multipliedReportingOverflow(by: UInt64(filesystem.f_bsize))
        let safetyReserve: UInt64 = 2 * 1024 * 1024 * 1024
        guard !overflow,
              requiredBytes <= UInt64.max - safetyReserve,
              available >= requiredBytes + safetyReserve
        else {
            throw IngestError.insufficientStagingCapacity
        }
    }

    func ensureTransactionQuota() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: rootPath)
        for name in names where name.hasPrefix("transaction-") {
            guard let identifier = UUID(uuidString: String(name.dropFirst("transaction-".count))),
                  "transaction-" + identifier.uuidString.lowercased() == name
            else {
                throw IngestError.unsafeRetainedTransaction
            }
            // Startup recovery must resolve and prune every previous transaction
            // before the listener opens. One broker process admits one transaction.
            throw IngestError.transactionQuotaExceeded
        }
    }

    func removeTransactionDirectory(id: UUID) throws {
        let leaf = "transaction-\(id.uuidString.lowercased())"
        let status = leaf.withCString {
            recordings_remove_directory_tree_at(rootDescriptor, $0)
        }
        guard status == 0 || status == ENOENT else { throw IngestError.couldNotCleanup }
    }

    func createTransactionDirectory(id: UUID) throws -> String {
        let leaf = "transaction-\(id.uuidString.lowercased())"
        guard mkdirat(rootDescriptor, leaf, 0o700) == 0 else {
            throw IngestError.couldNotCreateTransaction
        }
        guard fsync(rootDescriptor) == 0 else { throw IngestError.couldNotSync }
        let descriptor = openat(rootDescriptor, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw IngestError.couldNotCreateTransaction }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw IngestError.couldNotCreateTransaction
        }
        return rootPath + "/" + leaf
    }
}

struct ArtifactIngestor {
    static let maximumArchiveBytes: Int64 = 256 * 1024 * 1024
    static let maximumManifestBytes: Int64 = 16 * 1024 * 1024
    static let maximumEnvelopeBytes: Int64 = 1024 * 1024
    static let maximumTransactionFootprintBytes: UInt64 = 2 * 1024 * 1024 * 1024

    let state: RootUpdateState

    func stage(archive: FileHandle, manifest: FileHandle, envelope: FileHandle) throws -> StagedUpdate {
        try state.ensureFreeSpace(
            requiredBytes: Self.maximumTransactionFootprintBytes
        )
        let retainedDescriptors = try [archive, manifest, envelope].map { handle -> Int32 in
            let retained = fcntl(handle.fileDescriptor, F_DUPFD_CLOEXEC, 10)
            guard retained >= 0, lseek(retained, 0, SEEK_CUR) >= 0 else {
                if retained >= 0 { Darwin.close(retained) }
                throw IngestError.invalidSourceDescriptor
            }
            return retained
        }
        defer { retainedDescriptors.forEach { Darwin.close($0) } }
        let transactionID = UUID()
        let directory = try state.createTransactionDirectory(id: transactionID)
        do {
            let stagedArchive = try copyDescriptor(
                retainedDescriptors[0],
                to: directory + "/artifact.pkg",
                maximumBytes: Self.maximumArchiveBytes,
                retainData: false
            )
            let stagedManifest = try copyDescriptor(
                retainedDescriptors[1],
                to: directory + "/manifest.json",
                maximumBytes: Self.maximumManifestBytes,
                retainData: true
            )
            let stagedEnvelope = try copyDescriptor(
                retainedDescriptors[2],
                to: directory + "/envelope.json",
                maximumBytes: Self.maximumEnvelopeBytes,
                retainData: true
            )
            return StagedUpdate(
                transactionID: transactionID,
                directory: directory,
                archive: stagedArchive,
                manifest: stagedManifest,
                envelope: stagedEnvelope
            )
        } catch {
            // Nothing in this transaction has executed. Remove only the exact
            // broker-generated UUID using the descriptor-relative root primitive.
            do {
                try state.removeTransactionDirectory(id: transactionID)
            } catch {
                throw error
            }
            throw error
        }
    }

    private func copyDescriptor(
        _ sourceDescriptor: Int32,
        to destination: String,
        maximumBytes: Int64,
        retainData: Bool
    ) throws -> StagedFile {
        var before = stat()
        guard fstat(sourceDescriptor, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              before.st_size > 0
        else {
            throw IngestError.invalidSourceDescriptor
        }
        guard before.st_size <= maximumBytes else { throw IngestError.sourceTooLarge }

        let output = Darwin.open(
            destination,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600
        )
        guard output >= 0 else { throw IngestError.couldNotCreateStagingFile }
        var shouldUnlink = true
        defer {
            Darwin.close(output)
            if shouldUnlink { Darwin.unlink(destination) }
        }
        guard DarwinACLValidator.descriptorHasNoExtendedACL(output) else {
            throw IngestError.couldNotCreateStagingFile
        }

        var hasher = SHA256()
        var captured = retainData ? Data() : nil
        if retainData { captured?.reserveCapacity(Int(before.st_size)) }
        var offset: off_t = 0
        var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while offset < before.st_size {
            let requestCount = min(buffer.count, Int(before.st_size - offset))
            let count = buffer.withUnsafeMutableBytes {
                pread(sourceDescriptor, $0.baseAddress, requestCount, offset)
            }
            guard count > 0 else { throw IngestError.sourceChangedDuringCopy }
            let data = Data(buffer.prefix(count))
            hasher.update(data: data)
            captured?.append(data)
            try writeAll(data, to: output)
            offset += off_t(count)
        }

        var trailingByte: UInt8 = 0
        guard pread(sourceDescriptor, &trailingByte, 1, offset) == 0 else {
            throw IngestError.sourceChangedDuringCopy
        }
        var after = stat()
        guard fstat(sourceDescriptor, &after) == 0,
              before.st_dev == after.st_dev,
              before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
        else {
            throw IngestError.sourceChangedDuringCopy
        }
        guard fsync(output) == 0,
              fchmod(output, 0o400) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(output),
              fsync(output) == 0
        else {
            throw IngestError.couldNotSync
        }
        let parent = Darwin.open(
            URL(fileURLWithPath: destination).deletingLastPathComponent().path,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard parent >= 0 else { throw IngestError.couldNotSync }
        defer { Darwin.close(parent) }
        guard DarwinACLValidator.descriptorHasNoExtendedACL(parent),
              fsync(parent) == 0
        else {
            throw IngestError.couldNotSync
        }
        shouldUnlink = false
        return StagedFile(
            path: destination,
            sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
            byteCount: before.st_size,
            data: captured
        )
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var written = 0
            while written < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: written), bytes.count - written)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw IngestError.couldNotWrite }
                written += count
            }
        }
    }
}

enum IngestError: Error, CustomStringConvertible {
    case brokerNotRoot
    case unsafeStateRoot
    case couldNotCreateTransaction
    case invalidSourceDescriptor
    case sourceTooLarge
    case sourceChangedDuringCopy
    case couldNotCreateStagingFile
    case couldNotWrite
    case couldNotSync
    case transactionLockUnavailable
    case insufficientStagingCapacity
    case couldNotCleanup
    case unsafeRetainedTransaction
    case transactionQuotaExceeded

    var description: String {
        switch self {
        case .brokerNotRoot: "The update broker is not running as root"
        case .unsafeStateRoot: "The root-owned update state directory is missing or unsafe"
        case .couldNotCreateTransaction: "Could not create a protected update transaction"
        case .invalidSourceDescriptor: "The update input is not a regular file descriptor"
        case .sourceTooLarge: "The update input exceeds its size limit"
        case .sourceChangedDuringCopy: "The update input changed while it was being copied"
        case .couldNotCreateStagingFile: "Could not create a protected staging file"
        case .couldNotWrite: "Could not write the protected staging file"
        case .couldNotSync: "Could not durably synchronize update state"
        case .transactionLockUnavailable: "The protected update transaction lock is unavailable"
        case .insufficientStagingCapacity: "The protected update volume lacks the required safety reserve"
        case .couldNotCleanup: "Could not remove a protected update transaction"
        case .unsafeRetainedTransaction: "A retained update transaction name is unsafe"
        case .transactionQuotaExceeded: "A protected update transaction is already retained"
        }
    }
}
