import AVFoundation
import Foundation
import Testing
@testable import RecordingsLib

/// A recorder that starts instantly and records when it was asked to, and that can deliver its
/// first PCM callback on demand. Lets the production `startRecording` path run without
/// microphone hardware or TCC grants, including the warm-up window between `start()` returning
/// and the first sample arriving.
private final class FakePCMRecorder: PCMRecordingSource, @unchecked Sendable {
    private let lock = NSLock()
    private var startedFlag = false
    private var stoppedFlag = false
    private var onPCM: (@Sendable (Data) -> Void)?

    var started: Bool {
        lock.withLock { startedFlag }
    }

    /// Whether `stop()` was called. The microphone staying open is the worst outcome of a
    /// botched teardown — it lights the macOS in-use indicator — so every abandon test asserts
    /// this.
    var isStopped: Bool {
        lock.withLock { stoppedFlag }
    }

    func attach(onPCM: @escaping @Sendable (Data) -> Void) {
        lock.withLock { self.onPCM = onPCM }
    }

    /// Delivers the recorder's first callback the way a real `AVAudioEngine` tap does, roughly
    /// 100 ms after `start()` has already returned.
    ///
    /// `bytes: 0` is a deliberate test seam: it drives the engine's first-chunk promotion —
    /// which is what the ordering tests below are about — while leaving the stream pipe empty,
    /// so the pipeline still ends in the deterministic no-audio state instead of writing a WAV
    /// and shelling out to the CLI. `PCMStreamPipe` skips empty chunks, and the production
    /// recorder never emits one.
    func emitFirstChunk(bytes: Int = 0) {
        let callback = lock.withLock { onPCM }
        callback?(Data(repeating: 0, count: bytes))
    }

    func start() throws {
        lock.withLock { startedFlag = true }
    }

    func stop() {
        lock.withLock { stoppedFlag = true }
    }
}

@MainActor
private func makeStartableEngine(
    recorder: FakePCMRecorder,
    selectionCapture: @escaping @Sendable (pid_t) -> AccessibilitySelectionToken? = { _ in nil }
) -> RecordingEngine {
    let engine = RecordingEngine(homePath: makeIsolatedTestHome("start-timing-tests"))
    engine.openAIAPIKeyProvider = { "" }
    engine.microphoneAuthorization = { .authorized }
    engine.accessibilityTrustCheck = { true }
    engine.protectedOperationTrust = { AccessibilityTrustResult(trusted: true, didPrompt: false) }
    engine.frontmostAppSnapshot = {
        FrontmostAppSnapshot(pid: 99_999, bundleIdentifier: "com.example.editor", launchDate: Date())
    }
    engine.recorderFactory = { onPCM in
        recorder.attach(onPCM: onPCM)
        return recorder
    }
    engine.selectionCapture = selectionCapture
    engine.focusedWindowTitleLookup = { _ in nil }
    engine.pasteInterceptorForTesting = { _, _, _ in }
    engine.commandCLI = { _, _, _ in "ERROR: command CLI must not run in this test" }
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

/// Drives the capture to live the way the recorder does, and waits for the MainActor hop that
/// promotes it.
@MainActor
private func confirmCapture(_ engine: RecordingEngine, _ recorder: FakePCMRecorder) async -> Bool {
    recorder.emitFirstChunk()
    return await waitUntil { engine.isRecording }
}

/// Full teardown checklist for an abandoned attempt. Kept in one place because a partial
/// assertion here is indistinguishable from a pass: an abandon that forgets `recorder.stop()`
/// leaves the microphone open with the macOS indicator lit, and one that forgets
/// `isWarmingUpCapture = false` wedges the engine so the start gate refuses every later press.
@MainActor
private func expectFullyTornDown(
    _ engine: RecordingEngine,
    _ recorder: FakePCMRecorder,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    #expect(recorder.isStopped, "the microphone must be released, not left open", sourceLocation: sourceLocation)
    #expect(!engine.isWarmingUpCapture, "a warming flag left set wedges the start gate", sourceLocation: sourceLocation)
    #expect(!engine.isRecording, sourceLocation: sourceLocation)
    #expect(!engine.captureIsActive, sourceLocation: sourceLocation)
    #expect(!engine.isTranscribing, "an empty buffer must never enter the transcription pipeline", sourceLocation: sourceLocation)
    #expect(engine.canStartRecording, "the engine must be immediately ready to try again", sourceLocation: sourceLocation)
}

/// The disclosure an empty attempt owes the user. Asserted on `blockedReason` rather than
/// `statusMessage` alone: only `blockedReason` reaches the always-visible menu-bar glyph, and
/// `statusMessage` is rewritten on every return to idle.
@MainActor
private func expectEmptyAttemptDisclosed(
    _ engine: RecordingEngine,
    _ alert: RecordingAttemptAlert,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    #expect(engine.blockedReason == alert.message, "the outcome must reach the always-on surface", sourceLocation: sourceLocation)
    #expect(engine.statusMessage == alert.message, sourceLocation: sourceLocation)
    #expect(engine.canStartRecording, "a disclosure must not disable Start", sourceLocation: sourceLocation)
}

@MainActor
struct RecordingStartTimingTests {
    @Test("the recorder starts on keydown even while the AX selection capture is blocked")
    func recorderStartDoesNotWaitOnSelectionCapture() async {
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
        #expect(engine.isWarmingUpCapture, "start() returning is warm-up, not captured audio")
        #expect(engine.captureIsActive)
        #expect(engine.flowPhase == .listening)

        #expect(await confirmCapture(engine, recorder))
        #expect(!engine.isWarmingUpCapture)

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
        #expect(await confirmCapture(engine, recorder))
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
    func cancelDuringPendingCapture() async {
        let captureGate = DispatchSemaphore(value: 0)
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder) { _ in
            captureGate.wait()
            return nil
        }
        engine.startRecording(trigger: .manual)
        #expect(await confirmCapture(engine, recorder))
        engine.cancelRecording()
        #expect(!engine.isRecording)
        #expect(engine.flowPhase == .idle)
        captureGate.signal()
        #expect(engine.canStartRecording)
    }
}

/// The defect this suite exists for: `recorder.start()` returns roughly 100 ms before the
/// microphone delivers a sample, so a trigger released inside that window captured nothing at
/// all. The engine already had the right branch for it — "released before recording started;
/// cancelling pending start" — and it was simply unreachable, because `isRecording` flipped on
/// `start()` returning. A 539 ms hold on the owner's machine missed the branch by 20 ms and ran
/// the whole transcription pipeline over an empty buffer, silently.
@MainActor
struct RecordingCaptureWarmUpTests {
    @Test("a trigger released between recorder start and the first PCM chunk cancels instead of transcribing")
    func releaseDuringWarmUpCancelsInsteadOfTranscribing() {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .fnKey)
        #expect(recorder.started)
        #expect(engine.isWarmingUpCapture)
        #expect(!engine.isRecording, "no audio has arrived, so nothing is being recorded yet")

        engine.handleTriggerRelease(.fnKey)

        expectFullyTornDown(engine, recorder)
        expectEmptyAttemptDisclosed(engine, .releasedBeforeAudio)
    }

    @Test("the configurable shortcut takes the same path as fn")
    func releaseDuringWarmUpCancelsForTheKeyboardShortcut() {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .keyboardShortcut)
        #expect(engine.isWarmingUpCapture)
        engine.handleTriggerRelease(.keyboardShortcut)

        expectFullyTornDown(engine, recorder)
        expectEmptyAttemptDisclosed(engine, .releasedBeforeAudio)
    }

    @Test("a release after the first PCM chunk transcribes as before")
    func releaseAfterFirstChunkTranscribes() async {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .fnKey)
        #expect(await confirmCapture(engine, recorder))
        #expect(!engine.isWarmingUpCapture)

        engine.handleTriggerRelease(.fnKey)
        #expect(engine.isTranscribing, "audio existed, so the pipeline must run")
        #expect(engine.blockedReason == nil, "a recording that captured audio discloses nothing")
    }

    @Test("a PCM chunk that lands after the attempt was abandoned cannot resurrect it")
    func lateChunkCannotResurrectAnAbandonedAttempt() async {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .fnKey)
        engine.handleTriggerRelease(.fnKey)
        expectFullyTornDown(engine, recorder)

        // The recorder's delivery queue can still hand over a buffer that was in flight when
        // the tap was torn down.
        recorder.emitFirstChunk()
        try? await Task.sleep(for: .milliseconds(150))

        expectFullyTornDown(engine, recorder)
    }

    @Test("Stop clicked during warm-up abandons instead of transcribing silence")
    func stopDuringWarmUpAbandons() {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .manual)
        #expect(engine.isWarmingUpCapture)
        engine.stopAndTranscribe()

        expectFullyTornDown(engine, recorder)
        expectEmptyAttemptDisclosed(engine, .releasedBeforeAudio)
    }

    @Test("Discard during warm-up tears down without raising an alert the user does not need")
    func discardDuringWarmUpIsSilent() {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .manual)
        engine.cancelRecording()

        expectFullyTornDown(engine, recorder)
        #expect(engine.blockedReason == nil, "the user asked for the discard; do not alarm them")
        #expect(engine.flowPhase == .idle)
        #expect(engine.statusMessage == "Ready")
    }

    @Test("warm-up blocks a second start, and a new start clears the previous alert")
    func warmUpBlocksASecondStartAndANewStartClearsTheAlert() {
        let recorder = FakePCMRecorder()
        let engine = makeStartableEngine(recorder: recorder)

        engine.startRecording(trigger: .manual)
        #expect(engine.isWarmingUpCapture)
        #expect(!engine.canStartRecording, "the surface must not offer Start during warm-up")
        #expect(!RecordingEngine.canBeginRecording(
            isRecording: false,
            isTranscribing: false,
            isWarmingUpCapture: true
        ))

        // `.manual` has no key to release; Stop is the only way out of a warming manual start.
        engine.stopAndTranscribe()
        expectEmptyAttemptDisclosed(engine, .releasedBeforeAudio)

        engine.startRecording(trigger: .manual)
        #expect(engine.blockedReason == nil, "a live recording must not sit under a stale disclosure")
    }
}
