import Testing
@testable import RecordingsLib

struct CLIRunnerTests {
    @Test("transcribeCLIArgs passes project, cleanup mode, and transcriber prompt")
    func transcribeCLIArgsWithPrompt() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: "project-1",
            transcriberPrompt: "Format as notes",
            postProcessingMode: "always"
        )
        #expect(args == [
            "--json",
            "--project", "project-1",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "always",
            "--transcriber-prompt", "Format as notes",
        ])
        #expect(!args.contains("--no-enhance"))
    }

    @Test("transcribeCLIArgs defaults to auto and omits blank prompt")
    func transcribeCLIArgsDefaultAuto() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: nil,
            transcriberPrompt: "   ",
            postProcessingMode: ""
        )
        #expect(args == [
            "--json",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "auto",
        ])
    }

    @Test("transcribeCLIArgs falls back to auto for invalid mode")
    func transcribeCLIArgsInvalidModeFallback() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: "",
            transcriberPrompt: "",
            postProcessingMode: "sometimes"
        )
        #expect(args == [
            "--json",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "auto",
        ])
    }

    @Test("saveTextCLIArgs persists realtime fast-path transcript")
    func saveTextCLIArgsRealtimeFastPath() {
        let args = RecordingEngine.saveTextCLIArgs(
            textFile: "/tmp/transcript.txt",
            audioPath: "/tmp/audio.wav",
            activeProjectId: "project-1",
            transcriberPrompt: "Format as notes",
            postProcessingMode: "auto",
            language: "en",
            durationMs: 1200,
            source: "realtime_fast_path",
            modelUsed: "gpt-realtime-whisper"
        )
        #expect(args == [
            "--json",
            "--project", "project-1",
            "save-text",
            "--text-file", "/tmp/transcript.txt",
            "--source", "realtime_fast_path",
            "--model-used", "gpt-realtime-whisper",
            "--post-processing", "auto",
            "--audio-path", "/tmp/audio.wav",
            "--duration-ms", "1200",
            "--language", "en",
            "--transcriber-prompt", "Format as notes",
        ])
    }

    @Test("parseError detects ERROR prefix")
    func parseError() {
        #expect(CLIRunner.parseError("ERROR: OpenAI API key not configured on this Mac") == "OpenAI API key not configured on this Mac")
    }

    @Test("parseError returns nil for normal output")
    func noError() {
        #expect(CLIRunner.parseError("Hello world") == nil)
    }

    @Test("parseError handles API key error")
    func apiKeyError() {
        #expect(CLIRunner.parseError("ERROR: OpenAI API key not configured") == "OpenAI API key not configured on this Mac")
    }

    @Test("parseError maps invalid API key (401) to a friendly message")
    func invalidKeyError() {
        let input = "ERROR: Transcription failed: 401 Incorrect API key provided: sk-proj-****vosA. You can find your API key at https://platform.openai.com."
        #expect(CLIRunner.parseError(input) == "OpenAI API key invalid or expired — update it in Recordings Settings")
    }

    @Test("parseError maps quota errors (429) to a friendly message")
    func quotaError() {
        let input = "ERROR: Transcription failed: 429 You exceeded your current quota, please check your plan and billing details."
        #expect(CLIRunner.parseError(input) == "OpenAI quota exceeded — check the OpenAI account billing")
    }

    @Test("parseError truncates long messages to 120 chars")
    func truncation() {
        let longMsg = String(repeating: "a", count: 200)
        let input = "ERROR: \(longMsg)"
        let result = CLIRunner.parseError(input)!
        #expect(result.count <= 120)
    }

    @Test("parseJSON extracts raw_text from JSON")
    func parseJSONRawText() {
        let output = """
        {"raw_text": "Hello world", "processed_text": null}
        """
        #expect(CLIRunner.parseJSON(output) == "Hello world")
    }

    @Test("parseJSON prefers processed_text over raw_text")
    func parseJSONProcessedText() {
        let output = """
        {"raw_text": "Hello world", "processed_text": "Hello World (enhanced)"}
        """
        #expect(CLIRunner.parseJSON(output) == "Hello World (enhanced)")
    }

    @Test("parseJSON falls back to plain text")
    func parseJSONFallback() {
        let output = "Transcribing...\nHello world\nSaved to file"
        #expect(CLIRunner.parseJSON(output) == "Hello world")
    }

    @Test("parseJSON returns nil for empty output")
    func emptyOutput() {
        #expect(CLIRunner.parseJSON("") == nil)
    }

    @Test("parseJSON handles empty transcription")
    func emptyTranscription() {
        let output = """
        {"raw_text": "", "processed_text": ""}
        """
        // Both are empty, so it should fall back to plain text extraction
        #expect(CLIRunner.parseJSON(output) == nil)
    }
}
