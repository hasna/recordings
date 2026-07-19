import CryptoKit
import Foundation

public struct ReleaseEnvelopePayload: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let purpose: String
    public let keyEpoch: UInt64
    public let releaseSequence: UInt64
    public let releaseID: String
    public let version: String
    public let build: String
    public let sourceCommit: String
    public let artifactSHA256: String
    public let artifactByteCount: UInt64
    public let manifestSHA256: String
    public let manifestByteCount: UInt64
    public let candidateTreeSHA256: String
    public let packageSHA256: String
    public let updateClientSHA256: String
    public let updateBrokerSHA256: String
    public let artifactVerifierSHA256: String
    public let bootstrapMarkerSHA256: String
    public let architectures: [String]
    public let minimumOSVersion: String
    public let minimumBrokerVersion: String
    public let signingTeamIdentifier: String
    public let applicationDesignatedRequirement: String
    public let updateClientDesignatedRequirement: String
    public let updateBrokerDesignatedRequirement: String
    public let artifactVerifierDesignatedRequirement: String
    public let installerCertificateSHA256: String
    public let issuedAtUTC: String
    public let expiresAtUTC: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case purpose
        case keyEpoch = "key_epoch"
        case releaseSequence = "release_sequence"
        case releaseID = "release_id"
        case version
        case build
        case sourceCommit = "source_commit"
        case artifactSHA256 = "artifact_sha256"
        case artifactByteCount = "artifact_byte_count"
        case manifestSHA256 = "manifest_sha256"
        case manifestByteCount = "manifest_byte_count"
        case candidateTreeSHA256 = "candidate_tree_sha256"
        case packageSHA256 = "package_sha256"
        case updateClientSHA256 = "update_client_sha256"
        case updateBrokerSHA256 = "update_broker_sha256"
        case artifactVerifierSHA256 = "artifact_verifier_sha256"
        case bootstrapMarkerSHA256 = "bootstrap_marker_sha256"
        case architectures
        case minimumOSVersion = "minimum_os_version"
        case minimumBrokerVersion = "minimum_broker_version"
        case signingTeamIdentifier = "signing_team_identifier"
        case applicationDesignatedRequirement = "application_designated_requirement"
        case updateClientDesignatedRequirement = "update_client_designated_requirement"
        case updateBrokerDesignatedRequirement = "update_broker_designated_requirement"
        case artifactVerifierDesignatedRequirement = "artifact_verifier_designated_requirement"
        case installerCertificateSHA256 = "installer_certificate_sha256"
        case issuedAtUTC = "issued_at_utc"
        case expiresAtUTC = "expires_at_utc"
    }

    public func canonicalData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public func validate(now: Date = Date(), brokerVersion: String = RecordingsUpdateConstants.brokerVersion) throws {
        guard schemaVersion == RecordingsUpdateConstants.protocolVersion else {
            throw ReleaseEnvelopeValidationError.unsupportedSchema
        }
        guard purpose == "bootstrap" || purpose == "update" else {
            throw ReleaseEnvelopeValidationError.invalidField("purpose")
        }
        guard keyEpoch > 0, releaseSequence > 0 else {
            throw ReleaseEnvelopeValidationError.invalidField("release_epoch_or_sequence")
        }
        guard UUID(uuidString: releaseID) != nil else {
            throw ReleaseEnvelopeValidationError.invalidField("release_id")
        }
        guard Self.isVersion(version), Self.isBuild(build), Self.isVersion(minimumBrokerVersion) else {
            throw ReleaseEnvelopeValidationError.invalidField("version")
        }
        guard Self.isLowerHex(sourceCommit, count: 40) else {
            throw ReleaseEnvelopeValidationError.invalidField("source_commit")
        }
        for (name, value) in [
            ("artifact_sha256", artifactSHA256),
            ("manifest_sha256", manifestSHA256),
            ("candidate_tree_sha256", candidateTreeSHA256),
            ("package_sha256", packageSHA256),
            ("update_client_sha256", updateClientSHA256),
            ("update_broker_sha256", updateBrokerSHA256),
            ("artifact_verifier_sha256", artifactVerifierSHA256),
            ("bootstrap_marker_sha256", bootstrapMarkerSHA256),
            ("installer_certificate_sha256", installerCertificateSHA256),
        ] where !Self.isLowerHex(value, count: 64) {
            throw ReleaseEnvelopeValidationError.invalidField(name)
        }
        guard purpose != "bootstrap" || artifactSHA256 == packageSHA256 else {
            throw ReleaseEnvelopeValidationError.invalidField("package_sha256")
        }
        guard artifactByteCount > 0,
              artifactByteCount <= 2 * 1024 * 1024 * 1024,
              manifestByteCount > 0,
              manifestByteCount <= 16 * 1024 * 1024
        else {
            throw ReleaseEnvelopeValidationError.invalidField("release_input_size")
        }
        guard architectures == ["arm64", "x86_64"] else {
            throw ReleaseEnvelopeValidationError.invalidField("architectures")
        }
        guard HostOSVersionPolicy.isValidNumericVersion(minimumOSVersion) else {
            throw ReleaseEnvelopeValidationError.invalidField("minimum_os_version")
        }
        guard signingTeamIdentifier.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil else {
            throw ReleaseEnvelopeValidationError.invalidField("signing_team_identifier")
        }
        for (name, value) in [
            ("application_designated_requirement", applicationDesignatedRequirement),
            ("update_client_designated_requirement", updateClientDesignatedRequirement),
            ("update_broker_designated_requirement", updateBrokerDesignatedRequirement),
            ("artifact_verifier_designated_requirement", artifactVerifierDesignatedRequirement),
        ] where value.isEmpty || value.utf8.count > 8_192 {
            throw ReleaseEnvelopeValidationError.invalidField(name)
        }
        guard Self.compareVersions(brokerVersion, minimumBrokerVersion) >= 0 else {
            throw ReleaseEnvelopeValidationError.brokerTooOld
        }
        guard let issued = Self.parseTimestamp(issuedAtUTC), let expires = Self.parseTimestamp(expiresAtUTC) else {
            throw ReleaseEnvelopeValidationError.invalidField("release_timestamp")
        }
        guard issued <= expires, now >= issued.addingTimeInterval(-300), now <= expires else {
            throw ReleaseEnvelopeValidationError.expiredOrNotYetValid
        }
        guard expires.timeIntervalSince(issued) <= 31 * 24 * 60 * 60 else {
            throw ReleaseEnvelopeValidationError.invalidField("release_validity_window")
        }
    }

    private static func isLowerHex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.range(of: "^[a-f0-9]{\(count)}$", options: .regularExpression) != nil
    }

    private static func isVersion(_ value: String) -> Bool {
        value.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil
    }

    private static func isBuild(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 32 else { return false }
        return value.range(
            of: #"^[0-9]+(?:\.[0-9]+){0,2}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func compareVersions(_ lhs: String, _ rhs: String) -> Int {
        let left = lhs.split(separator: "-", maxSplits: 1)[0].split(separator: ".").compactMap { Int($0) }
        let right = rhs.split(separator: "-", maxSplits: 1)[0].split(separator: ".").compactMap { Int($0) }
        guard left.count == 3, right.count == 3 else { return -1 }
        for index in 0..<3 where left[index] != right[index] {
            return left[index] < right[index] ? -1 : 1
        }
        return 0
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

public struct SignedReleaseEnvelope: Codable, Sendable {
    public let payload: ReleaseEnvelopePayload
    public let signature: String

    public init(payload: ReleaseEnvelopePayload, signature: String) {
        self.payload = payload
        self.signature = signature
    }

    public func verify(publicKeyData: Data, now: Date = Date()) throws -> ReleaseEnvelopePayload {
        try payload.validate(now: now)
        guard publicKeyData.count == 32 else {
            throw ReleaseEnvelopeValidationError.invalidPublicKey
        }
        guard let signatureData = Data(base64Encoded: signature), signatureData.count == 64 else {
            throw ReleaseEnvelopeValidationError.invalidSignatureEncoding
        }
        let publicKey: Curve25519.Signing.PublicKey
        do {
            publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        } catch {
            throw ReleaseEnvelopeValidationError.invalidPublicKey
        }
        guard publicKey.isValidSignature(signatureData, for: try payload.canonicalData()) else {
            throw ReleaseEnvelopeValidationError.invalidSignature
        }
        return payload
    }
}

public enum ReleaseEnvelopeValidationError: Error, CustomStringConvertible {
    case unsupportedSchema
    case invalidField(String)
    case brokerTooOld
    case expiredOrNotYetValid
    case invalidPublicKey
    case invalidSignatureEncoding
    case invalidSignature

    public var description: String {
        switch self {
        case .unsupportedSchema: "Unsupported release-envelope schema"
        case let .invalidField(name): "Invalid release-envelope field: \(name)"
        case .brokerTooOld: "The installed update broker is too old for this release"
        case .expiredOrNotYetValid: "The release envelope is expired or not yet valid"
        case .invalidPublicKey: "The pinned release-envelope public key is invalid"
        case .invalidSignatureEncoding: "The release-envelope signature encoding is invalid"
        case .invalidSignature: "The release-envelope signature is invalid"
        }
    }
}
