import Foundation

/// Swift bridge over the `recordings` CLI. The macOS app uses this for the library,
/// search, stats, and local/cloud storage — reusing the exact same SQLite/Postgres
/// store the CLI and MCP server write, instead of re-implementing persistence in Swift.
public enum RecordingsCLI {
    public struct Failure: Error, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }

    public static var defaultHome: String {
        FileManager.default.homeDirectoryForCurrentUser.path
    }

    // MARK: - Library

    public static func list(limit: Int = 100, offset: Int = 0, projectId: String? = nil, home: String = defaultHome) throws -> [Recording] {
        var args = ["--json"]
        if let projectId, !projectId.isEmpty { args += ["--project", projectId] }
        args += ["list", "-n", String(limit), "--offset", String(offset)]
        return try runDecoding([Recording].self, args, home: home)
    }

    /// Load the complete library in pages. The HTTP store caps each request at 500,
    /// while the local SQLite store accepts the same offset/limit contract.
    public static func listAll(pageSize: Int = 500, home: String = defaultHome) throws -> [Recording] {
        try collectAllPages(pageSize: pageSize) { limit, offset in
            try list(limit: limit, offset: offset, home: home)
        }
    }

    static func collectAllPages(
        pageSize: Int = 500,
        loadPage: (_ limit: Int, _ offset: Int) throws -> [Recording]
    ) rethrows -> [Recording] {
        let size = max(1, min(pageSize, 500))
        var recordings: [Recording] = []
        var seen = Set<String>()
        var offset = 0

        while true {
            let page = try loadPage(size, offset)
            let unseen = page.filter { seen.insert($0.id).inserted }
            recordings.append(contentsOf: unseen)

            guard page.count == size, !unseen.isEmpty else { break }
            offset += page.count
        }

        return recordings
    }

    public static func show(id: String, home: String = defaultHome) throws -> Recording {
        try runDecoding(Recording.self, ["--json", "show", id], home: home)
    }

    public static func search(_ query: String, limit: Int = 100, home: String = defaultHome) throws -> [Recording] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return try list(limit: limit, home: home) }
        return try runDecoding([Recording].self, ["--json", "search", trimmed, "-n", String(limit)], home: home)
    }

    public static func stats(home: String = defaultHome) throws -> RecordingStats {
        try runDecoding(RecordingStats.self, ["--json", "stats"], home: home)
    }

    public static func delete(id: String, home: String = defaultHome) throws {
        let output = CLIRunner.run(["delete", id], home: home)
        if let err = CLIRunner.parseError(output) { throw Failure(message: err) }
    }

    // MARK: - Storage (local + cloud)

    public static func storageStatus(home: String = defaultHome) throws -> StorageStatus {
        try runDecoding(StorageStatus.self, ["storage", "status", "--json"], home: home)
    }

    /// Push local changes then pull remote changes. Returns the raw JSON summary so the
    /// caller can surface counts; throws if the CLI reports an error (e.g. no DB URL set).
    @discardableResult
    public static func storageSync(home: String = defaultHome) throws -> String {
        let output = CLIRunner.run(["storage", "sync", "--json"], home: home)
        if let err = CLIRunner.parseError(output) { throw Failure(message: err) }
        let json = Self.extractJSON(from: output) ?? output
        if let data = json.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let errMessage = obj["error"] as? String {
            throw Failure(message: errMessage)
        }
        return json
    }

    // MARK: - Internals

    private static func runDecoding<T: Decodable>(_ type: T.Type, _ args: [String], home: String) throws -> T {
        let output = CLIRunner.run(args, home: home)
        if let err = CLIRunner.parseError(output) { throw Failure(message: err) }
        guard let json = Self.extractJSON(from: output), let data = json.data(using: .utf8) else {
            throw Failure(message: "No JSON in CLI output")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure(message: "Failed to decode \(T.self): \(error.localizedDescription)")
        }
    }

    /// Extract the JSON value from CLI stdout, tolerating any leading log lines. Handles
    /// both a top-level array (`[...]`) and object (`{...}`).
    static func extractJSON(from output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.first == "[" || trimmed.first == "{" { return trimmed }

        let firstArray = trimmed.firstIndex(of: "[")
        let firstObject = trimmed.firstIndex(of: "{")
        // Choose whichever bracket appears first.
        let start: String.Index
        let close: Character
        switch (firstArray, firstObject) {
        case let (a?, o?): if a < o { start = a; close = "]" } else { start = o; close = "}" }
        case let (a?, nil): start = a; close = "]"
        case let (nil, o?): start = o; close = "}"
        default: return nil
        }
        guard let end = trimmed.lastIndex(of: close), start < end else { return nil }
        return String(trimmed[start...end])
    }
}
