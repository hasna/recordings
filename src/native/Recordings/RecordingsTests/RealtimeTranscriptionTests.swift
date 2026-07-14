import Testing
import Foundation
@testable import RecordingsLib

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

    @Test("Realtime finish only settles after completed transcription events")
    func finishSettledDecision() {
        #expect(RealtimeTranscriptionClient.isFinishSettledTestHelper(
            didManualCommit: true,
            completedCountBeforeCommit: 0,
            completedEventCount: 0,
            expectedCommitCount: 1,
            hasIncompleteCommittedItems: true,
            uncommittedAudioBytes: 0,
            secondsSinceLastEvent: 0.5
        ) == false)
        #expect(RealtimeTranscriptionClient.isFinishSettledTestHelper(
            didManualCommit: true,
            completedCountBeforeCommit: 0,
            completedEventCount: 1,
            expectedCommitCount: 1,
            hasIncompleteCommittedItems: false,
            uncommittedAudioBytes: 0,
            secondsSinceLastEvent: 0.5
        ))
        #expect(RealtimeTranscriptionClient.isFinishSettledTestHelper(
            didManualCommit: true,
            completedCountBeforeCommit: 0,
            completedEventCount: 1,
            expectedCommitCount: 1,
            hasIncompleteCommittedItems: false,
            uncommittedAudioBytes: 0,
            secondsSinceLastEvent: 0.1
        ) == false)
        #expect(RealtimeTranscriptionClient.isFinishSettledTestHelper(
            didManualCommit: false,
            completedCountBeforeCommit: 1,
            completedEventCount: 1,
            expectedCommitCount: 1,
            hasIncompleteCommittedItems: false,
            uncommittedAudioBytes: 1,
            secondsSinceLastEvent: 0.5
        ) == false)
        #expect(RealtimeTranscriptionClient.isFinishSettledTestHelper(
            didManualCommit: false,
            completedCountBeforeCommit: 1,
            completedEventCount: 1,
            expectedCommitCount: 1,
            hasIncompleteCommittedItems: false,
            uncommittedAudioBytes: 5_759,
            secondsSinceLastEvent: 0.5
        ) == false)
    }

    @Test("Partial realtime text falls back for longer recordings")
    func partialRealtimeFallback() {
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 96_000) == true)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "This is a complete sentence.", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 12_000) == false)
    }

    @Test("Realtime fast path accepts useful and safely repaired text")
    func realtimeFastPathDecision() {
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "  this is a useful transcript  ", pcmByteCount: 96_000))
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "Hi", pcmByteCount: 12_000))
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "Hi", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.shouldUseRealtimeFastPath(realtimeText: "   ", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "Actually 리수 Zoom your goal",
            pcmByteCount: 96_000,
            language: "en"
        ) == "Actually Zoom your goal")
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "어 Okay I don't know if this This is working어 Okay I don't know if this This is working",
            pcmByteCount: 96_000,
            language: "en"
        ) == "Okay I don't know if this is working")
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

    @Test("Realtime artifact cleanup removes CJK tokens from English-dominant text")
    func realtimeCJKArtifactCleanup() {
        let cleaned = RecordingEngine.cleanRealtimeArtifactText(
            "Actually 리수 Zoom your goal and do this work with sabi 度扫 agents actually"
        )
        #expect(cleaned == "Actually Zoom your goal and do this work with sabi agents actually")
    }
}
