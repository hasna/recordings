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

    @Test("paste target does not choose arbitrary apps without a captured or frontmost target")
    func noArbitraryFallback() {
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

        #expect(selected == nil)
    }

    @Test("paste target prefers the frontmost app over an arbitrary regular app")
    func prefersFrontmostFallback() {
        let candidates = [
            PasteTargetCandidate(pid: 5, bundleIdentifier: "com.background", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil,
            frontmostPid: 30
        )

        #expect(selected?.pid == 30)
    }

    @Test("paste target never selects the recorder app even when frontmost")
    func skipsOwnAppWhenFrontmost() {
        let candidates = [
            PasteTargetCandidate(pid: 99, bundleIdentifier: "com.hasna.recordings", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil,
            frontmostPid: 99
        )

        #expect(selected == nil)
    }

    @Test("captured pid wins over frontmost fallback")
    func capturedPidBeatsFrontmost() {
        let candidates = [
            PasteTargetCandidate(pid: 10, bundleIdentifier: "com.editor", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: 10,
            frontmostPid: 30
        )

        #expect(selected?.pid == 10)
    }
}
