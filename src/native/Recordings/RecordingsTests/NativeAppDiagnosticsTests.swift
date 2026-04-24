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

    private func makeHome() throws -> String {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-diagnostics-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.path
    }
}
