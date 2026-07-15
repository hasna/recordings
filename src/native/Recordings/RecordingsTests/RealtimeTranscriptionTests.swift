import Testing
import Foundation
@testable import RecordingsLib

@MainActor
private final class FakeRealtimeClock {
    var nowMilliseconds: UInt64 = 0

    func advance(by milliseconds: UInt64) {
        nowMilliseconds += milliseconds
    }
}

@MainActor
private final class RealtimeDeliveryProbe {
    var deliveredText: String?
    var persistedResult: RealtimeFastPathSaveResult?
}

private actor BlockingRealtimePersistence {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func run() async -> RealtimeFastPathSaveResult {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if !released {
            await withCheckedContinuation { releaseWaiters.append($0) }
        }
        return RealtimeFastPathSaveResult(text: "stored text", error: nil)
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func hasStarted() -> Bool {
        started
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor BlockingRealtimeDelivery {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func run() async {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if !released {
            await withCheckedContinuation { releaseWaiters.append($0) }
        }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

// MARK: - RealtimeTranscriptionClient Event Parsing Tests

struct RealtimeTranscriptionTests {
    @Test("Model ID is set to low-latency realtime transcription model")
    func modelID() {
        #expect(RealtimeTranscriptionClient.sessionModelID == "gpt-realtime")
        #expect(RealtimeTranscriptionClient.transcriptionModelID == "gpt-realtime-whisper")
        #expect(RealtimeTranscriptionClient.modelID == "gpt-realtime-whisper")
        #expect(RealtimeTranscriptionClient.transcriptionDelay == "low")
    }

    @Test("Parses transcription delta events")
    func parseDelta() {
        let deltaJSON = """
        {"type":"conversation.item.input_audio_transcription.delta","delta":"Hello "}
        """
        #expect(RealtimeTranscriptionClient.parseDeltaTestHelper(deltaJSON) == "Hello ")
    }

    @Test("Parses transcription completed event")
    func parseCompleted() {
        let completedJSON = """
        {"type":"conversation.item.input_audio_transcription.completed","transcript":"Hello world"}
        """
        #expect(RealtimeTranscriptionClient.parseDeltaTestHelper(completedJSON) == "Hello world")
    }

    @Test("Returns nil for non-transcription events")
    func ignoreOtherEvents() {
        let sessionJSON = """
        {"type":"session.created","session":{"id":"abc"}}
        """
        #expect(RealtimeTranscriptionClient.parseDeltaTestHelper(sessionJSON) == nil)
    }

    @Test("Returns nil for malformed JSON")
    func malformedJSON() {
        #expect(RealtimeTranscriptionClient.parseDeltaTestHelper("not json") == nil)
    }

    @Test("Returns nil for empty delta")
    func emptyDelta() {
        let emptyJSON = """
        {"type":"conversation.item.input_audio_transcription.delta","delta":""}
        """
        // Empty string delta is still valid — client should handle it
        #expect(RealtimeTranscriptionClient.parseDeltaTestHelper(emptyJSON) == "")
    }

    @Test("Detects error events")
    func detectError() {
        let errorJSON = """
        {"type":"error","error":{"message":"Invalid API key","code":401}}
        """
        #expect(RealtimeTranscriptionClient.isSessionErrorTestHelper(errorJSON) == true)
    }

    @Test("Does not flag normal events as errors")
    func noFalsePositives() {
        #expect(RealtimeTranscriptionClient.isSessionErrorTestHelper(
            "{\"type\":\"conversation.item.input_audio_transcription.delta\"}"
        ) == false)
    }

    @Test("Parse error message from error event")
    func parseErrorMessage() {
        let errorJSON = """
        {"type":"error","error":{"message":"Model not found","code":404}}
        """
        #expect(RealtimeTranscriptionClient.parseErrorTestHelper(errorJSON) == "Model not found")
    }

    @Test("Realtime error parsing redacts credentials before returning display-safe text")
    func parseErrorMessageRedactsCredentials() throws {
        let keyFragment = "sk-" + "synthetic-fragment-123456"
        let bearerFragment = "synthetic-bearer-123456"
        let tokenFragment = "synthetic-query-token-123456"
        let message = "401 Incorrect API key provided: \(keyFragment); Authorization: Bearer \(bearerFragment); request?token=\(tokenFragment)"
        let event: [String: Any] = ["type": "error", "error": ["message": message, "code": 401]]
        let data = try JSONSerialization.data(withJSONObject: event)
        let json = try #require(String(data: data, encoding: .utf8))

        let parsed = try #require(RealtimeTranscriptionClient.parseErrorTestHelper(json))

        #expect(!parsed.contains(keyFragment))
        #expect(!parsed.contains(bearerFragment))
        #expect(!parsed.contains(tokenFragment))
        #expect(parsed.contains("401 Incorrect API key provided"))
    }

    @Test("Realtime error events store only sanitized state and preserve ordinary errors")
    @MainActor
    func errorEventStateIsSanitized() throws {
        let keyFragment = "sk-" + "synthetic-state-fragment-123456"
        let event: [String: Any] = [
            "type": "conversation.item.input_audio_transcription.failed",
            "error": ["message": "401 rejected \(keyFragment)"],
        ]
        let data = try JSONSerialization.data(withJSONObject: event)
        let json = try #require(String(data: data, encoding: .utf8))
        let client = RealtimeTranscriptionClient(apiKey: "synthetic-test-value", homePath: "/tmp")

        client.handleEventTestHelper(json)

        #expect(client.error == "401 rejected [REDACTED]")
        #expect(RealtimeTranscriptionClient.parseErrorTestHelper(
            #"{"type":"error","error":{"message":"Model not found"}}"#
        ) == "Model not found")
    }

    @Test("Builds strict verbatim prompt with vocabulary context")
    func buildPrompt() {
        let prompt = RealtimeTranscriptionClient.buildPromptTestHelper("Alumia, Takumi")
        #expect(prompt.contains("verbatim"))
        #expect(prompt.contains("Do not summarize"))
        #expect(prompt.contains("vocabulary context"))
        #expect(prompt.contains("Alumia"))
    }

    @Test("Builds realtime transcription session update event")
    func buildSessionUpdateEvent() {
        let event = RealtimeTranscriptionClient.sessionUpdateTestHelper(prompt: "Use Alumia as vocabulary", language: "en")
        #expect(event["type"] as? String == "session.update")

        let session = event["session"] as? [String: Any]
        #expect(session?["type"] as? String == "transcription")

        let audio = session?["audio"] as? [String: Any]
        let input = audio?["input"] as? [String: Any]
        let format = input?["format"] as? [String: Any]
        #expect(format?["type"] as? String == "audio/pcm")
        #expect(format?["rate"] as? Int == 24_000)

        let transcription = input?["transcription"] as? [String: Any]
        #expect(transcription?["model"] as? String == "gpt-realtime-whisper")
        #expect(transcription?["delay"] as? String == "low")
        #expect(transcription?["prompt"] as? String == nil)
        #expect(transcription?["language"] as? String == "en")

        #expect(input?["turn_detection"] is NSNull)

        let include = session?["include"] as? [String]
        #expect(include == nil)
    }

    @Test("Joins transcript parts without dropping spoken text")
    func joinParts() {
        let text = RealtimeTranscriptionClient.joinTranscriptPartsTestHelper(["Hello", "world.", " Next"])
        #expect(text == "Hello world. Next")
    }

    @Test("Manual commit waits for enough buffered PCM audio")
    func manualCommitThreshold() {
        #expect(RealtimeTranscriptionClient.shouldManuallyCommitTestHelper(uncommittedAudioBytes: 4_799) == false)
        #expect(RealtimeTranscriptionClient.shouldManuallyCommitTestHelper(uncommittedAudioBytes: 5_760) == true)
    }

    @Test("Realtime finish waits for the exact final item and every prior item")
    func exactFinalItemSettlementHandlesOutOfOrderCompletion() {
        var tracker = RealtimeCommitSettlementTracker()
        tracker.queueCommit(isFinal: false)
        tracker.queueCommit(isFinal: true)
        tracker.complete(itemID: "item-final")
        tracker.acknowledge(itemID: "item-prior")
        tracker.acknowledge(itemID: "item-final")
        #expect(tracker.resolution(uncommittedRealAudioBytes: 0) == .waiting)

        tracker.complete(itemID: "item-prior")
        #expect(tracker.finalItemID == "item-final")
        #expect(tracker.resolution(uncommittedRealAudioBytes: 1) == .waiting)
        #expect(tracker.resolution(uncommittedRealAudioBytes: 0) == .settled)
    }

    @Test("Commit settlement handles duplicate acknowledgements, prior failure, and periodic reuse")
    func commitSettlementEdgeCases() {
        var tracker = RealtimeCommitSettlementTracker()
        let priorSequence = tracker.queueCommit(isFinal: false)
        let finalSequence = tracker.queueCommit(isFinal: false)
        #expect(tracker.acknowledge(itemID: "item-prior")?.sequence == priorSequence)
        #expect(tracker.acknowledge(itemID: "item-prior")?.sequence == priorSequence)
        #expect(tracker.acknowledge(itemID: "item-final")?.sequence == finalSequence)
        let didMarkLatestCommitFinal = tracker.markLatestCommitFinal()
        #expect(didMarkLatestCommitFinal)
        #expect(tracker.finalItemID == "item-final")

        tracker.complete(itemID: "item-final")
        tracker.fail(itemID: "item-prior")
        #expect(tracker.resolution(uncommittedRealAudioBytes: 0) == .failed)
    }

    @Test("A final completion at 690 ms settles without a batch fallback")
    @MainActor
    func finalCompletionNearDeadlineUsesFastPath() async {
        var tracker = RealtimeCommitSettlementTracker()
        tracker.queueCommit(isFinal: true)
        let clock = FakeRealtimeClock()

        let waitResult = await RealtimeTranscriptionClient.waitForSettlementTestHelper(
            timeoutMilliseconds: 700,
            resolution: {
                tracker.resolution(uncommittedRealAudioBytes: 0)
            },
            nowMilliseconds: {
                clock.nowMilliseconds
            },
            sleepMilliseconds: { milliseconds in
                clock.advance(by: milliseconds)
                if clock.nowMilliseconds == 10 {
                    tracker.acknowledge(itemID: "item-final")
                }
                if clock.nowMilliseconds >= 690 {
                    tracker.complete(itemID: "item-final")
                }
            }
        )

        #expect(waitResult.resolution == .settled)
        #expect(waitResult.elapsedMilliseconds == 690)
        let finishResult = RealtimeFinishResult(text: "final words", settled: true, error: nil)
        #expect(RecordingEngine.settledRealtimeFastPathTranscript(
            finishResult: finishResult,
            pcmByteCount: 12_000,
            language: "en"
        ) == "final words")
    }

    @Test("A sub-threshold final PCM tail is retained and padded only for realtime commit")
    func subThresholdFinalTailIsPadded() {
        let storedPCM = Data((0..<1_280).map { UInt8($0 % 251) })
        let storedCopy = storedPCM
        let plan = RealtimeTranscriptionClient.finalCommitPlanTestHelper(
            realAudioByteCount: storedPCM.count
        )

        #expect(plan.realAudioByteCount == 1_280)
        #expect(plan.paddingByteCount == 4_480)
        #expect(plan.committedAudioByteCount == 5_760)
        #expect(plan.realtimePadding.count == 4_480)
        #expect(plan.realtimePadding.allSatisfy { $0 == 0 })
        #expect(storedPCM == storedCopy)
        #expect(RealtimeTranscriptionClient.finalCommitPlanTestHelper(
            realAudioByteCount: 5_759
        ).paddingByteCount == 1)
        #expect(RealtimeTranscriptionClient.finalCommitPlanTestHelper(
            realAudioByteCount: 5_760
        ).paddingByteCount == 0)
        #expect(RealtimeTranscriptionClient.finalCommitPlanTestHelper(
            realAudioByteCount: 0
        ).committedAudioByteCount == 0)
    }

    @Test("Failed and unacknowledged final items require batch fallback without partial paste")
    func incompleteFinalItemsRejectFastPath() {
        var failedTracker = RealtimeCommitSettlementTracker()
        failedTracker.queueCommit(isFinal: true)
        failedTracker.acknowledge(itemID: "item-final")
        failedTracker.fail(itemID: "item-final")
        failedTracker.complete(itemID: "item-final")
        #expect(failedTracker.resolution(uncommittedRealAudioBytes: 0) == .failed)

        var unacknowledgedTracker = RealtimeCommitSettlementTracker()
        unacknowledgedTracker.queueCommit(isFinal: true)
        unacknowledgedTracker.complete(itemID: "unbound-completion")
        #expect(unacknowledgedTracker.resolution(uncommittedRealAudioBytes: 0) == .waiting)

        let partialResult = RealtimeFinishResult(text: "optimistic partial", settled: false, error: nil)
        #expect(RecordingEngine.settledRealtimeFastPathTranscript(
            finishResult: partialResult,
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
        #expect(RecordingEngine.settledRealtimeFallbackTranscript(
            finishResult: partialResult,
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)

        let settledPartialResult = RealtimeFinishResult(text: "Hi", settled: true, error: nil)
        #expect(RecordingEngine.settledRealtimeFallbackTranscript(
            finishResult: settledPartialResult,
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
    }

    @Test("Disabled transformation pastes before blocked persistence completes")
    @MainActor
    func blockedPersistenceDoesNotDelayPaste() async {
        let delivery = BlockingRealtimeDelivery()
        let persistence = BlockingRealtimePersistence()
        let probe = RealtimeDeliveryProbe()

        let persistenceTask = RecordingEngine.deliverRealtimeBeforePersistence(
            text: "settled realtime text",
            persist: { await persistence.run() },
            deliver: {
                probe.deliveredText = $0
                await delivery.run()
            },
            persistenceCompleted: { probe.persistedResult = $0 }
        )

        #expect(probe.persistedResult?.text == nil)
        await delivery.waitUntilStarted()
        #expect(await persistence.hasStarted() == false)
        await delivery.release()
        await persistence.waitUntilStarted()
        #expect(probe.deliveredText == "settled realtime text")

        await persistence.release()
        await persistenceTask.value
        #expect(probe.persistedResult?.text == "stored text")
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            recordingMode: .pushToTalk,
            postProcessingMode: PostProcessingMode.off.rawValue
        ))
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            recordingMode: .command,
            postProcessingMode: PostProcessingMode.off.rawValue
        ) == false)
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            recordingMode: .pushToTalk,
            postProcessingMode: PostProcessingMode.always.rawValue
        ) == false)
        #expect(RecordingEngine.shouldLabelRewriting(
            recordingMode: .pushToTalk,
            postProcessingMode: PostProcessingMode.always.rawValue
        ))
        #expect(RecordingEngine.shouldLabelRewriting(
            recordingMode: .pushToTalk,
            postProcessingMode: PostProcessingMode.auto.rawValue
        ))
        #expect(RecordingEngine.shouldLabelRewriting(
            recordingMode: .pushToTalk,
            postProcessingMode: PostProcessingMode.off.rawValue
        ) == false)
    }

    @Test("Partial realtime text falls back for longer recordings")
    func partialRealtimeFallback() {
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 96_000) == true)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "This is a complete sentence.", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 12_000) == false)
    }

    @Test("Realtime fast path accepts safe text and rejects lexical cleanup")
    func realtimeFastPathDecision() {
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "  this is a useful transcript  ", pcmByteCount: 96_000))
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "Hi", pcmByteCount: 12_000))
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "Hi", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "   ", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "Actually 리수 Zoom your goal",
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "어 Okay I don't know if this This is working어 Okay I don't know if this This is working",
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "Actually Zoom your goal",
            pcmByteCount: 96_000,
            language: "en"
        ) == "Actually Zoom your goal")
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "리수 度扫 開けたの 어",
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
    }

    @Test("Realtime artifact cleanup removes duplicated chunks and filler tokens")
    func realtimeArtifactCleanup() {
        let cleaned = RecordingEngine.cleanRealtimeArtifactText(
            "어 Okay I don't know if this This is working어 Okay I don't know if this This is working"
        )
        #expect(cleaned == "Okay I don't know if this is working")
    }

    @Test("Realtime artifact cleanup preserves mixed-language lexical tokens")
    func realtimeMixedLanguageCleanup() {
        let cleaned = RecordingEngine.cleanRealtimeArtifactText(
            "Actually 리수 Zoom your goal and do this work with sabi 度扫 agents actually"
        )
        #expect(cleaned == "Actually 리수 Zoom your goal and do this work with sabi 度扫 agents actually")
    }
}
