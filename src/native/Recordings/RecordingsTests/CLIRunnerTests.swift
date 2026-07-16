import Foundation
import Darwin
import Testing
@testable import RecordingsLib

struct CLIRunnerTests {
    @Test("bundled CLI takes precedence over a stale user installation")
    func bundledCLIIsPreferred() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-bundled-cli-\(UUID().uuidString)")
        let app = root.appendingPathComponent("Recordings.app")
        let helper = app.appendingPathComponent("Contents/Helpers/recordings")
        let home = root.appendingPathComponent("home")
        let external = home.appendingPathComponent(".bun/bin/recordings")
        try FileManager.default.createDirectory(
            at: helper.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: external.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "bundled".write(to: helper, atomically: true, encoding: .utf8)
        try "stale".write(to: external, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        let command = CLIRunner.resolveCommand(home: home.path, bundleURL: app)

        #expect(command.executable == helper.path)
        #expect(command.argumentsPrefix.isEmpty)
    }

    @Test("packaged app never falls back when its bundled CLI is missing")
    func packagedAppDoesNotUseGlobalFallback() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-missing-companion-\(UUID().uuidString)")
        let app = root.appendingPathComponent("Recordings.app")
        let home = root.appendingPathComponent("home")
        let external = home.appendingPathComponent(".bun/bin/recordings")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: external.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "stale".write(to: external, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        let command = CLIRunner.resolveCommand(home: home.path, bundleURL: app)

        #expect(command.executable == app.appendingPathComponent("Contents/Helpers/recordings").path)
        #expect(command.executable != external.path)
    }

    @Test("process runner drains more than one MiB from stdout and stderr without blocking")
    func drainsLargeConcurrentOutput() throws {
        let command = """
        (dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr '\\0' o) &
        (dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr '\\0' e >&2) &
        wait
        """
        let result = try CLIRunner.runExecutable("/bin/sh", arguments: ["-c", command])
        #expect(result.terminationStatus == 0)
        #expect(result.stdout.utf8.count == 2 * 1_048_576)
        #expect(result.stderr.utf8.count == 2 * 1_048_576)
        #expect(result.stdout.first == "o")
        #expect(result.stderr.first == "e")
    }

    @Test("process runner observes immediate exits without false timeouts")
    func observesImmediateExits() throws {
        for _ in 0..<25 {
            let result = try CLIRunner.runExecutable(
                "/usr/bin/true",
                arguments: [],
                executionTimeout: 0.1,
                terminationGracePeriod: 0,
                forceKillGracePeriod: 0.1,
                pipeDrainTimeout: 0.1
            )
            #expect(result.terminationStatus == 0)
        }
    }

    @Test("process runner terminates an entire command process group after its deadline")
    func forceKillsTimedOutProcessGroup() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-cli-timeout-\(UUID().uuidString)")
        let script = root.appendingPathComponent("ignore-term-parent.sh")
        let childScript = root.appendingPathComponent("ignore-term-child.sh")
        let parentPidFile = root.appendingPathComponent("parent-pid")
        let childPidFile = root.appendingPathComponent("child-pid")
        let termFile = root.appendingPathComponent("term-received")
        let sideEffectFile = root.appendingPathComponent("server-side-effect")
        let readinessFIFO = root.appendingPathComponent("ready")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try #require(Darwin.mkfifo(readinessFIFO.path, 0o600) == 0)
        defer {
            let runnerProcessGroup = Darwin.getpgrp()
            if let parentPid = Self.readPID(from: parentPidFile) {
                let childProcessGroup = Darwin.getpgid(parentPid)
                if childProcessGroup == parentPid, childProcessGroup != runnerProcessGroup {
                    _ = Darwin.kill(-childProcessGroup, SIGKILL)
                } else {
                    _ = Darwin.kill(parentPid, SIGKILL)
                }
            }
            if let childPid = Self.readPID(from: childPidFile) {
                _ = Darwin.kill(childPid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try """
        #!/bin/sh
        trap 'printf term > "$2"' TERM
        printf '%s' "$$" > "$1"
        "$4" "$5" "$6" &
        while [ ! -s "$5" ] || [ ! -s "$6" ]; do /bin/sleep 0.01; done
        printf parent-output
        printf parent-error >&2
        printf ready > "$3"
        while :; do /bin/sleep 0.05; done
        """.write(to: script, atomically: true, encoding: .utf8)
        try """
        #!/bin/sh
        trap '' TERM HUP
        printf '%s' "$$" > "$1"
        printf child-output
        printf child-error >&2
        while :; do
          printf tick >> "$2"
          /bin/sleep 0.02
        done
        """.write(to: childScript, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: childScript.path)

        var executionDeadlineStartedAt: ContinuousClock.Instant?
        var observedReadiness = false
        var lifecycleEvents: [CLIRunner.ProcessLifecycleEvent] = []
        do {
            _ = try CLIRunner.runExecutable(
                script.path,
                arguments: [
                    parentPidFile.path,
                    termFile.path,
                    readinessFIFO.path,
                    childScript.path,
                    childPidFile.path,
                    sideEffectFile.path,
                ],
                executionTimeout: 0.2,
                terminationGracePeriod: 0.5,
                forceKillGracePeriod: 0.5,
                pipeDrainTimeout: 0.2,
                beforeExecutionDeadline: {
                    guard let handle = FileHandle(forReadingAtPath: readinessFIFO.path) else { return }
                    defer { try? handle.close() }
                    observedReadiness = handle.readDataToEndOfFile() == Data("ready".utf8)
                    guard let parentPid = Self.readPID(from: parentPidFile),
                          let childPid = Self.readPID(from: childPidFile) else {
                        Issue.record("ready process group did not publish both process identifiers")
                        return
                    }
                    let processGroup = Darwin.getpgid(parentPid)
                    #expect(processGroup == parentPid)
                    #expect(Darwin.getpgid(childPid) == parentPid)
                    #expect(processGroup != Darwin.getpgrp())
                    executionDeadlineStartedAt = ContinuousClock.now
                },
                lifecycleObserver: { lifecycleEvents.append($0) }
            )
            Issue.record("command unexpectedly completed before its deadline")
        } catch let error as CLIRunner.ExecutionError {
            guard case let .timedOut(executable, seconds) = error else {
                Issue.record("command returned the wrong execution error: \(error)")
                return
            }
            #expect(executable == script.path)
            #expect(seconds == 0.2)
            #expect(error.localizedDescription.contains("timed out"))
        }

        let startedAt = try #require(executionDeadlineStartedAt)
        #expect(ContinuousClock.now - startedAt < .seconds(2.5))
        #expect(observedReadiness)
        #expect(try String(contentsOf: termFile, encoding: .utf8) == "term")
        #expect(lifecycleEvents == [
            .processGroupSignaled(SIGTERM),
            .processGroupSignaled(SIGKILL),
            .leaderExitObserved,
            .leaderReaped(128 + SIGKILL),
        ])
        let parentPid = try #require(Self.readPID(from: parentPidFile))
        let childPid = try #require(Self.readPID(from: childPidFile))
        let processGroup = parentPid
        expectProcessIsGone(parentPid)
        expectProcessIsGone(childPid)
        expectProcessGroupIsGone(processGroup)

        let sideEffectSize = try Data(contentsOf: sideEffectFile).count
        Thread.sleep(forTimeInterval: 0.15)
        #expect(try Data(contentsOf: sideEffectFile).count == sideEffectSize)
    }

    private static func readPID(from file: URL) -> pid_t? {
        guard let value = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return pid_t(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func expectProcessIsGone(_ pid: pid_t, sourceLocation: SourceLocation = #_sourceLocation) {
        let (result, error) = pollForMissingProcess(pid)
        #expect(result == -1, sourceLocation: sourceLocation)
        #expect(error == ESRCH, sourceLocation: sourceLocation)
    }

    private func expectProcessGroupIsGone(
        _ processGroup: pid_t,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        let (result, error) = pollForMissingProcess(-processGroup)
        #expect(result == -1, sourceLocation: sourceLocation)
        #expect(error == ESRCH, sourceLocation: sourceLocation)
    }

    private func pollForMissingProcess(_ processOrNegativeGroup: pid_t) -> (Int32, Int32) {
        let deadline = ContinuousClock.now + .milliseconds(500)
        var result: Int32 = 0
        var error: Int32 = 0
        repeat {
            errno = 0
            result = Darwin.kill(processOrNegativeGroup, 0)
            error = errno
            if result == -1, error == ESRCH { return (result, error) }
            Thread.sleep(forTimeInterval: 0.01)
        } while ContinuousClock.now < deadline
        errno = 0
        result = Darwin.kill(processOrNegativeGroup, 0)
        error = errno
        return (result, error)
    }

    @Test("process runner cleans up a background descendant after its leader exits")
    func cleansUpInheritedPipeDescendant() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-cli-background-\(UUID().uuidString)")
        let childPidFile = root.appendingPathComponent("child-pid")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            if let childPid = Self.readPID(from: childPidFile) {
                _ = Darwin.kill(childPid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: root)
        }
        let command = """
        /bin/sh -c 'printf "%s" "$$" > "$1"; trap "" TERM HUP; while :; do /bin/sleep 1; done' child '\(childPidFile.path)' &
        while [ ! -s '\(childPidFile.path)' ]; do /bin/sleep 0.01; done
        printf 'complete'
        printf 'warning' >&2
        exit 23
        """
        let startedAt = ContinuousClock.now
        var lifecycleEvents: [CLIRunner.ProcessLifecycleEvent] = []

        let result = try CLIRunner.runExecutable(
            "/bin/sh",
            arguments: ["-c", command],
            executionTimeout: 1,
            terminationGracePeriod: 0.2,
            forceKillGracePeriod: 0.2,
            pipeDrainTimeout: 0.3,
            lifecycleObserver: { lifecycleEvents.append($0) }
        )

        #expect(ContinuousClock.now - startedAt < .seconds(1.5))
        #expect(result.terminationStatus == 23)
        #expect(result.stdout == "complete")
        #expect(result.stderr == "warning")
        #expect(lifecycleEvents == [
            .leaderExitObserved,
            .processGroupSignaled(SIGTERM),
            .processGroupSignaled(SIGKILL),
            .leaderReaped(23),
        ])
        expectProcessIsGone(try #require(Self.readPID(from: childPidFile)))
    }

    @Test("a total wall-clock budget bounds execution, termination grace, kill grace, and pipe drain together")
    func totalWallClockBudgetBoundsCleanup() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-cli-wall-budget-\(UUID().uuidString)")
        let script = root.appendingPathComponent("ignore-term.sh")
        let pidFile = root.appendingPathComponent("pid")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            if let pid = Self.readPID(from: pidFile) {
                _ = Darwin.kill(pid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try """
        #!/bin/sh
        trap '' TERM
        printf '%s' "$$" > "$1"
        while :; do /bin/sleep 0.05; done
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let startedAt = ContinuousClock.now
        var lifecycleEvents: [CLIRunner.ProcessLifecycleEvent] = []
        do {
            _ = try CLIRunner.runExecutable(
                script.path,
                arguments: [pidFile.path],
                executionTimeout: 60,
                totalWallClockBudget: 2,
                lifecycleObserver: { lifecycleEvents.append($0) }
            )
            Issue.record("command unexpectedly completed inside its wall budget")
        } catch let error as CLIRunner.ExecutionError {
            guard case let .timedOut(_, seconds) = error else {
                Issue.record("command returned the wrong execution error: \(error)")
                return
            }
            // The execution window is the budget minus the cleanup reserve, never the
            // caller's larger execution timeout.
            #expect(seconds == 2 - CLIRunner.wallClockCleanupReserve)
        }
        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(lifecycleEvents.contains(.processGroupSignaled(SIGTERM)))
        #expect(lifecycleEvents.contains(.processGroupSignaled(SIGKILL)))
        if let pid = Self.readPID(from: pidFile) {
            expectProcessIsGone(pid)
        }
    }

    @Test("a hung rewrite helper returns within the 10 s interactive budget, cleanup included")
    @MainActor
    func hungRewriteHelperReturnsWithinInteractiveBudget() async throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-rewrite-budget-\(UUID().uuidString)")
        let bin = home.appendingPathComponent(".bun/bin")
        let pidFile = home.appendingPathComponent("pid")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        try """
        #!/bin/sh
        trap '' TERM
        printf '%s' "$$" > '\(pidFile.path)'
        while :; do /bin/sleep 0.05; done
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        defer {
            if let pid = Self.readPID(from: pidFile) {
                _ = Darwin.kill(pid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: home)
        }

        // The production seam exactly as runCommandMode uses it: the engine's default
        // commandCLI closure on a detached task, budgeted by commandRewriteTimeout — the
        // observable wall time must stay inside the budget even though the helper never
        // exits on its own and ignores SIGTERM.
        let runCLI = RecordingEngine().commandCLI
        let homePath = home.path
        let startedAt = ContinuousClock.now
        let output = await Task.detached {
            runCLI(["rewrite-selection"], homePath, RecordingEngine.commandRewriteTimeout)
        }.value
        let elapsed = ContinuousClock.now - startedAt

        #expect(elapsed < .seconds(RecordingEngine.commandRewriteTimeout))
        #expect(output.hasPrefix("ERROR:"))
        #expect(output.contains("timed out"))
    }

    @Test("an exhausted rewrite deadline with pipes held by an escaped descendant returns under the public ceiling")
    @MainActor
    func exhaustedRewriteDeadlineWithHeldPipesReturnsUnderCeiling() async throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-rewrite-exhaustion-\(UUID().uuidString)")
        let bin = home.appendingPathComponent(".bun/bin")
        let leaderPidFile = home.appendingPathComponent("leader-pid")
        let holderPidFile = home.appendingPathComponent("holder-pid")
        let markerFile = home.appendingPathComponent("holder-epipe")
        let holderSource = home.appendingPathComponent("pipe-holder.c")
        let holderBinary = home.appendingPathComponent("pipe-holder")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        defer {
            if let holderPid = Self.readPID(from: holderPidFile) {
                _ = Darwin.kill(holderPid, SIGKILL)
            }
            if let leaderPid = Self.readPID(from: leaderPidFile) {
                _ = Darwin.kill(-leaderPid, SIGKILL)
                _ = Darwin.kill(leaderPid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: home)
        }

        // The holder escapes the CLI process group via setsid before any group-directed
        // signal can reach it, inherits both capture pipes, and keeps their write ends open
        // until the runner closes its read ends — at which point every write fails with
        // EPIPE and the marker file records that both descriptor readers were shut down.
        try """
        #include <errno.h>
        #include <signal.h>
        #include <stdio.h>
        #include <time.h>
        #include <unistd.h>

        int main(int argc, char **argv) {
            if (argc < 3) return 64;
            if (setsid() == -1) return 65;
            signal(SIGPIPE, SIG_IGN);
            FILE *pid = fopen(argv[1], "w");
            if (!pid) return 66;
            fprintf(pid, "%d", (int)getpid());
            fclose(pid);
            int stdoutBroken = 0;
            int stderrBroken = 0;
            while (!stdoutBroken || !stderrBroken) {
                if (!stdoutBroken && write(STDOUT_FILENO, "x", 1) == -1 && errno == EPIPE) stdoutBroken = 1;
                if (!stderrBroken && write(STDERR_FILENO, "y", 1) == -1 && errno == EPIPE) stderrBroken = 1;
                struct timespec delay = {0, 50000000};
                nanosleep(&delay, 0);
            }
            FILE *marker = fopen(argv[2], "w");
            if (!marker) return 67;
            fputs("both-epipe", marker);
            fclose(marker);
            return 0;
        }
        """.write(to: holderSource, atomically: true, encoding: .utf8)
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/cc")
        compile.arguments = ["-o", holderBinary.path, holderSource.path]
        try compile.run()
        compile.waitUntilExit()
        try #require(compile.terminationStatus == 0)

        let executable = bin.appendingPathComponent("recordings")
        try """
        #!/bin/sh
        trap '' TERM
        printf '%s' "$$" > '\(leaderPidFile.path)'
        '\(holderBinary.path)' '\(holderPidFile.path)' '\(markerFile.path)' &
        while [ ! -s '\(holderPidFile.path)' ]; do /bin/sleep 0.01; done
        while :; do /bin/sleep 0.05; done
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        // The production seam exactly as runCommandMode uses it. The leader ignores SIGTERM
        // (exhausting the execution window and the termination grace), only dies at the
        // group SIGKILL, and the escaped holder keeps both pipes open so the drain wait
        // also runs to exhaustion. The observable wall time must still land under the
        // public ceiling — the return margin absorbs spawn, poll overshoot, capture
        // shutdown, and the task hops.
        let runCLI = RecordingEngine().commandCLI
        let homePath = home.path
        let startedAt = ContinuousClock.now
        let output = await Task.detached {
            runCLI(["rewrite-selection"], homePath, RecordingEngine.commandRewriteTimeout)
        }.value
        let elapsed = ContinuousClock.now - startedAt

        // Upper bound is the public promise, with the ~1 s return margin left as CI
        // tolerance above the internal deadline; the lower bound proves the deadline chain
        // really ran to exhaustion instead of the helper exiting early.
        #expect(elapsed < .seconds(RecordingEngine.commandRewriteTimeout))
        #expect(elapsed > .seconds(8.4))
        #expect(output.hasPrefix("ERROR:"))
        #expect(output.contains("timed out"))

        let leaderPid = try #require(Self.readPID(from: leaderPidFile))
        expectProcessIsGone(leaderPid)
        expectProcessGroupIsGone(leaderPid)

        // The runner returned while the holder still owned both write ends; its EPIPE
        // marker proves the capture read descriptors were closed rather than left behind
        // with live readers, and the holder exits on its own once both pipes are broken.
        let holderPid = try #require(Self.readPID(from: holderPidFile))
        var marker: String?
        let markerDeadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < markerDeadline {
            if let contents = try? String(contentsOf: markerFile, encoding: .utf8), !contents.isEmpty {
                marker = contents
                break
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(marker == "both-epipe")
        expectProcessIsGone(holderPid)
    }

    @Test("the replaced shutdown returned without joining its readers and could snapshot truncated output")
    func oldShutdownReturnedBeforeReadersExited() throws {
        // Faithful reconstruction of the shutdown this runner used before
        // PipeCaptureReader: a blocking reader thread tracked only by a DispatchGroup,
        // and a finishCaptures that waited with a timeout, revoked the descriptor slot
        // with dup2(/dev/null), scheduled the close on an async notify, and returned
        // with no happens-before edge to the reader's exit.
        //
        // (Measured on macOS 26.0.1: dup2 over a blocked read(2) DOES wake the reader
        // and widow the pipe — an undocumented Darwin drain that POSIX does not promise
        // and Linux does not perform. The suspected silent-holder hang therefore only
        // appears if the kernel ever stops extending that courtesy; the defect provable
        // on every schedule is this one: nothing stopped the runner from snapshotting
        // output while a reader sat between its read(2) and its append.)
        final class CapturedBytes: @unchecked Sendable {
            private let lock = NSLock()
            private var storage = Data()
            func append(_ data: Data) {
                lock.lock()
                storage.append(data)
                lock.unlock()
            }
            var snapshot: Data {
                lock.lock()
                defer { lock.unlock() }
                return storage
            }
        }

        var ends: [Int32] = [0, 0]
        try #require(Darwin.pipe(&ends) == 0)
        let readDescriptor = ends[0]
        let writeDescriptor = ends[1]
        let capture = CapturedBytes()
        let readers = DispatchGroup()
        // A legal scheduler preemption point between the read returning and the append
        // landing; the old shutdown had nothing that excluded this interleaving.
        let preemptedBetweenReadAndAppend = DispatchSemaphore(value: 0)
        readers.enter()
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 65_536)
            var firstRead = true
            while true {
                let count = buffer.withUnsafeMutableBytes {
                    Darwin.read(readDescriptor, $0.baseAddress, $0.count)
                }
                if count > 0 {
                    if firstRead {
                        firstRead = false
                        _ = preemptedBetweenReadAndAppend.wait(timeout: .now() + .seconds(10))
                    }
                    capture.append(Data(bytes: buffer, count: count))
                    continue
                }
                if count == -1 && errno == EINTR { continue }
                break
            }
            readers.leave()
        }

        // The child's entire output arrives and the child exits cleanly — the ordinary
        // nil-budget success shape, no escaped holder anywhere.
        var payload = Array("tail-data".utf8)
        try #require(
            payload.withUnsafeMutableBytes {
                Darwin.write(writeDescriptor, $0.baseAddress, $0.count)
            } == payload.count
        )
        Darwin.close(writeDescriptor)

        // Old finishCaptures, verbatim in structure: bounded group wait, dup2
        // revocation, async close, return.
        _ = readers.wait(timeout: .now() + .milliseconds(500))
        let devnull = Darwin.open("/dev/null", O_RDONLY)
        try #require(devnull != -1)
        try #require(Darwin.dup2(devnull, readDescriptor) != -1)
        Darwin.close(devnull)
        readers.notify(queue: .global(qos: .utility)) {
            Darwin.close(readDescriptor)
        }

        // At the exact point the old runner built its ProcessOutput, the reader is still
        // alive and the delivered bytes are missing from the snapshot: truncation.
        #expect(readers.wait(timeout: .now()) == .timedOut)
        #expect(capture.snapshot.isEmpty)

        // Let the "preempted" reader resume: the very same bytes land after the fact,
        // proving only the missing join — not the child, not the pipe — lost them.
        preemptedBetweenReadAndAppend.signal()
        #expect(readers.wait(timeout: .now() + .seconds(5)) == .success)
        #expect(String(decoding: capture.snapshot, as: UTF8.self) == "tail-data")
    }

    @Test("capture reader wakes from a silent held-open pipe on cancellation and joins with its data intact")
    func captureReaderCancellationWithSilentWriter() throws {
        let reader = try CLIRunner.PipeCaptureReader()
        defer { reader.closeWriteDescriptor() }
        // Deliver data through the pipe, then go silent while keeping the write end
        // open — the escaped-descendant shape a blocking read could never be woken from.
        var payload = Array("captured-before-silence".utf8)
        try #require(
            payload.withUnsafeMutableBytes {
                Darwin.write(reader.writeDescriptor, $0.baseAddress, $0.count)
            } == payload.count
        )
        let dataDeadline = ContinuousClock.now + .seconds(5)
        while reader.data.isEmpty && ContinuousClock.now < dataDeadline {
            Thread.sleep(forTimeInterval: 0.005)
        }
        #expect(String(decoding: reader.data, as: UTF8.self) == "captured-before-silence")

        // No end-of-file is coming; a bounded natural-drain wait must report that.
        #expect(!reader.waitUntilExited(deadline: .now() + .milliseconds(200)))

        let startedAt = ContinuousClock.now
        reader.cancel()
        reader.join()
        #expect(ContinuousClock.now - startedAt < .seconds(1))

        // Joining proves the reader thread exited and closed the read end: the write end
        // this test still holds must observe a widowed pipe on its very next write,
        // exactly what a silent escaped holder sees the moment the runner returns.
        _ = Darwin.fcntl(reader.writeDescriptor, F_SETNOSIGPIPE, 1)
        var probeByte: UInt8 = 0
        errno = 0
        #expect(Darwin.write(reader.writeDescriptor, &probeByte, 1) == -1)
        #expect(errno == EPIPE)
        #expect(String(decoding: reader.data, as: UTF8.self) == "captured-before-silence")
    }

    @Test("capture reader cancellation still drains data already buffered in the pipe")
    func captureReaderCancellationDrainsBufferedTail() throws {
        let reader = try CLIRunner.PipeCaptureReader()
        defer { reader.closeWriteDescriptor() }
        var payload = [UInt8](repeating: UInt8(ascii: "t"), count: 8_192)
        try #require(
            payload.withUnsafeMutableBytes {
                Darwin.write(reader.writeDescriptor, $0.baseAddress, $0.count)
            } == payload.count
        )
        reader.cancel()
        reader.join()
        #expect(reader.data.count == 8_192)
    }

    @Test("capture reader retries interrupted setup and closes every descriptor when setup fails")
    func captureReaderDescriptorSetupIsFailClosed() throws {
        // Four descriptors each get F_GETFD/F_SETFD, followed by F_GETFL/F_SETFL on
        // the capture read end. Force every individual setup operation to fail in turn.
        for failingCall in 1...10 {
            var createdDescriptors: [Int32] = []
            var configurationCall = 0
            let systemCalls = CLIRunner.PipeCaptureReader.SystemCalls(
                makePipe: { _ in
                    var ends: [Int32] = [0, 0]
                    guard Darwin.pipe(&ends) == 0 else {
                        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                    }
                    createdDescriptors.append(contentsOf: ends)
                    return (ends[0], ends[1])
                },
                fcntl: { descriptor, command, value in
                    configurationCall += 1
                    if configurationCall == failingCall {
                        errno = EIO
                        return -1
                    }
                    if let value { return Darwin.fcntl(descriptor, command, value) }
                    return Darwin.fcntl(descriptor, command)
                }
            )

            #expect(throws: (any Error).self) {
                _ = try CLIRunner.PipeCaptureReader(systemCalls: systemCalls)
            }
            #expect(createdDescriptors.count == 4)
            for descriptor in createdDescriptors {
                errno = 0
                #expect(Darwin.fcntl(descriptor, F_GETFD) == -1)
                #expect(errno == EBADF)
            }
        }

        // EINTR is retried at every setup call; successful construction still proves
        // both inheritance protection and nonblocking capture configuration landed.
        var interruptedCalls = Set<Int>()
        var configurationCall = 0
        var retryDescriptors: [Int32] = []
        let retryingSystemCalls = CLIRunner.PipeCaptureReader.SystemCalls(
            makePipe: { _ in
                var ends: [Int32] = [0, 0]
                guard Darwin.pipe(&ends) == 0 else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
                retryDescriptors.append(contentsOf: ends)
                return (ends[0], ends[1])
            },
            fcntl: { descriptor, command, value in
                configurationCall += 1
                let logicalCall = (configurationCall + 1) / 2
                if configurationCall % 2 == 1 {
                    interruptedCalls.insert(logicalCall)
                    errno = EINTR
                    return -1
                }
                if let value { return Darwin.fcntl(descriptor, command, value) }
                return Darwin.fcntl(descriptor, command)
            }
        )
        let reader = try CLIRunner.PipeCaptureReader(systemCalls: retryingSystemCalls)
        defer { reader.closeWriteDescriptor() }
        #expect(interruptedCalls == Set(1...10))
        for descriptor in retryDescriptors {
            #expect(Darwin.fcntl(descriptor, F_GETFD) & FD_CLOEXEC != 0)
        }
        #expect(Darwin.fcntl(reader.readDescriptor, F_GETFL) & O_NONBLOCK != 0)
        reader.cancel()
        reader.join()
    }

    @Test("a reaper failure still joins capture readers and closes silent escaped pipes")
    func reapFailureStillFinishesCaptures() throws {
        struct InjectedReapFailure: Error {}

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-reap-failure-\(UUID().uuidString)")
        let source = root.appendingPathComponent("silent-holder.c")
        let executable = root.appendingPathComponent("silent-holder")
        let holderPidFile = root.appendingPathComponent("holder-pid")
        let markerFile = root.appendingPathComponent("holder-probe")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            if let holderPid = Self.readPID(from: holderPidFile) {
                _ = Darwin.kill(holderPid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: root)
        }

        try """
        #include <errno.h>
        #include <signal.h>
        #include <stdio.h>
        #include <stdlib.h>
        #include <sys/wait.h>
        #include <time.h>
        #include <unistd.h>

        static volatile sig_atomic_t probeRequested = 0;
        static void requestProbe(int signo) { (void)signo; probeRequested = 1; }

        int main(int argc, char **argv) {
            if (argc < 3) return 64;
            pid_t child = fork();
            if (child == -1) return 65;
            if (child != 0) {
                while (access(argv[1], F_OK) == -1) {
                    struct timespec delay = {0, 10000000};
                    nanosleep(&delay, 0);
                }
                return 0;
            }
            if (setsid() == -1) _exit(66);
            signal(SIGPIPE, SIG_IGN);
            signal(SIGUSR1, requestProbe);
            FILE *pid = fopen(argv[1], "w");
            if (!pid) _exit(67);
            fprintf(pid, "%d", (int)getpid());
            fclose(pid);
            while (!probeRequested) {
                struct timespec delay = {0, 20000000};
                nanosleep(&delay, 0);
            }
            int outBroken = (write(STDOUT_FILENO, "x", 1) == -1 && errno == EPIPE);
            int errBroken = (write(STDERR_FILENO, "y", 1) == -1 && errno == EPIPE);
            FILE *marker = fopen(argv[2], "w");
            if (!marker) _exit(68);
            fputs(outBroken && errBroken ? "both-epipe" : "still-connected", marker);
            fclose(marker);
            _exit(0);
        }
        """.write(to: source, atomically: true, encoding: .utf8)
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/cc")
        compile.arguments = ["-o", executable.path, source.path]
        try compile.run()
        compile.waitUntilExit()
        try #require(compile.terminationStatus == 0)

        let startedAt = ContinuousClock.now
        #expect(throws: InjectedReapFailure.self) {
            _ = try CLIRunner.runExecutable(
                executable.path,
                arguments: [holderPidFile.path, markerFile.path],
                pipeDrainTimeout: 0.1,
                leaderReaper: { processIdentifier, _ in
                    var status: Int32 = 0
                    var result: pid_t
                    repeat {
                        result = Darwin.waitpid(processIdentifier, &status, 0)
                    } while result == -1 && errno == EINTR
                    guard result == processIdentifier else {
                        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                    }
                    throw InjectedReapFailure()
                }
            )
        }
        #expect(ContinuousClock.now - startedAt < .seconds(2))

        let holderPid = try #require(Self.readPID(from: holderPidFile))
        #expect(Darwin.kill(holderPid, 0) == 0)
        try #require(Darwin.kill(holderPid, SIGUSR1) == 0)
        var marker: String?
        let markerDeadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < markerDeadline {
            if let contents = try? String(contentsOf: markerFile, encoding: .utf8), !contents.isEmpty {
                marker = contents
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        #expect(marker == "both-epipe")
        expectProcessIsGone(holderPid)
    }

    @Test("output at the exit/drain boundary is captured completely for nil-budget and budgeted runs")
    func outputCompleteAtExitDrainBoundary() throws {
        // 256 KiB per stream overflows the kernel pipe buffer many times over, so data is
        // still in flight as the runner observes the exit, and the final sentinel lands
        // in each pipe immediately before end-of-file.
        let command = """
        dd if=/dev/zero bs=262144 count=1 2>/dev/null | tr '\\0' o
        dd if=/dev/zero bs=262144 count=1 2>/dev/null | tr '\\0' e >&2
        printf 'OUT-END'
        printf 'ERR-END' >&2
        """
        for budget in [nil, 5.0] as [TimeInterval?] {
            let result = try CLIRunner.runExecutable(
                "/bin/sh",
                arguments: ["-c", command],
                totalWallClockBudget: budget
            )
            #expect(result.terminationStatus == 0)
            #expect(result.stdout.utf8.count == 262_144 + "OUT-END".utf8.count)
            #expect(result.stderr.utf8.count == 262_144 + "ERR-END".utf8.count)
            #expect(result.stdout.hasSuffix("OUT-END"))
            #expect(result.stderr.hasSuffix("ERR-END"))
        }
    }

    @Test("a completely silent escaped descendant cannot pin the capture readers past the ceiling")
    @MainActor
    func silentEscapedDescendantCannotPinCaptureReaders() async throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-rewrite-silent-holder-\(UUID().uuidString)")
        let bin = home.appendingPathComponent(".bun/bin")
        let leaderPidFile = home.appendingPathComponent("leader-pid")
        let holderPidFile = home.appendingPathComponent("holder-pid")
        let markerFile = home.appendingPathComponent("holder-probe")
        let holderSource = home.appendingPathComponent("silent-holder.c")
        let holderBinary = home.appendingPathComponent("silent-holder")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        defer {
            if let holderPid = Self.readPID(from: holderPidFile) {
                _ = Darwin.kill(holderPid, SIGKILL)
            }
            if let leaderPid = Self.readPID(from: leaderPidFile) {
                _ = Darwin.kill(-leaderPid, SIGKILL)
                _ = Darwin.kill(leaderPid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: home)
        }

        // Unlike the EPIPE holder above, this descendant never writes a byte while the
        // runner is alive: a reader blocked in read(2) would never be handed the data it
        // needs to run onto a revoked descriptor, which is exactly the shape that pinned
        // the old blocking readers forever. Only after the runner has returned does the
        // test send SIGUSR1, and the holder's very first write on each stream must then
        // fail with EPIPE — possible only if the reader threads already exited and closed
        // both read ends before the runner returned, not asynchronously afterwards.
        try """
        #include <errno.h>
        #include <signal.h>
        #include <stdio.h>
        #include <time.h>
        #include <unistd.h>

        static volatile sig_atomic_t probeRequested = 0;
        static void requestProbe(int signo) { (void)signo; probeRequested = 1; }

        int main(int argc, char **argv) {
            if (argc < 3) return 64;
            if (setsid() == -1) return 65;
            signal(SIGPIPE, SIG_IGN);
            signal(SIGUSR1, requestProbe);
            FILE *pid = fopen(argv[1], "w");
            if (!pid) return 66;
            fprintf(pid, "%d", (int)getpid());
            fclose(pid);
            while (!probeRequested) {
                struct timespec delay = {0, 20000000};
                nanosleep(&delay, 0);
            }
            int stdoutBroken = (write(STDOUT_FILENO, "x", 1) == -1 && errno == EPIPE);
            int stderrBroken = (write(STDERR_FILENO, "y", 1) == -1 && errno == EPIPE);
            FILE *marker = fopen(argv[2], "w");
            if (!marker) return 67;
            fputs(stdoutBroken && stderrBroken ? "both-epipe" : "still-connected", marker);
            fclose(marker);
            return 0;
        }
        """.write(to: holderSource, atomically: true, encoding: .utf8)
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/cc")
        compile.arguments = ["-o", holderBinary.path, holderSource.path]
        try compile.run()
        compile.waitUntilExit()
        try #require(compile.terminationStatus == 0)

        let executable = bin.appendingPathComponent("recordings")
        try """
        #!/bin/sh
        trap '' TERM
        printf '%s' "$$" > '\(leaderPidFile.path)'
        '\(holderBinary.path)' '\(holderPidFile.path)' '\(markerFile.path)' &
        while [ ! -s '\(holderPidFile.path)' ]; do /bin/sleep 0.01; done
        while :; do /bin/sleep 0.05; done
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        // The production seam exactly as runCommandMode uses it. The leader ignores
        // SIGTERM and the silent holder keeps both pipes open, so every deadline in the
        // chain — execution window, termination grace, drain wait — runs to exhaustion
        // with zero bytes ever arriving to wake a reader.
        let runCLI = RecordingEngine().commandCLI
        let homePath = home.path
        let startedAt = ContinuousClock.now
        let output = await Task.detached {
            runCLI(["rewrite-selection"], homePath, RecordingEngine.commandRewriteTimeout)
        }.value
        let elapsed = ContinuousClock.now - startedAt

        #expect(elapsed < .seconds(RecordingEngine.commandRewriteTimeout))
        #expect(elapsed > .seconds(8.4))
        #expect(output.hasPrefix("ERROR:"))
        #expect(output.contains("timed out"))

        let leaderPid = try #require(Self.readPID(from: leaderPidFile))
        expectProcessIsGone(leaderPid)
        expectProcessGroupIsGone(leaderPid)

        // The holder escaped the group kill and stayed completely silent: it must still
        // be alive, and must not have probed yet.
        let holderPid = try #require(Self.readPID(from: holderPidFile))
        #expect(Darwin.kill(holderPid, 0) == 0)
        #expect(!FileManager.default.fileExists(atPath: markerFile.path))

        // Ask for the probe only now, after the runner has returned. First-write EPIPE on
        // both streams proves the capture read ends were closed — and the reader threads
        // joined — before the return, with no writer traffic ever helping them along.
        try #require(Darwin.kill(holderPid, SIGUSR1) == 0)
        var marker: String?
        let markerDeadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < markerDeadline {
            if let contents = try? String(contentsOf: markerFile, encoding: .utf8), !contents.isEmpty {
                marker = contents
                break
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(marker == "both-epipe")
        expectProcessIsGone(holderPid)
    }

    @Test("transcribeCLIArgs passes project, cleanup mode, and transcriber prompt")
    func transcribeCLIArgsWithPrompt() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: "project-1",
            transcriberPrompt: "Format as notes",
            postProcessingMode: "always"
        )
        #expect(args == [
            "--json",
            "--project", "project-1",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "always",
            "--transcriber-prompt", "Format as notes",
        ])
        #expect(!args.contains("--no-enhance"))
    }

    @Test("transcribeCLIArgs defaults to auto and omits blank prompt")
    func transcribeCLIArgsDefaultAuto() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: nil,
            transcriberPrompt: "   ",
            postProcessingMode: ""
        )
        #expect(args == [
            "--json",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "auto",
        ])
    }

    @Test("transcribeCLIArgs falls back to auto for invalid mode")
    func transcribeCLIArgsInvalidModeFallback() {
        let args = RecordingEngine.transcribeCLIArgs(
            audioPath: "/tmp/audio.wav",
            activeProjectId: "",
            transcriberPrompt: "",
            postProcessingMode: "sometimes"
        )
        #expect(args == [
            "--json",
            "transcribe", "/tmp/audio.wav",
            "--post-processing", "auto",
        ])
    }

    @Test("saveTextCLIArgs persists realtime fast-path transcript")
    func saveTextCLIArgsRealtimeFastPath() {
        let args = RecordingEngine.saveTextCLIArgs(
            textFile: "/tmp/transcript.txt",
            audioPath: "/tmp/audio.wav",
            activeProjectId: "project-1",
            transcriberPrompt: "Format as notes",
            postProcessingMode: "auto",
            language: "en",
            durationMs: 1200,
            source: "realtime_fast_path",
            modelUsed: "gpt-realtime-whisper"
        )
        #expect(args == [
            "--json",
            "--project", "project-1",
            "save-text",
            "--text-file", "/tmp/transcript.txt",
            "--source", "realtime_fast_path",
            "--model-used", "gpt-realtime-whisper",
            "--post-processing", "auto",
            "--audio-path", "/tmp/audio.wav",
            "--duration-ms", "1200",
            "--language", "en",
            "--transcriber-prompt", "Format as notes",
        ])
    }

    @Test("saveTextCLIArgs omits an unsafe local project id")
    func saveTextCLIArgsWithoutCanonicalProject() {
        let args = RecordingEngine.saveTextCLIArgs(
            textFile: "/tmp/transcript.txt",
            audioPath: nil,
            activeProjectId: nil,
            transcriberPrompt: "Keep local prompt context",
            postProcessingMode: "auto",
            language: "en",
            durationMs: 0,
            source: "realtime_fast_path",
            modelUsed: "gpt-realtime-whisper"
        )

        #expect(!args.contains("--project"))
        #expect(args.contains("--transcriber-prompt"))
        #expect(args.contains("Keep local prompt context"))
    }

    @Test("parseError detects ERROR prefix")
    func parseError() {
        #expect(CLIRunner.parseError("ERROR: OpenAI API key not configured on this Mac") == "OpenAI API key not configured on this Mac")
    }

    @Test("parseError returns nil for normal output")
    func noError() {
        #expect(CLIRunner.parseError("Hello world") == nil)
    }

    @Test("parseError handles API key error")
    func apiKeyError() {
        #expect(CLIRunner.parseError("ERROR: OpenAI API key not configured") == "OpenAI API key not configured on this Mac")
    }

    @Test("parseError maps invalid API key (401) to a friendly message")
    func invalidKeyError() {
        let input = "ERROR: Transcription failed: 401 Incorrect API key provided: " + "sk" + "-proj-" + "****vosA. You can find your API key at https://platform.openai.com."
        #expect(CLIRunner.parseError(input) == "OpenAI API key invalid or expired — update it in Recordings Settings")
    }

    @Test("parseError maps quota errors (429) to a friendly message")
    func quotaError() {
        let input = "ERROR: Transcription failed: 429 You exceeded your current quota, please check your plan and billing details."
        #expect(CLIRunner.parseError(input) == "OpenAI quota exceeded — check the OpenAI account billing")
    }

    @Test("parseError truncates long messages to 120 chars")
    func truncation() {
        let longMsg = String(repeating: "a", count: 200)
        let input = "ERROR: \(longMsg)"
        let result = CLIRunner.parseError(input)!
        #expect(result.count <= 120)
    }

    @Test("parseError sanitizes generic credential-bearing failures")
    func genericErrorsAreSanitized() {
        let key = "sk-" + "synthetic-cli-secret-123456"
        let bearer = "synthetic-bearer-secret-123456"
        let token = "synthetic-query-secret-123456"
        let result = CLIRunner.parseError(
            "ERROR: upstream failed key=\(key) Authorization: Bearer \(bearer) https://example.test?access_token=\(token)"
        )

        #expect(result?.contains(key) == false)
        #expect(result?.contains(bearer) == false)
        #expect(result?.contains(token) == false)
        #expect(result?.contains("[REDACTED]") == true)

        let structured = CLIRunner.parseError(
            "ERROR: OPENAI_API_KEY=plain-synthetic-secret CLIENT_SECRET=client-synthetic-secret "
                + "PASSWORD=password-synthetic-secret payload={\"api_key\":\"json-synthetic-secret\","
                + "\"private_key\":\"private-synthetic-secret\"}"
        )
        #expect(structured?.contains("plain-synthetic-secret") == false)
        #expect(structured?.contains("client-synthetic-secret") == false)
        #expect(structured?.contains("password-synthetic-secret") == false)
        #expect(structured?.contains("json-synthetic-secret") == false)
        #expect(structured?.contains("private-synthetic-secret") == false)

        let quoted = CLIRunner.parseError(
            "ERROR: payload={\"password\":\"correct horse battery staple\","
                + "\"secret\":\"bare secret phrase\",\"private\":\"private phrase\"}"
        )
        #expect(quoted?.contains("correct horse battery staple") == false)
        #expect(quoted?.contains("bare secret phrase") == false)
        #expect(quoted?.contains("private phrase") == false)
        #expect(quoted?.contains("horse battery staple") == false)

        let escapedAndUnquoted = CLIRunner.parseError(
            "ERROR: payload={\"secret\":\"alpha \\\"quoted\\\" beta gamma\"}; "
                + "private: delta echo foxtrot"
        )
        #expect(escapedAndUnquoted?.contains("quoted") == false)
        #expect(escapedAndUnquoted?.contains("beta gamma") == false)
        #expect(escapedAndUnquoted?.contains("echo foxtrot") == false)

        let commonCredentials = CLIRunner.parseError(
            "ERROR: Authorization: Basic synthetic-basic-value; "
                + "AWS_SECRET_ACCESS_KEY=delta echo foxtrot"
        )
        #expect(commonCredentials?.contains("synthetic-basic-value") == false)
        #expect(commonCredentials?.contains("echo foxtrot") == false)
    }

    @Test("parseError preserves ordinary generic failures")
    func ordinaryErrorsRemainUseful() {
        #expect(CLIRunner.parseError("ERROR: microphone disconnected") == "microphone disconnected")
        #expect(CLIRunner.parseError("ERROR: Unexpected token: EOF") == "Unexpected token: EOF")
        #expect(CLIRunner.parseError("ERROR: resource is private: access denied") == "resource is private: access denied")
    }

    @Test("run sanitizes failed process stderr before returning it")
    func failedProcessStderrIsSanitized() throws {
        let key = "sk-" + "synthetic-process-secret-123456"
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-cli-sanitize-\(UUID().uuidString)")
        let bin = home.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        try "#!/bin/sh\nprintf 'request failed: %s' '$KEY' >&2\nexit 1\n"
            .replacingOccurrences(of: "$KEY", with: key)
            .write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        defer { try? FileManager.default.removeItem(at: home) }

        let output = CLIRunner.run([], home: home.path)

        #expect(!output.contains(key))
        #expect(output.contains("[REDACTED]"))
    }

    @Test("run sanitizes stderr-only output from a successful process")
    func successfulProcessStderrIsSanitized() throws {
        let password = "synthetic-process-password-123456"
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-cli-success-sanitize-\(UUID().uuidString)")
        let bin = home.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        try "#!/bin/sh\nprintf 'PASSWORD=%s' '$PASSWORD' >&2\n"
            .replacingOccurrences(of: "$PASSWORD", with: password)
            .write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        defer { try? FileManager.default.removeItem(at: home) }

        let output = CLIRunner.run([], home: home.path)

        #expect(!output.contains(password))
        #expect(output.contains("[REDACTED]"))
    }

    @Test("parseJSON extracts raw_text from JSON")
    func parseJSONRawText() {
        let output = """
        {"raw_text": "Hello world", "processed_text": null}
        """
        #expect(CLIRunner.parseJSON(output) == "Hello world")
    }

    @Test("parseJSON prefers processed_text over raw_text")
    func parseJSONProcessedText() {
        let output = """
        {"raw_text": "Hello world", "processed_text": "Hello World (enhanced)"}
        """
        #expect(CLIRunner.parseJSON(output) == "Hello World (enhanced)")
    }

    @Test("parseJSON falls back to plain text")
    func parseJSONFallback() {
        let output = "Transcribing...\nHello world\nSaved to file"
        #expect(CLIRunner.parseJSON(output) == "Hello world")
    }

    @Test("parseJSON returns nil for empty output")
    func emptyOutput() {
        #expect(CLIRunner.parseJSON("") == nil)
    }

    @Test("parseJSON handles empty transcription")
    func emptyTranscription() {
        let output = """
        {"raw_text": "", "processed_text": ""}
        """
        // Both are empty, so it should fall back to plain text extraction
        #expect(CLIRunner.parseJSON(output) == nil)
    }
}
