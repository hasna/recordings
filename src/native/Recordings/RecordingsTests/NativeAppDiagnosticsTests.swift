import Foundation
import Testing
@testable import RecordingsLib

struct NativeAppDiagnosticsTests {
    @Test("Native app log writes to recordings log file")
    func logWritesFile() throws {
        let home = try makeHome()

        NativeAppLog.write("diagnostic-test", homePath: home)

        let path = "\(home)/.hasna/recordings/Recordings.log"
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(text.contains("diagnostic-test"))
    }

    @Test("Native app log redacts credentials before persistence")
    func logRedactsCredentials() throws {
        let home = try makeHome()
        let keyFragment = "sk-" + "synthetic-log-fragment-123456"
        let bearerFragment = "synthetic-log-bearer-123456"
        let tokenFragment = "synthetic-log-token-123456"

        NativeAppLog.write(
            "request failed key=\(keyFragment) Authorization: Bearer \(bearerFragment) endpoint?api_key=\(tokenFragment)",
            homePath: home
        )

        let path = "\(home)/.hasna/recordings/Recordings.log"
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(!text.contains(keyFragment))
        #expect(!text.contains(bearerFragment))
        #expect(!text.contains(tokenFragment))
        #expect(text.contains("[REDACTED]"))
    }

    private func makeHome() throws -> String {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-diagnostics-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.path
    }
}
