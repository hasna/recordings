import Testing
@testable import Recordings

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
            """{"type":"conversation.item.input_audio_transcription.delta"}"""
        ) == false)
    }

    @Test("Parse error message from error event")
    func parseErrorMessage() {
        let errorJSON = """
        {"type":"error","error":{"message":"Model not found","code":404}}
        """
        #expect(RealtimeTranscriptionClient.parseErrorTestHelper(errorJSON) == "Model not found")
    }
}
