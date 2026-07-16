import AVFoundation
import Foundation
import Testing
@testable import RecordingsLib

/// A recorder that starts instantly and records when it was asked to. Lets the production
/// `startRecording` path run without microphone hardware or TCC grants.
private final class FakePCMRecorder: PCMRecordingSource, @unchecked Sendable {
    private let lock = NSLock()
    private var startedFlag = false

    var started: Bool {
        lock.withLock { startedFlag }
    }

    func start() throws {
        lock.withLock { startedFlag = true }
    }

    func stop() {}
}

@MainActor
private func makeStartableEngine(
    recorder: FakePCMRecorder,
    selectionCapture: @escaping @Sendable (pid_t) -> AccessibilitySelectionToken?
) -> RecordingEngine {
    let engine = RecordingEngine()
    engine.openAIAPIKeyProvider = { "" }
    engine.microphoneAuthorization = { .authorized }
    engine.accessibilityTrustCheck = { true }
    engine.protectedOperationTrust = { AccessibilityTrustResult(trusted: true, didPrompt: false) }
    engine.frontmostAppSnapshot = {
        FrontmostAppSnapshot(pid: 99_999, bundleIdentifier: "com.example.editor", launchDate: Date())
    }
    engine.recorderFactory = { _ in recorder }
    engine.selectionCapture = selectionCapture
    engine.focusedWindowTitleLookup = { _ in nil }
    engine.pasteInterceptorForTesting = { _, _, _ in }
    return engine
}

@MainActor
private func waitUntil(
    timeout: TimeInterval = 5,
    _ condition: @MainActor () -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

@MainActor
struct RecordingStartTimingTests {
    @Test("the recorder starts on keydown even while the AX selection capture is blocked")
    func recorderStartDoesNotWaitOnSelectionCapture() {
        let captureGate = DispatchSemaphore(value: 0)
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder) { _ in
            // Simulates a beachballing target app: the capture IPC hangs far longer than
            // any acceptable start budget.
            captureGate.wait()
            return nil
        }

        // `startRecording` runs synchronously on the MainActor through recorder start.
        // With the pre-fix ordering (capture before recorder start, on the MainActor) this
        // call would block on the semaphore and the test would time out; with the fixed
        // ordering the recorder is live before the capture has produced anything.
        engine.startRecording(trigger: .manual)
        #expect(recorder.started, "recorder must start while AX capture is still pending")
        #expect(engine.isRecording)
        #expect(engine.flowPhase == .listening)

        captureGate.signal()
        engine.cancelRecording()
        #expect(engine.flowPhase == .idle)
    }

    @Test("stopping waits for the generation-bound start context instead of dropping the frozen target")
    func stopAwaitsFrozenStartContext() async {
        let captureGate = DispatchSemaphore(value: 0)
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder) { _ in
            captureGate.wait()
            return AccessibilitySelectionToken.unsafeTestToken(selectedText: "frozen words")
        }

        engine.startRecording(trigger: .manual)
        #expect(engine.isRecording)
        engine.stopAndTranscribe()
        #expect(engine.isTranscribing)

        // The pipeline must hold in finalizing while the frozen context is unresolved —
        // it may not deliver without the selection frozen at start.
        try? await Task.sleep(for: .milliseconds(150))
        #expect(engine.flowPhase == .finalizing)

        captureGate.signal()
        // No audio was produced by the fake recorder, so the pipeline ends in the
        // fail-closed no-audio state — importantly, only after the context resolved.
        #expect(await waitUntil {
            if case .failed = engine.flowPhase { return true }
            return false
        })
        #expect(engine.statusMessage == "No audio captured")
        #expect(engine.canStartRecording)
    }

    @Test("a released key before the capture resolves still cancels cleanly")
    func cancelDuringPendingCapture() {
        let captureGate = DispatchSemaphore(value: 0)
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder) { _ in
            captureGate.wait()
            return nil
        }
        engine.startRecording(trigger: .manual)
        #expect(engine.isRecording)
        engine.cancelRecording()
        #expect(!engine.isRecording)
        #expect(engine.flowPhase == .idle)
        captureGate.signal()
        #expect(engine.canStartRecording)
    }
}
