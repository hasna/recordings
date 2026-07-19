import Foundation
import Testing
@testable import RecordingsUpdateProtocol

struct ReleaseEnvelopeValidationTests {
    @Test("macOS numeric dotted bundle builds are accepted")
    func numericDottedBundleBuildIsAccepted() throws {
        try payload(build: "0.2.13").validate(
            now: fixedDate("2026-07-19T12:00:00.000Z"),
            brokerVersion: "1.0.0"
        )
    }

    @Test("nonnumeric bundle build components are rejected")
    func nonnumericBundleBuildIsRejected() {
        #expect(throws: ReleaseEnvelopeValidationError.self) {
            try payload(build: "0.2.beta").validate(
                now: fixedDate("2026-07-19T12:00:00.000Z"),
                brokerVersion: "1.0.0"
            )
        }
    }

    private func payload(build: String) -> ReleaseEnvelopePayload {
        ReleaseEnvelopePayload(
            schemaVersion: RecordingsUpdateConstants.protocolVersion,
            purpose: "update",
            keyEpoch: 1,
            releaseSequence: 2,
            releaseID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            version: "0.2.13",
            build: build,
            sourceCommit: String(repeating: "a", count: 40),
            artifactSHA256: String(repeating: "b", count: 64),
            artifactByteCount: 1024,
            manifestSHA256: String(repeating: "c", count: 64),
            manifestByteCount: 512,
            candidateTreeSHA256: String(repeating: "d", count: 64),
            packageSHA256: String(repeating: "e", count: 64),
            updateClientSHA256: String(repeating: "f", count: 64),
            updateBrokerSHA256: String(repeating: "1", count: 64),
            artifactVerifierSHA256: String(repeating: "2", count: 64),
            bootstrapMarkerSHA256: String(repeating: "3", count: 64),
            architectures: ["arm64", "x86_64"],
            minimumOSVersion: "26.0",
            minimumBrokerVersion: "1.0.0",
            signingTeamIdentifier: "EXAMPLE123",
            applicationDesignatedRequirement: "identifier \"com.hasna.recordings\"",
            updateClientDesignatedRequirement:
                "identifier \"com.hasna.recordings.update-client\"",
            updateBrokerDesignatedRequirement: "identifier \"com.hasna.recordings.updater\"",
            artifactVerifierDesignatedRequirement:
                "identifier \"com.hasna.recordings.artifact-verifier\"",
            installerCertificateSHA256: String(repeating: "4", count: 64),
            issuedAtUTC: "2026-07-19T00:00:00.000Z",
            expiresAtUTC: "2026-07-20T00:00:00.000Z"
        )
    }

    private func fixedDate(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }
}
