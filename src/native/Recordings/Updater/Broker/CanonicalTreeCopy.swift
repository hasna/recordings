import Darwin
import Foundation
import RecordingsVerifierLauncher

enum CanonicalTreeCopier {
    static func copyApplication(
        from verifierRoot: String,
        to rootCandidatePath: String,
        verifierUserID: uid_t
    ) throws {
        let source = Darwin.open(verifierRoot, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        var sourceMetadata = stat()
        guard source >= 0,
              fstat(source, &sourceMetadata) == 0,
              (sourceMetadata.st_mode & S_IFMT) == S_IFDIR,
              sourceMetadata.st_uid == 0,
              (sourceMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(source)
        else {
            if source >= 0 { Darwin.close(source) }
            throw CanonicalCopyError.unsafeSourceEntry
        }
        defer { Darwin.close(source) }
        let destinationRoot = URL(fileURLWithPath: rootCandidatePath).deletingLastPathComponent().path
        guard URL(fileURLWithPath: rootCandidatePath).lastPathComponent == "Recordings.app" else {
            throw CanonicalCopyError.nonCanonicalRoot
        }
        let destination = Darwin.open(
            destinationRoot,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        var destinationMetadata = stat()
        guard destination >= 0,
              fstat(destination, &destinationMetadata) == 0,
              (destinationMetadata.st_mode & S_IFMT) == S_IFDIR,
              destinationMetadata.st_uid == 0,
              (destinationMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(destination)
        else {
            if destination >= 0 { Darwin.close(destination) }
            throw CanonicalCopyError.couldNotCreateDestination
        }
        defer { Darwin.close(destination) }
        let status = recordings_copy_canonical_application_tree(source, destination, verifierUserID)
        guard status == 0 else { throw CanonicalCopyError.copyRejected(status) }
    }
}

enum CanonicalCopyError: Error, CustomStringConvertible {
    case nonCanonicalRoot
    case unsafeSourceEntry
    case couldNotCreateDestination
    case copyRejected(Int32)

    var description: String {
        switch self {
        case .nonCanonicalRoot: "The verifier output does not contain the canonical application root"
        case .unsafeSourceEntry: "The verifier output directory is unsafe"
        case .couldNotCreateDestination: "The root-owned candidate directory is unsafe"
        case let .copyRejected(status): "Descriptor-relative candidate copying was rejected (\(status))"
        }
    }
}
