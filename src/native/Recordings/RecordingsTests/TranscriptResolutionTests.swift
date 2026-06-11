import Testing
@testable import RecordingsLib

struct TranscriptResolutionTests {
    @Test("CLI transcript is preferred when present")
    func cliWins() {
        let resolved = RecordingEngine.resolveFinalTranscript(
            cliText: "full transcript from whole audio",
            cliError: nil,
            realtimeText: "partial realtime"
        )
        #expect(resolved.text == "full transcript from whole audio")
        #expect(resolved.failureStatus == nil)
    }

    @Test("Realtime transcript is used when CLI transcription fails")
    func realtimeFallbackOnError() {
        let resolved = RecordingEngine.resolveFinalTranscript(
            cliText: nil,
            cliError: "OpenAI API key invalid or expired — update it in Recordings Settings",
            realtimeText: "what the user actually said"
        )
        #expect(resolved.text == "what the user actually said")
        #expect(resolved.failureStatus == nil)
    }

    @Test("Realtime transcript is used when CLI returns empty text")
    func realtimeFallbackOnEmpty() {
        let resolved = RecordingEngine.resolveFinalTranscript(
            cliText: "   ",
            cliError: nil,
            realtimeText: "spoken words"
        )
        #expect(resolved.text == "spoken words")
    }

    @Test("CLI error is surfaced when no transcript exists at all")
    func errorWhenNothing() {
        let resolved = RecordingEngine.resolveFinalTranscript(
            cliText: nil,
            cliError: "OpenAI API key invalid or expired — update it in Recordings Settings",
            realtimeText: "  "
        )
        #expect(resolved.text == nil)
        #expect(resolved.failureStatus == "OpenAI API key invalid or expired — update it in Recordings Settings")
    }

    @Test("Generic failure status when both transcripts are empty without error")
    func genericEmpty() {
        let resolved = RecordingEngine.resolveFinalTranscript(
            cliText: "",
            cliError: nil,
            realtimeText: nil
        )
        #expect(resolved.text == nil)
        #expect(resolved.failureStatus == "Empty transcription")
    }
}
