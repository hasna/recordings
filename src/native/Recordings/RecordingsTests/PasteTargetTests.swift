import Testing
@testable import RecordingsLib

struct PasteTargetTests {
    @Test("paste target prefers captured process id over bundle fallback")
    func prefersCapturedPid() {
        let candidates = [
            PasteTargetCandidate(pid: 10, bundleIdentifier: "com.editor", isRegularApp: true),
            PasteTargetCandidate(pid: 20, bundleIdentifier: "com.editor", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20
        )

        #expect(selected?.pid == 20)
    }

    @Test("paste target ignores current app when falling back")
    func ignoresCurrentApp() {
        let candidates = [
            PasteTargetCandidate(pid: 99, bundleIdentifier: "com.hasna.recordings", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil
        )

        #expect(selected?.pid == 30)
    }
}
