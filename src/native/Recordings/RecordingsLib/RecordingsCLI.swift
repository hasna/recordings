import Foundation

/// Swift bridge over the `recordings` CLI. The macOS app uses this for the library,
/// search, stats, and active Store — reusing the exact same local/HTTP
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

    public struct CanonicalProject: Codable, Sendable {
        public let id: String
        public let name: String
        public let path: String
    }

    public static func registerProject(
        name: String,
        path: String,
        description: String = "Recordings macOS project",
        home: String = defaultHome
    ) throws -> CanonicalProject {
        try runDecoding(
            CanonicalProject.self,
            ["--json", "project", "register", "--name", name, "--path", path, "--description", description],
            home: home
        )
    }

    // MARK: - Internals

    private static func runDecoding<T: Decodable>(_ type: T.Type, _ args: [String], home: String) throws -> T {
        let output = CLIRunner.run(args, home: home)
        if let err = CLIRunner.parseError(output) { throw Failure(message: err) }
        return try decode(type, from: output)
    }

    static func decode<T: Decodable>(_ type: T.Type, from output: String) throws -> T {
        let candidates = Self.jsonCandidates(from: output)
        guard !candidates.isEmpty else {
            throw Failure(message: "No JSON in CLI output")
        }
        var lastError: Error?
        for json in candidates.reversed() {
            guard let data = json.data(using: .utf8) else { continue }
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                lastError = error
            }
        }
        throw Failure(message: "Failed to decode \(T.self): \(lastError?.localizedDescription ?? "invalid JSON")")
    }

    /// Find a balanced, valid top-level JSON array or object while ignoring bracketed logs.
    static func extractJSON(from output: String) -> String? {
        jsonCandidates(from: output).last
    }

    static func jsonCandidates(from output: String) -> [String] {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        var candidates: [String] = []
        var cursor = trimmed.startIndex

        while cursor < trimmed.endIndex {
            guard let start = trimmed[cursor...].firstIndex(where: { $0 == "[" || $0 == "{" }) else { break }
            var stack: [Character] = []
            var inString = false
            var escaped = false
            var index = start
            var candidateEnd: String.Index?

            scan: while index < trimmed.endIndex {
                let character = trimmed[index]
                if inString {
                    if escaped { escaped = false }
                    else if character == "\\" { escaped = true }
                    else if character == "\"" { inString = false }
                } else {
                    switch character {
                    case "\"": inString = true
                    case "[": stack.append("]")
                    case "{": stack.append("}")
                    case "]", "}":
                        guard stack.last == character else { break scan }
                        stack.removeLast()
                        if stack.isEmpty {
                            candidateEnd = index
                            break scan
                        }
                    default: break
                    }
                }
                index = trimmed.index(after: index)
            }

            if let end = candidateEnd {
                let candidate = String(trimmed[start...end])
                if let data = candidate.data(using: .utf8),
                   let value = try? JSONSerialization.jsonObject(with: data),
                   value is [Any] || value is [String: Any] {
                    candidates.append(candidate)
                }
                cursor = trimmed.index(after: end)
            } else {
                cursor = trimmed.index(after: start)
            }
        }
        return candidates
    }
}
