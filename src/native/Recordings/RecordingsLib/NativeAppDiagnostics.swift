import Foundation

public enum NativeErrorSanitizer {
    private static let replacements: [(pattern: String, template: String)] = [
        (#"(?i)\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b"#, "[REDACTED]"),
        (#"(?i)(\bBearer\s+)[^\s,;]+"#, "$1[REDACTED]"),
        (#"(?i)(\bAuthorization\s*:\s*(?:Basic|Digest)\s+)[^;\n]+"#, "$1[REDACTED]"),
        (#"(?i)(\b[A-Z0-9_]*(?:(?:API|SECRET|PRIVATE)[_-]?KEY|SECRET[_-]?ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?(?:SECRET|PASSWORD)|PASSWORD|PASSCODE|SECRET|PRIVATE)\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;\n}]+)"#, "$1[REDACTED]"),
        (#"(?i)((?:[{,]\s*)"?(?:(?:api|secret|private)[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?(?:secret|password)|password|passcode|token|secret|private)"?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)"#, "$1[REDACTED]"),
        (#"(?i)((?:[?&]|\b)(?:(?:api|secret|private)[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?(?:secret|password)|password|passcode|token|secret|private)=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&\s,;]+)"#, "$1[REDACTED]"),
        (#"(?i)((?:api\s+key(?:\s+provided)?|client\s+(?:secret|password)|password|passcode|private\s+key|secret(?:\s+key)?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;\n}]+)"#, "$1[REDACTED]"),
        // Bare "private:" labels a value only at the start of a clause; mid-sentence uses
        // like "resource is private: access denied" are ordinary error prose and stay.
        (#"(?i)((?:^|[;,{\n])\s*)(private\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;\n}]+)"#, "$1$2[REDACTED]"),
    ]

    public static func sanitize(_ message: String) -> String {
        replacements.reduce(message) { result, replacement in
            guard let expression = try? NSRegularExpression(pattern: replacement.pattern) else {
                return result
            }
            let range = NSRange(result.startIndex..<result.endIndex, in: result)
            return expression.stringByReplacingMatches(
                in: result,
                range: range,
                withTemplate: replacement.template
            )
        }
    }
}

public enum NativeAppLog {
    private static let lock = NSLock()

    public static func write(_ message: String, homePath: String = FileManager.default.homeDirectoryForCurrentUser.path) {
        lock.lock()
        defer { lock.unlock() }

        let dir = "\(homePath)/.hasna/recordings"
        let path = "\(dir)/Recordings.log"
        let line = "[\(Self.timestamp())] \(NativeErrorSanitizer.sanitize(message))\n"

        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: path),
               let handle = FileHandle(forWritingAtPath: path) {
                defer { try? handle.close() }
                try handle.seekToEnd()
                if let data = line.data(using: .utf8) {
                    try handle.write(contentsOf: data)
                }
            } else {
                try line.write(toFile: path, atomically: true, encoding: .utf8)
            }
        } catch {
            let safeError = NativeErrorSanitizer.sanitize(error.localizedDescription)
            fputs("[Recordings] log write failed: \(safeError)\n", stderr)
        }
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
