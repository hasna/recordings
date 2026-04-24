import Foundation
import Testing
@testable import RecordingsLib

// MARK: - RealtimeTranscriptionClient Event Parsing Tests

struct RealtimeTranscriptionTests {
    @Test("Model ID is set to latest gpt-4o-transcribe")
    func modelID() {
        #expect(RealtimeTranscriptionClient.modelID == "gpt-4o-transcribe")
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
        #expect(transcription?["model"] as? String == "gpt-4o-transcribe")
        #expect(transcription?["prompt"] as? String == "Use Alumia as vocabulary")
        #expect(transcription?["language"] as? String == "en")

        #expect(input?["turn_detection"] is NSNull)

        let include = session?["include"] as? [String]
        #expect(include?.contains("item.input_audio_transcription.logprobs") == true)
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

    @Test("Live commits wait for enough audio and elapsed time")
    func liveCommitThreshold() {
        #expect(RealtimeTranscriptionClient.shouldAutoCommitLiveInputTestHelper(
            uncommittedAudioBytes: 38_399,
            secondsSinceLastCommit: 1.0
        ) == false)
        #expect(RealtimeTranscriptionClient.shouldAutoCommitLiveInputTestHelper(
            uncommittedAudioBytes: 38_400,
            secondsSinceLastCommit: 0.79
        ) == false)
        #expect(RealtimeTranscriptionClient.shouldAutoCommitLiveInputTestHelper(
            uncommittedAudioBytes: 38_400,
            secondsSinceLastCommit: 0.8
        ) == true)
    }

    @Test("Partial realtime text falls back for longer recordings")
    func partialRealtimeFallback() {
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 96_000) == true)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "This is a complete sentence.", pcmByteCount: 96_000) == false)
        #expect(RecordingEngine.shouldFallbackFromPartialRealtime(text: "Hi", pcmByteCount: 12_000) == false)
    }
}
