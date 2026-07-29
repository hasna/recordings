import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    static func spawnProcessGroup(
        _ executable: String,
        arguments: [String],
        environment: [String: String]?,
        stdoutDescriptor: Int32,
        stderrDescriptor: Int32,
        stdoutReadDescriptor: Int32,
        stderrReadDescriptor: Int32
    ) throws -> pid_t {
        var duplicatedDescriptors: [Int32] = []
        defer {
            for descriptor in duplicatedDescriptors {
                Darwin.close(descriptor)
            }
        }
        let childStdoutDescriptor = try nonStandardDescriptor(
            stdoutDescriptor,
            duplicates: &duplicatedDescriptors
        )
        let childStderrDescriptor = try nonStandardDescriptor(
            stderrDescriptor,
            duplicates: &duplicatedDescriptors
        )

        var fileActions: posix_spawn_file_actions_t?
        try checkPOSIX(posix_spawn_file_actions_init(&fileActions), operation: "initialize spawn file actions")
        defer { posix_spawn_file_actions_destroy(&fileActions) }

        try checkPOSIX(
            posix_spawn_file_actions_adddup2(&fileActions, childStdoutDescriptor, STDOUT_FILENO),
            operation: "configure command stdout"
        )
        try checkPOSIX(
            posix_spawn_file_actions_adddup2(&fileActions, childStderrDescriptor, STDERR_FILENO),
            operation: "configure command stderr"
        )
        let inheritedDescriptors = Set([
            stdoutReadDescriptor,
            stderrReadDescriptor,
            stdoutDescriptor,
            stderrDescriptor,
            childStdoutDescriptor,
            childStderrDescriptor,
        ]).filter { $0 != STDOUT_FILENO && $0 != STDERR_FILENO }
        for descriptor in inheritedDescriptors {
            try checkPOSIX(
                posix_spawn_file_actions_addclose(&fileActions, descriptor),
                operation: "close inherited command descriptor"
            )
        }

        var attributes: posix_spawnattr_t?
        try checkPOSIX(posix_spawnattr_init(&attributes), operation: "initialize spawn attributes")
        defer { posix_spawnattr_destroy(&attributes) }
        var defaultSignals = sigset_t()
        Darwin.sigemptyset(&defaultSignals)
        Darwin.sigaddset(&defaultSignals, SIGTERM)
        try checkPOSIX(
            posix_spawnattr_setsigdefault(&attributes, &defaultSignals),
            operation: "reset command termination signal"
        )
        var unblockedSignals = sigset_t()
        Darwin.sigemptyset(&unblockedSignals)
        try checkPOSIX(
            posix_spawnattr_setsigmask(&attributes, &unblockedSignals),
            operation: "unblock command signals"
        )
        let spawnFlags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        try checkPOSIX(
            posix_spawnattr_setflags(&attributes, Int16(spawnFlags)),
            operation: "configure command process group"
        )
        try checkPOSIX(
            posix_spawnattr_setpgroup(&attributes, 0),
            operation: "configure command process group leader"
        )

        let environmentValues = (environment ?? ProcessInfo.processInfo.environment)
            .map { "\($0.key)=\($0.value)" }
        var processIdentifier: pid_t = 0
        let spawnResult = withMutableCStringArray([executable] + arguments) { argumentVector in
            withMutableCStringArray(environmentValues) { environmentVector in
                posix_spawn(
                    &processIdentifier,
                    executable,
                    &fileActions,
                    &attributes,
                    argumentVector,
                    environmentVector
                )
            }
        }
        try checkPOSIX(spawnResult, operation: "launch command")
        return processIdentifier
    }

    static func nonStandardDescriptor(
        _ descriptor: Int32,
        duplicates: inout [Int32]
    ) throws -> Int32 {
        guard descriptor == STDOUT_FILENO || descriptor == STDERR_FILENO else {
            return descriptor
        }
        let duplicate = Darwin.fcntl(descriptor, F_DUPFD_CLOEXEC, 3)
        guard duplicate != -1 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "Failed to duplicate command descriptor: \(String(cString: strerror(errno)))"]
            )
        }
        duplicates.append(duplicate)
        return duplicate
    }

    static func withMutableCStringArray<Result>(
        _ strings: [String],
        body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
    ) rethrows -> Result {
        var pointers = strings.map { strdup($0) }
        pointers.append(nil)
        defer {
            for pointer in pointers where pointer != nil {
                free(pointer)
            }
        }
        return try pointers.withUnsafeMutableBufferPointer { buffer in
            try body(buffer.baseAddress!)
        }
    }

    static func checkPOSIX(_ result: Int32, operation: String) throws {
        guard result == 0 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(result),
                userInfo: [NSLocalizedDescriptionKey: "Failed to \(operation): \(String(cString: strerror(result)))"]
            )
        }
    }

    static func waitForUnreapedLeaderExit(
        _ processIdentifier: pid_t,
        timeout: TimeInterval,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Bool {
        let deadline = monotonicUptimeDeadline(after: timeout)
        repeat {
            var information = siginfo_t()
            var result: Int32
            repeat {
                result = Darwin.waitid(
                    P_PID,
                    id_t(processIdentifier),
                    &information,
                    WEXITED | WNOHANG | WNOWAIT
                )
            } while result == -1 && errno == EINTR
            guard result == 0 else {
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errno),
                    userInfo: [NSLocalizedDescriptionKey: "Failed to observe command exit: \(String(cString: strerror(errno)))"]
                )
            }
            if information.si_pid == processIdentifier {
                lifecycleObserver?(.leaderExitObserved)
                return true
            }
            if DispatchTime.now().uptimeNanoseconds >= deadline { return false }
            usleep(10_000)
        } while true
    }

    static func signalProcessGroup(
        _ processGroup: pid_t,
        signal: Int32,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) {
        lifecycleObserver?(.processGroupSignaled(signal))
        _ = Darwin.kill(-processGroup, signal)
    }

    static func reapLeader(
        _ processIdentifier: pid_t,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Int32 {
        var waitStatus: Int32 = 0
        var waitResult: pid_t
        repeat {
            waitResult = Darwin.waitpid(processIdentifier, &waitStatus, 0)
        } while waitResult == -1 && errno == EINTR
        guard waitResult == processIdentifier else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "Failed to reap command: \(String(cString: strerror(errno)))"]
            )
        }
        let terminationStatus = decode(waitStatus: waitStatus)
        lifecycleObserver?(.leaderReaped(terminationStatus))
        return terminationStatus
    }

    static func reapLeaderInBackground(_ processIdentifier: pid_t) {
        DispatchQueue.global(qos: .utility).async {
            var waitStatus: Int32 = 0
            var waitResult: pid_t
            repeat {
                waitResult = Darwin.waitpid(processIdentifier, &waitStatus, 0)
            } while waitResult == -1 && errno == EINTR
        }
    }

    static func decode(waitStatus: Int32) -> Int32 {
        let signal = waitStatus & 0x7f
        if signal == 0 {
            return (waitStatus >> 8) & 0xff
        }
        return 128 + signal
    }

    static func monotonicDispatchDeadline(after timeout: TimeInterval) -> DispatchTime {
        DispatchTime(uptimeNanoseconds: monotonicUptimeDeadline(after: timeout))
    }

    static func monotonicUptimeDeadline(after timeout: TimeInterval) -> UInt64 {
        let now = DispatchTime.now().uptimeNanoseconds
        let maximumDelay = min(UInt64(Int64.max), UInt64.max - now)
        let requestedNanoseconds = timeout * 1_000_000_000
        let nanoseconds = requestedNanoseconds >= Double(maximumDelay)
            ? maximumDelay
            : UInt64(requestedNanoseconds.rounded(.up))
        return now + nanoseconds
    }

    /// Shuts capture down deterministically. Waits up to `pipeDrainTimeout` for the
    /// readers to observe end-of-file on their own — the complete-output path — then
    /// cancels and joins whatever is still running. Both reader threads have provably
    /// exited and both pipe read ends are closed before this returns: a silent escaped
    /// descendant still holding a write end observes a widowed pipe at that point, and no
    /// snapshot of captured output can race a reader mid-append.
    static func finishCaptures(
        _ readers: [PipeCaptureReader],
        pipeDrainTimeout: TimeInterval
    ) -> ExecutionError? {
        let deadline = monotonicDispatchDeadline(after: pipeDrainTimeout)
        for reader in readers {
            reader.waitUntilExited(deadline: deadline)
        }
        for reader in readers {
            reader.cancel()
        }
        for reader in readers {
            reader.join()
        }
        return readers.lazy.compactMap(\.terminalError).first
    }

    /// Owns one capture pipe end to end: it creates the pipe, lends the write end to the
    /// spawn, and consumes the read end on a dedicated thread that multiplexes the
    /// nonblocking pipe with a private wakeup pipe through poll(2). `cancel()` writes one
    /// wakeup byte, so the thread deterministically leaves poll even when a silent
    /// escaped descendant keeps the write end open forever without writing a byte — POSIX
    /// does not promise that replacing or closing a descriptor interrupts a read(2)
    /// already blocked on it, so the blocking-read + dup2 revocation this replaces could
    /// leave the reader thread and the process's pipe reference alive indefinitely.
    ///
    /// The runner must keep owning every reference to the read descriptor itself:
    /// `FileHandle.readabilityHandler` keeps a private duplicate of the descriptor that
    /// can survive `close()` while data is flowing, which would leave the pipe readable
    /// forever — a descendant that inherited the write end would never observe EPIPE, and
    /// the descriptor would leak in this process. Never reintroduce it here.
    final class PipeCaptureReader: @unchecked Sendable {
        struct SystemCalls: @unchecked Sendable {
            let makePipe: (_ operation: String) throws -> (read: Int32, write: Int32)
            let fcntl: (_ descriptor: Int32, _ command: Int32, _ value: Int32?) -> Int32
            let close: (_ descriptor: Int32) -> Int32
            let read: (
                _ descriptor: Int32,
                _ buffer: UnsafeMutableRawPointer?,
                _ count: Int
            ) -> Int
            let poll: (
                _ descriptors: UnsafeMutablePointer<pollfd>?,
                _ count: nfds_t,
                _ timeout: Int32
            ) -> Int32

            init(
                makePipe: @escaping (_ operation: String) throws -> (read: Int32, write: Int32) = {
                    try PipeCaptureReader.makePipe(operation: $0)
                },
                fcntl: @escaping (
                    _ descriptor: Int32,
                    _ command: Int32,
                    _ value: Int32?
                ) -> Int32 = { descriptor, command, value in
                    if let value {
                        return Darwin.fcntl(descriptor, command, value)
                    }
                    return Darwin.fcntl(descriptor, command)
                },
                close: @escaping (_ descriptor: Int32) -> Int32 = { Darwin.close($0) },
                read: @escaping (
                    _ descriptor: Int32,
                    _ buffer: UnsafeMutableRawPointer?,
                    _ count: Int
                ) -> Int = { Darwin.read($0, $1, $2) },
                poll: @escaping (
                    _ descriptors: UnsafeMutablePointer<pollfd>?,
                    _ count: nfds_t,
                    _ timeout: Int32
                ) -> Int32 = { Darwin.poll($0, $1, $2) }
            ) {
                self.makePipe = makePipe
                self.fcntl = fcntl
                self.close = close
                self.read = read
                self.poll = poll
            }

            static let live = SystemCalls()
        }

        /// Write end lent to the spawned child; the runner closes it through
        /// `closeWriteDescriptor()` once the child holds its own copies.
        let writeDescriptor: Int32
        /// Read end consumed — and eventually closed — exclusively by the reader thread.
        let readDescriptor: Int32

        private let wakeupReadDescriptor: Int32
        private let wakeupWriteDescriptor: Int32
        private let systemCalls: SystemCalls
        private let capture = ProcessDataCapture()
        private let exited = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var cancelRequested = false
        private var writeDescriptorClosed = false
        private var wakeupDescriptorsClosed = false
        private var storedTerminalError: ExecutionError?

        /// Reads per drain burst between polls, so a flooding writer cannot starve the
        /// wakeup descriptor check.
        private static let drainReadLimit = 64
        /// Reads allowed after cancellation — comfortably above the kernel's largest pipe
        /// buffer, so an already-buffered tail is never dropped, yet `join()` stays
        /// prompt against a descendant that keeps writing.
        private static let cancelledDrainReadLimit = 16

        init(systemCalls: SystemCalls = .live) throws {
            let dataPipe = try systemCalls.makePipe("create capture pipe")
            let wakeupPipe: (read: Int32, write: Int32)
            do {
                wakeupPipe = try systemCalls.makePipe("create capture wakeup pipe")
            } catch {
                _ = systemCalls.close(dataPipe.read)
                _ = systemCalls.close(dataPipe.write)
                throw error
            }

            let descriptors = [dataPipe.read, dataPipe.write, wakeupPipe.read, wakeupPipe.write]
            var setupSucceeded = false
            defer {
                if !setupSucceeded {
                    for descriptor in descriptors {
                        _ = systemCalls.close(descriptor)
                    }
                }
            }

            for descriptor in descriptors {
                let descriptorFlags = try Self.checkedFcntl(
                    descriptor,
                    command: F_GETFD,
                    operation: "read capture descriptor flags",
                    systemCalls: systemCalls
                )
                _ = try Self.checkedFcntl(
                    descriptor,
                    command: F_SETFD,
                    value: descriptorFlags | FD_CLOEXEC,
                    operation: "protect capture descriptor from inheritance",
                    systemCalls: systemCalls
                )
            }
            let readFlags = try Self.checkedFcntl(
                dataPipe.read,
                command: F_GETFL,
                operation: "read capture pipe status flags",
                systemCalls: systemCalls
            )
            _ = try Self.checkedFcntl(
                dataPipe.read,
                command: F_SETFL,
                value: readFlags | O_NONBLOCK,
                operation: "make capture pipe nonblocking",
                systemCalls: systemCalls
            )

            readDescriptor = dataPipe.read
            writeDescriptor = dataPipe.write
            wakeupReadDescriptor = wakeupPipe.read
            wakeupWriteDescriptor = wakeupPipe.write
            self.systemCalls = systemCalls
            setupSucceeded = true
            Thread.detachNewThread { [self] in consumePipe() }
        }

        deinit {
            // The reader thread retains this object until it has closed the read end.
            // Callers must still close/cancel/join; this only releases any remaining
            // owner-side descriptors after the reader has already exited.
            if !writeDescriptorClosed { _ = systemCalls.close(writeDescriptor) }
            if !wakeupDescriptorsClosed {
                _ = systemCalls.close(wakeupReadDescriptor)
                _ = systemCalls.close(wakeupWriteDescriptor)
            }
        }

        /// Everything captured so far; stable and complete once `join()` has returned.
        var data: Data { capture.data }

        /// A terminal capture failure, stable once `join()` has returned. Cancellation
        /// and ordinary end-of-file are not failures.
        var terminalError: ExecutionError? {
            lock.lock()
            defer { lock.unlock() }
            return storedTerminalError
        }

        func closeWriteDescriptor() {
            lock.lock()
            defer { lock.unlock() }
            guard !writeDescriptorClosed else { return }
            writeDescriptorClosed = true
            _ = systemCalls.close(writeDescriptor)
        }

        /// Waits until `deadline` for the reader thread to exit on its own — that is,
        /// for end-of-file once every write end is closed. Returns whether it has.
        @discardableResult
        func waitUntilExited(deadline: DispatchTime) -> Bool {
            guard exited.wait(timeout: deadline) == .success else { return false }
            exited.signal()
            return true
        }

        /// Wakes the reader thread out of poll(2) even when the capture pipe never
        /// becomes readable again. Idempotent; never blocks.
        func cancel() {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelRequested, !wakeupDescriptorsClosed else { return }
            cancelRequested = true
            var wakeupByte: UInt8 = 1
            var result: Int
            repeat {
                result = Darwin.write(wakeupWriteDescriptor, &wakeupByte, 1)
            } while result == -1 && errno == EINTR
        }

        /// Blocks until the reader thread has provably exited and closed the pipe read
        /// end, then releases the wakeup pipe. Callers must `cancel()` first whenever the
        /// pipe may never reach end-of-file; the wakeup then bounds this wait to thread
        /// scheduling plus one final drain burst. Idempotent.
        func join() {
            exited.wait()
            exited.signal()
            lock.lock()
            defer { lock.unlock() }
            guard !wakeupDescriptorsClosed else { return }
            wakeupDescriptorsClosed = true
            _ = systemCalls.close(wakeupReadDescriptor)
            _ = systemCalls.close(wakeupWriteDescriptor)
        }

        private func consumePipe() {
            Thread.current.name = "CLIRunner.PipeCaptureReader"
            var buffer = [UInt8](repeating: 0, count: 65_536)
            var cancelled = false
            readLoop: while true {
                var reads = 0
                var sawEndOfFile = false
                var sawFailure = false
                let readLimit = cancelled ? Self.cancelledDrainReadLimit : Self.drainReadLimit
                while reads < readLimit {
                    let count = buffer.withUnsafeMutableBytes {
                        systemCalls.read(readDescriptor, $0.baseAddress, $0.count)
                    }
                    if count > 0 {
                        capture.append(Data(bytes: buffer, count: count))
                        reads += 1
                        continue
                    }
                    if count == 0 {
                        sawEndOfFile = true
                    } else if errno == EINTR {
                        continue
                    } else if errno != EAGAIN {
                        storeTerminalError(operation: .read, code: errno)
                        sawFailure = true
                    }
                    break
                }
                if sawEndOfFile || sawFailure || cancelled { break readLoop }
                var descriptors = [
                    pollfd(fd: readDescriptor, events: Int16(POLLIN), revents: 0),
                    pollfd(fd: wakeupReadDescriptor, events: Int16(POLLIN), revents: 0),
                ]
                let events = systemCalls.poll(&descriptors, 2, -1)
                if events == -1 {
                    if errno == EINTR { continue readLoop }
                    storeTerminalError(operation: .poll, code: errno)
                    break readLoop
                }
                if descriptors[0].revents & Int16(POLLNVAL) != 0 {
                    storeTerminalError(operation: .poll, code: EBADF)
                    break readLoop
                }
                if descriptors[0].revents & Int16(POLLERR) != 0 {
                    storeTerminalError(operation: .poll, code: EIO)
                    break readLoop
                }
                if descriptors[1].revents & Int16(POLLNVAL) != 0 {
                    storeTerminalError(operation: .poll, code: EBADF)
                    break readLoop
                }
                if descriptors[1].revents & Int16(POLLERR) != 0 {
                    storeTerminalError(operation: .poll, code: EIO)
                    break readLoop
                }
                if descriptors[1].revents != 0 {
                    // One final bounded drain of already-buffered data, then exit.
                    cancelled = true
                }
            }
            _ = capture.finish()
            _ = systemCalls.close(readDescriptor)
            exited.signal()
        }

        private func storeTerminalError(operation: CaptureOperation, code: Int32) {
            lock.lock()
            defer { lock.unlock() }
            guard storedTerminalError == nil else { return }
            storedTerminalError = .captureFailed(operation: operation, code: code)
        }

        private static func makePipe(operation: String) throws -> (read: Int32, write: Int32) {
            var ends: [Int32] = [0, 0]
            guard Darwin.pipe(&ends) == 0 else {
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errno),
                    userInfo: [NSLocalizedDescriptionKey: "Failed to \(operation): \(String(cString: strerror(errno)))"]
                )
            }
            return (ends[0], ends[1])
        }

        private static func checkedFcntl(
            _ descriptor: Int32,
            command: Int32,
            value: Int32? = nil,
            operation: String,
            systemCalls: SystemCalls
        ) throws -> Int32 {
            var result: Int32
            repeat {
                result = systemCalls.fcntl(descriptor, command, value)
            } while result == -1 && errno == EINTR
            guard result != -1 else {
                let errorNumber = errno
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errorNumber),
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Failed to \(operation): \(String(cString: strerror(errorNumber)))"
                    ]
                )
            }
            return result
        }
    }

    static func parseError(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("ERROR:") else { return nil }
        let message = NativeErrorSanitizer.sanitize(
            trimmed.dropFirst("ERROR:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let lowercased = message.lowercased()
        if lowercased.contains("401") || lowercased.contains("incorrect api key")
            || lowercased.contains("invalid_api_key") || lowercased.contains("invalid or expired") {
            return "OpenAI API key invalid or expired — update it in Recordings Settings"
        }
        if lowercased.contains("429") || lowercased.contains("exceeded your current quota")
            || lowercased.contains("insufficient_quota") || lowercased.contains("quota exceeded") {
            return "OpenAI quota exceeded — check the OpenAI account billing"
        }
        if message.contains("OpenAI API key not configured") {
            return "OpenAI API key not configured on this Mac"
        }
        if message.isEmpty {
            return "Transcription failed"
        }
        return String(message.prefix(120))
    }

    /// The raw (pre-enhancement) transcript from a CLI JSON envelope. Intent decisions must
    /// run on this, never on `processed_text`.
    static func parseRawTranscript(_ output: String) -> String? {
        guard let s = output.range(of: "{"), let e = output.range(of: "}", options: .backwards),
              s.lowerBound < e.upperBound else { return nil }
        let json = String(output[s.lowerBound..<e.upperBound])
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["raw_text"] as? String,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return raw
    }

    static func parseJSON(_ output: String) -> String? {
        if let s = output.range(of: "{"), let e = output.range(of: "}", options: .backwards),
           s.lowerBound < e.upperBound {
            let json = String(output[s.lowerBound..<e.upperBound])
            if let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let t = obj["processed_text"] as? String, !t.isEmpty { return t }
                if let t = obj["raw_text"] as? String, !t.isEmpty { return t }
            }
        }
        return output.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.hasPrefix("{") && !$0.contains("Transcribing") && !$0.hasPrefix("Saved") && !$0.hasPrefix("ERROR:") }
    }
}
