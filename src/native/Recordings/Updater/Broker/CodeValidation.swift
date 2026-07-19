import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol
import Security

struct CandidateValidationResult: Sendable {
    let treeSHA256: String
    let applicationIdentifier: String
}

/// Cross-runtime release material is ordered by its unsigned UTF-8 bytes.
///
/// Swift's native `String` comparison is normalization-aware, while the
/// artifact tooling deliberately compares the encoded bytes. Keep this in
/// lockstep with `compareUnsignedUtf8` in `scripts/macos_artifact.ts`.
enum CanonicalReleaseOrder {
    static func unsignedUTF8Precedes(_ left: String, _ right: String) -> Bool {
        left.utf8.lexicographicallyPrecedes(right.utf8)
    }

    static func sorted(_ values: [String]) -> [String] {
        values.sorted(by: unsignedUTF8Precedes)
    }
}

enum ReleaseCodeValidator {
    static func validateProtectedComponents(payload: ReleaseEnvelopePayload) throws {
        try validateRegularDigest(
            path: RecordingsUpdateConstants.brokerExecutablePath,
            expected: payload.updateBrokerSHA256
        )
        try validateStaticCode(
            path: RecordingsUpdateConstants.brokerExecutablePath,
            requirementText: payload.updateBrokerDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        try validateRegularDigest(
            path: RecordingsUpdateConstants.artifactVerifierPath,
            expected: payload.artifactVerifierSHA256
        )
        try validateStaticCode(
            path: RecordingsUpdateConstants.artifactVerifierPath,
            requirementText: payload.artifactVerifierDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
    }

    static func validateCandidate(
        at applicationPath: String,
        payload: ReleaseEnvelopePayload,
        policy: BrokerPolicy
    ) throws -> CandidateValidationResult {
        let treeDigest = try CanonicalTree.digest(at: applicationPath)
        guard treeDigest == payload.candidateTreeSHA256 else {
            throw CodeValidationError.treeDigestMismatch
        }
        try validateStaticCode(
            path: applicationPath,
            requirementText: payload.applicationDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        let clientPath = applicationPath + "/" + RecordingsUpdateConstants.updateClientRelativePath
        try validateRegularDigest(path: clientPath, expected: payload.updateClientSHA256)
        try validateStaticCode(
            path: clientPath,
            requirementText: payload.updateClientDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        let actualUpdateClientArchitectures = try readArchitectures(clientPath)

        let informationPath = applicationPath + "/Contents/Info.plist"
        let informationData = try readBoundedRegularFile(path: informationPath, maximumBytes: 1024 * 1024)
        guard let propertyList = try PropertyListSerialization.propertyList(
            from: informationData,
            options: [],
            format: nil
        ) as? [String: Any],
              let identifier = propertyList["CFBundleIdentifier"] as? String,
              let shortVersion = propertyList["CFBundleShortVersionString"] as? String,
              let buildVersion = propertyList["CFBundleVersion"] as? String,
              let executable = propertyList["CFBundleExecutable"] as? String,
              let minimumOS = propertyList["LSMinimumSystemVersion"] as? String
        else {
            throw CodeValidationError.invalidApplicationMetadata
        }

        let provenancePath =
            applicationPath + "/Contents/Resources/recordings-build-provenance.json"
        let provenanceData = try readBoundedRegularFile(
            path: provenancePath,
            maximumBytes: 64 * 1024
        )
        let provenance: ReleaseBuildProvenance
        let provenanceObject: [String: Any]
        do {
            provenance = try JSONDecoder().decode(ReleaseBuildProvenance.self, from: provenanceData)
            guard let object = try JSONSerialization.jsonObject(with: provenanceData) as? [String: Any]
            else {
                throw CodeValidationError.invalidBuildProvenance
            }
            provenanceObject = object
        } catch {
            throw CodeValidationError.invalidBuildProvenance
        }
        let expectedProvenanceFields: Set<String> = [
            "schema_version",
            "bundle_id",
            "bundle_version",
            "bundle_build_version",
            "git_sha",
            "architectures",
            "team_id",
            "minimum_macos",
            "companion",
        ]
        let expectedCompanionFields: Set<String> = ["version", "sha256", "architectures"]
        guard Set(provenanceObject.keys) == expectedProvenanceFields,
              let companionObject = provenanceObject["companion"] as? [String: Any],
              Set(companionObject.keys) == expectedCompanionFields
        else {
            throw CodeValidationError.invalidBuildProvenance
        }
        let executablePath = applicationPath + "/Contents/MacOS/Recordings"
        let actualArchitectures = try readArchitectures(executablePath)
        let companionPath = applicationPath + "/Contents/Helpers/recordings"
        let actualCompanionSHA256 = try sha256RegularFile(path: companionPath)
        let actualCompanionArchitectures = try readArchitectures(companionPath)
        let localOnlyFieldNames: Set<String> = [
            "artifact_policy",
            "approved_target",
            "approved_target_identity_kind",
            "approved_target_identity_sha256",
            "builder_identity_kind",
            "builder_identity_sha256",
            "non_notarized",
        ]
        do {
            try CandidateMetadataPolicy.validate(
                application: CandidateApplicationMetadata(
                    bundleIdentifier: identifier,
                    shortVersion: shortVersion,
                    buildVersion: buildVersion,
                    executable: executable,
                    minimumOSVersion: minimumOS,
                    architectures: actualArchitectures
                ),
                updateClientArchitectures: actualUpdateClientArchitectures,
                companion: CandidateCompanionMetadata(
                    sha256: actualCompanionSHA256,
                    architectures: actualCompanionArchitectures
                ),
                provenance: CandidateBuildProvenanceMetadata(
                    schemaVersion: provenance.schemaVersion,
                    containsLocalOnlyFields:
                        !localOnlyFieldNames.isDisjoint(with: Set(provenanceObject.keys)),
                    bundleIdentifier: provenance.bundleIdentifier,
                    bundleVersion: provenance.bundleVersion,
                    bundleBuildVersion: provenance.bundleBuildVersion,
                    sourceCommit: provenance.sourceCommit,
                    teamIdentifier: provenance.teamIdentifier,
                    minimumMacOS: provenance.minimumMacOS,
                    architectures: provenance.architectures,
                    companionVersion: provenance.companion.version,
                    companionSHA256: provenance.companion.sha256,
                    companionArchitectures: provenance.companion.architectures
                ),
                expected: CandidateReleaseMetadataExpectation(
                    applicationIdentifier: policy.applicationIdentifier,
                    applicationExecutable: "Recordings",
                    version: payload.version,
                    build: payload.build,
                    sourceCommit: payload.sourceCommit,
                    signingTeamIdentifier: payload.signingTeamIdentifier,
                    minimumOSVersion: payload.minimumOSVersion,
                    architectures: payload.architectures
                )
            )
        } catch let error as CandidateMetadataPolicyError {
            throw mapMetadataPolicyError(error)
        }
        return CandidateValidationResult(treeSHA256: treeDigest, applicationIdentifier: identifier)
    }

    static func validateRegularDigest(path: String, expected: String) throws {
        guard try sha256RegularFile(path: path) == expected else {
            throw CodeValidationError.fileDigestMismatch
        }
    }

    static func sha256RegularFile(
        path: String,
        requireRootOwnedAncestry: Bool = true
    ) throws -> String {
        if requireRootOwnedAncestry {
            let parentDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().path
            guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
                to: parentDirectory
            ) else {
                throw CodeValidationError.unsafeRegularFile
            }
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw CodeValidationError.unsafeRegularFile }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              before.st_uid == 0,
              (before.st_mode & 0o022) == 0,
              before.st_nlink == 1,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              before.st_size >= 0
        else {
            throw CodeValidationError.unsafeRegularFile
        }
        var hasher = SHA256()
        var offset: off_t = 0
        var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while offset < before.st_size {
            let requested = min(buffer.count, Int(before.st_size - offset))
            let count = buffer.withUnsafeMutableBytes {
                pread(descriptor, $0.baseAddress, requested, offset)
            }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw CodeValidationError.fileChanged }
            hasher.update(data: Data(buffer.prefix(count)))
            offset += off_t(count)
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev,
              before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw CodeValidationError.fileChanged
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func validateStaticCode(
        path: String,
        requirementText: String,
        expectedTeam: String
    ) throws {
        let parentDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
            to: parentDirectory
        ) else {
            throw CodeValidationError.unsafeTreeEntry
        }
        var pathMetadata = stat()
        guard lstat(path, &pathMetadata) == 0,
              DarwinACLValidator.pathHasNoExtendedACL(
                  path,
                  directory: (pathMetadata.st_mode & S_IFMT) == S_IFDIR
              )
        else {
            throw CodeValidationError.unsafeTreeEntry
        }
        var staticCode: SecStaticCode?
        let createStatus = SecStaticCodeCreateWithPath(
            URL(fileURLWithPath: path) as CFURL,
            [],
            &staticCode
        )
        guard createStatus == errSecSuccess, let staticCode else {
            throw CodeValidationError.codeIdentityUnavailable(createStatus)
        }
        var requirement: SecRequirement?
        let requirementStatus = SecRequirementCreateWithString(
            requirementText as CFString,
            [],
            &requirement
        )
        guard requirementStatus == errSecSuccess, let requirement else {
            throw CodeValidationError.invalidDesignatedRequirement
        }
        let validityStatus = SecStaticCodeCheckValidity(
            staticCode,
            SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
            requirement
        )
        guard validityStatus == errSecSuccess else {
            throw CodeValidationError.codeIdentityRejected(validityStatus)
        }
        var information: CFDictionary?
        let informationStatus = SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &information
        )
        guard informationStatus == errSecSuccess,
              let values = information as? [String: Any],
              values[kSecCodeInfoTeamIdentifier as String] as? String == expectedTeam
        else {
            throw CodeValidationError.codeIdentityRejected(informationStatus)
        }
    }

    private static func readArchitectures(_ path: String) throws -> [String] {
        guard DarwinACLValidator.pathHasNoExtendedACL(path, directory: false) else {
            throw CodeValidationError.architectureCheckFailed
        }
        let result: BoundedProcessResult
        do {
            result = try BoundedProcessRunner.run(
                executablePath: "/usr/bin/lipo",
                arguments: ["-archs", path],
                environment: [
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                    "HOME": "/var/empty",
                    "TMPDIR": "/tmp",
                ],
                maximumOutputBytes: 4_096,
                timeout: 5
            )
        } catch {
            throw CodeValidationError.architectureCheckFailed
        }
        guard result.exitedNormally,
              result.terminationStatus == 0,
              result.standardOutput.count <= 4_096,
              let text = String(data: result.standardOutput, encoding: .utf8)
        else {
            throw CodeValidationError.architectureCheckFailed
        }
        let actual = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !actual.isEmpty, Set(actual).count == actual.count else {
            throw CodeValidationError.architectureCheckFailed
        }
        return CanonicalReleaseOrder.sorted(actual)
    }

    private static func mapMetadataPolicyError(
        _ error: CandidateMetadataPolicyError
    ) -> CodeValidationError {
        switch error {
        case .applicationIdentifierMismatch,
             .applicationVersionMismatch,
             .applicationBuildMismatch,
             .applicationExecutableMismatch,
             .applicationMinimumOSMismatch,
             .applicationArchitectureMismatch,
             .updateClientArchitectureMismatch,
             .companionArchitectureMismatch:
            return .invalidApplicationMetadata
        case .provenanceSchemaMismatch,
             .localOnlyProvenanceRejected,
             .provenanceIdentifierMismatch,
             .provenanceVersionMismatch,
             .provenanceBuildMismatch,
             .provenanceSourceMismatch,
             .provenanceTeamMismatch,
             .provenanceMinimumOSMismatch,
             .provenanceArchitectureMismatch,
             .companionDigestMismatch,
             .provenanceCompanionVersionMismatch:
            return .invalidBuildProvenance
        }
    }

    private static func readBoundedRegularFile(path: String, maximumBytes: Int64) throws -> Data {
        let parentDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
            to: parentDirectory
        ) else {
            throw CodeValidationError.unsafeRegularFile
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw CodeValidationError.unsafeRegularFile }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0,
              metadata.st_nlink == 1,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              metadata.st_size > 0,
              metadata.st_size <= maximumBytes
        else {
            throw CodeValidationError.unsafeRegularFile
        }
        var data = Data(count: Int(metadata.st_size))
        var offset: off_t = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < metadata.st_size {
                let count = pread(descriptor, base.advanced(by: Int(offset)), Int(metadata.st_size - offset), offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw CodeValidationError.fileChanged }
                offset += off_t(count)
            }
        }
        var trailingByte: UInt8 = 0
        guard pread(descriptor, &trailingByte, 1, offset) == 0 else {
            throw CodeValidationError.fileChanged
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              metadata.st_dev == after.st_dev,
              metadata.st_ino == after.st_ino,
              metadata.st_mode == after.st_mode,
              metadata.st_uid == after.st_uid,
              metadata.st_gid == after.st_gid,
              metadata.st_nlink == after.st_nlink,
              metadata.st_size == after.st_size,
              metadata.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              metadata.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              metadata.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              metadata.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw CodeValidationError.fileChanged
        }
        return data
    }
}

private struct ReleaseBuildProvenance: Codable {
    let schemaVersion: Int
    let bundleIdentifier: String
    let bundleVersion: String
    let bundleBuildVersion: String
    let sourceCommit: String
    let architectures: [String]
    let teamIdentifier: String
    let minimumMacOS: String
    let companion: Companion

    struct Companion: Codable {
        let version: String
        let sha256: String
        let architectures: [String]
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case bundleIdentifier = "bundle_id"
        case bundleVersion = "bundle_version"
        case bundleBuildVersion = "bundle_build_version"
        case sourceCommit = "git_sha"
        case architectures
        case teamIdentifier = "team_id"
        case minimumMacOS = "minimum_macos"
        case companion
    }
}

enum CanonicalTree {
    static func digest(
        at root: String,
        modeOverrides: [String: UInt16] = [:]
    ) throws -> String {
        let parent = URL(fileURLWithPath: root).deletingLastPathComponent().path
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(to: parent) else {
            throw CodeValidationError.unsafeTreeEntry
        }
        var records: [String] = []
        try collectRecords(
            path: root,
            root: root,
            modeOverrides: modeOverrides,
            records: &records
        )
        return SHA256.hash(data: Data(records.joined(separator: "\n").utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func collectRecords(
        path: String,
        root: String,
        modeOverrides: [String: UInt16],
        records: inout [String]
    ) throws {
        var metadata = stat()
        guard lstat(path, &metadata) == 0 else { throw CodeValidationError.unsafeTreeEntry }
        let relative = path == root ? "." : String(path.dropFirst(root.count + 1))
        let recordedMode: mode_t
        if let modeOverride = modeOverrides[relative] {
            recordedMode = mode_t(modeOverride)
        } else {
            recordedMode = metadata.st_mode & 0o777
        }
        let mode = String(recordedMode, radix: 8)
        switch metadata.st_mode & S_IFMT {
        case S_IFDIR:
            guard metadata.st_uid == 0,
                  (metadata.st_mode & 0o022) == 0,
                  DarwinACLValidator.pathHasNoExtendedACL(path, directory: true)
            else {
                throw CodeValidationError.unsafeTreeEntry
            }
            records.append("d\0\(relative)\0\(mode)")
            let children = try FileManager.default.contentsOfDirectory(atPath: path)
            for child in CanonicalReleaseOrder.sorted(children) {
                guard child != ".", child != "..", !child.contains("/") else {
                    throw CodeValidationError.unsafeTreeEntry
                }
                try collectRecords(
                    path: path + "/" + child,
                    root: root,
                    modeOverrides: modeOverrides,
                    records: &records
                )
            }
        case S_IFREG:
            guard metadata.st_uid == 0,
                  (metadata.st_mode & 0o022) == 0,
                  metadata.st_nlink == 1,
                  DarwinACLValidator.pathHasNoExtendedACL(path, directory: false)
            else {
                throw CodeValidationError.unsafeTreeEntry
            }
            let digest = try ReleaseCodeValidator.sha256RegularFile(
                path: path,
                requireRootOwnedAncestry: false
            )
            records.append("f\0\(relative)\0\(mode)\0\(metadata.st_size)\0\(digest)")
        default:
            throw CodeValidationError.unsafeTreeEntry
        }
    }
}

enum CodeValidationError: Error, CustomStringConvertible {
    case unsafeRegularFile
    case fileChanged
    case fileDigestMismatch
    case unsafeTreeEntry
    case treeDigestMismatch
    case invalidApplicationMetadata
    case invalidBuildProvenance
    case architectureCheckFailed
    case invalidDesignatedRequirement
    case codeIdentityUnavailable(OSStatus)
    case codeIdentityRejected(OSStatus)

    var description: String {
        switch self {
        case .unsafeRegularFile: "A release component is not a safe root-owned regular file"
        case .fileChanged: "A release component changed during validation"
        case .fileDigestMismatch: "A release component digest does not match the signed envelope"
        case .unsafeTreeEntry: "The candidate contains a link, special file, unsafe owner, mode, or hard link"
        case .treeDigestMismatch: "The candidate tree digest does not match the signed envelope"
        case .invalidApplicationMetadata: "The candidate application metadata is invalid"
        case .invalidBuildProvenance: "The candidate build provenance does not match the signed envelope"
        case .architectureCheckFailed: "The candidate application architectures do not match the signed envelope"
        case .invalidDesignatedRequirement: "A signed designated requirement could not be compiled"
        case let .codeIdentityUnavailable(status): "A release code identity is unavailable (\(status))"
        case let .codeIdentityRejected(status): "A release code identity was rejected (\(status))"
        }
    }
}
