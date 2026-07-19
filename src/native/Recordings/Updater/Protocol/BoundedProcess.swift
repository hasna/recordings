import Darwin
import Foundation

public struct BoundedProcessResult: Sendable {
    public let standardOutput: Data
    public let exitedNormally: Bool
    public let terminationStatus: Int32
}

public enum BoundedProcessError: Error, Equatable, Sendable {
    case invalidConfiguration
    case launchFailed
    case timedOut
    case outputTooLarge
    case outputReadFailed
}

/// Runs a fixed executable with bounded stdout and a hard wall-clock deadline.
///
/// Stdout is drained with nonblocking `poll(2)`, preventing either the child or an
/// inherited-pipe descendant from extending the wall-clock bound. The reader
/// retains at most `maximumOutputBytes`; the first byte beyond that limit kills the
/// direct child, closes the pipe, and fails closed.
public enum BoundedProcessRunner {
    public static func run(
        executablePath: String,
        arguments: [String],
        environment: [String: String],
        maximumOutputBytes: Int,
        timeout: TimeInterval
    ) throws -> BoundedProcessResult {
        guard executablePath.hasPrefix("/"),
              maximumOutputBytes >= 0,
              timeout > 0,
              timeout <= 3_600,
              timeout.isFinite
        else {
            throw BoundedProcessError.invalidConfiguration
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw BoundedProcessError.launchFailed
        }

        let processIdentifier = process.processIdentifier
        let outputHandle = output.fileHandleForReading
        let outputDescriptor = outputHandle.fileDescriptor
        let existingFlags = Darwin.fcntl(outputDescriptor, F_GETFL)
        guard existingFlags >= 0,
              Darwin.fcntl(outputDescriptor, F_SETFL, existingFlags | O_NONBLOCK) >= 0
        else {
            if process.isRunning { _ = Darwin.kill(processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw BoundedProcessError.outputReadFailed
        }
        let startedAt = DispatchTime.now().uptimeNanoseconds
        let timeoutNanoseconds = UInt64(timeout * 1_000_000_000)
        let deadline = startedAt + timeoutNanoseconds

        var standardOutput = Data()
        var outputTooLarge = false
        var outputReadFailed = false
        var timedOut = false
        var reachedEOF = false
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while !reachedEOF && !outputTooLarge && !outputReadFailed {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline {
                timedOut = true
                break
            }
            let remainingNanoseconds = deadline - now
            let remainingMilliseconds = max(
                1,
                min(
                    Int(Int32.max),
                    Int((remainingNanoseconds + 999_999) / 1_000_000)
                )
            )
            var descriptor = pollfd(
                fd: outputDescriptor,
                events: Int16(POLLIN | POLLHUP | POLLERR),
                revents: 0
            )
            let pollResult = Darwin.poll(&descriptor, 1, Int32(remainingMilliseconds))
            if pollResult == 0 {
                timedOut = true
                break
            }
            if pollResult < 0 {
                if errno == EINTR { continue }
                outputReadFailed = true
                break
            }
            while true {
                let count = buffer.withUnsafeMutableBytes { bytes in
                    Darwin.read(outputDescriptor, bytes.baseAddress, bytes.count)
                }
                if count > 0 {
                    if count > maximumOutputBytes - standardOutput.count {
                        outputTooLarge = true
                        break
                    }
                    standardOutput.append(contentsOf: buffer.prefix(count))
                    continue
                }
                if count == 0 {
                    reachedEOF = true
                    break
                }
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                outputReadFailed = true
                break
            }
        }

        while !timedOut && !outputTooLarge && !outputReadFailed && process.isRunning {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline {
                timedOut = true
                break
            }
            let remaining = Double(deadline - now) / 1_000_000_000
            Thread.sleep(forTimeInterval: min(0.005, remaining))
        }

        if timedOut || outputTooLarge || outputReadFailed {
            if process.isRunning {
                _ = Darwin.kill(processIdentifier, SIGKILL)
            }
            do {
                try outputHandle.close()
            } catch {
                outputReadFailed = true
            }
        }
        process.waitUntilExit()

        if timedOut { throw BoundedProcessError.timedOut }
        if outputTooLarge { throw BoundedProcessError.outputTooLarge }
        if outputReadFailed { throw BoundedProcessError.outputReadFailed }
        return BoundedProcessResult(
            standardOutput: standardOutput,
            exitedNormally: process.terminationReason == .exit,
            terminationStatus: process.terminationStatus
        )
    }
}
