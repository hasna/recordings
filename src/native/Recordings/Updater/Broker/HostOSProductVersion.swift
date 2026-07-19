import Foundation

enum HostOSProductVersionQueryError: Error {
    case unavailable
}

/// Reads the live macOS ProductVersion without a shell, search path, or inherited
/// environment. Any launch, exit-status, encoding, size, or shape anomaly fails closed.
enum HostOSProductVersionReader {
    static func read() throws -> String {
        let result: BoundedProcessResult
        do {
            result = try BoundedProcessRunner.run(
                executablePath: "/usr/bin/sw_vers",
                arguments: ["-productVersion"],
                environment: [
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                    "HOME": "/var/empty",
                    "TMPDIR": "/tmp",
                ],
                maximumOutputBytes: 65,
                timeout: 2
            )
        } catch {
            throw HostOSProductVersionQueryError.unavailable
        }
        let data = result.standardOutput
        guard result.exitedNormally,
              result.terminationStatus == 0,
              !data.isEmpty,
              data.count <= 65,
              let text = String(data: data, encoding: .utf8)
        else {
            throw HostOSProductVersionQueryError.unavailable
        }
        let value: String
        if text.hasSuffix("\n") {
            value = String(text.dropLast())
        } else {
            value = text
        }
        guard !value.isEmpty,
              value.utf8.count <= 64,
              !value.contains(where: { $0.isWhitespace || $0.isNewline })
        else {
            throw HostOSProductVersionQueryError.unavailable
        }
        return value
    }
}
