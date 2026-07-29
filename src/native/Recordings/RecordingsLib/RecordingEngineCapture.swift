import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    // MARK: - Start Recording (Streaming)

    public func startRecording(trigger: RecordingTrigger = .manual) {
        guard Self.canBeginRecording(
            isRecording: isRecording,
            isTranscribing: isTranscribing,
            isWarmingUpCapture: isWarmingUpCapture,
            isAwaitingMicrophonePermission: microphonePermissionStartGate.isAwaitingResponse,
            isDeliveryPending: deliveryIsPending
        ) else {
            if isTranscribing {
                statusMessage = "Finish transcribing before recording again"
            } else if deliveryIsPending {
                statusMessage = "Still delivering the last recording"
            }
            return
        }
        log("startRecording trigger=\(trigger) microphoneStatus=\(microphoneAuthorization().rawValue) accessibility=\(accessibilityTrustCheck())")
        recordingGeneration &+= 1
        if pasteTargetProcessIdentityByGeneration.count >= 32 {
            let oldestRetainedGeneration = recordingGeneration > 16 ? recordingGeneration - 16 : 0
            pasteTargetProcessIdentityByGeneration = pasteTargetProcessIdentityByGeneration.filter {
                $0.key >= oldestRetainedGeneration
            }
        }
        activeTrigger = trigger
        keyboardShortcutIsDown = trigger == .keyboardShortcut
        conversationReply = nil
        // Both transient reasons are superseded by a new press, and the delivery one is the
        // reason this clearing exists: "transcript copied, press Cmd-V" was only ever cleared
        // by the NEXT delivery's completion, so a recording that produced no delivery left it
        // asserted indefinitely — and by then the clipboard may hold something else, so Cmd-V
        // pastes the wrong thing on the app's own instruction. This recording is about to
        // rewrite the clipboard, so the old instruction stops being true here.
        //
        // Accepted cost, stated rather than hidden: if this recording is itself cancelled, a
        // still-accurate "press Cmd-V" has been cleared early. Losing a true message is a
        // smaller failure than asserting a false one forever.
        setBlockedReason(nil, for: .pressConsumed)
        setBlockedReason(nil, for: .delivery)

        let myPID = ProcessInfo.processInfo.processIdentifier
        let frontmostApp = frontmostAppSnapshot()
        let isOwnApp = frontmostApp?.pid == myPID
        targetAppBundleIdentifier = isOwnApp ? nil : frontmostApp?.bundleIdentifier
        targetAppPid = isOwnApp ? nil : frontmostApp?.pid
        if !isOwnApp,
           let pid = frontmostApp?.pid,
           let bundleIdentifier = frontmostApp?.bundleIdentifier,
           let launchDate = frontmostApp?.launchDate {
            pasteTargetProcessIdentityByGeneration[recordingGeneration] = PasteTargetProcessIdentity(
                pid: pid,
                bundleIdentifier: bundleIdentifier,
                launchDate: launchDate
            )
        } else {
            pasteTargetProcessIdentityByGeneration[recordingGeneration] = nil
        }

        // The selection is still frozen for every recording (not only an exposed "command
        // mode"), so a later command decision can only ever act on the exact text and
        // element that were selected when the user started speaking. The Accessibility IPC
        // that reads it runs on a detached task, concurrently with recorder start: the
        // microphone must never wait on a beachballing target app, and the MainActor stays
        // free to process the key-up that stops the recording. Skipped entirely when intent
        // detection is off — no command route exists to consume it.
        let shouldCaptureSelection = Self.shouldCaptureSelection(
            targetPid: targetAppPid,
            accessibilityTrusted: accessibilityTrustCheck(),
            intentDetectionEnabled: intentDetectionEnabled
        )
        let capturePid = targetAppPid
        let captureSelection = selectionCapture
        let windowTitleLookup = focusedWindowTitleLookup
        let windowTitlePid = frontmostApp?.pid
        let axSnapshotTask = Task.detached(priority: .userInitiated) { () -> RecordingStartAXSnapshot in
            let selectionToken = shouldCaptureSelection ? capturePid.flatMap { captureSelection($0) } : nil
            let focusedWindowTitle = windowTitlePid.flatMap { windowTitleLookup($0) }
            return RecordingStartAXSnapshot(
                selectionToken: selectionToken,
                focusedWindowTitle: focusedWindowTitle
            )
        }

        // Project auto-selection and the processing configuration resolve with the
        // snapshot, still once per recording start and frozen for this generation; the
        // recording pipeline awaits this context only after the recorder has stopped.
        let generation = recordingGeneration
        let projectStore = projectStore
        let targetBundleIdentifierForProjects = targetAppBundleIdentifier
        let transcriptionLanguageAtStart = transcriptionLanguage
        let intentDetectionEnabledAtStart = intentDetectionEnabled
        let homePath = home
        let startContext = Task { @MainActor [weak self] () -> RecordingStartResolvedContext in
            let axSnapshot = await axSnapshotTask.value
            if let self, generation == self.recordingGeneration, let store = projectStore {
                let projects = store.settings.projects
                let detected = ProjectStore.matchProject(
                    windowTitle: axSnapshot.focusedWindowTitle,
                    bundleId: targetBundleIdentifierForProjects,
                    projects: projects
                )
                if let detected,
                   detected.id != store.settings.activeProjectId,
                   store.canMutateProjects {
                    do {
                        try store.setActive(detected.id)
                    } catch {
                        self.log("project auto-selection failed; continuing capture with the last active project: \(error.localizedDescription)")
                    }
                }
                if let warning = store.synchronizationError ?? store.persistenceError {
                    self.log("project synchronization degraded; continuing capture: \(warning)")
                }
            }
            let modelSelection = OpenAIAPIKeyStore.loadProcessingModelSelection(homePath: homePath)
            return RecordingStartResolvedContext(
                selectionToken: axSnapshot.selectionToken,
                canonicalProjectId: projectStore?.activeCanonicalProjectIdForRecording,
                displayProjectId: projectStore?.settings.activeProjectId,
                activeProjectName: projectStore?.activeProject?.name,
                processing: RecordingProcessingConfiguration(
                    transcriptionPrompt: modelSelection.transcriptionPrompt,
                    transcriberPrompt: projectStore?.effectiveSystemPrompt ?? "",
                    postProcessingMode: projectStore?.effectivePostProcessingMode ?? PostProcessingMode.auto.rawValue,
                    transcriptionLanguage: transcriptionLanguageAtStart,
                    transcriptionModel: modelSelection.transcriptionModel,
                    transcriberModel: modelSelection.transcriberModel,
                    enhancementModel: modelSelection.enhancementModel,
                    intentModel: modelSelection.intentModel,
                    intentDetectionEnabled: intentDetectionEnabledAtStart,
                    enhanceTriggersJSON: modelSelection.enhanceTriggersJSON,
                    keywordTransformsJSON: modelSelection.keywordTransformsJSON
                )
            )
        }

        switch microphoneAuthorization() {
        case .authorized:
            startNativeRecording(startContext: startContext)
        case .notDetermined:
            guard let requestID = microphonePermissionStartGate.reserve() else { return }
            statusMessage = "Allow microphone access to record"
            log("requesting microphone access before recording")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard self.microphonePermissionStartGate.consumeResponse(for: requestID) else {
                        self.log("ignoring stale microphone permission response")
                        return
                    }
                    self.log("microphone access response granted=\(granted)")
                    if granted {
                        guard self.shouldContinueStarting(trigger: trigger) else {
                            self.log("recording start cancelled before microphone permission completed trigger=\(trigger)")
                            self.resetRecordingIntent()
                            self.updateStatus()
                            return
                        }
                        self.startNativeRecording(startContext: startContext)
                    } else {
                        self.resetRecordingIntent()
                        self.statusMessage = "Microphone permission denied"
                        self.flowPhase = .failed(self.statusMessage)
                    }
                }
            }
        case .denied, .restricted:
            resetRecordingIntent()
            log("microphone permission blocked status=\(microphoneAuthorization().rawValue)")
            statusMessage = "Enable Microphone permission for Recordings in System Settings"
            flowPhase = .failed(statusMessage)
        @unknown default:
            resetRecordingIntent()
            statusMessage = "Microphone permission unavailable"
            flowPhase = .failed(statusMessage)
        }
    }

    /// `isWarmingUpCapture` deliberately has no default. It is a safety input, and a default of
    /// `false` is the permissive value: a call site that forgot it would compile, read as
    /// startable during the warm-up window, and open a second recorder on top of a live one.
    nonisolated static func canBeginRecording(
        isRecording: Bool,
        isTranscribing: Bool,
        isWarmingUpCapture: Bool,
        isAwaitingMicrophonePermission: Bool = false,
        isDeliveryPending: Bool = false
    ) -> Bool {
        !isRecording && !isTranscribing && !isAwaitingMicrophonePermission && !isDeliveryPending
            && !isWarmingUpCapture
    }

    nonisolated static func shouldCaptureSelection(
        targetPid: pid_t?,
        accessibilityTrusted: Bool,
        intentDetectionEnabled: Bool
    ) -> Bool {
        targetPid != nil && accessibilityTrusted && intentDetectionEnabled
    }

    nonisolated static func recordingStatus(
        trigger: RecordingTrigger
    ) -> String {
        switch trigger {
        case .manual: "Recording — click Stop when finished"
        case .fnKey, .keyboardShortcut: "Recording — release to stop"
        }
    }

    var deliveryIsPending: Bool {
        intentDeliveryPendingGeneration != nil || pasteTransactionCoordinator.hasPendingTransaction
    }

    func beginIntentDelivery(for generation: UInt64) {
        intentDeliveryPendingGeneration = generation
    }

    func endIntentDelivery(for generation: UInt64) {
        if intentDeliveryPendingGeneration == generation {
            intentDeliveryPendingGeneration = nil
        }
    }

    /// Truthful start availability for UI surfaces. Mirrors exactly the gate
    /// `startRecording` applies, so a menu bar or button can never present Start while the
    /// engine would reject it.
    public var canStartRecording: Bool {
        Self.canBeginRecording(
            isRecording: isRecording,
            isTranscribing: isTranscribing,
            isWarmingUpCapture: isWarmingUpCapture,
            isAwaitingMicrophonePermission: microphonePermissionStartGate.isAwaitingResponse,
            isDeliveryPending: deliveryIsPending
        )
    }

    /// A capture attempt is in flight — warming up or live. Anything that used to read
    /// `isRecording` because it meant "a recording is happening" reads this instead, so the
    /// warm-up window can neither look idle nor accept a second start.
    public var captureIsActive: Bool { isWarmingUpCapture || isRecording }

    /// Whether an in-flight Deciding/Answering/Rewriting delivery can be cancelled. Once a
    /// paste transaction is submitted the remaining window is sub-second and has its own
    /// target/clipboard safety rails, so cancellation stops being offered.
    public var canCancelIntentDelivery: Bool {
        intentDeliveryPendingGeneration != nil && !pasteTransactionCoordinator.hasPendingTransaction
    }

    /// Cancels the pending intent delivery. Every phase that can be pending here —
    /// Deciding, Answering, Rewriting — inserted the transcript into Recent before the
    /// phase began (and the recording was already persisted to the library), so cancelling
    /// only abandons the delivery: "transcript saved to Recent" is literally true. Bumping
    /// the generation makes every in-flight completion stale, and every completion path
    /// re-checks the generation before touching state, the clipboard, or the target app —
    /// a cancelled decision, answer, or rewrite can never land later.
    public func cancelIntentProcessing() {
        guard canCancelIntentDelivery else { return }
        log("intent delivery cancelled by user generation=\(recordingGeneration)")
        recordingGeneration &+= 1
        intentDeliveryPendingGeneration = nil
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = "Cancelled — transcript saved to Recent"
        flowPhase = .idle
    }

    #if DEBUG
    /// Test-only: advances and registers a pipeline generation the way a recording
    /// start/stop pair would, so delivery tests can drive `finishWithText` repeatedly.
    func beginPipelineForTesting() -> UInt64 {
        recordingGeneration &+= 1
        pipelineDeliveryGate.registerPipeline(recordingGeneration)
        return recordingGeneration
    }
    #endif

    /// Single staleness rule for generation-bound deliveries: anything bound to a
    /// superseded generation — or arriving mid-recording — is abandoned.
    nonisolated static func shouldAbandonDelivery(
        pipelineGeneration: UInt64?,
        currentGeneration: UInt64,
        isRecording: Bool
    ) -> Bool {
        guard let pipelineGeneration else { return false }
        return isRecording || pipelineGeneration != currentGeneration
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

    func shouldContinueStarting(trigger: RecordingTrigger) -> Bool {
        activeTrigger == trigger && Self.shouldContinueStartingAfterPermission(
            trigger: trigger,
            keyboardShortcutIsDown: keyboardShortcutIsDown,
            fnKeyIsDown: fnKeyIsDown
        )
    }

    func startNativeRecording(startContext: Task<RecordingStartResolvedContext, Never>) {
        let apiKey = openAIAPIKeyProvider()
        let captureConfiguration = RecordingCaptureConfiguration(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            startContext: startContext
        )
        activeCaptureConfiguration = captureConfiguration
        log("startNativeRecording apiKeyConfigured=\(!apiKey.isEmpty)")
        // Constructing the client is a plain allocation; the WebSocket handshake happens in
        // `beginRealtimeStreaming` below, only once the recorder has actually started. The
        // stream pipe needs the client at construction time, which is why the two steps are
        // split rather than simply reordered. The handshake cannot be deferred further — to
        // the first PCM chunk — without reworking `PCMStreamPipe`: `RealtimeTranscriptionClient`
        // silently drops audio queued while `isStreaming` is false.
        let client: RealtimeTranscriptionClient? = apiKey.isEmpty
            ? nil
            : RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)
        realtimeClient = client

        let streamPipe = PCMStreamPipe(chunkSize: 4_800, client: client)
        pcmStreamPipe = streamPipe
        let homePath = home
        let captureGeneration = recordingGeneration
        let confirmCapture: @MainActor @Sendable (UInt64) -> Void = { [weak self] generation in
            self?.confirmCaptureIsLive(generation: generation)
        }
        let firstChunkLogged = LockedFlag()
        let recorder = recorderFactory { data in
            if firstChunkLogged.take() {
                NativeAppLog.write("native recorder received first PCM chunk bytes=\(data.count)", homePath: homePath)
                // The first sample is the only honest signal that this recording exists.
                // Promoting the capture here — not when `start()` returned — is what makes a
                // release during warm-up take the cancel path.
                Task { @MainActor in confirmCapture(captureGeneration) }
            }
            streamPipe.append(data)
        }

        do {
            try recorder.start()
            log("native recorder started")
            nativeRecorder = recorder
            isWarmingUpCapture = true
            recordingDuration = 0
            streamingText = ""
            liveTranscriptionText = ""
            recordedPCM.removeAll(keepingCapacity: true)
            activeAudioPath = "\(audioDir)/recording-\(Self.timestampForFilename()).wav"
            let trigger = activeTrigger ?? .manual
            statusMessage = Self.recordingStatus(trigger: trigger)
            // The pane must not look dead for the ~100 ms of warm-up, so it enters the
            // listening layout immediately; Stop and Discard there both abandon the attempt.
            flowPhase = .listening
            if let client {
                beginRealtimeStreaming(client: client, transcriptionLanguage: transcriptionLanguage)
            }

            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.recordingDuration += 0.1
                }
            }
        } catch {
            log("native recorder failed error=\(error.localizedDescription)")
            // Unreachable today — nothing between `recorder.start()` and `isWarmingUpCapture`
            // can throw — but a warming flag left set here wedges the engine permanently: the
            // start gate refuses every press and no teardown path runs, with the input device
            // possibly open. One added throwing call above is all it would take, so clear it
            // here rather than rely on the current statement order.
            isWarmingUpCapture = false
            realtimeClient?.stop()
            realtimeClient = nil
            streamingTask?.cancel()
            streamingTask = nil
            pcmStreamPipe?.cancel()
            pcmStreamPipe = nil
            activeCaptureConfiguration = nil
            resetRecordingIntent()
            statusMessage = "Failed: \(error.localizedDescription)"
            flowPhase = .failed(statusMessage)
        }
    }

    // MARK: - Capture confirmation

    /// Promotes a warming capture to live on the first PCM chunk. Bound to the generation that
    /// requested it, because a chunk already in the recorder's delivery queue can be handed to
    /// the MainActor *after* a key-up has abandoned the attempt — that late chunk must never
    /// resurrect a dead recording.
    func confirmCaptureIsLive(generation: UInt64) {
        guard generation == recordingGeneration, isWarmingUpCapture else { return }
        isWarmingUpCapture = false
        isRecording = true
        log("native capture confirmed live")
    }

    /// Tears down a capture attempt that never produced a sample. `recorder.start()` had
    /// succeeded, so the microphone is open and a realtime session may be mid-handshake, but
    /// there is no audio: running the transcription pipeline over that empty buffer is exactly
    /// what made a short tap finish silently. `alert` is nil when the user asked for the
    /// discard and therefore already knows the outcome.
    func abandonWarmingCapture(reason: String, alert: RecordingAttemptAlert?) {
        guard isWarmingUpCapture else { return }
        log("capture abandoned before first audio reason=\(reason)")
        // Supersede the attempt so every completion still bound to it — a queued first-chunk
        // confirmation, the resolved start context — is stale and cannot apply.
        recordingGeneration &+= 1

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

        isWarmingUpCapture = false
        isRecording = false
        isTranscribing = false
        streamingText = ""
        liveTranscriptionText = ""
        recordedPCM.removeAll(keepingCapacity: true)
        activeAudioPath = nil
        activeCaptureConfiguration = nil
        resetRecordingIntent()

        if let alert {
            discloseEmptyAttempt(alert)
        } else {
            // `updateStatus()`, never a direct "Ready": the state above is already cleared, so
            // its early return does not fire, and going through it is what preserves a live
            // `blockedReason` instead of overwriting the disclosure with "Ready".
            updateStatus()
        }
    }

    // MARK: - Visible outcome

    /// Discloses an attempt that produced nothing, on the one surface that is always on screen.
    ///
    /// Routed through `setBlockedReason(_:for: .pressConsumed)` rather than a published field of
    /// its own. That slot already means "a press was consumed and nothing was recorded", it is
    /// already cleared by the next `startRecording`, and `MenuBarPresentation` already renders
    /// `blockedReason` with a distinct icon and a distinct VoiceOver label. It also outlives a
    /// timer: the disclosure is still on the glyph a minute later, which a three-second badge on
    /// a surface the user had no reason to watch would not be.
    func discloseEmptyAttempt(_ alert: RecordingAttemptAlert) {
        log("attempt produced no audio disclosure=\(alert)")
        setBlockedReason(alert.message, for: .pressConsumed)
        updateStatus()
    }

    // MARK: - Real-time Streaming

    func beginRealtimeStreaming(
        client: RealtimeTranscriptionClient,
        transcriptionLanguage: String
    ) {
        let language = OpenAIAPIKeyStore.apiLanguageHint(for: transcriptionLanguage)
        log("realtime streaming task starting language=\(language.isEmpty ? "auto" : language)")

        streamingTask = Task {
            await client.startStreaming(language: language)
            self.log("realtime start completed streaming=\(client.isStreaming) error=\(client.error ?? "")")

            var lastPeriodicCommitAt: UInt64?

            // Receive deltas
            while client.isStreaming {
                try? await Task.sleep(for: .milliseconds(100))
                let now = Self.monotonicMilliseconds()
                let periodicCommitIsDue = Self.realtimePeriodicCommitIsDue(
                    nowMilliseconds: now,
                    lastCommitMilliseconds: lastPeriodicCommitAt
                )
                if self.isRecording, periodicCommitIsDue {
                    if await client.commitInput(reason: "periodic") {
                        lastPeriodicCommitAt = now
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
        // Discard during warm-up: identical teardown, but the user asked for it, so the glyph
        // stays quiet.
        if isWarmingUpCapture {
            abandonWarmingCapture(reason: "discarded during warm-up", alert: nil)
            return
        }
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
        activeCaptureConfiguration = nil
        resetRecordingIntent()
        // Same reason as the warm-up abandon path: this used to assign "Ready" directly and
        // silently discard a live trigger-blocked warning.
        updateStatus()
    }

    // MARK: - Stop & Transcribe

}
