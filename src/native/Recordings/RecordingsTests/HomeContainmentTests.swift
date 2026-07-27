import Foundation
import Testing
@testable import RecordingsLib

/// Guards the containment seam that keeps a test run out of the live user's data directory.
///
/// On 2026-07-27 a suite run appended 132 lines to the owner's `~/.hasna/recordings/Recordings.log`
/// while he was using the app, including a false
/// `RecordingEngine init; microphone=Microphone not requested; accessibility=Accessibility needed`
/// line in a log being used as the forensic record of a live incident. The cause was a home that
/// resolved itself at the property rather than being injected, so a default-constructed engine
/// logged to the real home.
///
/// Two assertions, deliberately of different kinds: the behavioural ones prove the seam actually
/// redirects writes, and the structural one fails if any test reintroduces a construction that
/// falls back to the live home. The structural check exists because the live-home default cannot
/// be removed outright — the app target legitimately depends on it — so nothing in the type system
/// prevents the regression.
@MainActor
struct HomeContainmentTests {
    /// Types in `RecordingsLib` whose no-argument construction resolves the live user home.
    /// Adding one here is what makes the structural guard cover it.
    private static let homeResolvingTypes = ["RecordingEngine", "VoiceShortcuts", "ProjectStore"]

    @Test("engine construction logs into the injected home, not the live one")
    func engineInitLogLandsInInjectedHome() throws {
        let home = makeTestHome("containment")

        let engine = RecordingEngine(home: home)

        // The parameter must be what the engine actually stores — every logging and
        // persistence path reads it back off the instance.
        #expect(engine.home == home)
        let log = "\(home)/.hasna/recordings/Recordings.log"
        let text = try String(contentsOfFile: log, encoding: .utf8)
        // The exact line that polluted the production log.
        #expect(text.contains("RecordingEngine init"))
    }

    @Test("engine construction creates its audio directory under the injected home")
    func engineAudioDirectoryLandsInInjectedHome() {
        let home = makeTestHome("containment-audio")

        _ = RecordingEngine(home: home)

        #expect(FileManager.default.fileExists(atPath: "\(home)/.hasna/recordings/audio"))
    }

    @Test("voice shortcuts persist under the injected home, not the live one")
    func voiceShortcutsPersistUnderInjectedHome() throws {
        let home = makeTestHome("containment-shortcuts")

        let shortcuts = VoiceShortcuts(home: home)
        shortcuts.add(trigger: "containment probe", content: "written to a temp home")

        let path = "\(home)/.hasna/recordings/voice-shortcuts.json"
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(text.contains("containment probe"))
    }

    @Test("no test constructs a home-resolving type without injecting a home")
    func testTargetNeverConstructsHomeResolvingTypesWithoutAHome() throws {
        // `#filePath` is the build machine's source path, so this requires the suite to run
        // where it was built — true for this package, which builds and tests on the same Mac.
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".swift") }
        // A guard that silently scans nothing is the failure mode this package keeps hitting.
        #expect(names.count > 1)

        var offenders: [String] = []
        for name in names.sorted() {
            let text = try String(
                contentsOf: directory.appendingPathComponent(name),
                encoding: .utf8
            )
            for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                for type in Self.homeResolvingTypes where line.contains("\(type)()") {
                    offenders.append("\(name):\(index + 1) \(type) constructed with no home")
                }
            }
        }

        #expect(offenders.isEmpty, "\(offenders.joined(separator: "; "))")
    }
}
