import Foundation
import Testing
@testable import RecordingsUpdateProtocol

struct BoundedProcessRunnerTests {
    @Test("captures small successful output exactly")
    func capturesSmallOutput() throws {
        let result = try BoundedProcessRunner.run(
            executablePath: "/bin/sh",
            arguments: ["-c", "printf '26.0.1\\n'"],
            environment: [:],
            maximumOutputBytes: 64,
            timeout: 1
        )
        #expect(result.exitedNormally)
        #expect(result.terminationStatus == 0)
        #expect(result.standardOutput == Data("26.0.1\n".utf8))
    }

    @Test("rejects output at the first byte beyond the configured limit")
    func rejectsOversizedOutput() {
        #expect(throws: BoundedProcessError.outputTooLarge) {
            _ = try BoundedProcessRunner.run(
                executablePath: "/bin/sh",
                arguments: ["-c", "printf '12345'"],
                environment: [:],
                maximumOutputBytes: 4,
                timeout: 1
            )
        }
    }

    @Test("kills a subprocess that exceeds its deadline")
    func rejectsTimedOutProcess() {
        #expect(throws: BoundedProcessError.timedOut) {
            _ = try BoundedProcessRunner.run(
                executablePath: "/bin/sh",
                arguments: ["-c", "exec /bin/sleep 5"],
                environment: [:],
                maximumOutputBytes: 64,
                timeout: 0.05
            )
        }
    }

    @Test("deadline is not extended by a descendant retaining stdout")
    func rejectsInheritedPipeDescendant() {
        let startedAt = Date()
        #expect(throws: BoundedProcessError.timedOut) {
            _ = try BoundedProcessRunner.run(
                executablePath: "/bin/sh",
                arguments: ["-c", "(/bin/sleep 2; printf inherited) & exit 0"],
                environment: [:],
                maximumOutputBytes: 64,
                timeout: 0.05
            )
        }
        #expect(Date().timeIntervalSince(startedAt) < 1)
    }
}
