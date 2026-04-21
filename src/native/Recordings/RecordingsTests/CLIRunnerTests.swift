import Testing
@testable import Recordings

struct CLIRunnerTests {
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
