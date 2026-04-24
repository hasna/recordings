import AVFoundation
@preconcurrency import ApplicationServices
import SwiftUI
@preconcurrency import KeyboardShortcuts

// MARK: - Custom shortcut (not fn — fn is handled by FnKeyMonitor)

extension KeyboardShortcuts.Name {
    @MainActor static let toggleRecording = Self("toggleRecording", default: .init(.f5))
}

// MARK: - Recording Mode

public enum RecordingMode: String, CaseIterable, Identifiable, Sendable {
    case pushToTalk = "Push to Talk"
    case dictation = "Dictation"
    case command = "Command"

    public var id: String { rawValue }
    public var icon: String {
        switch self {
        case .pushToTalk: return "hand.tap.fill"
        case .dictation: return "text.bubble.fill"
        case .command: return "wand.and.stars"
        }
    }
    public var hint: String {
        switch self {
        case .pushToTalk: return "Hold F5 or your chosen shortcut to record, then release to paste"
        case .dictation: return "Hold F5 or your chosen shortcut to dictate, then release to paste"
        case .command: return "Select text, then hold F5 or your chosen shortcut and release to rewrite"
        }
    }
}

// MARK: - Transcription Result

public struct TranscriptionResult: Sendable {
    let rawText: String
    let processedText: String?
    let timestamp: Date
    let projectId: String?
    let projectName: String?
    var displayText: String { processedText ?? rawText }
}

public enum RecordingTrigger {
    case manual
    case fnKey
    case keyboardShortcut
}

private actor PCMStreamState {
    private var recordedPCM = Data()
    private var pendingChunk = Data()

    func append(_ data: Data, chunkSize: Int) -> [Data] {
        guard !data.isEmpty else { return [] }

        recordedPCM.append(data)
        pendingChunk.append(data)

        var chunks: [Data] = []
        while pendingChunk.count >= chunkSize {
            chunks.append(pendingChunk.prefixData(count: chunkSize))
            pendingChunk.removeFirst(chunkSize)
        }
        return chunks
    }

    func flushPendingChunk() -> Data? {
        guard !pendingChunk.isEmpty else { return nil }
        let chunk = pendingChunk
        pendingChunk.removeAll(keepingCapacity: true)
        return chunk
    }

    func capturedPCM() -> Data {
        recordedPCM
    }
}

private extension Data {
    func prefixData(count: Int) -> Data {
        Data(prefix(count))
    }
}

// MARK: - Recording Engine

@MainActor
public final class RecordingEngine: ObservableObject {
    @Published public var isRecording = false
    @Published public var mode: RecordingMode = .pushToTalk {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: "recordingMode")
            updateStatus()
        }
    }
    @Published public var useFnKey: Bool = false {
        didSet {
            UserDefaults.standard.set(useFnKey, forKey: "useFnKey")
            updateFnMonitor()
            updateStatus()
        }
    }
    @Published public var isWhisperMode = false
    @Published public var recentTranscriptions: [TranscriptionResult] = []
    @Published public var statusMessage = "Starting..."
    @Published public var isTranscribing = false
    @Published public var recordingDuration: TimeInterval = 0
    @Published public var liveTranscriptionText = ""

    private var nativeRecorder: NativePCMRecorder?
    private var recordingTimer: Timer?
    private var activeTrigger: RecordingTrigger?
    private var keyboardShortcutIsDown = false
    private var targetAppBundleIdentifier: String?
    private var targetAppPid: pid_t?
    public var projectStore: ProjectStore?
    public var voiceShortcuts: VoiceShortcuts?

    // Real-time streaming
    private var realtimeClient: RealtimeTranscriptionClient?
    private var streamingTask: Task<Void, Never>?
    private var pcmStreamState: PCMStreamState?
    private var streamingText = ""
    private var recordedPCM = Data()
    private var activeAudioPath: String?
    private var lastAccessibilityPromptAt: Date?

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var audioDir: String { "\(home)/.hasna/recordings/audio" }

    // MARK: - OpenAI API Key

    private var openAIAPIKey: String {
        OpenAIAPIKeyStore.load(homePath: home)
    }

    public init() {
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)
        log("RecordingEngine init; microphone=\(microphonePermissionLabel); accessibility=\(accessibilityPermissionLabel)")

        // Load preferences
        if let savedMode = UserDefaults.standard.string(forKey: "recordingMode"),
           let parsedMode = RecordingMode(rawValue: savedMode) {
            mode = parsedMode
        }
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

    public var microphonePermissionLabel: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return "Microphone allowed"
        case .notDetermined:
            return "Microphone not requested"
        case .denied:
            return "Microphone denied"
        case .restricted:
            return "Microphone restricted"
        @unknown default:
            return "Microphone unknown"
        }
    }

    public var accessibilityPermissionLabel: String {
        AXIsProcessTrusted() ? "Accessibility allowed" : "Accessibility needed"
    }

    public func requestMicrophonePermission() {
        log("requestMicrophonePermission status=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log("requestMicrophonePermission result granted=\(granted)")
                self.statusMessage = granted
                    ? "Microphone allowed"
                    : "Enable Microphone permission for Recordings in System Settings"
                self.objectWillChange.send()
            }
        }
    }

    public func requestAccessibilityPermission() {
        let trusted = ensureAccessibilityPermission(prompt: true)
        log("requestAccessibilityPermission trusted=\(trusted)")
        statusMessage = trusted
            ? "Accessibility allowed"
            : "Enable Accessibility permission for Recordings to paste"
        objectWillChange.send()
    }

    public func openMicrophoneSettings() {
        openPrivacySettings("Privacy_Microphone")
    }

    public func openAccessibilitySettings() {
        openPrivacySettings("Privacy_Accessibility")
    }

    private func openPrivacySettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func updateFnMonitor() {
        if useFnKey {
            let ok = fnMonitor.start()
            log("fn monitor start ok=\(ok)")
            if !ok {
                statusMessage = "fn needs Input Monitoring / Accessibility permission, and Globe must be set to Do Nothing"
            }
        } else {
            fnMonitor.stop()
        }
    }

    public func updateStatus() {
        if isRecording || isTranscribing { return }
        statusMessage = "Ready"
    }

    // MARK: - Toggle

    public func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording(trigger: .manual) }
    }

    // MARK: - Start Recording (Streaming)

    public func startRecording(trigger: RecordingTrigger = .manual) {
        guard !isRecording else { return }
        log("startRecording trigger=\(trigger) microphoneStatus=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) accessibility=\(AXIsProcessTrusted())")
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

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            startNativeRecording()
        case .notDetermined:
            statusMessage = "Allow microphone access to record"
            log("requesting microphone access before recording")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.log("microphone access response granted=\(granted)")
                    if granted {
                        self.startNativeRecording()
                    } else {
                        self.resetRecordingIntent()
                        self.statusMessage = "Microphone permission denied"
                    }
                }
            }
        case .denied, .restricted:
            resetRecordingIntent()
            log("microphone permission blocked status=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
            statusMessage = "Enable Microphone permission for Recordings in System Settings"
        @unknown default:
            resetRecordingIntent()
            statusMessage = "Microphone permission unavailable"
        }
    }

    private func startNativeRecording() {
        let streamState = PCMStreamState()
        pcmStreamState = streamState

        let apiKey = openAIAPIKey
        log("startNativeRecording apiKeyConfigured=\(!apiKey.isEmpty)")
        if !apiKey.isEmpty {
            startRealtimeStreaming(apiKey: apiKey)
        }

        let client = realtimeClient
        let homePath = home
        let firstChunkLogged = LockedFlag()
        let recorder = NativePCMRecorder { [weak client] data in
            if firstChunkLogged.take() {
                NativeAppLog.write("native recorder received first PCM chunk bytes=\(data.count)", homePath: homePath)
            }
            Task {
                let chunks = await streamState.append(data, chunkSize: 4_800)
                for chunk in chunks {
                    await client?.sendAudio(chunk)
                }
            }
        }

        do {
            try recorder.start()
            log("native recorder started")
            nativeRecorder = recorder
            isRecording = true
            recordingDuration = 0
            streamingText = ""
            liveTranscriptionText = ""
            recordedPCM.removeAll(keepingCapacity: true)
            activeAudioPath = "\(audioDir)/recording-\(Self.timestampForFilename()).wav"
            let trigger = activeTrigger ?? .manual
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
            log("native recorder failed error=\(error.localizedDescription)")
            realtimeClient?.stop()
            realtimeClient = nil
            streamingTask?.cancel()
            streamingTask = nil
            pcmStreamState = nil
            resetRecordingIntent()
            statusMessage = "Failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Real-time Streaming

    private func startRealtimeStreaming(apiKey: String) {
        let systemPrompt = projectStore?.effectiveSystemPrompt ?? ""
        let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)
        realtimeClient = client
        log("realtime streaming task starting")

        streamingTask = Task {
            await client.startStreaming(systemPrompt: systemPrompt)
            self.log("realtime start completed streaming=\(client.isStreaming) error=\(client.error ?? "")")

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

            if let message = client.error, !message.isEmpty {
                await MainActor.run {
                    self.log("realtime unavailable message=\(message)")
                    self.statusMessage = "Realtime unavailable — will transcribe after recording"
                }
            }
        }
    }

    // MARK: - Stop & Transcribe

    public func stopAndTranscribe() {
        guard isRecording else { return }
        log("stopAndTranscribe")

        recordingTimer?.invalidate()
        recordingTimer = nil

        let recorder = nativeRecorder
        nativeRecorder = nil
        recorder?.stop()

        isRecording = false
        isTranscribing = true

        let curMode = mode
        let targetAppBundleIdentifier = targetAppBundleIdentifier
        let activeProjectId = projectStore?.settings.activeProjectId
        let activeProjectName = projectStore?.activeProject?.name
        let audioPath = activeAudioPath
        let pcmStreamState = pcmStreamState
        let client = realtimeClient
        resetRecordingIntent()
        self.pcmStreamState = nil

        Task {
            if let pcmStreamState {
                if let finalChunk = await pcmStreamState.flushPendingChunk() {
                    client?.sendAudio(finalChunk)
                }
                self.recordedPCM = await pcmStreamState.capturedPCM()
            }
            self.log("captured pcm bytes=\(self.recordedPCM.count)")

            let streamingResult = await client?.finish() ?? ""

            self.realtimeClient = nil
            self.streamingTask?.cancel()
            self.streamingTask = nil

            let text = streamingResult.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : streamingResult

            self.liveTranscriptionText = ""

            if let text {
                self.log("finish using realtime text chars=\(text.count)")
                self.isTranscribing = false
                self.finishWithText(
                    text,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName
                )
            } else if let audioPath, self.writeCapturedWAV(to: audioPath) {
                self.log("falling back to CLI transcription audioPath=\(audioPath)")
                self.fallbackTranscribe(
                    audioPath: audioPath,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName
                )
            } else {
                self.log("no audio captured")
                self.finish("No audio captured")
            }

            self.activeAudioPath = nil
            self.recordedPCM.removeAll(keepingCapacity: true)
        }
    }

    private func finishWithText(_ text: String, curMode: RecordingMode, targetAppBundleIdentifier: String?, activeProjectId: String?, activeProjectName: String?) {
        log("finishWithText mode=\(curMode.rawValue) chars=\(text.count)")
        if curMode == .command {
            runCommandMode(instruction: text)
            return
        }

        let shortcutText = voiceShortcuts?.match(text)
        let output = shortcutText ?? text
        pasteIntoFrontApp(output, targetAppBundleIdentifier: targetAppBundleIdentifier)
        recentTranscriptions.insert(
            TranscriptionResult(
                rawText: text,
                processedText: shortcutText,
                timestamp: Date(),
                projectId: activeProjectId,
                projectName: activeProjectName
            ),
            at: 0
        )
        if recentTranscriptions.count > 20 { recentTranscriptions.removeLast() }
    }

    private func writeCapturedWAV(to path: String) -> Bool {
        guard !recordedPCM.isEmpty else { return false }
        do {
            try Self.writeWAV(
                pcmData: recordedPCM,
                sampleRate: 24_000,
                channelCount: 1,
                bitsPerSample: 16,
                to: URL(fileURLWithPath: path)
            )
            log("wrote wav path=\(path) pcmBytes=\(recordedPCM.count)")
            return true
        } catch {
            log("failed to save wav error=\(error.localizedDescription)")
            statusMessage = "Failed to save audio"
            return false
        }
    }

    private static func writeWAV(pcmData: Data, sampleRate: UInt32, channelCount: UInt16, bitsPerSample: UInt16, to url: URL) throws {
        let byteRate = sampleRate * UInt32(channelCount) * UInt32(bitsPerSample / 8)
        let blockAlign = channelCount * (bitsPerSample / 8)
        let dataSize = UInt32(pcmData.count)
        let fileSize = UInt32(36) + dataSize

        var wav = Data()
        func appendASCII(_ string: String) {
            wav.append(contentsOf: string.utf8)
        }
        func appendUInt16LE(_ value: UInt16) {
            wav.append(UInt8(value & 0xff))
            wav.append(UInt8((value >> 8) & 0xff))
        }
        func appendUInt32LE(_ value: UInt32) {
            wav.append(UInt8(value & 0xff))
            wav.append(UInt8((value >> 8) & 0xff))
            wav.append(UInt8((value >> 16) & 0xff))
            wav.append(UInt8((value >> 24) & 0xff))
        }

        appendASCII("RIFF")
        appendUInt32LE(fileSize)
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32LE(16)
        appendUInt16LE(1)
        appendUInt16LE(channelCount)
        appendUInt32LE(sampleRate)
        appendUInt32LE(byteRate)
        appendUInt16LE(blockAlign)
        appendUInt16LE(bitsPerSample)
        appendASCII("data")
        appendUInt32LE(dataSize)
        wav.append(pcmData)

        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try wav.write(to: url, options: .atomic)
    }

    private static func timestampForFilename() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return formatter.string(from: Date())
    }

    // MARK: - Fallback Transcription

    private func fallbackTranscribe(audioPath: String, curMode: RecordingMode, targetAppBundleIdentifier: String?, activeProjectId: String?, activeProjectName: String?) {
        let homePath = home

        isTranscribing = true
        statusMessage = "Transcribing..."

        Task.detached {
            let output = CLIRunner.run(["--json", "transcribe", audioPath, "--no-enhance"], home: homePath)
            if let error = CLIRunner.parseError(output) {
                await MainActor.run {
                    self.log("fallback transcription failed error=\(error)")
                    self.finish(error)
                }
                return
            }

            let text = CLIRunner.parseJSON(output)
            guard let text, !text.isEmpty else {
                await MainActor.run {
                    self.log("fallback transcription empty output=\(output.prefix(160))")
                    self.finish("Empty transcription")
                }
                return
            }

            await MainActor.run {
                self.log("fallback transcription succeeded chars=\(text.count)")
                self.isTranscribing = false
                self.finishWithText(
                    text,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName
                )
            }
        }
    }

    private func mostRecentAudioFile() -> String? {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: audioDir)) ?? []
        let wavFiles = files.filter { $0.hasSuffix(".wav") }.sorted().reversed()
        return wavFiles.first.map { "\(audioDir)/\($0)" }
    }

    private func finish(_ msg: String) {
        log("finish status=\(msg)")
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = msg
    }

    private func resetRecordingIntent() {
        activeTrigger = nil
        keyboardShortcutIsDown = false
        targetAppBundleIdentifier = nil
        targetAppPid = nil
    }

    // MARK: - Command Mode

    private func runCommandMode(instruction: String) {
        guard ensureAccessibilityPermission(prompt: shouldPromptAccessibility()) else {
            log("command mode blocked by accessibility permission")
            statusMessage = "Enable Accessibility permission for Recordings to rewrite selected text"
            return
        }
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

            Task.detached {
                let result = CLIRunner.run(["rewrite", selected, "--instruction", instruction], home: homePath)
                await MainActor.run {
                    self.isTranscribing = false
                    self.liveTranscriptionText = ""
                    if CLIRunner.parseError(result) == nil, !result.isEmpty {
                        self.pasteIntoFrontApp(result)
                        self.statusMessage = "Rewritten"
                    } else {
                        self.statusMessage = CLIRunner.parseError(result) ?? "Rewrite failed"
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
        log("paste requested chars=\(text.count) target=\(targetAppBundleIdentifier ?? "nil") accessibility=\(AXIsProcessTrusted())")
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        let prompted = shouldPromptAccessibility()
        guard ensureAccessibilityPermission(prompt: prompted) else {
            log("paste blocked by accessibility permission; copied to clipboard")
            self.statusMessage = prompted
                ? "Copied — approve Accessibility for this Recordings app"
                : "Copied — waiting for Accessibility approval"
            return
        }

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
            log("paste target app not found")
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
            self.log("paste event posted")
            self.statusMessage = "Pasted (\(text.count) chars)"
        }
    }

    private func ensureAccessibilityPermission(prompt: Bool) -> Bool {
        if AXIsProcessTrusted() {
            return true
        }
        if !prompt {
            return false
        }
        return AXIsProcessTrustedWithOptions(
            ["AXTrustedCheckOptionPrompt" as CFString: true] as CFDictionary
        )
    }

    private func shouldPromptAccessibility() -> Bool {
        let now = Date()
        if let lastAccessibilityPromptAt,
           now.timeIntervalSince(lastAccessibilityPromptAt) < 20 {
            return false
        }
        lastAccessibilityPromptAt = now
        return true
    }

    private func log(_ message: String) {
        NativeAppLog.write(message, homePath: home)
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true

    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard value else { return false }
        value = false
        return true
    }
}

// MARK: - CLI Runner

enum CLIRunner: Sendable {
    static func run(_ args: [String], home: String) -> String {
        let bin = "\(home)/.bun/bin/recordings"
        let proc = Process()
        let outPipe = Pipe()
        let errPipe = Pipe()
        if FileManager.default.fileExists(atPath: bin) {
            proc.executableURL = URL(fileURLWithPath: bin)
            proc.arguments = args
        } else {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["recordings"] + args
        }
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "PATH": "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        ]) { _, new in new }
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
