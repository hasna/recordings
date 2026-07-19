import Foundation

public struct CandidateReleaseMetadataExpectation: Equatable, Sendable {
    public let applicationIdentifier: String
    public let applicationExecutable: String
    public let version: String
    public let build: String
    public let sourceCommit: String
    public let signingTeamIdentifier: String
    public let minimumOSVersion: String
    public let architectures: [String]

    public init(
        applicationIdentifier: String,
        applicationExecutable: String,
        version: String,
        build: String,
        sourceCommit: String,
        signingTeamIdentifier: String,
        minimumOSVersion: String,
        architectures: [String]
    ) {
        self.applicationIdentifier = applicationIdentifier
        self.applicationExecutable = applicationExecutable
        self.version = version
        self.build = build
        self.sourceCommit = sourceCommit
        self.signingTeamIdentifier = signingTeamIdentifier
        self.minimumOSVersion = minimumOSVersion
        self.architectures = architectures
    }
}

public struct CandidateApplicationMetadata: Equatable, Sendable {
    public let bundleIdentifier: String
    public let shortVersion: String
    public let buildVersion: String
    public let executable: String
    public let minimumOSVersion: String
    public let architectures: [String]

    public init(
        bundleIdentifier: String,
        shortVersion: String,
        buildVersion: String,
        executable: String,
        minimumOSVersion: String,
        architectures: [String]
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.shortVersion = shortVersion
        self.buildVersion = buildVersion
        self.executable = executable
        self.minimumOSVersion = minimumOSVersion
        self.architectures = architectures
    }
}

public struct CandidateCompanionMetadata: Equatable, Sendable {
    public let sha256: String
    public let architectures: [String]

    public init(sha256: String, architectures: [String]) {
        self.sha256 = sha256
        self.architectures = architectures
    }
}

public struct CandidateBuildProvenanceMetadata: Equatable, Sendable {
    public let schemaVersion: Int
    public let containsLocalOnlyFields: Bool
    public let bundleIdentifier: String
    public let bundleVersion: String
    public let bundleBuildVersion: String
    public let sourceCommit: String
    public let teamIdentifier: String
    public let minimumMacOS: String
    public let architectures: [String]
    public let companionVersion: String
    public let companionSHA256: String
    public let companionArchitectures: [String]

    public init(
        schemaVersion: Int,
        containsLocalOnlyFields: Bool,
        bundleIdentifier: String,
        bundleVersion: String,
        bundleBuildVersion: String,
        sourceCommit: String,
        teamIdentifier: String,
        minimumMacOS: String,
        architectures: [String],
        companionVersion: String,
        companionSHA256: String,
        companionArchitectures: [String]
    ) {
        self.schemaVersion = schemaVersion
        self.containsLocalOnlyFields = containsLocalOnlyFields
        self.bundleIdentifier = bundleIdentifier
        self.bundleVersion = bundleVersion
        self.bundleBuildVersion = bundleBuildVersion
        self.sourceCommit = sourceCommit
        self.teamIdentifier = teamIdentifier
        self.minimumMacOS = minimumMacOS
        self.architectures = architectures
        self.companionVersion = companionVersion
        self.companionSHA256 = companionSHA256
        self.companionArchitectures = companionArchitectures
    }
}

public enum CandidateMetadataPolicyError: Error, Equatable, Sendable {
    case applicationIdentifierMismatch
    case applicationVersionMismatch
    case applicationBuildMismatch
    case applicationExecutableMismatch
    case applicationMinimumOSMismatch
    case applicationArchitectureMismatch
    case updateClientArchitectureMismatch
    case companionDigestMismatch
    case companionArchitectureMismatch
    case provenanceSchemaMismatch
    case localOnlyProvenanceRejected
    case provenanceIdentifierMismatch
    case provenanceVersionMismatch
    case provenanceBuildMismatch
    case provenanceSourceMismatch
    case provenanceTeamMismatch
    case provenanceMinimumOSMismatch
    case provenanceArchitectureMismatch
    case provenanceCompanionVersionMismatch
}

/// Pure equality policy between candidate metadata and a verified release envelope.
///
/// Parsing, ownership, and file-stability checks remain at the broker I/O boundary.
/// This policy runs before the broker enters monotonic state handling, so every
/// semantic value used to identify a release must exactly equal signed evidence.
public enum CandidateMetadataPolicy {
    public static func validate(
        application: CandidateApplicationMetadata,
        updateClientArchitectures: [String],
        companion: CandidateCompanionMetadata,
        provenance: CandidateBuildProvenanceMetadata,
        expected: CandidateReleaseMetadataExpectation
    ) throws {
        guard application.bundleIdentifier == expected.applicationIdentifier else {
            throw CandidateMetadataPolicyError.applicationIdentifierMismatch
        }
        guard application.shortVersion == expected.version else {
            throw CandidateMetadataPolicyError.applicationVersionMismatch
        }
        guard application.buildVersion == expected.build else {
            throw CandidateMetadataPolicyError.applicationBuildMismatch
        }
        guard application.executable == expected.applicationExecutable else {
            throw CandidateMetadataPolicyError.applicationExecutableMismatch
        }
        guard application.minimumOSVersion == expected.minimumOSVersion else {
            throw CandidateMetadataPolicyError.applicationMinimumOSMismatch
        }
        guard application.architectures == expected.architectures else {
            throw CandidateMetadataPolicyError.applicationArchitectureMismatch
        }
        guard updateClientArchitectures == expected.architectures else {
            throw CandidateMetadataPolicyError.updateClientArchitectureMismatch
        }
        guard companion.architectures == expected.architectures else {
            throw CandidateMetadataPolicyError.companionArchitectureMismatch
        }
        guard companion.sha256 == provenance.companionSHA256 else {
            throw CandidateMetadataPolicyError.companionDigestMismatch
        }

        guard provenance.schemaVersion == 4 else {
            throw CandidateMetadataPolicyError.provenanceSchemaMismatch
        }
        guard !provenance.containsLocalOnlyFields else {
            throw CandidateMetadataPolicyError.localOnlyProvenanceRejected
        }
        guard provenance.bundleIdentifier == expected.applicationIdentifier else {
            throw CandidateMetadataPolicyError.provenanceIdentifierMismatch
        }
        guard provenance.bundleVersion == expected.version else {
            throw CandidateMetadataPolicyError.provenanceVersionMismatch
        }
        guard provenance.bundleBuildVersion == expected.build else {
            throw CandidateMetadataPolicyError.provenanceBuildMismatch
        }
        guard provenance.sourceCommit == expected.sourceCommit else {
            throw CandidateMetadataPolicyError.provenanceSourceMismatch
        }
        guard provenance.teamIdentifier == expected.signingTeamIdentifier else {
            throw CandidateMetadataPolicyError.provenanceTeamMismatch
        }
        guard provenance.minimumMacOS == expected.minimumOSVersion else {
            throw CandidateMetadataPolicyError.provenanceMinimumOSMismatch
        }
        // The release build contract requires the packaged companion's --version
        // to equal the app release version before signing. At update time the
        // broker binds that signed semantic assertion to the measured companion
        // digest without executing candidate code as root.
        guard provenance.companionVersion == provenance.bundleVersion,
              provenance.companionVersion == expected.version
        else {
            throw CandidateMetadataPolicyError.provenanceCompanionVersionMismatch
        }
        guard provenance.architectures == expected.architectures,
              provenance.companionArchitectures == expected.architectures
        else {
            throw CandidateMetadataPolicyError.provenanceArchitectureMismatch
        }
    }
}
