import Testing
import Foundation
@testable import RecordingsLib

/// Tests for the CLI bridge layer the full macOS app relies on: decoding the `recordings`
/// CLI JSON into models and tolerating leading log noise in stdout.
struct RecordingBridgeTests {
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

    @Test("StorageStatus decodes mode/enabled/db_path/tables and finds recordings row count")
    func decodeStorage() throws {
        let json = """
        { "mode": "local", "enabled": false, "db_path": "/Users/x/.hasna/recordings/recordings.db",
          "tables": [ {"table": "recordings", "rows": 42}, {"table": "agents", "rows": 3} ] }
        """
        let status = try JSONDecoder().decode(StorageStatus.self, from: Data(json.utf8))
        #expect(status.mode == "local")
        #expect(status.enabled == false)
        #expect(status.recordingsRowCount == 42)
    }

    @Test("extractJSON strips leading log lines before a JSON array")
    func extractArrayWithLeadingLogs() {
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
}
