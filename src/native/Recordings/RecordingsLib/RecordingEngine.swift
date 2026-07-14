import AVFoundation
@preconcurrency import ApplicationServices
import SwiftUI
@preconcurrency import KeyboardShortcuts

// MARK: - Custom shortcut (not fn — fn is handled by FnKeyMonitor)

extension KeyboardShortcuts.Name {
    @MainActor public static let toggleRecording = Self("toggleRecording", default: .init(.f5))
}

// MARK: - Recording Mode

public enum RecordingMode: String, CaseIterable, Identifiable, Sendable {
    case pushToTalk = "Push to Talk"
    case dictation = "Dictation"
    case command = "Command"

    public var id: String { rawValue }
    public var shortName: String {
        switch self {
        case .pushToTalk: return "Talk"
        case .dictation: return "Dictate"
        case .command: return "Command"
        }
    }
    public var icon: String {
        switch self {
        case .pushToTalk: return "hand.tap.fill"
        case .dictation: return "text.bubble.fill"
        case .command: return "wand.and.stars"
        }
    }
    public var hint: String {
        switch self {
        case .pushToTalk: return "Hold your recording shortcut, then release to paste"
        case .dictation: return "Hold your recording shortcut to dictate, then release to paste"
        case .command: return "Select text, hold your recording shortcut, then release to rewrite"
        }
    }
}

// MARK: - Transcription Result

public struct TranscriptionResult: Identifiable, Sendable {
    public let id = UUID()
    let rawText: String
    let processedText: String?
    let timestamp: Date
    let projectId: String?
    let projectName: String?
    public var displayText: String { processedText ?? rawText }

    init(rawText: String, processedText: String?, timestamp: Date, projectId: String?, projectName: String?) {
        self.rawText = rawText
        self.processedText = processedText
        self.timestamp = timestamp
        self.projectId = projectId
        self.projectName = projectName
    }
}

private struct RealtimeFastPathSaveResult: Sendable {
    let text: String?
    let error: String?
}

public enum RecordingTrigger: Equatable, Sendable {
    case manual
    case fnKey
    case keyboardShortcut
}

struct PasteTargetCandidate: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String?
    let isRegularApp: Bool
}

private final class PCMStreamPipe: @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private let processor: Task<Data, Never>

    init(chunkSize: Int, client: RealtimeTranscriptionClient?) {
        var streamContinuation: AsyncStream<Data>.Continuation!
        let stream = AsyncStream<Data>(bufferingPolicy: .unbounded) { continuation in
            streamContinuation = continuation
        }
        continuation = streamContinuation
        processor = Task {
            var recordedPCM = Data()
            var pendingChunk = Data()

            for await data in stream {
                guard !data.isEmpty else { continue }
                recordedPCM.append(data)
                pendingChunk.append(data)

                while pendingChunk.count >= chunkSize {
                    await client?.sendAudio(pendingChunk.prefixData(count: chunkSize))
                    pendingChunk.removeFirst(chunkSize)
                }
            }

            if !pendingChunk.isEmpty {
                await client?.sendAudio(pendingChunk)
            }
            return recordedPCM
        }
    }

    func append(_ data: Data) {
        continuation.yield(data)
    }

    func finish() async -> Data {
        continuation.finish()
        return await processor.value
    }

    func cancel() {
        continuation.finish()
        processor.cancel()
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
    @Published public var transcriptionLanguage = OpenAIAPIKeyStore.defaultLanguage {
        didSet {
            UserDefaults.standard.set(transcriptionLanguage, forKey: "recordingsLanguage")
            try? OpenAIAPIKeyStore.saveLanguage(language: transcriptionLanguage, homePath: home)
        }
    }

    private var nativeRecorder: NativePCMRecorder?
    private var recordingTimer: Timer?
    private var activeTrigger: RecordingTrigger?
    private var microphonePermissionRequestID: UUID?
    private var keyboardShortcutIsDown = false
    private var fnKeyIsDown = false
    private var targetAppBundleIdentifier: String?
    private var targetAppPid: pid_t?
    public var projectStore: ProjectStore?
    public var voiceShortcuts: VoiceShortcuts?

    // Real-time streaming
    private var realtimeClient: RealtimeTranscriptionClient?
    private var streamingTask: Task<Void, Never>?
    private var pcmStreamPipe: PCMStreamPipe?
    private var streamingText = ""
    private var recordedPCM = Data()
    private var activeAudioPath: String?
    private var lastAccessibilityPromptAt: Date?

    private nonisolated static let realtimePeriodicCommitInterval: TimeInterval = 0.9
    private nonisolated static let realtimeFinishTimeoutMilliseconds: UInt64 = 700

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()
    private var permissionRetryTimer: Timer?

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
        transcriptionLanguage = OpenAIAPIKeyStore.loadLanguage(homePath: home)
        useFnKey = UserDefaults.standard.object(forKey: "useFnKey") as? Bool ?? false
        if KeyboardShortcuts.getShortcut(for: .toggleRecording) == nil {
            KeyboardShortcuts.setShortcut(.init(.f5), for: .toggleRecording)
        }

        // Set up fn key monitor — hold fn to record, release to stop (like WisprFlow)
        fnMonitor.onFnKeyDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = true
                guard self.useFnKey, Self.canBeginRecording(
                    isRecording: self.isRecording,
                    isTranscribing: self.isTranscribing,
                    isAwaitingMicrophonePermission: self.microphonePermissionRequestID != nil
                ) else { return }
                self.startRecording(trigger: .fnKey)
            }
        }
        fnMonitor.onFnKeyUp = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = false
                guard self.useFnKey, self.activeTrigger == .fnKey else { return }
                guard self.isRecording else {
                    self.log("fn released before recording started; cancelling pending start")
                    self.resetRecordingIntent()
                    self.updateStatus()
                    return
                }
                self.stopAndTranscribe()
            }
        }
        updateFnMonitor()

        KeyboardShortcuts.onKeyDown(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = true
                guard Self.canBeginRecording(
                    isRecording: self.isRecording,
                    isTranscribing: self.isTranscribing,
                    isAwaitingMicrophonePermission: self.microphonePermissionRequestID != nil
                ) else { return }
                self.startRecording(trigger: .keyboardShortcut)
            }
        }
        KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = false
                guard self.activeTrigger == .keyboardShortcut else { return }
                guard self.isRecording else {
                    self.log("shortcut released before recording started; cancelling pending start")
                    self.resetRecordingIntent()
                    self.updateStatus()
                    return
                }
                self.stopAndTranscribe()
            }
        }

        // Granting Accessibility does not revive a tap that failed to create,
        // so retry until permissions arrive instead of requiring a relaunch.
        permissionRetryTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, !self.fnMonitor.isRunning, AXIsProcessTrusted() else { return }
                self.log("accessibility granted — retrying fn monitor")
                self.updateFnMonitor()
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
        guard Self.canBeginRecording(
            isRecording: isRecording,
            isTranscribing: isTranscribing,
            isAwaitingMicrophonePermission: microphonePermissionRequestID != nil
        ) else {
            if isTranscribing {
                statusMessage = "Finish transcribing before recording again"
            }
            return
        }
        log("startRecording trigger=\(trigger) microphoneStatus=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) accessibility=\(AXIsProcessTrusted())")
        activeTrigger = trigger
        keyboardShortcutIsDown = trigger == .keyboardShortcut

        let myPID = ProcessInfo.processInfo.processIdentifier
        let frontmostApp = NSWorkspace.shared.frontmostApplication
        let isOwnApp = frontmostApp?.processIdentifier == myPID
        targetAppBundleIdentifier = isOwnApp ? nil : frontmostApp?.bundleIdentifier
        targetAppPid = isOwnApp ? nil : frontmostApp?.processIdentifier

        if let store = projectStore {
            guard store.isReadyForRecording else {
                resetRecordingIntent()
                statusMessage = store.persistenceError ?? "Preparing projects before recording"
                return
            }
            let windowTitle = Self.focusedWindowTitle(pid: frontmostApp?.processIdentifier)
            let projects = store.settings.projects
            let detected = ProjectStore.matchProject(windowTitle: windowTitle, bundleId: targetAppBundleIdentifier, projects: projects)
            if let detected {
                do {
                    try store.setActive(detected.id)
                } catch {
                    resetRecordingIntent()
                    statusMessage = store.persistenceError ?? "Failed to select project"
                    return
                }
            }
        }

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            startNativeRecording()
        case .notDetermined:
            let requestID = UUID()
            microphonePermissionRequestID = requestID
            statusMessage = "Allow microphone access to record"
            log("requesting microphone access before recording")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard Self.isCurrentMicrophonePermissionRequest(
                        activeRequestID: self.microphonePermissionRequestID,
                        responseRequestID: requestID
                    ) else {
                        self.log("ignoring stale microphone permission response")
                        return
                    }
                    self.microphonePermissionRequestID = nil
                    self.log("microphone access response granted=\(granted)")
                    if granted {
                        guard self.shouldContinueStarting(trigger: trigger) else {
                            self.log("recording start cancelled before microphone permission completed trigger=\(trigger)")
                            self.resetRecordingIntent()
                            self.updateStatus()
                            return
                        }
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

    nonisolated static func canBeginRecording(
        isRecording: Bool,
        isTranscribing: Bool,
        isAwaitingMicrophonePermission: Bool = false
    ) -> Bool {
        !isRecording && !isTranscribing && !isAwaitingMicrophonePermission
    }

    nonisolated static func isCurrentMicrophonePermissionRequest(
        activeRequestID: UUID?,
        responseRequestID: UUID
    ) -> Bool {
        activeRequestID == responseRequestID
    }

    nonisolated static func shouldContinueStartingAfterPermission(
        trigger: RecordingTrigger,
        keyboardShortcutIsDown: Bool,
        fnKeyIsDown: Bool
    ) -> Bool {
        switch trigger {
        case .manual:
            return true
        case .keyboardShortcut:
            return keyboardShortcutIsDown
        case .fnKey:
            return fnKeyIsDown
        }
    }

    private func shouldContinueStarting(trigger: RecordingTrigger) -> Bool {
        activeTrigger == trigger && Self.shouldContinueStartingAfterPermission(
            trigger: trigger,
            keyboardShortcutIsDown: keyboardShortcutIsDown,
            fnKeyIsDown: fnKeyIsDown
        )
    }

    private func startNativeRecording() {
        let apiKey = openAIAPIKey
        log("startNativeRecording apiKeyConfigured=\(!apiKey.isEmpty)")
        if !apiKey.isEmpty {
            startRealtimeStreaming(apiKey: apiKey)
        }

        let client = realtimeClient
        let streamPipe = PCMStreamPipe(chunkSize: 4_800, client: client)
        pcmStreamPipe = streamPipe
        let homePath = home
        let firstChunkLogged = LockedFlag()
        let recorder = NativePCMRecorder { data in
            if firstChunkLogged.take() {
                NativeAppLog.write("native recorder received first PCM chunk bytes=\(data.count)", homePath: homePath)
            }
            streamPipe.append(data)
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
            pcmStreamPipe?.cancel()
            pcmStreamPipe = nil
            resetRecordingIntent()
            statusMessage = "Failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Real-time Streaming

    private func startRealtimeStreaming(apiKey: String) {
        let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)
        realtimeClient = client
        let language = OpenAIAPIKeyStore.apiLanguageHint(for: transcriptionLanguage)
        log("realtime streaming task starting language=\(language.isEmpty ? "auto" : language)")

        streamingTask = Task {
            await client.startStreaming(language: language)
            self.log("realtime start completed streaming=\(client.isStreaming) error=\(client.error ?? "")")

            var lastPeriodicCommitAt = Date.distantPast

            // Receive deltas
            while client.isStreaming {
                try? await Task.sleep(for: .milliseconds(100))
                if self.isRecording,
                   Date().timeIntervalSince(lastPeriodicCommitAt) >= Self.realtimePeriodicCommitInterval {
                    if await client.commitInput(reason: "periodic") {
                        lastPeriodicCommitAt = Date()
                    }
                }
                let text = client.accumulatedText
                if text != streamingText {
                    await MainActor.run {
                        self.streamingText = text
                        self.liveTranscriptionText = Self.cleanRealtimeArtifactText(text)
                    }
                }
            }

            if let message = client.error, !message.isEmpty {
                await MainActor.run {
                    self.log("realtime unavailable message=\(message)")
                    if self.isRecording {
                        self.statusMessage = "Live preview unavailable — will transcribe after recording"
                    }
                }
            }
        }
    }

    // MARK: - Cancel (discard without transcribing)

    public func cancelRecording() {
        guard isRecording else { return }
        log("cancelRecording")

        recordingTimer?.invalidate()
        recordingTimer = nil

        let recorder = nativeRecorder
        nativeRecorder = nil
        recorder?.stop()

        realtimeClient?.stop()
        realtimeClient = nil
        streamingTask?.cancel()
        streamingTask = nil
        pcmStreamPipe?.cancel()
        pcmStreamPipe = nil

        isRecording = false
        isTranscribing = false
        liveTranscriptionText = ""
        recordedPCM.removeAll(keepingCapacity: true)
        activeAudioPath = nil
        resetRecordingIntent()
        statusMessage = "Ready"
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
        let targetAppPid = targetAppPid
        let activeProjectId = projectStore?.settings.activeProjectId
        let activeProjectName = projectStore?.activeProject?.name
        let audioPath = activeAudioPath
        let pcmStreamPipe = pcmStreamPipe
        let client = realtimeClient
        resetRecordingIntent()
        self.pcmStreamPipe = nil

        Task {
            if let pcmStreamPipe {
                self.recordedPCM = await pcmStreamPipe.finish()
            }
            self.log("captured pcm bytes=\(self.recordedPCM.count)")

            let streamingResult = await client?.finish(timeoutMilliseconds: Self.realtimeFinishTimeoutMilliseconds)
                ?? RealtimeFinishResult(text: "", settled: false, error: nil)

            self.realtimeClient = nil
            self.streamingTask?.cancel()
            self.streamingTask = nil

            if let error = streamingResult.error {
                self.log("realtime finish reported error=\(error)")
            }

            let realtimeText = Self.normalizedRealtimeTranscript(streamingResult.text)
            let safeRealtimeFallbackText = Self.safeRealtimeFallbackTranscript(
                realtimeText: streamingResult.text,
                language: self.transcriptionLanguage
            )
            let realtimeFastPathText = streamingResult.settled && streamingResult.error == nil ? Self.realtimeFastPathTranscript(
                realtimeText: streamingResult.text,
                pcmByteCount: self.recordedPCM.count,
                language: self.transcriptionLanguage
            ) : nil

            self.liveTranscriptionText = ""

            if let realtimeFastPathText {
                let pcmData = self.recordedPCM
                let durationMs = Int(self.recordingDuration * 1_000)
                self.log("using realtime fast path chars=\(realtimeFastPathText.count) pcmBytes=\(pcmData.count)")
                let saveResult = await Self.saveRealtimeTranscript(
                    text: realtimeFastPathText,
                    audioPath: audioPath,
                    pcmData: pcmData,
                    durationMs: durationMs,
                    activeProjectId: activeProjectId,
                    transcriberPrompt: self.projectStore?.effectiveSystemPrompt ?? "",
                    postProcessingMode: self.projectStore?.effectivePostProcessingMode ?? PostProcessingMode.auto.rawValue,
                    language: OpenAIAPIKeyStore.apiLanguageHint(for: self.transcriptionLanguage),
                    homePath: self.home
                )
                guard let savedText = saveResult.text else {
                    self.log("realtime fast-path save failed error=\(saveResult.error ?? "unknown")")
                    if let audioPath, FileManager.default.fileExists(atPath: audioPath) || self.writeCapturedWAV(to: audioPath) {
                        self.fallbackTranscribe(
                            audioPath: audioPath,
                            curMode: curMode,
                            targetAppBundleIdentifier: targetAppBundleIdentifier,
                            targetAppPid: targetAppPid,
                            activeProjectId: activeProjectId,
                            activeProjectName: activeProjectName,
                            realtimeText: safeRealtimeFallbackText
                        )
                    } else {
                        self.finish(saveResult.error ?? "Failed to save transcription")
                    }
                    self.activeAudioPath = nil
                    self.recordedPCM.removeAll(keepingCapacity: true)
                    return
                }
                self.isTranscribing = false
                self.finishWithText(
                    savedText,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName
                )
            } else if let audioPath, self.writeCapturedWAV(to: audioPath) {
                if realtimeText != nil, !streamingResult.settled {
                    self.log("realtime fast path skipped because final transcript did not settle")
                }
                self.log("transcribing captured full audio with quality model audioPath=\(audioPath) realtimePreviewChars=\(realtimeText?.count ?? 0)")
                self.fallbackTranscribe(
                    audioPath: audioPath,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName,
                    realtimeText: safeRealtimeFallbackText
                )
            } else {
                let resolved = Self.resolveFinalTranscript(
                    cliText: nil,
                    cliError: "No audio captured",
                    realtimeText: safeRealtimeFallbackText
                )
                if let text = resolved.text {
                    self.log("no audio file written; using realtime transcript chars=\(text.count)")
                    self.isTranscribing = false
                    self.finishWithText(
                        text,
                        curMode: curMode,
                        targetAppBundleIdentifier: targetAppBundleIdentifier,
                        targetAppPid: targetAppPid,
                        activeProjectId: activeProjectId,
                        activeProjectName: activeProjectName
                    )
                } else {
                    self.log("no audio captured")
                    self.finish(resolved.failureStatus ?? "No audio captured")
                }
            }

            self.activeAudioPath = nil
            self.recordedPCM.removeAll(keepingCapacity: true)
        }
    }

    public nonisolated static func shouldFallbackFromPartialRealtime(text: String, pcmByteCount: Int) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pcmByteCount >= 48_000, !trimmed.isEmpty else { return false }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        return trimmed.count < 12 || words.count <= 2
    }

    public nonisolated static func normalizedRealtimeTranscript(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = cleanRealtimeArtifactText(text).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public nonisolated static func shouldUseRealtimeFastPath(
        realtimeText: String?,
        pcmByteCount: Int,
        language: String = "en"
    ) -> Bool {
        realtimeFastPathTranscript(
            realtimeText: realtimeText,
            pcmByteCount: pcmByteCount,
            language: language
        ) != nil
    }

    public nonisolated static func realtimeFastPathTranscript(
        realtimeText: String?,
        pcmByteCount: Int,
        language: String = "en"
    ) -> String? {
        guard let text = safeRealtimeFallbackTranscript(realtimeText: realtimeText, language: language) else { return nil }
        return shouldFallbackFromPartialRealtime(text: text, pcmByteCount: pcmByteCount) ? nil : text
    }

    public nonisolated static func safeRealtimeFallbackTranscript(
        realtimeText: String?,
        language: String = "en"
    ) -> String? {
        guard let text = normalizedRealtimeTranscript(realtimeText) else { return nil }
        guard isSafeRealtimeFastPathText(
            rawText: realtimeText ?? "",
            cleanedText: text,
            language: language
        ) else { return nil }
        return text
    }

    public nonisolated static func isSafeRealtimeFastPathText(rawText: String, cleanedText: String, language: String) -> Bool {
        guard !cleanedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let languageHint = OpenAIAPIKeyStore.apiLanguageHint(for: language)

        let rawTrimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawNormalized = normalizedTranscriptText(rawTrimmed)
        let cleanedNormalized = normalizedTranscriptText(cleanedText)
        guard !cleanedNormalized.isEmpty else { return false }
        if languageHint == "en" {
            guard cjkLetterCount(in: cleanedNormalized) == 0 else { return false }
        }
        guard rawNormalized != cleanedNormalized else { return true }
        guard cjkLetterCount(in: cleanedNormalized) == 0 else { return false }

        let cleanedWords = canonicalTranscriptWords(cleanedNormalized)
        guard !cleanedWords.isEmpty else { return false }

        // CJK fragments are known realtime transport artifacts, but repeated words and
        // fillers may be intentional speech. The fast path is only safe when cleanup
        // preserves every lexical token; otherwise the whole WAV is transcribed.
        let rawWords = languageHint == "en"
            ? canonicalTranscriptWordsPreservingSpeechTokens(rawNormalized)
            : canonicalTranscriptWords(rawNormalized)
        guard cleanedWords == rawWords else { return false }

        guard languageHint == "en" else { return true }

        let rawCJKCount = cjkLetterCount(in: rawNormalized)
        if rawCJKCount > 0 {
            let cleanedLatinCount = latinLetterCount(in: cleanedNormalized)
            guard cleanedLatinCount >= max(2, rawCJKCount * 2) else { return false }
            guard rawCJKCount <= max(6, cleanedLatinCount / 3) else { return false }
        }

        return true
    }

    public nonisolated static func wasRealtimeTranscriptRepaired(rawText: String, cleanedText: String) -> Bool {
        normalizedTranscriptText(rawText) != normalizedTranscriptText(cleanedText)
    }

    public nonisolated static func cleanRealtimeArtifactText(_ text: String) -> String {
        var cleaned = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
        cleaned = cleaned.replacingOccurrences(
            of: #"(?i)(?<=[A-Za-z])어\b"#,
            with: "",
            options: .regularExpression
        )
        cleaned = cleaned.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        cleaned = removeStandaloneRealtimeArtifacts(from: cleaned)
        cleaned = collapseAdjacentDuplicateWords(in: cleaned)
        cleaned = collapseAdjacentDuplicatePhrases(in: cleaned)
        cleaned = cleaned.replacingOccurrences(
            of: #"\s+([,.;:!?])"#,
            with: "$1",
            options: .regularExpression
        )
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private nonisolated static func removeStandaloneRealtimeArtifacts(from text: String) -> String {
        let artifactTokens: Set<String> = ["어", "음", "um", "umm", "uh", "uhh", "erm", "hmm", "eh"]
        let words = text.split(separator: " ").compactMap { rawWord -> String? in
            let normalized = rawWord
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            return artifactTokens.contains(normalized) ? nil : String(rawWord)
        }
        return words.joined(separator: " ")
    }

    private nonisolated static func normalizedTranscriptText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .replacingOccurrences(
                of: #"\s+"#,
                with: " ",
                options: .regularExpression
            )
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private nonisolated static func canonicalTranscriptWords(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).compactMap { rawWord in
            let normalized = String(rawWord)
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            guard !normalized.isEmpty else { return nil }
            return normalized
        }
    }

    private nonisolated static func canonicalTranscriptWordsPreservingSpeechTokens(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).compactMap { rawWord in
            var normalized = String(rawWord)
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            if normalized == "어" || normalized == "음" {
                return nil
            }
            if normalized.hasSuffix("어") {
                let withoutSuffix = String(normalized.dropLast())
                if latinLetterCount(in: withoutSuffix) > 0 {
                    normalized = withoutSuffix
                }
            }
            return normalized.isEmpty ? nil : normalized
        }
    }

    private nonisolated static func collapseAdjacentDuplicateWords(in text: String) -> String {
        let words = text.split(separator: " ").map(String.init)
        guard words.count > 1 else { return text }

        var output: [String] = []
        for word in words {
            if let last = output.last,
               normalizedTranscriptWord(last) == normalizedTranscriptWord(word) {
                continue
            }
            output.append(word)
        }
        return output.joined(separator: " ")
    }

    private nonisolated static func collapseAdjacentDuplicatePhrases(in text: String) -> String {
        var words = text.split(separator: " ").map(String.init)
        guard words.count >= 6 else { return text }

        var i = 0
        while i < words.count {
            let maxLength = min(24, (words.count - i) / 2)
            var removedDuplicate = false
            if maxLength >= 3 {
                for length in stride(from: maxLength, through: 3, by: -1) {
                    let first = words[i..<(i + length)].map(normalizedTranscriptWord)
                    let second = words[(i + length)..<(i + (2 * length))].map(normalizedTranscriptWord)
                    if first == second {
                        words.removeSubrange((i + length)..<(i + (2 * length)))
                        removedDuplicate = true
                        break
                    }
                }
            }
            if !removedDuplicate {
                i += 1
            }
        }
        return words.joined(separator: " ")
    }

    private nonisolated static func normalizedTranscriptWord(_ word: String) -> String {
        word.trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines)).lowercased()
    }

    private nonisolated static func latinLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter { scalar in
            (65...90).contains(Int(scalar.value)) || (97...122).contains(Int(scalar.value))
        }.count
    }

    private nonisolated static func cjkLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter(isCJKScalar).count
    }

    private nonisolated static func containsCJKArtifact(in text: String) -> Bool {
        cjkLetterCount(in: text) > 0
    }

    private nonisolated static func isCJKScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF:
            return true
        default:
            return false
        }
    }

    private func finishWithText(_ text: String, curMode: RecordingMode, targetAppBundleIdentifier: String?, targetAppPid: pid_t?, activeProjectId: String?, activeProjectName: String?) {
        log("finishWithText mode=\(curMode.rawValue) chars=\(text.count)")
        if curMode == .command {
            runCommandMode(instruction: text, targetAppBundleIdentifier: targetAppBundleIdentifier, targetAppPid: targetAppPid)
            return
        }

        let shortcutText = voiceShortcuts?.match(text)
        let output = shortcutText ?? text
        pasteIntoFrontApp(output, targetAppBundleIdentifier: targetAppBundleIdentifier, targetAppPid: targetAppPid, restoreClipboard: true)
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

    private nonisolated static func saveRealtimeTranscript(
        text: String,
        audioPath: String?,
        pcmData: Data,
        durationMs: Int,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String,
        language: String,
        homePath: String
    ) async -> RealtimeFastPathSaveResult {
        await Task.detached(priority: .utility) {
            do {
                var savedAudioPath: String?
                if let audioPath, !pcmData.isEmpty {
                    try Self.writeWAV(
                        pcmData: pcmData,
                        sampleRate: 24_000,
                        channelCount: 1,
                        bitsPerSample: 16,
                        to: URL(fileURLWithPath: audioPath)
                    )
                    savedAudioPath = audioPath
                    NativeAppLog.write("wrote wav path=\(audioPath) pcmBytes=\(pcmData.count)", homePath: homePath)
                }

                let textFile = try Self.writeTemporaryTranscript(text: text, homePath: homePath)
                defer { try? FileManager.default.removeItem(atPath: textFile) }

                let args = saveTextCLIArgs(
                    textFile: textFile,
                    audioPath: savedAudioPath,
                    activeProjectId: activeProjectId,
                    transcriberPrompt: transcriberPrompt,
                    postProcessingMode: postProcessingMode,
                    language: language,
                    durationMs: durationMs,
                    source: "realtime_fast_path",
                    modelUsed: RealtimeTranscriptionClient.transcriptionModelID
                )
                let output = CLIRunner.run(args, home: homePath)
                if let error = CLIRunner.parseError(output) {
                    return RealtimeFastPathSaveResult(text: nil, error: error)
                }

                NativeAppLog.write("realtime fast-path save completed", homePath: homePath)
                return RealtimeFastPathSaveResult(text: CLIRunner.parseJSON(output) ?? text, error: nil)
            } catch {
                return RealtimeFastPathSaveResult(text: nil, error: error.localizedDescription)
            }
        }.value
    }

    private nonisolated static func writeTemporaryTranscript(text: String, homePath: String) throws -> String {
        let dir = URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("recordings", isDirectory: true)
            .appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("realtime-\(UUID().uuidString).txt")
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    private nonisolated static func writeWAV(pcmData: Data, sampleRate: UInt32, channelCount: UInt16, bitsPerSample: UInt16, to url: URL) throws {
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

    private func fallbackTranscribe(audioPath: String, curMode: RecordingMode, targetAppBundleIdentifier: String?, targetAppPid: pid_t?, activeProjectId: String?, activeProjectName: String?, realtimeText: String? = nil) {
        let homePath = home

        isTranscribing = true
        statusMessage = "Transcribing..."

        // Tag the persisted recording with the active project so the app's library/filters
        // (which use the same local project id) line up. Global flags precede the subcommand.
        let transcribeArgs = Self.transcribeCLIArgs(
            audioPath: audioPath,
            activeProjectId: activeProjectId,
            transcriberPrompt: projectStore?.effectiveSystemPrompt ?? "",
            postProcessingMode: projectStore?.effectivePostProcessingMode ?? PostProcessingMode.auto.rawValue
        )

        Task.detached {
            let output = CLIRunner.run(transcribeArgs, home: homePath)
            let cliError = CLIRunner.parseError(output)
            let cliText = cliError == nil ? CLIRunner.parseJSON(output) : nil

            await MainActor.run {
                if let cliError {
                    self.log("cli transcription failed error=\(cliError)")
                } else if cliText == nil {
                    self.log("cli transcription empty output=\(output.prefix(160))")
                }

                let resolved = Self.resolveFinalTranscript(cliText: cliText, cliError: cliError, realtimeText: realtimeText)
                guard let text = resolved.text else {
                    self.finish(resolved.failureStatus ?? "Transcription failed")
                    return
                }

                if cliText == nil {
                    self.log("using realtime transcript fallback chars=\(text.count)")
                } else {
                    self.log("cli transcription succeeded chars=\(text.count)")
                }
                self.isTranscribing = false
                self.finishWithText(
                    text,
                    curMode: curMode,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
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

    nonisolated static func transcribeCLIArgs(
        audioPath: String,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String
    ) -> [String] {
        var args = ["--json"]
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += ["transcribe", audioPath]

        let mode = PostProcessingMode(rawValue: postProcessingMode)?.rawValue ?? PostProcessingMode.auto.rawValue
        args += ["--post-processing", mode]

        let prompt = transcriberPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            args += ["--transcriber-prompt", prompt]
        }

        return args
    }

    nonisolated static func saveTextCLIArgs(
        textFile: String,
        audioPath: String?,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String,
        language: String,
        durationMs: Int,
        source: String,
        modelUsed: String
    ) -> [String] {
        var args = ["--json"]
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += [
            "save-text",
            "--text-file", textFile,
            "--source", source,
            "--model-used", modelUsed,
            "--post-processing", PostProcessingMode(rawValue: postProcessingMode)?.rawValue ?? PostProcessingMode.auto.rawValue,
        ]
        if let audioPath, !audioPath.isEmpty {
            args += ["--audio-path", audioPath]
        }
        if durationMs > 0 {
            args += ["--duration-ms", String(durationMs)]
        }
        if !language.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args += ["--language", language]
        }
        let prompt = transcriberPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            args += ["--transcriber-prompt", prompt]
        }
        return args
    }

    private func finish(_ msg: String) {
        log("finish status=\(msg)")
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = msg
    }

    private func resetRecordingIntent() {
        activeTrigger = nil
        microphonePermissionRequestID = nil
        keyboardShortcutIsDown = false
        fnKeyIsDown = false
        targetAppBundleIdentifier = nil
        targetAppPid = nil
    }

    // MARK: - Command Mode

    private func runCommandMode(instruction: String, targetAppBundleIdentifier: String?, targetAppPid: pid_t?) {
        guard ensureAccessibilityPermission(prompt: shouldPromptAccessibility()) else {
            log("command mode blocked by accessibility permission")
            statusMessage = "Enable Accessibility permission for Recordings to rewrite selected text"
            return
        }
        let targetApp = selectedRunningPasteTarget(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier
        )
        guard let targetApp else {
            log("command mode target app not found")
            statusMessage = "No target app found"
            return
        }
        let alreadyFrontmost = targetApp.processIdentifier == NSWorkspace.shared.frontmostApplication?.processIdentifier
        if !alreadyFrontmost {
            targetApp.activate(options: [.activateIgnoringOtherApps])
        }

        let copyDelay: TimeInterval = alreadyFrontmost ? 0.15 : 0.5
        DispatchQueue.main.asyncAfter(deadline: .now() + copyDelay) {
            self.postKey(0x08, flags: .maskCommand) // Cmd+C
        }

        let homePath = home
        Task {
            try? await Task.sleep(for: .milliseconds(Int((copyDelay + 0.25) * 1_000)))
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

    public func pasteIntoFrontApp(_ text: String, targetAppBundleIdentifier: String? = nil, targetAppPid: pid_t? = nil, restoreClipboard: Bool = false) {
        log("paste requested chars=\(text.count) target=\(targetAppBundleIdentifier ?? "nil") pid=\(targetAppPid.map(String.init) ?? "nil") accessibility=\(AXIsProcessTrusted())")
        let pb = NSPasteboard.general
        let previousClipboard = restoreClipboard ? ClipboardSnapshot(pasteboard: pb) : nil
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

        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let targetApp = selectedRunningPasteTarget(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            frontmostPid: frontmostPid
        )

        guard let app = targetApp else {
            log("paste target app not found")
            self.statusMessage = "Copied — no target app found"
            return
        }

        // Activate the exact app that owned focus when recording started, then paste after focus settles.
        let alreadyFrontmost = app.processIdentifier == frontmostPid
        if !alreadyFrontmost {
            app.activate(options: [.activateIgnoringOtherApps])
        }

        let pasteDelay: TimeInterval = alreadyFrontmost ? 0.15 : 0.5
        DispatchQueue.main.asyncAfter(deadline: .now() + pasteDelay) {
            let src = CGEventSource(stateID: .hidSystemState)
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true),
               let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false) {
                down.flags = .maskCommand
                up.flags = .maskCommand
                down.post(tap: .cgSessionEventTap)
                up.post(tap: .cgSessionEventTap)
            }
            self.log("paste event posted target=\(app.bundleIdentifier ?? "?") alreadyFrontmost=\(alreadyFrontmost)")
            self.statusMessage = "Pasted (\(text.count) chars)"

            if let previousClipboard {
                // Give the target app time to consume the paste, then hand the clipboard back.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    let pb = NSPasteboard.general
                    if pb.string(forType: .string) == text {
                        previousClipboard.restore(to: pb)
                    }
                }
            }
        }
    }

    private func selectedRunningPasteTarget(targetAppBundleIdentifier: String?, targetAppPid: pid_t?, frontmostPid: pid_t?) -> NSRunningApplication? {
        let myPID = ProcessInfo.processInfo.processIdentifier
        let runningApps = NSWorkspace.shared.runningApplications
        let candidates = runningApps.map {
            PasteTargetCandidate(
                pid: $0.processIdentifier,
                bundleIdentifier: $0.bundleIdentifier,
                isRegularApp: $0.activationPolicy == .regular
            )
        }
        let selectedTarget = Self.selectPasteTarget(
            candidates: candidates,
            currentPid: myPID,
            targetBundleIdentifier: targetAppBundleIdentifier,
            targetPid: targetAppPid,
            frontmostPid: frontmostPid
        )
        return selectedTarget.flatMap { selected in
            runningApps.first { $0.processIdentifier == selected.pid }
        }
    }

    nonisolated static func selectPasteTarget(
        candidates: [PasteTargetCandidate],
        currentPid: pid_t,
        targetBundleIdentifier: String?,
        targetPid: pid_t?,
        frontmostPid: pid_t? = nil
    ) -> PasteTargetCandidate? {
        candidates.first {
            guard let targetPid else { return false }
            return $0.pid == targetPid && $0.pid != currentPid
        } ?? candidates.first {
            guard $0.pid != currentPid, $0.isRegularApp else { return false }
            guard let targetBundleIdentifier else { return false }
            return $0.bundleIdentifier == targetBundleIdentifier
        } ?? candidates.first {
            guard let frontmostPid else { return false }
            return $0.pid == frontmostPid && $0.pid != currentPid && $0.isRegularApp
        }
    }

    nonisolated static func resolveFinalTranscript(
        cliText: String?,
        cliError: String?,
        realtimeText: String?
    ) -> (text: String?, failureStatus: String?) {
        if let cliText, !cliText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (cliText, nil)
        }
        if let realtimeText, !realtimeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (realtimeText, nil)
        }
        return (nil, cliError ?? "Empty transcription")
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

private struct ClipboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init?(pasteboard: NSPasteboard) {
        let capturedItems = pasteboard.pasteboardItems?.compactMap { item -> [NSPasteboard.PasteboardType: Data]? in
            let dataByType = item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { result, type in
                if let data = item.data(forType: type) {
                    result[type] = data
                }
            }
            return dataByType.isEmpty ? nil : dataByType
        } ?? []
        guard !capturedItems.isEmpty else { return nil }
        items = capturedItems
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let pasteboardItems = items.map { itemData in
            let item = NSPasteboardItem()
            for (type, data) in itemData {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(pasteboardItems)
    }
}

// MARK: - CLI Runner

private final class ProcessDataCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func store(_ data: Data) {
        lock.lock()
        storage = data
        lock.unlock()
    }

    var data: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

enum CLIRunner: Sendable {
    struct ProcessOutput: Sendable {
        let stdout: String
        let stderr: String
        let terminationStatus: Int32
    }

    static func run(_ args: [String], home: String) -> String {
        let bin = "\(home)/.bun/bin/recordings"
        let executable: String
        let arguments: [String]
        if FileManager.default.fileExists(atPath: bin) {
            executable = bin
            arguments = args
        } else {
            executable = "/usr/bin/env"
            arguments = ["recordings"] + args
        }
        let environment = ProcessInfo.processInfo.environment.merging([
            "PATH": "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        ]) { _, new in new }
        do {
            let output = try runExecutable(executable, arguments: arguments, environment: environment)
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

    static func runExecutable(
        _ executable: String,
        arguments: [String],
        environment: [String: String]? = nil
    ) throws -> ProcessOutput {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()

        let stdoutCapture = ProcessDataCapture()
        let stderrCapture = ProcessDataCapture()
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            stdoutCapture.store(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            stderrCapture.store(stderrPipe.fileHandleForReading.readDataToEndOfFile())
            readers.leave()
        }

        process.waitUntilExit()
        readers.wait()
        return ProcessOutput(
            stdout: String(decoding: stdoutCapture.data, as: UTF8.self),
            stderr: String(decoding: stderrCapture.data, as: UTF8.self),
            terminationStatus: process.terminationStatus
        )
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
