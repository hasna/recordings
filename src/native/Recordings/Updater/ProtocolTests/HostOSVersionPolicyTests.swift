import Testing
@testable import RecordingsUpdateProtocol

struct HostOSVersionPolicyTests {
    @Test("equal minimum and host versions are admitted")
    func equalVersionIsAdmitted() throws {
        try HostOSVersionPolicy.validate(
            candidateMinimumOSVersion: "26.0",
            hostProductVersion: "26.0.0"
        )
    }

    @Test("an older minimum OS is admitted on a newer host using numeric semantics")
    func olderMinimumIsAdmitted() throws {
        try HostOSVersionPolicy.validate(
            candidateMinimumOSVersion: "15.9.12",
            hostProductVersion: "15.10"
        )
    }

    @Test("a newer minimum OS is rejected")
    func newerMinimumIsRejected() {
        #expect(throws: HostOSVersionPolicyError.candidateRequiresNewerOS) {
            try HostOSVersionPolicy.validate(
                candidateMinimumOSVersion: "26.1",
                hostProductVersion: "26.0.9"
            )
        }
    }

    @Test("malformed host ProductVersion evidence is rejected")
    func malformedHostEvidenceIsRejected() {
        for value in ["", "26", "26.beta", "26.0.0.1", "026.0", "26..1"] {
            #expect(throws: HostOSVersionPolicyError.malformedHostProductVersion) {
                try HostOSVersionPolicy.validate(
                    candidateMinimumOSVersion: "26.0",
                    hostProductVersion: value
                )
            }
        }
    }

    @Test("malformed signed minimum OS evidence is rejected")
    func malformedCandidateEvidenceIsRejected() {
        #expect(throws: HostOSVersionPolicyError.malformedCandidateMinimumOSVersion) {
            try HostOSVersionPolicy.validate(
                candidateMinimumOSVersion: "26.beta",
                hostProductVersion: "26.0"
            )
        }
    }

    @Test("unavailable host ProductVersion evidence is rejected")
    func unavailableHostEvidenceIsRejected() {
        #expect(throws: HostOSVersionPolicyError.hostProductVersionUnavailable) {
            try HostOSVersionPolicy.validate(
                candidateMinimumOSVersion: "26.0",
                hostProductVersion: nil
            )
        }
    }
}
