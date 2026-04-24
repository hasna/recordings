import Foundation

enum NativeAppLog {
    private static let lock = NSLock()

    static func write(_ message: String, homePath: String = FileManager.default.homeDirectoryForCurrentUser.path) {
        lock.lock()
        defer { lock.unlock() }

        let dir = "\(homePath)/.hasna/recordings"
        let path = "\(dir)/Recordings.log"
        let line = "[\(Self.timestamp())] \(message)\n"

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
            fputs("[Recordings] log write failed: \(error.localizedDescription)\n", stderr)
        }
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
