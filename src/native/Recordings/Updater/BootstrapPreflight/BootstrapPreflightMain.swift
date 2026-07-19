import CryptoKit
import Darwin
import Foundation
import RecordingsUpdateProtocol
import Security

@main
enum RecordingsBootstrapPreflight {
    static func main() {
        do {
            let arguments = try Arguments.parse(CommandLine.arguments)
            try verify(arguments)
        } catch {
            let message = "recordings-bootstrap-preflight: \(sanitized(error))\n"
            FileHandle.standardError.write(Data(message.utf8))
            Darwin.exit(1)
        }
    }

    private static func verify(_ arguments: Arguments) throws {
        guard geteuid() == 0 else { throw PreflightError.notRoot }
        let packageDigest = try sha256RegularFile(arguments.packagePath, maximumBytes: 2 * 1024 * 1024 * 1024)
        let packageSize = try regularFileSize(arguments.packagePath, maximumBytes: 2 * 1024 * 1024 * 1024)
        let manifestData = try readRegularFile(arguments.manifestPath, maximumBytes: 16 * 1024 * 1024)
        let envelopeData = try readRegularFile(arguments.envelopePath, maximumBytes: 1024 * 1024)
        let envelope = try JSONDecoder().decode(SignedReleaseEnvelope.self, from: envelopeData)

        let key = try findSolePublicKey(payloadRoot: arguments.payloadRoot)
        let payload = try envelope.verify(publicKeyData: key.data)
        guard payload.purpose == "bootstrap",
              payload.keyEpoch == key.epoch,
              payload.signingTeamIdentifier == arguments.expectedTeamIdentifier,
              payload.installerCertificateSHA256 == arguments.installerCertificateSHA256,
              payload.packageSHA256 == packageDigest,
              payload.artifactSHA256 == packageDigest,
              payload.artifactByteCount == UInt64(packageSize),
              payload.manifestSHA256 == sha256(manifestData),
              payload.manifestByteCount == UInt64(manifestData.count)
        else {
            throw PreflightError.envelopeBindingMismatch
        }
        do {
            try HostOSVersionPolicy.validate(
                candidateMinimumOSVersion: payload.minimumOSVersion,
                hostProductVersion: try hostProductVersion()
            )
        } catch {
            throw PreflightError.hostCompatibilityMismatch
        }

        let manifest = try JSONDecoder().decode(ReleaseManifest.self, from: manifestData)
        try validateManifest(manifest, payload: payload)

        let app = arguments.payloadRoot + "/Applications/Recordings.app"
        let client = app + "/" + RecordingsUpdateConstants.updateClientRelativePath
        let broker = arguments.payloadRoot + "/Library/PrivilegedHelperTools/com.hasna.recordings.updater"
        let artifactVerifier = arguments.payloadRoot
            + "/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
        let marker = arguments.payloadRoot
            + "/Library/Application Support/Hasna/Recordings/Trust/bootstrap-marker.json"

        try requireDigest(client, expected: payload.updateClientSHA256)
        try requireDigest(broker, expected: payload.updateBrokerSHA256)
        try requireDigest(artifactVerifier, expected: payload.artifactVerifierSHA256)
        try requireDigest(marker, expected: payload.bootstrapMarkerSHA256)
        try validateStaticCode(
            path: app,
            requirementText: payload.applicationDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier,
            checkNestedCode: true
        )
        try validateStaticCode(
            path: client,
            requirementText: payload.updateClientDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        try requireArchitectures(client, expected: payload.architectures)
        try validateStaticCode(
            path: broker,
            requirementText: payload.updateBrokerDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        try validateStaticCode(
            path: artifactVerifier,
            requirementText: payload.artifactVerifierDesignatedRequirement,
            expectedTeam: payload.signingTeamIdentifier
        )
        try validateApplicationMetadata(app: app, manifest: manifest, payload: payload)
        let actualTreeDigest = try treeDigest(using: artifactVerifier, app: app)
        guard actualTreeDigest == payload.candidateTreeSHA256,
              actualTreeDigest == manifest.binding.bundleTreeSHA256
        else {
            throw PreflightError.applicationBindingMismatch
        }
        try validateBootstrapMarker(path: marker, payload: payload)

        if let statePath = arguments.releaseStatePath {
            try validateReleaseState(
                path: statePath,
                payload: payload,
                requireCommitted: arguments.requireCommittedState
            )
        } else if arguments.requireCommittedState {
            throw PreflightError.releaseStateMismatch
        }
    }

    private static func findSolePublicKey(payloadRoot: String) throws -> (epoch: UInt64, data: Data) {
        let directory = payloadRoot
            + "/Library/Application Support/Hasna/Recordings/Trust/envelope-keys"
        var metadata = stat()
        guard lstat(directory, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0
        else {
            throw PreflightError.unsafeInput
        }
        let entries = try FileManager.default.contentsOfDirectory(atPath: directory)
        guard entries.count == 1,
              entries[0].hasSuffix(".raw"),
              let epoch = UInt64(entries[0].dropLast(4)),
              epoch > 0
        else {
            throw PreflightError.publicKeyLayoutMismatch
        }
        let data = try readRegularFile(directory + "/" + entries[0], maximumBytes: 32)
        guard data.count == 32 else { throw PreflightError.publicKeyLayoutMismatch }
        return (epoch, data)
    }

    private static func validateManifest(
        _ manifest: ReleaseManifest,
        payload: ReleaseEnvelopePayload
    ) throws {
        guard manifest.schemaVersion == 4,
              manifest.artifactType == "recordings-macos-app",
              manifest.bundleIdentifier == "com.hasna.recordings",
              manifest.bundleVersion == payload.version,
              manifest.bundleBuildVersion == payload.build,
              manifest.sourceCommit == payload.sourceCommit,
              manifest.teamIdentifier == payload.signingTeamIdentifier,
              manifest.signing.teamIdentifier == payload.signingTeamIdentifier,
              manifest.signing.helperTeamIdentifier == payload.signingTeamIdentifier,
              manifest.architectures == payload.architectures,
              manifest.companion.architectures == payload.architectures,
              manifest.minimumMacOS == payload.minimumOSVersion,
              manifest.binding.bundleTreeSHA256 == payload.candidateTreeSHA256,
              sha256(Data(payload.applicationDesignatedRequirement.utf8))
                == manifest.signing.designatedRequirementSHA256,
              isLowerSHA256(manifest.applicationSHA256),
              isLowerSHA256(manifest.provenanceSHA256),
              isLowerSHA256(manifest.companion.sha256),
              isLowerSHA256(manifest.archive.sha256)
        else {
            throw PreflightError.manifestBindingMismatch
        }
    }

    private static func validateApplicationMetadata(
        app: String,
        manifest: ReleaseManifest,
        payload: ReleaseEnvelopePayload
    ) throws {
        let informationData = try readRegularFile(app + "/Contents/Info.plist", maximumBytes: 1024 * 1024)
        guard let information = try PropertyListSerialization.propertyList(
            from: informationData,
            options: [],
            format: nil
        ) as? [String: Any],
              information["CFBundleIdentifier"] as? String == manifest.bundleIdentifier,
              information["CFBundleShortVersionString"] as? String == payload.version,
              information["CFBundleVersion"] as? String == payload.build,
              information["LSMinimumSystemVersion"] as? String == payload.minimumOSVersion,
              let executableName = information["CFBundleExecutable"] as? String,
              executableName.range(
                of: #"^[A-Za-z0-9._-]{1,128}$"#,
                options: .regularExpression
              ) != nil
        else {
            throw PreflightError.applicationBindingMismatch
        }
        let executable = app + "/Contents/MacOS/" + executableName
        try requireDigest(executable, expected: manifest.applicationSHA256)
        try requireArchitectures(executable, expected: payload.architectures)
        let companion = app + "/Contents/Helpers/recordings"
        try requireDigest(companion, expected: manifest.companion.sha256)
        try requireArchitectures(companion, expected: payload.architectures)
        let provenance = app + "/Contents/Resources/recordings-build-provenance.json"
        try requireDigest(provenance, expected: manifest.provenanceSHA256)
    }

    private static func validateBootstrapMarker(
        path: String,
        payload: ReleaseEnvelopePayload
    ) throws {
        let data = try readRegularFile(path, maximumBytes: 1024 * 1024)
        let marker = try JSONDecoder().decode(BootstrapMarker.self, from: data)
        guard marker.schemaVersion == RecordingsUpdateConstants.protocolVersion,
              marker.keyEpoch == payload.keyEpoch,
              marker.releaseSequence == payload.releaseSequence,
              marker.releaseID == payload.releaseID,
              marker.version == payload.version,
              marker.sourceCommit == payload.sourceCommit,
              marker.signingTeamIdentifier == payload.signingTeamIdentifier,
              marker.appTreeSHA256 == payload.candidateTreeSHA256,
              marker.updateClientSHA256 == payload.updateClientSHA256,
              marker.updateBrokerSHA256 == payload.updateBrokerSHA256,
              marker.artifactVerifierSHA256 == payload.artifactVerifierSHA256,
              marker.lifecycle == RecordingsUpdateConstants.lifecycle,
              marker.rootMaintenanceSupported == RecordingsUpdateConstants.rootMaintenanceSupported,
              marker.keyRotationSupported == RecordingsUpdateConstants.keyRotationSupported
        else {
            throw PreflightError.bootstrapMarkerMismatch
        }
    }

    private static func validateReleaseState(
        path: String,
        payload: ReleaseEnvelopePayload,
        requireCommitted: Bool
    ) throws {
        let data = try readRegularFile(path, maximumBytes: 64 * 1024, requireOwnerOnly: true)
        let state = try JSONDecoder().decode(BootstrapReleaseState.self, from: data)
        let payloadDigest = sha256(try payload.canonicalData())
        guard state.schemaVersion == RecordingsUpdateConstants.protocolVersion,
              state.purpose == "bootstrap",
              (state.phase == "seen" || state.phase == "committed"),
              (!requireCommitted || state.phase == "committed"),
              state.keyEpoch == payload.keyEpoch,
              state.releaseSequence == payload.releaseSequence,
              state.releaseID == payload.releaseID,
              state.version == payload.version,
              state.build == payload.build,
              state.cohortPackageSHA256 == payload.packageSHA256,
              state.envelopePayloadSHA256 == payloadDigest
        else {
            throw PreflightError.releaseStateMismatch
        }
    }

    private static func validateStaticCode(
        path: String,
        requirementText: String,
        expectedTeam: String,
        checkNestedCode: Bool = false
    ) throws {
        var staticCode: SecStaticCode?
        let createStatus = SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode)
        guard createStatus == errSecSuccess, let staticCode else {
            throw PreflightError.codeIdentityRejected
        }
        var requirement: SecRequirement?
        let requirementStatus = SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
        guard requirementStatus == errSecSuccess, let requirement else {
            throw PreflightError.codeIdentityRejected
        }
        var rawFlags = kSecCSStrictValidate | kSecCSCheckAllArchitectures
        if checkNestedCode { rawFlags |= kSecCSCheckNestedCode }
        let validityStatus = SecStaticCodeCheckValidity(
            staticCode,
            SecCSFlags(rawValue: rawFlags),
            requirement
        )
        guard validityStatus == errSecSuccess else { throw PreflightError.codeIdentityRejected }
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
            throw PreflightError.codeIdentityRejected
        }
    }

    private static func treeDigest(using verifier: String, app: String) throws -> String {
        let result: BoundedProcessResult
        do {
            result = try BoundedProcessRunner.run(
                executablePath: verifier,
                arguments: ["tree-digest", "--path", app],
                environment: [
                    "HOME": "/var/empty",
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                    "TMPDIR": "/private/var/empty",
                    "LC_ALL": "C",
                    "LANG": "C",
                    "TZ": "UTC0",
                ],
                maximumOutputBytes: 4_096,
                timeout: 10
            )
        } catch {
            throw PreflightError.treeDigestFailed
        }
        guard result.exitedNormally,
              result.terminationStatus == 0,
              let value = String(data: result.standardOutput, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              isLowerSHA256(value)
        else {
            throw PreflightError.treeDigestFailed
        }
        return value
    }

    private static func requireArchitectures(_ path: String, expected: [String]) throws {
        let result: BoundedProcessResult
        do {
            result = try BoundedProcessRunner.run(
                executablePath: "/usr/bin/lipo",
                arguments: ["-archs", path],
                environment: [
                    "HOME": "/var/empty",
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                    "TMPDIR": "/private/var/empty",
                ],
                maximumOutputBytes: 4_096,
                timeout: 5
            )
        } catch {
            throw PreflightError.architectureMismatch
        }
        let actual = String(data: result.standardOutput, encoding: .utf8)?
            .split(whereSeparator: \.isWhitespace)
            .map(String.init) ?? []
        guard result.exitedNormally,
              result.terminationStatus == 0,
              !actual.isEmpty,
              Set(actual).count == actual.count,
              actual.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) == expected
        else {
            throw PreflightError.architectureMismatch
        }
    }

    private static func hostProductVersion() throws -> String {
        let result = try BoundedProcessRunner.run(
            executablePath: "/usr/bin/sw_vers",
            arguments: ["-productVersion"],
            environment: [
                "HOME": "/var/empty",
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": "/private/var/empty",
            ],
            maximumOutputBytes: 65,
            timeout: 2
        )
        guard result.exitedNormally,
              result.terminationStatus == 0,
              !result.standardOutput.isEmpty,
              result.standardOutput.count <= 65,
              let text = String(data: result.standardOutput, encoding: .utf8)
        else {
            throw PreflightError.hostCompatibilityMismatch
        }
        let value = text.hasSuffix("\n") ? String(text.dropLast()) : text
        guard !value.isEmpty,
              value.utf8.count <= 64,
              !value.contains(where: { $0.isWhitespace || $0.isNewline })
        else {
            throw PreflightError.hostCompatibilityMismatch
        }
        return value
    }

    private static func requireDigest(_ path: String, expected: String) throws {
        guard try sha256RegularFile(path, maximumBytes: 2 * 1024 * 1024 * 1024) == expected else {
            throw PreflightError.fileDigestMismatch
        }
    }

    private static func sha256RegularFile(_ path: String, maximumBytes: Int64) throws -> String {
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PreflightError.unsafeInput }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              before.st_uid == 0,
              (before.st_mode & 0o022) == 0,
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= maximumBytes
        else {
            throw PreflightError.unsafeInput
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
            guard count > 0 else { throw PreflightError.inputChanged }
            hasher.update(data: Data(buffer.prefix(count)))
            offset += off_t(count)
        }
        var extra: UInt8 = 0
        guard pread(descriptor, &extra, 1, before.st_size) == 0 else {
            throw PreflightError.inputChanged
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
            throw PreflightError.inputChanged
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func regularFileSize(_ path: String, maximumBytes: Int64) throws -> Int64 {
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PreflightError.unsafeInput }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0,
              metadata.st_nlink == 1,
              metadata.st_size > 0,
              metadata.st_size <= maximumBytes
        else {
            throw PreflightError.unsafeInput
        }
        return metadata.st_size
    }

    private static func readRegularFile(
        _ path: String,
        maximumBytes: Int64,
        requireOwnerOnly: Bool = false
    ) throws -> Data {
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PreflightError.unsafeInput }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              before.st_uid == 0,
              (before.st_mode & (requireOwnerOnly ? 0o077 : 0o022)) == 0,
              before.st_nlink == 1,
              before.st_size > 0,
              before.st_size <= maximumBytes
        else {
            throw PreflightError.unsafeInput
        }
        var data = Data(count: Int(before.st_size))
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
                guard count > 0 else { throw PreflightError.inputChanged }
                offset += off_t(count)
            }
        }
        var extra: UInt8 = 0
        guard pread(descriptor, &extra, 1, before.st_size) == 0 else {
            throw PreflightError.inputChanged
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
            throw PreflightError.inputChanged
        }
        return data
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isLowerSHA256(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func sanitized(_ error: Error) -> String {
        if let error = error as? PreflightError { return error.description }
        if let error = error as? ReleaseEnvelopeValidationError { return error.description }
        return "verification failed"
    }
}

private struct Arguments {
    let packagePath: String
    let manifestPath: String
    let envelopePath: String
    let payloadRoot: String
    let expectedTeamIdentifier: String
    let installerCertificateSHA256: String
    let releaseStatePath: String?
    let requireCommittedState: Bool

    static func parse(_ values: [String]) throws -> Arguments {
        var parsed: [String: String] = [:]
        var requireCommittedState = false
        var index = 1
        while index < values.count {
            if values[index] == "--require-committed-state" {
                guard !requireCommittedState else { throw PreflightError.usage }
                requireCommittedState = true
                index += 1
                continue
            }
            guard index + 1 < values.count,
                  values[index].hasPrefix("--"),
                  parsed[values[index]] == nil
            else {
                throw PreflightError.usage
            }
            parsed[values[index]] = values[index + 1]
            index += 2
        }
        let required = [
            "--package",
            "--manifest",
            "--envelope",
            "--payload-root",
            "--expected-team-id",
            "--installer-certificate-sha256",
        ]
        let requiredPaths = ["--package", "--manifest", "--envelope", "--payload-root"]
        guard required.allSatisfy({ parsed[$0] != nil }),
              requiredPaths.allSatisfy({ parsed[$0]?.hasPrefix("/") == true }),
              let packagePath = parsed["--package"],
              let manifestPath = parsed["--manifest"],
              let envelopePath = parsed["--envelope"],
              let payloadRoot = parsed["--payload-root"],
              let expectedTeamIdentifier = parsed["--expected-team-id"],
              let installerCertificateSHA256 = parsed["--installer-certificate-sha256"],
              expectedTeamIdentifier.range(
                of: "^[A-Z0-9]{10}$",
                options: .regularExpression
              ) != nil,
              installerCertificateSHA256.range(
                of: "^[a-f0-9]{64}$",
                options: .regularExpression
              ) != nil,
              Set(parsed.keys).isSubset(of: Set(required + ["--release-state"])),
              parsed["--release-state"] == nil || parsed["--release-state"]?.hasPrefix("/") == true
        else {
            throw PreflightError.usage
        }
        return Arguments(
            packagePath: packagePath,
            manifestPath: manifestPath,
            envelopePath: envelopePath,
            payloadRoot: payloadRoot,
            expectedTeamIdentifier: expectedTeamIdentifier,
            installerCertificateSHA256: installerCertificateSHA256,
            releaseStatePath: parsed["--release-state"],
            requireCommittedState: requireCommittedState
        )
    }
}

private struct ReleaseManifest: Codable {
    let schemaVersion: Int
    let artifactType: String
    let bundleIdentifier: String
    let bundleVersion: String
    let bundleBuildVersion: String
    let sourceCommit: String
    let architectures: [String]
    let teamIdentifier: String
    let minimumMacOS: String
    let applicationSHA256: String
    let binding: Binding
    let provenanceSHA256: String
    let signing: Signing
    let companion: Companion
    let archive: Archive

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case artifactType = "artifact_type"
        case bundleIdentifier = "bundle_id"
        case bundleVersion = "bundle_version"
        case bundleBuildVersion = "bundle_build_version"
        case sourceCommit = "git_sha"
        case architectures
        case teamIdentifier = "team_id"
        case minimumMacOS = "minimum_macos"
        case applicationSHA256 = "app_sha256"
        case binding
        case provenanceSHA256 = "provenance_sha256"
        case signing
        case companion
        case archive
    }

    struct Binding: Codable {
        let bundleTreeSHA256: String
        enum CodingKeys: String, CodingKey { case bundleTreeSHA256 = "bundle_tree_sha256" }
    }

    struct Signing: Codable {
        let teamIdentifier: String
        let helperTeamIdentifier: String
        let designatedRequirementSHA256: String
        enum CodingKeys: String, CodingKey {
            case teamIdentifier = "team_id"
            case helperTeamIdentifier = "helper_team_id"
            case designatedRequirementSHA256 = "designated_requirement_sha256"
        }
    }

    struct Companion: Codable {
        let sha256: String
        let architectures: [String]
    }

    struct Archive: Codable { let sha256: String }
}

private struct BootstrapMarker: Codable {
    let schemaVersion: Int
    let keyEpoch: UInt64
    let releaseSequence: UInt64
    let releaseID: String
    let version: String
    let sourceCommit: String
    let signingTeamIdentifier: String
    let appTreeSHA256: String
    let updateClientSHA256: String
    let updateBrokerSHA256: String
    let artifactVerifierSHA256: String
    let lifecycle: String
    let rootMaintenanceSupported: Bool
    let keyRotationSupported: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case keyEpoch = "key_epoch"
        case releaseSequence = "release_sequence"
        case releaseID = "release_id"
        case version
        case sourceCommit = "source_commit"
        case signingTeamIdentifier = "signing_team_identifier"
        case appTreeSHA256 = "app_tree_sha256"
        case updateClientSHA256 = "update_client_sha256"
        case updateBrokerSHA256 = "update_broker_sha256"
        case artifactVerifierSHA256 = "artifact_verifier_sha256"
        case lifecycle
        case rootMaintenanceSupported = "root_maintenance_supported"
        case keyRotationSupported = "key_rotation_supported"
    }
}

private struct BootstrapReleaseState: Codable {
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
    }
}

private enum PreflightError: Error, CustomStringConvertible {
    case usage
    case notRoot
    case unsafeInput
    case inputChanged
    case publicKeyLayoutMismatch
    case envelopeBindingMismatch
    case manifestBindingMismatch
    case fileDigestMismatch
    case codeIdentityRejected
    case architectureMismatch
    case hostCompatibilityMismatch
    case treeDigestFailed
    case applicationBindingMismatch
    case bootstrapMarkerMismatch
    case releaseStateMismatch

    var description: String {
        switch self {
        case .usage: "invalid arguments"
        case .notRoot: "preflight verification must run as root"
        case .unsafeInput: "an input is missing, mutable, linked, or otherwise unsafe"
        case .inputChanged: "an input changed while it was verified"
        case .publicKeyLayoutMismatch: "the package does not contain one exact bootstrap public key"
        case .envelopeBindingMismatch: "the signed bootstrap envelope does not bind the staged inputs"
        case .manifestBindingMismatch: "the signed bootstrap envelope and app manifest disagree"
        case .fileDigestMismatch: "a protected package component has the wrong digest"
        case .codeIdentityRejected: "a protected package component has the wrong code identity"
        case .architectureMismatch: "a protected package component has the wrong architectures"
        case .hostCompatibilityMismatch: "the live host does not satisfy the signed minimum macOS version"
        case .treeDigestFailed: "the packaged application tree could not be authenticated"
        case .applicationBindingMismatch: "the packaged application does not match the signed release"
        case .bootstrapMarkerMismatch: "the package bootstrap marker does not match the signed release"
        case .releaseStateMismatch: "the installed bootstrap state conflicts with the signed release"
        }
    }
}
