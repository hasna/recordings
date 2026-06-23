import Foundation

/// A persisted recording/transcript, decoded from the `recordings` CLI (`--json`).
/// This mirrors the TypeScript `Recording` shape so the macOS app reads the exact same
/// store the CLI/MCP write — no duplicated persistence logic.
public struct Recording: Identifiable, Codable, Sendable, Equatable {
    public let id: String
    public let audioPath: String?
    public let rawText: String
    public let processedText: String?
    public let processingMode: String      // "raw" | "enhanced"
    public let modelUsed: String?
    public let enhancementModel: String?
    public let durationMs: Int
    public let language: String?
    public let tags: [String]
    public let projectId: String?
    public let machineId: String?
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case audioPath = "audio_path"
        case rawText = "raw_text"
        case processedText = "processed_text"
        case processingMode = "processing_mode"
        case modelUsed = "model_used"
        case enhancementModel = "enhancement_model"
        case durationMs = "duration_ms"
        case language
        case tags
        case projectId = "project_id"
        case machineId = "machine_id"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        audioPath = try c.decodeIfPresent(String.self, forKey: .audioPath)
        rawText = (try c.decodeIfPresent(String.self, forKey: .rawText)) ?? ""
        processedText = try c.decodeIfPresent(String.self, forKey: .processedText)
        processingMode = (try c.decodeIfPresent(String.self, forKey: .processingMode)) ?? "raw"
        modelUsed = try c.decodeIfPresent(String.self, forKey: .modelUsed)
        enhancementModel = try c.decodeIfPresent(String.self, forKey: .enhancementModel)
        durationMs = (try c.decodeIfPresent(Int.self, forKey: .durationMs)) ?? 0
        language = try c.decodeIfPresent(String.self, forKey: .language)
        tags = (try c.decodeIfPresent([String].self, forKey: .tags)) ?? []
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        machineId = try c.decodeIfPresent(String.self, forKey: .machineId)
        createdAt = (try c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
    }

    // Memberwise init for tests / previews.
    public init(id: String, audioPath: String? = nil, rawText: String, processedText: String? = nil,
                processingMode: String = "raw", modelUsed: String? = nil, enhancementModel: String? = nil,
                durationMs: Int = 0, language: String? = nil, tags: [String] = [],
                projectId: String? = nil, machineId: String? = nil, createdAt: String = "") {
        self.id = id
        self.audioPath = audioPath
        self.rawText = rawText
        self.processedText = processedText
        self.processingMode = processingMode
        self.modelUsed = modelUsed
        self.enhancementModel = enhancementModel
        self.durationMs = durationMs
        self.language = language
        self.tags = tags
        self.projectId = projectId
        self.machineId = machineId
        self.createdAt = createdAt
    }

    /// The user-facing text: enhanced output when available, otherwise the raw transcript.
    public var displayText: String {
        if let p = processedText, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return p }
        return rawText
    }

    /// First line / short preview for list rows.
    public var snippet: String {
        let collapsed = displayText
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if collapsed.isEmpty { return "No transcript" }
        return collapsed.count > 140 ? String(collapsed.prefix(140)) + "…" : collapsed
    }

    public var isEnhanced: Bool { processingMode == "enhanced" }

    public var durationSeconds: Double { Double(durationMs) / 1000.0 }

    public var durationLabel: String {
        let total = Int(durationSeconds.rounded())
        let m = total / 60, s = total % 60
        return m > 0 ? String(format: "%d:%02d", m, s) : "\(s)s"
    }

    public var createdDate: Date? { Recording.parseDate(createdAt) }

    public static func parseDate(_ value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: value) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: value) { return d }
        // SQLite "YYYY-MM-DD HH:MM:SS" fallback.
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return df.date(from: value)
    }
}

/// Aggregate statistics (`recordings --json stats`).
public struct RecordingStats: Codable, Sendable {
    public let total: Int
    public let raw: Int
    public let enhanced: Int
    public let totalDurationMs: Int

    enum CodingKeys: String, CodingKey {
        case total, raw, enhanced
        case totalDurationMs = "total_duration_ms"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = (try c.decodeIfPresent(Int.self, forKey: .total)) ?? 0
        raw = (try c.decodeIfPresent(Int.self, forKey: .raw)) ?? 0
        enhanced = (try c.decodeIfPresent(Int.self, forKey: .enhanced)) ?? 0
        totalDurationMs = (try c.decodeIfPresent(Int.self, forKey: .totalDurationMs)) ?? 0
    }

    public init(total: Int, raw: Int, enhanced: Int, totalDurationMs: Int) {
        self.total = total; self.raw = raw; self.enhanced = enhanced; self.totalDurationMs = totalDurationMs
    }
}

/// Local/remote storage status (`recordings storage status --json`).
public struct StorageStatus: Codable, Sendable {
    public struct Table: Codable, Sendable {
        public let table: String
        public let rows: Int
    }
    public let mode: String
    public let enabled: Bool
    public let dbPath: String
    public let tables: [Table]

    enum CodingKeys: String, CodingKey {
        case mode, enabled, tables
        case dbPath = "db_path"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try c.decodeIfPresent(String.self, forKey: .mode)) ?? "local"
        enabled = (try c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        dbPath = (try c.decodeIfPresent(String.self, forKey: .dbPath)) ?? ""
        tables = (try c.decodeIfPresent([Table].self, forKey: .tables)) ?? []
    }

    public init(mode: String, enabled: Bool, dbPath: String, tables: [Table]) {
        self.mode = mode; self.enabled = enabled; self.dbPath = dbPath; self.tables = tables
    }

    public var recordingsRowCount: Int? {
        tables.first { $0.table == "recordings" }?.rows
    }
}
