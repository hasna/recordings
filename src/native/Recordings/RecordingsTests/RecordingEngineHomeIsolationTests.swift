import Foundation
import Testing
@testable import RecordingsLib

/// Locks the `homePath` seam that keeps a test run out of the operator's real
/// `~/.hasna/recordings`. `RecordingEngine.init` already creates the audio spool and logs
/// before it returns, so the seam is only worth anything if it is honoured that early —
/// these tests assert against artifacts `init` itself produced.
@MainActor
struct RecordingEngineHomeIsolationTests {
    @Test("init writes its log line and audio spool under the injected home, not the real one")
    func initArtifactsLandUnderInjectedHome() throws {
        let home = makeIsolatedTestHome("home-isolation")

        let engine = RecordingEngine(homePath: home)

        #expect(engine.home == home)
        #expect(FileManager.default.fileExists(atPath: "\(home)/.hasna/recordings/audio"))

        // Reading the line back proves the seam reaches NativeAppLog rather than merely
        // being stored: an unthreaded `home` would leave this file absent here and append
        // to the real log instead.
        let logged = try String(
            contentsOfFile: "\(home)/.hasna/recordings/Recordings.log",
            encoding: .utf8
        )
        #expect(logged.contains("RecordingEngine init"))
    }

    @Test("every log write the engine makes is addressed to the injected home")
    func engineLogWritesStayUnderInjectedHome() throws {
        let first = makeIsolatedTestHome("home-isolation-first")
        let second = makeIsolatedTestHome("home-isolation-second")

        _ = RecordingEngine(homePath: first)
        _ = RecordingEngine(homePath: second)

        // Two engines with two homes must not cross-write. A shared or process-global home
        // would put both init lines in one file and leave the other empty or missing.
        for home in [first, second] {
            let logged = try String(
                contentsOfFile: "\(home)/.hasna/recordings/Recordings.log",
                encoding: .utf8
            )
            #expect(logged.components(separatedBy: "RecordingEngine init").count - 1 == 1)
        }
    }

    /// The engine is not the only type that roots itself at the live home. `VoiceShortcuts`
    /// persists `voice-shortcuts.json` the same way, so a test that adds a shortcut used to
    /// rewrite the operator's real file. Ported from the same seam work; the structural half of
    /// this rule is enforced in `src/__tests__/native-test-log-isolation-contract.test.ts`,
    /// which — unlike this file — can actually run without a Swift toolchain.
    @Test("voice shortcuts persist under the injected home, not the live one")
    func voiceShortcutsPersistUnderInjectedHome() throws {
        let home = makeIsolatedTestHome("home-isolation-shortcuts")

        let shortcuts = VoiceShortcuts(homePath: home)
        shortcuts.add(trigger: "containment probe", content: "written to a temp home")

        let text = try String(
            contentsOfFile: "\(home)/.hasna/recordings/voice-shortcuts.json",
            encoding: .utf8
        )
        #expect(text.contains("containment probe"))
    }
}
