import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol

@main
enum RecordingsEnvelopeSigner {
    static func main() {
        do {
            let arguments = try Arguments.parse(CommandLine.arguments)
            let payloadData = try readRegularFile(
                path: arguments.payloadPath,
                maximumBytes: 1024 * 1024,
                requireOwnerOnly: false
            )
            let payload = try JSONDecoder().decode(ReleaseEnvelopePayload.self, from: payloadData)
            try payload.validate()
            let privateKeyData = try readRegularFile(
                path: arguments.privateKeyPath,
                maximumBytes: 32,
                requireOwnerOnly: true
            )
            guard privateKeyData.count == 32 else { throw SignerError.invalidPrivateKey }
            let privateKey: Curve25519.Signing.PrivateKey
            do {
                privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
            } catch {
                throw SignerError.invalidPrivateKey
            }
            let publicKeyData = try readRegularFile(
                path: arguments.publicKeyPath,
                maximumBytes: 32,
                requireOwnerOnly: false
            )
            guard publicKeyData.count == 32,
                  privateKey.publicKey.rawRepresentation == publicKeyData
            else {
                throw SignerError.publicKeyMismatch
            }
            let signature = try privateKey.signature(for: payload.canonicalData())
            let envelope = SignedReleaseEnvelope(
                payload: payload,
                signature: signature.base64EncodedString()
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            let output = try encoder.encode(envelope) + Data([0x0a])
            try writeExclusive(path: arguments.outputPath, data: output)
        } catch {
            let message = "recordings-envelope-signer: \(sanitized(error))\n"
            FileHandle.standardError.write(Data(message.utf8))
            Darwin.exit(1)
        }
    }

    private static func readRegularFile(
        path: String,
        maximumBytes: Int64,
        requireOwnerOnly: Bool
    ) throws -> Data {
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw SignerError.couldNotOpenInput }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_size > 0,
              metadata.st_size <= maximumBytes,
              (!requireOwnerOnly || (metadata.st_uid == geteuid() && (metadata.st_mode & 0o077) == 0))
        else {
            throw SignerError.unsafeInput
        }
        let before = metadata
        var data = Data(count: Int(metadata.st_size))
        var offset: off_t = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < before.st_size {
                let count = pread(
                    descriptor,
                    base.advanced(by: Int(offset)),
                    Int(before.st_size - offset),
                    offset
                )
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw SignerError.couldNotReadInput }
                offset += off_t(count)
            }
        }
        var extra: UInt8 = 0
        guard pread(descriptor, &extra, 1, metadata.st_size) == 0 else {
            throw SignerError.inputChanged
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev,
              before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
        else {
            throw SignerError.inputChanged
        }
        return data
    }

    private static func writeExclusive(path: String, data: Data) throws {
        let outputURL = URL(fileURLWithPath: path)
        let parentPath = outputURL.deletingLastPathComponent().path
        let leaf = outputURL.lastPathComponent
        guard !leaf.isEmpty, leaf != ".", leaf != "..", !leaf.contains("/") else {
            throw SignerError.outputAlreadyExistsOrUnsafe
        }
        let parent = Darwin.open(parentPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parent >= 0 else { throw SignerError.outputAlreadyExistsOrUnsafe }
        defer { Darwin.close(parent) }
        var parentMetadata = stat()
        guard fstat(parent, &parentMetadata) == 0,
              (parentMetadata.st_mode & S_IFMT) == S_IFDIR,
              parentMetadata.st_uid == geteuid(),
              (parentMetadata.st_mode & 0o022) == 0
        else {
            throw SignerError.outputAlreadyExistsOrUnsafe
        }
        let descriptor = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw SignerError.outputAlreadyExistsOrUnsafe }
        var keep = false
        defer {
            Darwin.close(descriptor)
            if !keep { unlinkat(parent, leaf, 0) }
        }
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw SignerError.couldNotWriteOutput }
                offset += count
            }
        }
        guard fsync(descriptor) == 0, fsync(parent) == 0 else {
            throw SignerError.couldNotWriteOutput
        }
        keep = true
    }

    private static func sanitized(_ error: Error) -> String {
        if let error = error as? SignerError { return error.description }
        if let error = error as? ReleaseEnvelopeValidationError { return error.description }
        return "operation failed"
    }
}

private struct Arguments {
    let payloadPath: String
    let privateKeyPath: String
    let publicKeyPath: String
    let outputPath: String

    static func parse(_ values: [String]) throws -> Arguments {
        guard values.count == 9,
              values[1] == "--payload",
              values[3] == "--private-key",
              values[5] == "--public-key",
              values[7] == "--output",
              values[2].hasPrefix("/"),
              values[4].hasPrefix("/"),
              values[6].hasPrefix("/"),
              values[8].hasPrefix("/")
        else {
            throw SignerError.usage
        }
        return Arguments(
            payloadPath: values[2],
            privateKeyPath: values[4],
            publicKeyPath: values[6],
            outputPath: values[8]
        )
    }
}

private enum SignerError: Error, CustomStringConvertible {
    case usage
    case couldNotOpenInput
    case unsafeInput
    case couldNotReadInput
    case inputChanged
    case invalidPrivateKey
    case publicKeyMismatch
    case outputAlreadyExistsOrUnsafe
    case couldNotWriteOutput

    var description: String {
        switch self {
        case .usage:
            "usage: recordings-envelope-signer --payload /absolute/payload.json --private-key /absolute/private-key.raw --public-key /absolute/public-key.raw --output /absolute/envelope.json"
        case .couldNotOpenInput: "could not open an input file"
        case .unsafeInput: "an input file has an unsafe type, size, owner, or mode"
        case .couldNotReadInput: "could not read an input file"
        case .inputChanged: "an input file changed while it was read"
        case .invalidPrivateKey: "the private signing key is invalid"
        case .publicKeyMismatch: "the private signing key does not match the selected epoch public key"
        case .outputAlreadyExistsOrUnsafe: "the output path already exists or is unsafe"
        case .couldNotWriteOutput: "could not durably write the output file"
        }
    }
}
