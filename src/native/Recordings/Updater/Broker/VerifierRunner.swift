import Darwin
import Foundation
import RecordingsUpdateProtocol
import RecordingsVerifierLauncher

struct ArtifactVerifierRunner {
    func materialize(stagedUpdate: StagedUpdate) throws -> String {
        var verifierUserID: uid_t = 0
        var verifierGroupID: gid_t = 0
        let lookupStatus = RecordingsUpdateConstants.artifactVerifierAccount.withCString {
            recordings_lookup_verifier_account($0, &verifierUserID, &verifierGroupID)
        }
        guard lookupStatus == 0, verifierUserID != 0, verifierGroupID != 0 else {
            throw VerifierRunnerError.invalidVerifierAccount
        }
        let outputPath = stagedUpdate.directory + "/verifier-output"
        guard mkdir(outputPath, 0o700) == 0,
              chown(outputPath, verifierUserID, verifierGroupID) == 0
        else {
            throw VerifierRunnerError.couldNotCreateOutput
        }
        let archive = Darwin.open(stagedUpdate.archive.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard archive >= 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(archive)
        else {
            if archive >= 0 { Darwin.close(archive) }
            throw VerifierRunnerError.invalidStagedArchive
        }
        defer { Darwin.close(archive) }
        let output = Darwin.open(outputPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard output >= 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(output)
        else {
            if output >= 0 { Darwin.close(output) }
            throw VerifierRunnerError.couldNotCreateOutput
        }
        defer { Darwin.close(output) }

        let status = stagedUpdate.archive.sha256.withCString {
            recordings_run_artifact_verifier(
                archive,
                output,
                verifierUserID,
                verifierGroupID,
                $0
            )
        }
        guard status == 0 else { throw VerifierRunnerError.verifierFailed(status) }
        var outputMetadata = stat()
        guard fchown(output, 0, 0) == 0,
              fchmod(output, 0o700) == 0,
              fstat(output, &outputMetadata) == 0,
              (outputMetadata.st_mode & S_IFMT) == S_IFDIR,
              outputMetadata.st_uid == 0,
              (outputMetadata.st_mode & 0o077) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(output),
              fsync(output) == 0
        else {
            throw VerifierRunnerError.couldNotSealOutput
        }
        return outputPath
    }
}

enum VerifierRunnerError: Error, CustomStringConvertible {
    case invalidVerifierAccount
    case couldNotCreateOutput
    case invalidStagedArchive
    case verifierFailed(Int32)
    case couldNotSealOutput

    var description: String {
        switch self {
        case .invalidVerifierAccount: "The no-login artifact-verifier account is missing or unsafe"
        case .couldNotCreateOutput: "Could not create protected verifier output"
        case .invalidStagedArchive: "The protected staged package is unavailable"
        case let .verifierFailed(status): "The sandboxed artifact verifier failed (\(status))"
        case .couldNotSealOutput: "Could not seal verifier output for root-side validation"
        }
    }
}
