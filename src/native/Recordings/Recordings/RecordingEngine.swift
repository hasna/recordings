import SwiftUI
import KeyboardShortcuts

// MARK: - Custom shortcut (not fn — fn is handled by FnKeyMonitor)

extension KeyboardShortcuts.Name {
    static let toggleRecording = Self("toggleRecording")
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
        case .pushToTalk: return "Hold fn to record, release to stop & paste"
        case .dictation: return "Hold fn to dictate, release to stop & paste"
        case .command: return "Select text, hold fn, speak to rewrite"
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

// MARK: - Recording Engine

@MainActor
final class RecordingEngine: ObservableObject {
    @Published var isRecording = false
    @Published var mode: RecordingMode = .pushToTalk
    @Published var useFnKey: Bool = true {
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
    private let maxDuration = 300

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var audioDir: String { "\(home)/.recordings/audio" }

    init() {
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)

        // Load preferences
        useFnKey = UserDefaults.standard.object(forKey: "useFnKey") as? Bool ?? true

        // Set up fn key monitor — hold fn to record, release to stop (like WisprFlow)
        fnMonitor.onFnKeyDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, !self.isRecording else { return }
                self.startRecording()
            }
        }
        fnMonitor.onFnKeyUp = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, self.isRecording else { return }
                self.stopAndTranscribe()
            }
        }
        updateFnMonitor()

        // Set up custom shortcut (toggle mode — press to start, press to stop)
        KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                self?.toggleRecording()
            }
        }

        updateStatus()
    }

    private func updateFnMonitor() {
        if useFnKey {
            let ok = fnMonitor.start()
            if !ok {
                statusMessage = "fn needs Accessibility permission (System Settings > Privacy & Security > Accessibility)"
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
            statusMessage = "No shortcut set — enable fn or set a custom shortcut"
        } else {
            statusMessage = "Ready — press \(parts.joined(separator: " or ")) to record"
        }
    }

    // MARK: - Toggle

    func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording() }
    }

    // MARK: - Start Recording

    func startRecording() {
        guard !isRecording else { return }

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
            statusMessage = mode == .command ? "Speak your instruction..." : "Recording — press fn to stop"

            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.recordingDuration += 0.1
                }
            }
        } catch {
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
                    self.pasteIntoFrontApp(text)
                    self.recentTranscriptions.insert(
                        TranscriptionResult(rawText: text, processedText: nil, timestamp: Date()), at: 0
                    )
                    if self.recentTranscriptions.count > 20 { self.recentTranscriptions.removeLast() }
                    self.statusMessage = "Pasted: \(String(text.prefix(50)))"
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

    func pasteIntoFrontApp(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        // Activate the last user app (not us)
        let myPID = ProcessInfo.processInfo.processIdentifier
        if let target = NSWorkspace.shared.runningApplications.first(where: {
            $0.activationPolicy == .regular && $0.processIdentifier != myPID
        }) {
            target.activate()
        }

        // Wait for activation, then Cmd+V
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            self.postKey(0x09, flags: .maskCommand)
        }
    }

    private func postKey(_ key: CGKeyCode, flags: CGEventFlags) {
        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true)
        down?.flags = flags
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false)
        up?.flags = flags
        up?.post(tap: .cghidEventTap)
    }
}

// MARK: - CLI Runner

enum CLIRunner: Sendable {
    static func run(_ args: [String], home: String) -> String {
        let bin = "\(home)/.bun/bin/recordings"
        let escaped = args.map { "\"\($0)\"" }.joined(separator: " ")
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", """
            export PATH="\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
            "\(bin)" \(escaped)
        """]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch { return "" }
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
            .first { !$0.isEmpty && !$0.hasPrefix("{") && !$0.contains("Transcribing") && !$0.hasPrefix("Saved") }
    }
}
