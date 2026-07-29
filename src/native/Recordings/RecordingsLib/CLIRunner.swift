import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

enum CLIRunner: Sendable {
    enum CaptureOperation: Sendable {
        case read
        case poll

        fileprivate var description: String {
            switch self {
            case .read: "reading"
            case .poll: "waiting for"
            }
        }
    }

    enum ExecutionError: Error, LocalizedError, Equatable {
        case timedOut(executable: String, seconds: TimeInterval)
        case captureFailed(operation: CaptureOperation, code: Int32)

        var errorDescription: String? {
            switch self {
            case let .timedOut(executable, seconds):
                return "Command timed out after \(seconds.formatted()) seconds: \(executable)"
            case let .captureFailed(operation, code):
                return "Failed to capture command output while \(operation.description): \(String(cString: strerror(code)))"
            }
        }
    }

    struct Command: Sendable {
        let executable: String
        let argumentsPrefix: [String]
    }

    struct ProcessOutput: Sendable {
        let stdout: String
        let stderr: String
        let terminationStatus: Int32
    }

    enum ProcessLifecycleEvent: Equatable, Sendable {
        case leaderExitObserved
        case processGroupSignaled(Int32)
        case leaderReaped(Int32)
    }

    typealias LeaderReaper = (
        _ processIdentifier: pid_t,
        _ lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Int32

    static func run(
        _ args: [String],
        home: String,
        timeout: TimeInterval = 120,
        totalWallClockBudget: TimeInterval? = nil
    ) -> String {
        let command = resolveCommand(home: home)
        let arguments = command.argumentsPrefix + args
        let environment = ProcessInfo.processInfo.environment.merging([
            "PATH": "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        ]) { _, new in new }
        do {
            let output = try runExecutable(
                command.executable,
                arguments: arguments,
                environment: environment,
                executionTimeout: timeout,
                totalWallClockBudget: totalWallClockBudget
            )
            if output.terminationStatus != 0 {
                let details = output.stderr.isEmpty ? output.stdout : output.stderr
                return "ERROR: \(NativeErrorSanitizer.sanitize(details.trimmingCharacters(in: .whitespacesAndNewlines)))"
            }
            return output.stdout.isEmpty
                ? NativeErrorSanitizer.sanitize(output.stderr)
                : output.stdout
        } catch {
            return "ERROR: \(NativeErrorSanitizer.sanitize(error.localizedDescription))"
        }
    }

    static func resolveCommand(
        home: String,
        bundleURL: URL = Bundle.main.bundleURL,
        fileManager: FileManager = .default
    ) -> Command {
        let bundled = bundleURL.appendingPathComponent("Contents/Helpers/recordings")
        let isPackagedApp = bundleURL.pathExtension.caseInsensitiveCompare("app") == .orderedSame
        if isPackagedApp || fileManager.fileExists(atPath: bundled.path) {
            return Command(executable: bundled.path, argumentsPrefix: [])
        }

        // SwiftPM development and test runs do not have an app bundle. Retain an
        // explicit local fallback there; packaged apps exclusively use their helper.
        let userCLI = "\(home)/.bun/bin/recordings"
        if fileManager.fileExists(atPath: userCLI) {
            return Command(executable: userCLI, argumentsPrefix: [])
        }
        return Command(executable: "/usr/bin/env", argumentsPrefix: ["recordings"])
    }

    /// Wall-clock time reserved out of the execution window when `totalWallClockBudget` is
    /// set, so termination grace, kill grace, and pipe drain land inside the budget with
    /// scheduling margin to spare.
    static let wallClockCleanupReserve: TimeInterval = 1

    static func runExecutable(
        _ executable: String,
        arguments: [String],
        environment: [String: String]? = nil,
        executionTimeout: TimeInterval = 120,
        terminationGracePeriod: TimeInterval = 0.5,
        forceKillGracePeriod: TimeInterval = 1,
        pipeDrainTimeout: TimeInterval = 2,
        totalWallClockBudget: TimeInterval? = nil,
        beforeExecutionDeadline: (() -> Void)? = nil,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)? = nil,
        leaderReaper: LeaderReaper? = nil,
        captureSystemCalls: PipeCaptureReader.SystemCalls = .live
    ) throws -> ProcessOutput {
        precondition(executionTimeout.isFinite && executionTimeout > 0)
        precondition(terminationGracePeriod.isFinite && terminationGracePeriod >= 0)
        precondition(forceKillGracePeriod.isFinite && forceKillGracePeriod >= 0)
        precondition(pipeDrainTimeout.isFinite && pipeDrainTimeout >= 0)
        if let totalWallClockBudget {
            precondition(totalWallClockBudget.isFinite && totalWallClockBudget > wallClockCleanupReserve)
        }

        // The budget clock starts before the spawn so setup latency cannot extend the
        // observable wall time. Every wait below is clamped to what is left of it.
        let wallClockDeadline = totalWallClockBudget.map { monotonicUptimeDeadline(after: $0) }
        func clampedToWallClockBudget(
            _ phaseTimeout: TimeInterval,
            reserving reserve: TimeInterval = 0
        ) -> TimeInterval {
            guard let wallClockDeadline else { return phaseTimeout }
            let now = DispatchTime.now().uptimeNanoseconds
            let remaining = wallClockDeadline > now
                ? Double(wallClockDeadline - now) / 1_000_000_000 - reserve
                : 0
            return max(0, min(phaseTimeout, remaining))
        }
        let contractualExecutionTimeout = totalWallClockBudget
            .map { min(executionTimeout, $0 - wallClockCleanupReserve) } ?? executionTimeout

        let stdoutReader = try PipeCaptureReader(systemCalls: captureSystemCalls)
        let stderrReader: PipeCaptureReader
        do {
            stderrReader = try PipeCaptureReader(systemCalls: captureSystemCalls)
        } catch {
            stdoutReader.closeWriteDescriptor()
            _ = finishCaptures([stdoutReader], pipeDrainTimeout: 0)
            throw error
        }
        let captureReaders = [stdoutReader, stderrReader]

        let processIdentifier: pid_t
        do {
            processIdentifier = try spawnProcessGroup(
                executable,
                arguments: arguments,
                environment: environment,
                stdoutDescriptor: stdoutReader.writeDescriptor,
                stderrDescriptor: stderrReader.writeDescriptor,
                stdoutReadDescriptor: stdoutReader.readDescriptor,
                stderrReadDescriptor: stderrReader.readDescriptor
            )
        } catch {
            stdoutReader.closeWriteDescriptor()
            stderrReader.closeWriteDescriptor()
            _ = finishCaptures(captureReaders, pipeDrainTimeout: 0)
            throw error
        }
        stdoutReader.closeWriteDescriptor()
        stderrReader.closeWriteDescriptor()

        beforeExecutionDeadline?()
        let leaderExitWasObserved: Bool
        let didTimeOut: Bool
        do {
            leaderExitWasObserved = try waitForUnreapedLeaderExit(
                processIdentifier,
                timeout: clampedToWallClockBudget(executionTimeout, reserving: wallClockCleanupReserve),
                lifecycleObserver: lifecycleObserver
            )
            didTimeOut = !leaderExitWasObserved
        } catch {
            signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
            reapLeaderInBackground(processIdentifier)
            _ = finishCaptures(
                captureReaders,
                pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
            )
            throw error
        }

        // Keep the direct child unreaped until every group-directed signal has
        // been sent. Its zombie reserves the process-group identifier, so a PID
        // reuse cannot redirect cleanup to an unrelated process group.
        signalProcessGroup(processIdentifier, signal: SIGTERM, lifecycleObserver: lifecycleObserver)
        var confirmedExit = leaderExitWasObserved
        if didTimeOut {
            do {
                confirmedExit = try waitForUnreapedLeaderExit(
                    processIdentifier,
                    timeout: clampedToWallClockBudget(terminationGracePeriod),
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        } else {
            let drainDeadline = monotonicDispatchDeadline(
                after: clampedToWallClockBudget(terminationGracePeriod)
            )
            for reader in captureReaders {
                reader.waitUntilExited(deadline: drainDeadline)
            }
        }
        signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
        if !confirmedExit {
            do {
                confirmedExit = try waitForUnreapedLeaderExit(
                    processIdentifier,
                    timeout: clampedToWallClockBudget(forceKillGracePeriod),
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        }
        let terminationStatus: Int32?
        if confirmedExit {
            do {
                terminationStatus = try leaderReaper?(
                    processIdentifier,
                    lifecycleObserver
                ) ?? reapLeader(
                    processIdentifier,
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        } else {
            reapLeaderInBackground(processIdentifier)
            terminationStatus = nil
        }

        let captureError = finishCaptures(
            captureReaders,
            pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
        )

        if didTimeOut {
            throw ExecutionError.timedOut(executable: executable, seconds: contractualExecutionTimeout)
        }
        if let captureError {
            throw captureError
        }

        // Both readers are joined by now, so these snapshots can never observe a
        // truncated mid-append state.
        return ProcessOutput(
            stdout: String(decoding: stdoutReader.data, as: UTF8.self),
            stderr: String(decoding: stderrReader.data, as: UTF8.self),
            terminationStatus: terminationStatus ?? 1
        )
    }

}
