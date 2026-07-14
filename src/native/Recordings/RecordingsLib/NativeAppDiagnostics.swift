import Foundation

public enum NativeErrorSanitizer {
    private static let replacements: [(pattern: String, template: String)] = [
        (#"(?i)\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b"#, "[REDACTED]"),
        (#"(?i)(\bBearer\s+)[^\s,;]+"#, "$1[REDACTED]"),
        (#"(?i)(\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)\s*=\s*)[^\s,;]+"#, "$1[REDACTED]"),
        (#"(?i)(\"?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token)\"?\s*:\s*\"?)[^\"\s,;}]+"#, "$1[REDACTED]"),
        (#"(?i)((?:[?&]|\b)(?:api[_-]?key|access[_-]?token|auth[_-]?token|token)=)[^&\s,;]+"#, "$1[REDACTED]"),
        (#"(?i)(api\s+key(?:\s+provided)?\s*[:=]\s*)[^\s,;]+"#, "$1[REDACTED]"),
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
