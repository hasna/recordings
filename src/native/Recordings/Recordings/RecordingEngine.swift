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

    private var recordProcess: Process?
    private var stdinPipe: Pipe?
    private var currentAudioPath: String?
    private var recordingTimer: Timer?
    private var activeTrigger: RecordingTrigger?
    private var keyboardShortcutIsDown = false
    private var targetAppBundleIdentifier: String?
    private let maxDuration = 300

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var audioDir: String { "\(home)/.hasna/recordings/audio" }

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

        var parts: [String] = []
        if useFnKey {
            parts.append("fn (hold)")
        }
        if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
            parts.append(shortcut.description)
        }

        if parts.isEmpty {
            statusMessage = "No shortcut set — enable fn or set a recording shortcut"
        } else {
            statusMessage = "Ready — hold \(parts.joined(separator: " or ")) to record"
        }
    }

    // MARK: - Toggle

    func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording(trigger: .manual) }
    }

    // MARK: - Start Recording

    func startRecording(trigger: RecordingTrigger = .manual) {
        guard !isRecording else { return }
        activeTrigger = trigger
        keyboardShortcutIsDown = trigger == .keyboardShortcut

        let myPID = ProcessInfo.processInfo.processIdentifier
        let frontmostApp = NSWorkspace.shared.frontmostApplication
        targetAppBundleIdentifier = frontmostApp?.processIdentifier == myPID ? nil : frontmostApp?.bundleIdentifier

        let ts = DateFormatter()
        ts.dateFormat = "yyyyMMdd'T'HHmmss"
        let path = "\(audioDir)/rec-\(ts.string(from: Date())).wav"
        currentAudioPath = path

        let proc = Process()
        let stdin = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", """
            export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
            if command -v ffmpeg &>/dev/null; then
                ffmpeg -f avfoundation -i ":0" -ar 16000 -ac 1 -t \(maxDuration) "\(path)" -y 2>/dev/null
            elif command -v rec &>/dev/null; then
                rec -r 16000 -c 1 -b 16 "\(path)" trim 0 \(maxDuration)
            else
                exit 1
            fi
        """]
        proc.standardInput = stdin
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            recordProcess = proc
            stdinPipe = stdin
            isRecording = true
            recordingDuration = 0
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
        } catch {
            activeTrigger = nil
            keyboardShortcutIsDown = false
            targetAppBundleIdentifier = nil
            statusMessage = "Failed: \(error.localizedDescription)"
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
        statusMessage = "Transcribing..."

        let audioPath = currentAudioPath
        let curMode = mode
        currentAudioPath = nil
        recordProcess = nil
        stdinPipe = nil
        let targetAppBundleIdentifier = targetAppBundleIdentifier
        activeTrigger = nil
        keyboardShortcutIsDown = false
        self.targetAppBundleIdentifier = nil
        let homePath = home

        Task.detached {
            try? await Task.sleep(for: .seconds(1))
            if proc.isRunning { proc.terminate() }
            try? await Task.sleep(for: .milliseconds(300))
            if proc.isRunning { proc.interrupt() }

            guard let audioPath else {
                await MainActor.run { self.finish("No audio file") }
                return
            }

            let attrs = try? FileManager.default.attributesOfItem(atPath: audioPath)
            let size = (attrs?[.size] as? Int) ?? 0
            guard size >= 1000 else {
                await MainActor.run { self.finish("Audio too short — speak longer") }
                return
            }

            let output = CLIRunner.run(["transcribe", audioPath, "--json"], home: homePath)
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
                        TranscriptionResult(rawText: text, processedText: nil, timestamp: Date()), at: 0
                    )
                    if self.recentTranscriptions.count > 20 { self.recentTranscriptions.removeLast() }
                    // statusMessage updated by pasteIntoFrontApp
                }
            }
        }
    }

    private func finish(_ msg: String) {
        isTranscribing = false
        statusMessage = msg
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

    // MARK: - Paste

    func pasteIntoFrontApp(_ text: String, targetAppBundleIdentifier: String? = nil) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        let trusted = AXIsProcessTrusted()
        fputs("[Paste] AXIsProcessTrusted=\(trusted)\n", stderr)

        let myPID = ProcessInfo.processInfo.processIdentifier
        let runningApps = NSWorkspace.shared.runningApplications
        let targetApp = runningApps.first(where: {
            guard $0.processIdentifier != myPID, $0.activationPolicy == .regular else { return false }
            guard let bundleIdentifier = targetAppBundleIdentifier else { return false }
            return $0.bundleIdentifier == bundleIdentifier
        }) ?? runningApps.first(where: {
            $0.activationPolicy == .regular && $0.processIdentifier != myPID
        })

        let localName = targetApp?.localizedName ?? "frontmost app"
        let bundleId = targetApp?.bundleIdentifier ?? "nil"
        fputs("[Paste] target=\(localName) bundle=\(bundleId) targetParam=\(targetAppBundleIdentifier ?? "nil")\n", stderr)

        statusMessage = "Pasting into \(localName)..."

        if let app = targetApp {
            app.activate()
            fputs("[Paste] activate() called on \(localName)\n", stderr)
        } else {
            fputs("[Paste] WARNING: no target app found\n", stderr)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.postCmdV()
            self.statusMessage = "Pasted: \(String(text.prefix(50)))"
        }
    }

    private func postCmdV() {
        let src = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false) else {
            fputs("[Paste] ERROR: CGEvent creation failed\n", stderr)
            return
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cgSessionEventTap)
        usleep(10_000)
        up.post(tap: .cgSessionEventTap)
        fputs("[Paste] CGEvent Cmd+V posted to cgSessionEventTap\n", stderr)
    }

    private func postKey(_ key: CGKeyCode, flags: CGEventFlags) {
        let src = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else {
            fputs("[Paste] ERROR: CGEvent creation failed for key \(key)\n", stderr)
            return
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cgSessionEventTap)
        usleep(10_000)
        up.post(tap: .cgSessionEventTap)
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
