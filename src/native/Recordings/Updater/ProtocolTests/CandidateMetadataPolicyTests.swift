import Testing
@testable import RecordingsUpdateProtocol

struct CandidateMetadataPolicyTests {
    @Test("exact release application and provenance metadata are admitted")
    func exactMetadataIsAdmitted() throws {
        try validate()
    }

    @Test("bundle identifier and executable mismatches are rejected")
    func applicationIdentityMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.applicationIdentifierMismatch) {
            try validate(applicationIdentifier: "com.example.other")
        }
        #expect(throws: CandidateMetadataPolicyError.applicationExecutableMismatch) {
            try validate(executable: "Other")
        }
    }

    @Test("application and provenance version mismatches are rejected")
    func versionMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.applicationVersionMismatch) {
            try validate(applicationVersion: "0.2.12")
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceVersionMismatch) {
            try validate(provenanceVersion: "0.2.12")
        }
    }

    @Test("application and provenance build mismatches are rejected")
    func buildMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.applicationBuildMismatch) {
            try validate(applicationBuild: "0.2.12")
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceBuildMismatch) {
            try validate(provenanceBuild: "0.2.12")
        }
    }

    @Test("provenance source and Team ID mismatches are rejected")
    func provenanceIdentityMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.provenanceSourceMismatch) {
            try validate(sourceCommit: String(repeating: "b", count: 40))
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceTeamMismatch) {
            try validate(teamIdentifier: "OTHERTE123")
        }
    }

    @Test("application and provenance minimum OS mismatches are rejected")
    func minimumOSMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.applicationMinimumOSMismatch) {
            try validate(applicationMinimumOS: "25.0")
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceMinimumOSMismatch) {
            try validate(provenanceMinimumOS: "25.0")
        }
    }

    @Test("actual, provenance, and companion architecture mismatches are rejected")
    func architectureMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.applicationArchitectureMismatch) {
            try validate(applicationArchitectures: ["arm64"])
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceArchitectureMismatch) {
            try validate(provenanceArchitectures: ["arm64"])
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceArchitectureMismatch) {
            try validate(companionArchitectures: ["arm64"])
        }
        #expect(throws: CandidateMetadataPolicyError.companionArchitectureMismatch) {
            try validate(actualCompanionArchitectures: ["arm64"])
        }
    }

    @Test("update client must contain exactly the signed universal architectures")
    func updateClientArchitectureMismatchIsRejected() {
        for architectures in [
            ["arm64"],
            ["x86_64"],
            [],
            ["arm64", "x86_64", "i386"],
        ] {
            #expect(throws: CandidateMetadataPolicyError.updateClientArchitectureMismatch) {
                try validate(actualUpdateClientArchitectures: architectures)
            }
        }
    }

    @Test("measured companion digest and signed companion release version are bound")
    func companionIdentityMismatchIsRejected() {
        #expect(throws: CandidateMetadataPolicyError.companionDigestMismatch) {
            try validate(actualCompanionSHA256: String(repeating: "c", count: 64))
        }
        #expect(throws: CandidateMetadataPolicyError.provenanceCompanionVersionMismatch) {
            try validate(companionVersion: "0.2.12")
        }
    }

    @Test("local-only provenance fields are rejected from release candidates")
    func localOnlyFieldsAreRejected() {
        #expect(throws: CandidateMetadataPolicyError.localOnlyProvenanceRejected) {
            try validate(containsLocalOnlyFields: true)
        }
    }

    private func validate(
        applicationIdentifier: String = "com.hasna.recordings",
        applicationVersion: String = "0.2.13",
        applicationBuild: String = "0.2.13",
        executable: String = "Recordings",
        applicationMinimumOS: String = "26.0",
        applicationArchitectures: [String] = ["arm64", "x86_64"],
        actualUpdateClientArchitectures: [String] = ["arm64", "x86_64"],
        provenanceVersion: String = "0.2.13",
        provenanceBuild: String = "0.2.13",
        sourceCommit: String = String(repeating: "a", count: 40),
        teamIdentifier: String = "EXAMPLE123",
        provenanceMinimumOS: String = "26.0",
        provenanceArchitectures: [String] = ["arm64", "x86_64"],
        actualCompanionSHA256: String = String(repeating: "d", count: 64),
        actualCompanionArchitectures: [String] = ["arm64", "x86_64"],
        companionVersion: String = "0.2.13",
        companionSHA256: String = String(repeating: "d", count: 64),
        companionArchitectures: [String] = ["arm64", "x86_64"],
        containsLocalOnlyFields: Bool = false
    ) throws {
        try CandidateMetadataPolicy.validate(
            application: CandidateApplicationMetadata(
                bundleIdentifier: applicationIdentifier,
                shortVersion: applicationVersion,
                buildVersion: applicationBuild,
                executable: executable,
                minimumOSVersion: applicationMinimumOS,
                architectures: applicationArchitectures
            ),
            updateClientArchitectures: actualUpdateClientArchitectures,
            companion: CandidateCompanionMetadata(
                sha256: actualCompanionSHA256,
                architectures: actualCompanionArchitectures
            ),
            provenance: CandidateBuildProvenanceMetadata(
                schemaVersion: 4,
                containsLocalOnlyFields: containsLocalOnlyFields,
                bundleIdentifier: "com.hasna.recordings",
                bundleVersion: provenanceVersion,
                bundleBuildVersion: provenanceBuild,
                sourceCommit: sourceCommit,
                teamIdentifier: teamIdentifier,
                minimumMacOS: provenanceMinimumOS,
                architectures: provenanceArchitectures,
                companionVersion: companionVersion,
                companionSHA256: companionSHA256,
                companionArchitectures: companionArchitectures
            ),
            expected: CandidateReleaseMetadataExpectation(
                applicationIdentifier: "com.hasna.recordings",
                applicationExecutable: "Recordings",
                version: "0.2.13",
                build: "0.2.13",
                sourceCommit: String(repeating: "a", count: 40),
                signingTeamIdentifier: "EXAMPLE123",
                minimumOSVersion: "26.0",
                architectures: ["arm64", "x86_64"]
            )
        )
    }
}
