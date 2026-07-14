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

    @Test("Realtime transcripts are normalized before fast-path use")
    func realtimeNormalization() {
        #expect(RecordingEngine.normalizedRealtimeTranscript("  hello world\n") == "hello world")
        #expect(RecordingEngine.normalizedRealtimeTranscript("working어") == "working")
        #expect(RecordingEngine.normalizedRealtimeTranscript(" \n ") == nil)
        #expect(RecordingEngine.normalizedRealtimeTranscript(nil) == nil)
    }

    @Test("English realtime text can be safely repaired before fast-path paste")
    func realtimeTextRepairedForFastPath() {
        #expect(RecordingEngine.isSafeRealtimeFastPathText(
            rawText: "Actually 리수 Zoom your goal",
            cleanedText: "Actually Zoom your goal",
            language: "en"
        ))
        #expect(RecordingEngine.isSafeRealtimeFastPathText(
            rawText: "Actually Zoom your goal",
            cleanedText: "Actually Zoom your goal",
            language: "en"
        ))
        #expect(RecordingEngine.isSafeRealtimeFastPathText(
            rawText: "Actually Zoom your goal",
            cleanedText: "Actually invented Zoom your goal",
            language: "en"
        ) == false)
        #expect(RecordingEngine.wasRealtimeTranscriptRepaired(
            rawText: "working어",
            cleanedText: "working"
        ))
    }

    @Test("Realtime fast path rejects cleanup that removes spoken repetition")
    func repeatedSpeechFallsBackToWholeAudio() {
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "very very good",
            pcmByteCount: 24_000,
            language: "en"
        ) == nil)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "muy muy bien",
            pcmByteCount: 24_000,
            language: "es"
        ) == nil)
    }

    @Test("Realtime fast path rejects cleanup that removes spoken filler words")
    func fillerSpeechFallsBackToWholeAudio() {
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "um I agree",
            pcmByteCount: 24_000,
            language: "en"
        ) == nil)
    }

    @Test("Lexically altered realtime text is never used after whole-audio failure")
    func alteredRealtimeTextIsNotAFailureFallback() {
        #expect(RecordingEngine.safeRealtimeFallbackTranscript(
            realtimeText: "very very good",
            language: "en"
        ) == nil)
        #expect(RecordingEngine.safeRealtimeFallbackTranscript(
            realtimeText: "um I agree",
            language: "en"
        ) == nil)
        #expect(RecordingEngine.safeRealtimeFallbackTranscript(
            realtimeText: "Actually 리수 Zoom your goal",
            language: "en"
        ) == "Actually Zoom your goal")
        #expect(RecordingEngine.safeRealtimeFallbackTranscript(
            realtimeText: "这是 完全 错误 的 实时 转录 内容",
            language: "en"
        ) == nil)
        #expect(RecordingEngine.realtimeFastPathTranscript(
            realtimeText: "这是 完全 错误 的 实时 转录 内容",
            pcmByteCount: 96_000,
            language: "en"
        ) == nil)
    }
}
