import SwiftUI
import KeyboardShortcuts

// MARK: - Custom shortcut (not fn — fn is handled by FnKeyMonitor)

extension KeyboardShortcuts.Name {
    static let toggleRecording = Self("toggleRecording", default: .init(.f5))
}

// MARK: - Recording Mode

enum RecordingMode: String, CaseIterable, Identifiable, Sendable {
    case pushToTalk = "Push to Talk"
    case dictation = "Dictation"
    case command = "Command"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .pushToTalk: return "hand.tap.fill"
        case .dictation: return "text.bubble.fill"
        case .command: return "wand.and.stars"
        }
    }
    var hint: String {
        switch self {
        case .pushToTalk: return "Hold F5 or your chosen shortcut to record, then release to paste"
        case .dictation: return "Hold F5 or your chosen shortcut to dictate, then release to paste"
        case .command: return "Select text, then hold F5 or your chosen shortcut and release to rewrite"
        }
    }
}

// MARK: - Transcription Result

struct TranscriptionResult: Sendable {
    let rawText: String
    let processedText: String?
    let timestamp: Date
    let projectId: String?
    let projectName: String?
    var displayText: String { processedText ?? rawText }
}

enum RecordingTrigger {
    case manual
    case fnKey
    case keyboardShortcut
}

// MARK: - Recording Engine

@MainActor
final class RecordingEngine: ObservableObject {
    @Published var isRecording = false
    @Published var mode: RecordingMode = .pushToTalk
    @Published var useFnKey: Bool = false {
        didSet {
            UserDefaults.standard.set(useFnKey, forKey: "useFnKey")
            updateFnMonitor()
            updateStatus()
        }
    }
    @Published var isWhisperMode = false
    @Published var recentTranscriptions: [TranscriptionResult] = []
    @Published var statusMessage = "Starting..."
    @Published var isTranscribing = false
    @Published var recordingDuration: TimeInterval = 0
    @Published var liveTranscriptionText = ""

    private var recordProcess: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var recordingTimer: Timer?
    private var activeTrigger: RecordingTrigger?
    private var keyboardShortcutIsDown = false
    private var targetAppBundleIdentifier: String?
    private var targetAppPid: pid_t?
    private let maxDuration = 300
    var projectStore: ProjectStore?

    // Real-time streaming
    private var realtimeClient: RealtimeTranscriptionClient?
    private var audioStreamContinuation: AsyncStream<Data>.Continuation?
    private var streamingTask: Task<Void, Never>?
    private var streamingText = ""

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var audioDir: String { "\(home)/.hasna/recordings/audio" }

    // MARK: - OpenAI API Key

    private var openAIAPIKey: String {
        // Try environment, then saved preference
        if let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !key.isEmpty {
            return key
        }
        return UserDefaults.standard.string(forKey: "openAIAPIKey") ?? ""
    }

    init() {
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)

        // Load preferences
        useFnKey = UserDefaults.standard.object(forKey: "useFnKey") as? Bool ?? false
        if KeyboardShortcuts.getShortcut(for: .toggleRecording) == nil {
            KeyboardShortcuts.setShortcut(.init(.f5), for: .toggleRecording)
        }

        // Set up fn key monitor — hold fn to record, release to stop (like WisprFlow)
        fnMonitor.onFnKeyDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, !self.isRecording else { return }
                self.startRecording(trigger: .fnKey)
            }
        }
        fnMonitor.onFnKeyUp = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, self.isRecording, self.activeTrigger == .fnKey else { return }
                self.stopAndTranscribe()
            }
        }
        updateFnMonitor()

        KeyboardShortcuts.onKeyDown(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = true
                guard !self.isRecording else { return }
                self.startRecording(trigger: .keyboardShortcut)
            }
        }
        KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = false
                guard self.isRecording, self.activeTrigger == .keyboardShortcut else { return }
                self.stopAndTranscribe()
            }
        }

        updateStatus()
    }

    private func updateFnMonitor() {
        if useFnKey {
            let ok = fnMonitor.start()
            if !ok {
                statusMessage = "fn needs Input Monitoring / Accessibility permission, and Globe must be set to Do Nothing"
            }
        } else {
            fnMonitor.stop()
        }
    }

    func updateStatus() {
        if isRecording || isTranscribing { return }
        statusMessage = "Ready"
    }

    // MARK: - Toggle

    func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording(trigger: .manual) }
    }

    // MARK: - Start Recording (Streaming)

    func startRecording(trigger: RecordingTrigger = .manual) {
        guard !isRecording else { return }
        activeTrigger = trigger
        keyboardShortcutIsDown = trigger == .keyboardShortcut

        let myPID = ProcessInfo.processInfo.processIdentifier
        let frontmostApp = NSWorkspace.shared.frontmostApplication
        let isOwnApp = frontmostApp?.processIdentifier == myPID
        targetAppBundleIdentifier = isOwnApp ? nil : frontmostApp?.bundleIdentifier
        targetAppPid = isOwnApp ? nil : frontmostApp?.processIdentifier

        if let store = projectStore {
            let windowTitle = Self.focusedWindowTitle(pid: frontmostApp?.processIdentifier)
            let projects = store.settings.projects
            let detected = ProjectStore.matchProject(windowTitle: windowTitle, bundleId: targetAppBundleIdentifier, projects: projects)
            if let detected {
                store.setActive(detected.id)
            }
        }

        // Start ffmpeg recording
        let proc = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderrPipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", """
            export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
            if command -v ffmpeg &>/dev/null; then
                ffmpeg -f avfoundation -i ":0" -ar 24000 -ac 1 -f s16le -t \(maxDuration) - 2>/dev/null
            elif command -v rec &>/dev/null; then
                rec -r 24000 -c 1 -b 16 -t raw - trim 0 \(maxDuration)
            else
                exit 1
            fi
        """]
        proc.standardInput = stdin
        proc.standardOutput = stdout
        proc.standardError = stderrPipe

        do {
            try proc.run()
            recordProcess = proc
            stdinPipe = stdin
            stdoutPipe = stdout
            isRecording = true
            recordingDuration = 0
            streamingText = ""
            liveTranscriptionText = ""
            statusMessage = switch (mode, trigger) {
            case (.command, _): "Speak your instruction..."
            case (_, .manual): "Recording — click Stop when finished"
            case (_, .fnKey), (_, .keyboardShortcut): "Recording — release to stop"
            }

            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.recordingDuration += 0.1
                }
            }

            // Start real-time streaming if API key is available
            let apiKey = openAIAPIKey
            if !apiKey.isEmpty {
                startRealtimeStreaming(apiKey: apiKey)
            } else {
                // Fall back to file-based recording for legacy
                startFallbackRecording()
            }

            // Read PCM from stdout and stream to OpenAI
            startPCMStreaming(stdout: stdout)
        } catch {
            activeTrigger = nil
            keyboardShortcutIsDown = false
            targetAppBundleIdentifier = nil
            statusMessage = "Failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Real-time Streaming

    private func startRealtimeStreaming(apiKey: String) {
        let systemPrompt = projectStore?.effectiveSystemPrompt ?? ""
        let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)
        realtimeClient = client

        streamingTask = Task {
            await client.startStreaming(systemPrompt: systemPrompt)

            // Receive deltas
            while client.isStreaming {
                try? await Task.sleep(for: .milliseconds(100))
                let text = client.accumulatedText
                if text != streamingText {
                    await MainActor.run {
                        self.streamingText = text
                        self.liveTranscriptionText = text
                    }
                }
            }
        }
    }

    private func startPCMStreaming(stdout: Pipe) {
        let handle = stdout.fileHandleForReading
        // Capture client reference for this recording session
        let client = realtimeClient

        Task {
            // Read in chunks (~500ms of audio at 24kHz/16-bit/mono = 24000 bytes/s)
            let chunkSize = 12000 // ~250ms chunks
            var buffer = Data()

            while true {
                try Task.checkCancellation()
                let data = handle.availableData
                if data.isEmpty {
                    // EOF — ffmpeg exited
                    break
                }
                buffer.append(data)

                // Send chunks to streaming client
                while buffer.count >= chunkSize {
                    let chunk = buffer.prefix(chunkSize)
                    buffer.removeFirst(chunkSize)

                    // Send to realtime client if available
                    if let client {
                        Task { @MainActor in
                            client.sendAudio(Data(chunk))
                        }
                    }
                }
            }
        }
    }

    // MARK: - Fallback (file-based for when no API key)

    private func startFallbackRecording() {
        // We'll use the existing file path for post-recording fallback
        Task {
            try? await Task.sleep(for: .seconds(1))
            if let proc = recordProcess, proc.isRunning {
                // Save as WAV for fallback by killing current PCM stream and re-recording
                await MainActor.run {
                    self.terminateRecordingProcess()
                    self.recordProcess = nil
                    self.isRecording = false
                    self.statusMessage = "OpenAI API key not configured — streaming unavailable"
                }
            }
        }
    }

    // MARK: - Stop & Transcribe

    func stopAndTranscribe() {
        guard let proc = recordProcess else { return }

        recordingTimer?.invalidate()
        recordingTimer = nil

        if let pipe = stdinPipe {
            try? pipe.fileHandleForWriting.write(contentsOf: Data("q".utf8))
            try? pipe.fileHandleForWriting.close()
        }

        isRecording = false
        isTranscribing = true

        let curMode = mode
        let targetAppBundleIdentifier = targetAppBundleIdentifier
        let activeProjectId = projectStore?.settings.activeProjectId
        let activeProjectName = projectStore?.activeProject?.name
        activeTrigger = nil
        keyboardShortcutIsDown = false
        self.targetAppBundleIdentifier = nil
        self.targetAppPid = nil
        recordProcess = nil
        stdinPipe = nil
        stdoutPipe = nil

        // If we were streaming, stop and get the accumulated text
        let streamingResult = realtimeClient?.stop() ?? ""
        realtimeClient = nil
        streamingTask?.cancel()
        streamingTask = nil

        // Kill the process
        Task.detached {
            if proc.isRunning { proc.terminate() }
            try? await Task.sleep(for: .milliseconds(300))

            let text = streamingResult.isEmpty ? nil : streamingResult

            await MainActor.run {
                self.isTranscribing = false
                self.liveTranscriptionText = ""

                if let text, !text.isEmpty {
                    if curMode == .command {
                        self.runCommandMode(instruction: text)
                    } else {
                        self.pasteIntoFrontApp(text, targetAppBundleIdentifier: targetAppBundleIdentifier)
                        self.recentTranscriptions.insert(
                            TranscriptionResult(rawText: text, processedText: nil, timestamp: Date(), projectId: activeProjectId, projectName: activeProjectName), at: 0
                        )
                        if self.recentTranscriptions.count > 20 { self.recentTranscriptions.removeLast() }
                    }
                } else {
                    // Fall back to file-based transcription if streaming didn't produce results
                    self.fallbackTranscribe(curMode: curMode, targetAppBundleIdentifier: targetAppBundleIdentifier, activeProjectId: activeProjectId, activeProjectName: activeProjectName)
                }
            }
        }
    }

    // MARK: - Fallback Transcription

    private func fallbackTranscribe(curMode: RecordingMode, targetAppBundleIdentifier: String?, activeProjectId: String?, activeProjectName: String?) {
        // Use most recent audio file in the directory
        guard let audioPath = self.mostRecentAudioFile() else {
            statusMessage = "No audio captured"
            return
        }

        let systemPrompt = projectStore?.effectiveSystemPrompt ?? ""
        let homePath = home

        isTranscribing = true
        statusMessage = "Transcribing..."

        Task.detached {
            var cliArgs = ["transcribe", audioPath, "--json"]
            if !systemPrompt.isEmpty {
                cliArgs += ["--system-prompt", systemPrompt]
            }
            let output = CLIRunner.run(cliArgs, home: homePath)
            if let error = CLIRunner.parseError(output) {
                await MainActor.run { self.finish(error) }
                return
            }

            let text = CLIRunner.parseJSON(output)
            guard let text, !text.isEmpty else {
                await MainActor.run { self.finish("Empty transcription") }
                return
            }

            await MainActor.run {
                self.isTranscribing = false
                if curMode == .command {
                    self.runCommandMode(instruction: text)
                } else {
                    self.pasteIntoFrontApp(text, targetAppBundleIdentifier: targetAppBundleIdentifier)
                    self.recentTranscriptions.insert(
                        TranscriptionResult(rawText: text, processedText: nil, timestamp: Date(), projectId: activeProjectId, projectName: activeProjectName), at: 0
                    )
                    if self.recentTranscriptions.count > 20 { self.recentTranscriptions.removeLast() }
                }
            }
        }
    }

    private func mostRecentAudioFile() -> String? {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: audioDir)) ?? []
        let wavFiles = files.filter { $0.hasSuffix(".wav") }.sorted().reversed()
        return wavFiles.first.map { "\(audioDir)/\($0)" }
    }

    private func finish(_ msg: String) {
        isTranscribing = false
        liveTranscriptionText = ""
        updateStatus()
    }

    private func terminateRecordingProcess() {
        guard let proc = recordProcess else { return }
        recordingTimer?.invalidate()
        recordingTimer = nil
        if let pipe = stdinPipe {
            try? pipe.fileHandleForWriting.write(contentsOf: Data("q".utf8))
            try? pipe.fileHandleForWriting.close()
        }
        if proc.isRunning { proc.terminate() }
        recordProcess = nil
        stdinPipe = nil
        stdoutPipe = nil
    }

    // MARK: - Command Mode

    private func runCommandMode(instruction: String) {
        postKey(0x08, flags: .maskCommand) // Cmd+C
        let homePath = home

        Task {
            try? await Task.sleep(for: .milliseconds(250))
            let selected = NSPasteboard.general.string(forType: .string) ?? ""
            guard !selected.isEmpty else {
                statusMessage = "No text selected"
                return
            }
            statusMessage = "Rewriting..."
            isTranscribing = true
            let prompt = "Rewrite: \"\(instruction)\"\n\nText:\n\(selected)"

            Task.detached {
                let result = CLIRunner.run(["transcribe", "--text", prompt, "--enhance"], home: homePath)
                await MainActor.run {
                    self.isTranscribing = false
                    self.liveTranscriptionText = ""
                    if !result.isEmpty {
                        self.pasteIntoFrontApp(result)
                        self.statusMessage = "Rewritten"
                    } else {
                        self.statusMessage = "Rewrite failed"
                    }
                }
            }
        }
    }

    private func postKey(_ key: CGKeyCode, flags: CGEventFlags) {
        let src = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else { return }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
    }

    // MARK: - Window Title (Accessibility API)

    private static func focusedWindowTitle(pid: pid_t?) -> String? {
        guard let pid else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let window = windowRef else { return nil }
        var titleRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
              let title = titleRef as? String else { return nil }
        return title
    }

    // MARK: - Paste

    func pasteIntoFrontApp(_ text: String, targetAppBundleIdentifier: String? = nil) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        let myPID = ProcessInfo.processInfo.processIdentifier
        let runningApps = NSWorkspace.shared.runningApplications
        let targetApp = runningApps.first(where: {
            guard $0.processIdentifier != myPID, $0.activationPolicy == .regular else { return false }
            guard let bundleIdentifier = targetAppBundleIdentifier else { return false }
            return $0.bundleIdentifier == bundleIdentifier
        }) ?? runningApps.first(where: {
            $0.activationPolicy == .regular && $0.processIdentifier != myPID
        })

        guard let app = targetApp else {
            self.statusMessage = "No target app found"
            return
        }

        // Activate target app and wait for focus to stabilize
        app.activate()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let src = CGEventSource(stateID: .hidSystemState)
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true),
               let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false) {
                down.flags = .maskCommand
                up.flags = .maskCommand
                down.post(tap: .cgSessionEventTap)
                up.post(tap: .cgSessionEventTap)
            }
            self.statusMessage = "Pasted (\(text.count) chars)"
        }
    }
}

// MARK: - CLI Runner

enum CLIRunner: Sendable {
    static func run(_ args: [String], home: String) -> String {
        let bin = "\(home)/.bun/bin/recordings"
        let escaped = args.map { "\"\($0)\"" }.joined(separator: " ")
        let proc = Process()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", """
            export PATH="\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
            "\(bin)" \(escaped)
        """]
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        do {
            try proc.run()
            proc.waitUntilExit()
            let stdout = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let stderr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            if proc.terminationStatus != 0 {
                let details = stderr.isEmpty ? stdout : stderr
                return "ERROR: \(details.trimmingCharacters(in: .whitespacesAndNewlines))"
            }
            return stdout.isEmpty ? stderr : stdout
        } catch {
            return "ERROR: \(error.localizedDescription)"
        }
    }

    static func parseError(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("ERROR:") else { return nil }
        let message = trimmed.dropFirst("ERROR:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        if message.contains("OpenAI API key not configured") {
            return "OpenAI API key not configured on this Mac"
        }
        if message.isEmpty {
            return "Transcription failed"
        }
        return String(message.prefix(120))
    }

    static func parseJSON(_ output: String) -> String? {
        if let s = output.range(of: "{"), let e = output.range(of: "}", options: .backwards) {
            let json = String(output[s.lowerBound...e.upperBound])
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
