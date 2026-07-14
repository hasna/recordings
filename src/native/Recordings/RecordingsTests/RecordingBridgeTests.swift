import Testing
import Foundation
@testable import RecordingsLib

/// Tests for the CLI bridge layer the full macOS app relies on: decoding the `recordings`
/// CLI JSON into models and tolerating leading log noise in stdout.
struct RecordingBridgeTests {
    @Test("native machine identity matches CLI host and explicit fleet override")
    func nativeMachineIdentity() {
        #expect(NativeMachineIdentity.current(environment: [:], hostName: "station05") == "station05")
        #expect(NativeMachineIdentity.current(environment: [:]) == NativeMachineIdentity.posixHostName())
        #expect(NativeMachineIdentity.current(
            environment: ["HASNA_MACHINE_ID": "station05"],
            hostName: "station05.local"
        ) == "station05")
    }

    @Test("Recording decodes from CLI snake_case JSON")
    func decodeRecording() throws {
        let json = """
        {
          "id": "rec_123",
          "audio_path": "/Users/x/.hasna/recordings/audio/a.wav",
          "raw_text": "hello world",
          "processed_text": "Hello, world.",
          "processing_mode": "enhanced",
          "model_used": "gpt-4o-transcribe",
          "enhancement_model": "gpt-4o",
          "duration_ms": 65000,
          "language": "en",
          "tags": ["demo", "test"],
          "project_id": "proj_1",
          "machine_id": "apple06",
          "created_at": "2026-06-22T10:00:00.000Z"
        }
        """
        let rec = try JSONDecoder().decode(Recording.self, from: Data(json.utf8))
        #expect(rec.id == "rec_123")
        #expect(rec.displayText == "Hello, world.")   // prefers processed_text
        #expect(rec.isEnhanced)
        #expect(rec.durationLabel == "1:05")
        #expect(rec.tags == ["demo", "test"])
        #expect(rec.projectId == "proj_1")
        #expect(rec.createdDate != nil)
    }

    @Test("Recording falls back to raw_text and tolerates missing optional fields")
    func decodeMinimalRecording() throws {
        let json = """
        { "id": "r1", "raw_text": "just raw", "processing_mode": "raw", "duration_ms": 4000, "tags": [], "created_at": "2026-06-22 10:00:00" }
        """
        let rec = try JSONDecoder().decode(Recording.self, from: Data(json.utf8))
        #expect(rec.displayText == "just raw")
        #expect(!rec.isEnhanced)
        #expect(rec.durationLabel == "4s")
        #expect(rec.audioPath == nil)
        #expect(rec.createdDate != nil)   // SQLite "yyyy-MM-dd HH:mm:ss" fallback parses
    }

    @Test("RecordingStats decodes aggregate fields")
    func decodeStats() throws {
        let json = #"{ "total": 12, "raw": 5, "enhanced": 7, "total_duration_ms": 90000, "by_model": {"gpt-4o": 7} }"#
        let stats = try JSONDecoder().decode(RecordingStats.self, from: Data(json.utf8))
        #expect(stats.total == 12)
        #expect(stats.enhanced == 7)
        #expect(stats.totalDurationMs == 90000)
    }

    @Test("RecordingStats rejects a structurally unrelated JSON log object")
    func statsRejectLogObject() {
        let log = Data(#"{"level":"info","message":"finished"}"#.utf8)

        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(RecordingStats.self, from: log)
        }
    }

    @Test("stats decoding ignores valid JSON logs before and after the requested payload")
    func statsDecodeSelectsStructurallyValidPayload() throws {
        let output = """
        {"level":"info","message":"starting"}
        {"total":12,"raw":5,"enhanced":7,"total_duration_ms":90000}
        {"level":"info","message":"finished"}
        """

        let stats = try RecordingsCLI.decode(RecordingStats.self, from: output)

        #expect(stats.total == 12)
        #expect(stats.raw == 5)
        #expect(stats.enhanced == 7)
        #expect(stats.totalDurationMs == 90000)
    }

    @Test("extractJSON strips leading log lines before a JSON array")
    func extractArrayWithLeadingLogs() throws {
        let output = """
        [recordings] opening database
        migrating schema...
        [
          { "id": "a" }
        ]
        """
        let json = RecordingsCLI.extractJSON(from: output)
        #expect(json != nil)
        #expect(json?.hasPrefix("[") == true)
        #expect(json?.hasSuffix("]") == true)
        let data = try #require(json?.data(using: .utf8))
        #expect((try? JSONSerialization.jsonObject(with: data)) is [Any])
    }

    @Test("extractJSON skips bracket and brace log noise before a decodable payload")
    func extractJSONAfterBracketedNoise() throws {
        let output = """
        [recordings] opening {database}
        worker [1/2] ready
        { "id": "real", "message": "literal [bracket] and {brace}" }
        finished
        """
        let json = try #require(RecordingsCLI.extractJSON(from: output))
        let object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String])
        #expect(object["id"] == "real")
        #expect(object["message"] == "literal [bracket] and {brace}")
    }

    @Test("extractJSON selects the final payload after a valid JSON log line")
    func extractJSONAfterValidJSONLog() throws {
        let output = """
        { "level": "info", "message": "opening database" }
        [ { "id": "recording-1" } ]
        """
        let json = try #require(RecordingsCLI.extractJSON(from: output))
        let array = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: String]])
        #expect(array == [["id": "recording-1"]])
    }

    @Test("extractJSON returns object payload when stdout is a JSON object")
    func extractObject() {
        let output = "noise line\n{ \"mode\": \"local\" }\n"
        let json = RecordingsCLI.extractJSON(from: output)
        #expect(json == "{ \"mode\": \"local\" }")
    }

    @Test("extractJSON returns nil when there is no JSON")
    func extractNone() {
        #expect(RecordingsCLI.extractJSON(from: "ERROR: nothing here") == nil)
    }

    @Test("list pagination collects every page with Store-compatible offsets")
    func collectAllPages() throws {
        let recordings = ["a", "b", "c"].map {
            Recording(id: $0, rawText: $0)
        }
        var requestedOffsets: [Int] = []

        let result = try RecordingsCLI.collectAllPages(pageSize: 2) { limit, offset in
            requestedOffsets.append(offset)
            return Array(recordings.dropFirst(offset).prefix(limit))
        }

        #expect(result.map(\.id) == ["a", "b", "c"])
        #expect(requestedOffsets == [0, 2])
    }

    @Test("list pagination stops when a backend ignores offsets")
    func collectAllPagesStopsWithoutProgress() throws {
        let repeated = [
            Recording(id: "a", rawText: "a"),
            Recording(id: "b", rawText: "b"),
        ]
        var requestCount = 0

        let result = try RecordingsCLI.collectAllPages(pageSize: 2) { _, _ in
            requestCount += 1
            return repeated
        }

        #expect(result.map(\.id) == ["a", "b"])
        #expect(requestCount == 2)
    }
}
