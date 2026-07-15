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

        let startedAt = ContinuousClock.now
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
