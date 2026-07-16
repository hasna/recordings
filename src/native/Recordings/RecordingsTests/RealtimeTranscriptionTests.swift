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
    private let result: RealtimeFastPathSaveResult
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: RealtimeFastPathSaveResult = RealtimeFastPathSaveResult(text: "stored text", error: nil)) {
        self.result = result
    }

    func run() async -> RealtimeFastPathSaveResult {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if !released {
            await withCheckedContinuation { releaseWaiters.append($0) }
        }
        return result
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

    @Test("Realtime configuration buffering fails closed before dropping early audio")
    func pendingAudioOverflowRequiresBatchFallback() {
        var buffer = RealtimePendingAudioBuffer(maximumByteCount: 6)
        let acceptedFirstChunk = buffer.append(Data([1, 2, 3]))
        let acceptedSecondChunk = buffer.append(Data([4, 5, 6]))
        let acceptedOverflowChunk = buffer.append(Data([7, 8, 9]))
        let retainedChunkCount = buffer.chunkCount
        let retainedByteCount = buffer.byteCount
        let retainedChunks = buffer.drain()

        #expect(acceptedFirstChunk)
        #expect(acceptedSecondChunk)
        #expect(!acceptedOverflowChunk)
        #expect(retainedChunkCount == 2)
        #expect(retainedByteCount == 6)
        #expect(retainedChunks == [Data([1, 2, 3]), Data([4, 5, 6])])
    }

    @Test("Configured realtime outbound audio stays bounded without Base64 task accumulation")
    func configuredOutboundAudioQueueIsBounded() {
        var queue = RealtimeOutboundEventBuffer(maximumByteCount: 8, maximumEventCount: 2)

        let acceptedFirst = queue.append(.audio(Data([1, 2, 3, 4])), sequence: 0)
        let acceptedSecond = queue.append(.audio(Data([5, 6, 7, 8])), sequence: 1)
        let acceptedOverflow = queue.append(.audio(Data([9])), sequence: 2)
        #expect(acceptedFirst)
        #expect(acceptedSecond)
        #expect(!acceptedOverflow)
        #expect(queue.byteCount == 8)
        #expect(queue.eventCount == 2)

        #expect(queue.popFirst()?.payload == .audio(Data([1, 2, 3, 4])))
        #expect(queue.byteCount == 4)
        #expect(queue.eventCount == 1)
    }

    @Test("A stalled configured WebSocket send reaches a bounded deadline and forces fallback")
    @MainActor
    func configuredOutboundSendDeadlineIsBounded() async {
        let client = RealtimeTranscriptionClient(apiKey: "synthetic-test-value", homePath: "/tmp")
        let clock = FakeRealtimeClock()
        let sent = await client.enqueueOutboundOperationTestHelper(
            timeoutMilliseconds: 50,
            operation: {
                try await Task.sleep(for: .seconds(60))
            },
            nowMilliseconds: { clock.nowMilliseconds },
            sleepMilliseconds: { milliseconds in
                await Task.yield()
                clock.advance(by: milliseconds)
            }
        )

        #expect(!sent)
        #expect(clock.nowMilliseconds == 50)
        #expect(client.error?.contains("timed out") == true)
        #expect(client.settlementResolutionTestHelper() == .failed)
    }

    @Test("Final realtime deadline includes a stalled outbound commit chain")
    @MainActor
    func stalledOutboundCommitCannotExtendFinishDeadline() async {
        let clock = FakeRealtimeClock()
        var commitStarted = false
        let waitResult = await RealtimeTranscriptionClient.waitForSettlementWhileCommitRunsTestHelper(
            timeoutMilliseconds: 700,
            beginCommit: {
                commitStarted = true
                try? await Task.sleep(for: .seconds(60))
                return false
            },
            resolution: { .waiting },
            nowMilliseconds: { clock.nowMilliseconds },
            sleepMilliseconds: { milliseconds in
                await Task.yield()
                clock.advance(by: milliseconds)
            }
        )

        #expect(commitStarted)
        #expect(waitResult.resolution == .waiting)
        #expect(waitResult.elapsedMilliseconds == 700)
    }

    @Test("WebSocket send failure settles immediately and never accepts partial realtime text")
    @MainActor
    func outboundSendFailureRequiresImmediateBatchFallback() async {
        struct SyntheticSendFailure: Error {}
        let client = RealtimeTranscriptionClient(apiKey: "synthetic-test-value", homePath: "/tmp")
        let sent = await client.enqueueOutboundOperationTestHelper {
            throw SyntheticSendFailure()
        }
        #expect(!sent)
        #expect(client.error?.contains("Realtime send failed") == true)

        let clock = FakeRealtimeClock()
        let waitResult = await RealtimeTranscriptionClient.waitForSettlementTestHelper(
            timeoutMilliseconds: 700,
            resolution: { client.settlementResolutionTestHelper() },
            nowMilliseconds: { clock.nowMilliseconds },
            sleepMilliseconds: { clock.advance(by: $0) }
        )
        #expect(waitResult.resolution == .failed)
        #expect(waitResult.elapsedMilliseconds == 0)

        let failedResult = RealtimeFinishResult(
            text: "optimistic partial",
            settled: false,
            error: client.error
        )
        #expect(RecordingEngine.settledRealtimeFastPathTranscript(
            finishResult: failedResult,
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
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

    @Test("Settlement deadline arithmetic saturates at UInt64 bounds")
    @MainActor
    func settlementDeadlineDoesNotOverflow() async {
        var now = UInt64.max - 5
        let waitResult = await RealtimeTranscriptionClient.waitForSettlementTestHelper(
            timeoutMilliseconds: 10,
            resolution: { .waiting },
            nowMilliseconds: { now },
            sleepMilliseconds: { milliseconds in
                let (advanced, overflow) = now.addingReportingOverflow(milliseconds)
                now = overflow ? UInt64.max : advanced
            }
        )

        #expect(waitResult.resolution == .waiting)
        #expect(waitResult.elapsedMilliseconds == 5)
    }

    @Test("Periodic realtime commits use bounded monotonic elapsed time")
    func periodicCommitSchedulingIsMonotonicAndBounded() {
        #expect(RecordingEngine.realtimePeriodicCommitIsDue(
            nowMilliseconds: 10,
            lastCommitMilliseconds: nil
        ))
        #expect(!RecordingEngine.realtimePeriodicCommitIsDue(
            nowMilliseconds: 999,
            lastCommitMilliseconds: 100
        ))
        #expect(RecordingEngine.realtimePeriodicCommitIsDue(
            nowMilliseconds: 1_000,
            lastCommitMilliseconds: 100
        ))
        #expect(!RecordingEngine.realtimePeriodicCommitIsDue(
            nowMilliseconds: 99,
            lastCommitMilliseconds: 100
        ))
        #expect(!RecordingEngine.realtimePeriodicCommitIsDue(
            nowMilliseconds: UInt64.max,
            lastCommitMilliseconds: UInt64.max - 899
        ))
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
            postProcessingMode: PostProcessingMode.off.rawValue
        ))
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.always.rawValue
        ) == false)
        #expect(RecordingEngine.shouldLabelRewriting(
            postProcessingMode: PostProcessingMode.always.rawValue
        ))
        #expect(RecordingEngine.shouldLabelRewriting(
            postProcessingMode: PostProcessingMode.auto.rawValue
        ))
        #expect(RecordingEngine.shouldLabelRewriting(
            postProcessingMode: PostProcessingMode.off.rawValue
        ) == false)
    }

    @Test("Async realtime delivery prompts once before persistence and normal launch never prompts")
    @MainActor
    func asyncRealtimeDeliveryUsesProcessPromptGate() async {
        let normalLaunch = PermissionRequestLaunchPlan(arguments: ["Recordings"])
        let gate = AccessibilityPromptGate()
        let persistence = BlockingRealtimePersistence()
        let probe = RealtimeDeliveryProbe()
        var promptCalls = 0

        #expect(!normalLaunch.requestsAccessibilityPrompt)
        #expect(gate.promptRequestCount == 0)

        let persistenceTask = RecordingEngine.deliverRealtimeBeforePersistence(
            text: "settled realtime text",
            persist: { await persistence.run() },
            deliver: { text in
                let first = gate.trustForProtectedOperation(
                    isTrusted: { false },
                    requestPrompt: {
                        promptCalls += 1
                        return false
                    }
                )
                let repeatedCheck = gate.trustForProtectedOperation(
                    isTrusted: { false },
                    requestPrompt: {
                        promptCalls += 1
                        return false
                    }
                )
                #expect(first.didPrompt)
                #expect(!repeatedCheck.didPrompt)
                probe.deliveredText = text
            },
            persistenceCompleted: { probe.persistedResult = $0 }
        )

        await persistence.waitUntilStarted()
        #expect(probe.deliveredText == "settled realtime text")
        #expect(promptCalls == 1)
        #expect(gate.promptRequestCount == 1)
        #expect(probe.persistedResult == nil)

        await persistence.release()
        await persistenceTask.value
        #expect(probe.persistedResult?.text == "stored text")
    }

    @Test("Async save failure starts recovery only after realtime text is delivered")
    @MainActor
    func asyncSaveFailureRecoversAfterDelivery() async {
        let persistence = BlockingRealtimePersistence(
            result: RealtimeFastPathSaveResult(text: nil, error: "synthetic save failure")
        )
        let probe = RealtimeDeliveryProbe()
        var recoveryError: String?

        let persistenceTask = RecordingEngine.deliverRealtimeBeforePersistence(
            text: "settled realtime text",
            persist: { await persistence.run() },
            deliver: { probe.deliveredText = $0 },
            persistenceCompleted: { result in
                #expect(probe.deliveredText == "settled realtime text")
                recoveryError = result.error
                probe.persistedResult = result
            }
        )

        await persistence.waitUntilStarted()
        #expect(probe.deliveredText == "settled realtime text")
        #expect(recoveryError == nil)

        await persistence.release()
        await persistenceTask.value
        #expect(recoveryError == "synthetic save failure")
        #expect(probe.persistedResult?.text == nil)
    }

    @Test("Background recovery never overwrites a newer recording pipeline or pastes twice")
    func backgroundRecoveryRespectsPipelineGeneration() {
        #expect(RecordingEngine.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: 4,
            currentGeneration: 4,
            isRecording: false,
            isTranscribing: false
        ))
        #expect(!RecordingEngine.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: 4,
            currentGeneration: 5,
            isRecording: false,
            isTranscribing: false
        ))
        #expect(!RecordingEngine.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: 4,
            currentGeneration: 4,
            isRecording: true,
            isTranscribing: false
        ))
        #expect(!RecordingEngine.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: 4,
            currentGeneration: 4,
            isRecording: false,
            isTranscribing: true
        ))

        #expect(RecordingEngine.fallbackCompletionAction(
            cliText: "saved full-file transcript",
            cliError: nil,
            realtimeText: nil,
            deliverResult: false
        ) == .backgroundRecovered)
        #expect(RecordingEngine.fallbackCompletionAction(
            cliText: nil,
            cliError: "synthetic fallback failure",
            realtimeText: nil,
            deliverResult: false
        ) == .backgroundFailed("synthetic fallback failure"))
        #expect(RecordingEngine.fallbackCompletionAction(
            cliText: "foreground transcript",
            cliError: nil,
            realtimeText: nil,
            deliverResult: true
        ) == .deliver("foreground transcript"))
    }

    @Test("Delayed delivery from recording A pastes once without overwriting recording B")
    func delayedDeliveryRespectsNewerPipeline() {
        var gate = PipelineDeliveryGate()
        gate.registerPipeline(4)
        gate.registerPipeline(5)

        let firstA = gate.claimDelivery(for: 4)
        let duplicateA = gate.claimDelivery(for: 4)
        let firstB = gate.claimDelivery(for: 5)
        #expect(firstA)
        #expect(!duplicateA)
        #expect(firstB)
        #expect(!gate.shouldApplyStatus(
            deliveryGeneration: 4,
            currentGeneration: 5,
            isRecording: true,
            isTranscribing: false
        ))
        #expect(gate.shouldApplyStatus(
            deliveryGeneration: 5,
            currentGeneration: 5,
            isRecording: false,
            isTranscribing: false
        ))
    }

    @Test("Delivery claims compact without forgetting old or out-of-order generations")
    func deliveryClaimsRemainExactAfterCompaction() {
        var gate = PipelineDeliveryGate()
        var sequentialClaims: [Bool] = []
        for generation in 1...64 {
            gate.registerPipeline(UInt64(generation))
            sequentialClaims.append(gate.claimDelivery(for: UInt64(generation)))
        }
        let duplicateOne = gate.claimDelivery(for: 1)
        let duplicateThirtyTwo = gate.claimDelivery(for: 32)
        #expect(sequentialClaims.allSatisfy { $0 })
        #expect(!duplicateOne)
        #expect(!duplicateThirtyTwo)

        var outOfOrder = PipelineDeliveryGate()
        outOfOrder.registerPipeline(100)
        outOfOrder.registerPipeline(1)
        let highClaim = outOfOrder.claimDelivery(for: 100)
        let pendingLowClaim = outOfOrder.claimDelivery(for: 1)
        let duplicateLowClaim = outOfOrder.claimDelivery(for: 1)
        outOfOrder.registerPipeline(99)
        let pendingMiddleClaim = outOfOrder.claimDelivery(for: 99)
        let duplicateHighClaim = outOfOrder.claimDelivery(for: 100)
        #expect(highClaim)
        #expect(pendingLowClaim)
        #expect(!duplicateLowClaim)
        #expect(pendingMiddleClaim)
        #expect(!duplicateHighClaim)

        var gapped = PipelineDeliveryGate()
        var gappedClaims: [Bool] = []
        for generation in stride(from: 2, through: 200, by: 2) {
            gapped.registerPipeline(UInt64(generation))
            gappedClaims.append(gapped.claimDelivery(for: UInt64(generation)))
        }
        let duplicateTwo = gapped.claimDelivery(for: 2)
        let duplicateOneNinetyEight = gapped.claimDelivery(for: 198)
        #expect(gappedClaims.allSatisfy { $0 })
        #expect(!duplicateTwo)
        #expect(!duplicateOneNinetyEight)
    }

    @Test("Background recovery reconstructs missing WAV without replacing an existing capture")
    func backgroundRecoveryAudioReconstruction() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-recovery-\(UUID().uuidString)", isDirectory: true)
        let audioURL = directory.appendingPathComponent("capture.wav")
        defer { try? FileManager.default.removeItem(at: directory) }

        let pcm = Data([0x01, 0x02, 0x03, 0x04])
        #expect(RecordingEngine.ensureBackgroundRecoveryAudio(
            audioPath: audioURL.path,
            pcmData: pcm
        ) == audioURL.path)
        let reconstructed = try Data(contentsOf: audioURL)
        #expect(reconstructed.count == 44 + pcm.count)
        #expect(reconstructed.suffix(pcm.count) == pcm)

        #expect(RecordingEngine.ensureBackgroundRecoveryAudio(
            audioPath: audioURL.path,
            pcmData: Data([0xFF, 0xFF])
        ) == audioURL.path)
        #expect(try Data(contentsOf: audioURL) == reconstructed)
        #expect(RecordingEngine.ensureBackgroundRecoveryAudio(
            audioPath: directory.appendingPathComponent("empty.wav").path,
            pcmData: Data()
        ) == nil)
    }

    @Test("Background recovery retains the failed recording's processing configuration")
    func backgroundRecoveryUsesCapturedConfiguration() {
        let recordingA = RecordingProcessingConfiguration(
            transcriptionPrompt: "Project A vocabulary",
            transcriberPrompt: "Project A vocabulary",
            postProcessingMode: PostProcessingMode.off.rawValue,
            transcriptionLanguage: "es",
            transcriptionModel: "whisper-1",
            transcriberModel: "gpt-a",
            enhancementModel: "gpt-a-fallback",
            intentModel: "gpt-intent-a",
            intentDetectionEnabled: true,
            enhanceTriggersJSON: #"["rewrite a"]"#,
            keywordTransformsJSON: #"{"code with":"Codewith"}"#
        )
        var currentProject = recordingA
        let capturedForRecovery = currentProject

        currentProject = RecordingProcessingConfiguration(
            transcriptionPrompt: "Project B vocabulary",
            transcriberPrompt: "Project B rewrite policy",
            postProcessingMode: PostProcessingMode.always.rawValue,
            transcriptionLanguage: "en",
            transcriptionModel: "gpt-4o-transcribe",
            transcriberModel: "gpt-b",
            enhancementModel: "gpt-b-fallback",
            intentModel: "gpt-intent-b",
            intentDetectionEnabled: true,
            enhanceTriggersJSON: #"["rewrite b"]"#,
            keywordTransformsJSON: #"{"open ai":"OpenAI"}"#
        )
        let recoveryArgs = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/recording-a.wav",
            activeProjectId: "project-a",
            transcriberPrompt: capturedForRecovery.transcriberPrompt,
            postProcessingMode: capturedForRecovery.postProcessingMode,
            language: capturedForRecovery.transcriptionLanguage,
            transcriptionPrompt: capturedForRecovery.transcriptionPrompt,
            transcriptionModel: capturedForRecovery.transcriptionModel,
            transcriberModel: capturedForRecovery.transcriberModel,
            enhancementModel: capturedForRecovery.enhancementModel,
            enhanceTriggersJSON: capturedForRecovery.enhanceTriggersJSON,
            keywordTransformsJSON: capturedForRecovery.keywordTransformsJSON,
            recordingId: "pipeline-a"
        )

        #expect(capturedForRecovery != currentProject)
        #expect(recoveryArgs.contains("Project A vocabulary"))
        #expect(recoveryArgs.contains(PostProcessingMode.off.rawValue))
        #expect(recoveryArgs.contains("es"))
        #expect(recoveryArgs.contains("whisper-1"))
        #expect(recoveryArgs.contains("gpt-a"))
        #expect(recoveryArgs.contains(#"["rewrite a"]"#))
        #expect(recoveryArgs.contains(#"{"code with":"Codewith"}"#))
        #expect(recoveryArgs.contains("pipeline-a"))
        #expect(!recoveryArgs.contains("Project B rewrite policy"))
        #expect(!recoveryArgs.contains(PostProcessingMode.always.rawValue))
        #expect(!recoveryArgs.contains("en"))
    }

    @Test("Command rewrite retains recording A configuration after switching to project B")
    func commandRewriteUsesCapturedConfiguration() {
        let recordingA = RecordingProcessingConfiguration(
            transcriptionPrompt: "Project A vocabulary",
            transcriberPrompt: "Project A rewrite policy",
            postProcessingMode: PostProcessingMode.always.rawValue,
            transcriptionLanguage: "es",
            transcriptionModel: "whisper-a",
            transcriberModel: "gpt-command-a",
            enhancementModel: "gpt-fallback-a",
            intentModel: "gpt-intent-a",
            intentDetectionEnabled: true,
            enhanceTriggersJSON: #"["rewrite a"]"#,
            keywordTransformsJSON: #"{"code with":"Codewith A"}"#
        )
        let recordingB = RecordingProcessingConfiguration(
            transcriptionPrompt: "Project B vocabulary",
            transcriberPrompt: "Project B rewrite policy",
            postProcessingMode: PostProcessingMode.off.rawValue,
            transcriptionLanguage: "en",
            transcriptionModel: "whisper-b",
            transcriberModel: "gpt-command-b",
            enhancementModel: "gpt-fallback-b",
            intentModel: "gpt-intent-b",
            intentDetectionEnabled: true,
            enhanceTriggersJSON: #"["rewrite b"]"#,
            keywordTransformsJSON: #"{"open ai":"OpenAI B"}"#
        )
        var mutableCurrentConfiguration = recordingA
        let capturedRequest = mutableCurrentConfiguration
        mutableCurrentConfiguration = recordingB

        let args = RecordingEngine.rewriteCLIArgs(
            selectedText: "selected A",
            instruction: "instruction A",
            activeProjectId: "project-a",
            processingConfiguration: capturedRequest
        )

        #expect(capturedRequest != mutableCurrentConfiguration)
        for expected in [
            "selected A", "instruction A", "project-a", "Project A vocabulary",
            "Project A rewrite policy", PostProcessingMode.always.rawValue, "es", "whisper-a",
            "gpt-command-a", "gpt-fallback-a", #"["rewrite a"]"#,
            #"{"code with":"Codewith A"}"#,
        ] {
            #expect(args.contains(expected))
        }
        for forbidden in [
            "Project B vocabulary", "Project B rewrite policy", PostProcessingMode.off.rawValue,
            "whisper-b", "gpt-command-b", "gpt-fallback-b", #"["rewrite b"]"#,
            #"{"open ai":"OpenAI B"}"#,
        ] {
            #expect(!args.contains(forbidden))
        }

        let optionLikeTextArgs = RecordingEngine.rewriteCLIArgs(
            selectedText: "--literal-selection",
            instruction: "instruction A",
            activeProjectId: "project-a",
            processingConfiguration: capturedRequest
        )
        #expect(Array(optionLikeTextArgs.suffix(2)) == ["--", "--literal-selection"])
        #expect(optionLikeTextArgs.firstIndex(of: "--instruction")! < optionLikeTextArgs.firstIndex(of: "--")!)
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
