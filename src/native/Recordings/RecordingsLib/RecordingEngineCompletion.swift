import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    func finishWithText(
        _ text: String,
        rawTranscript: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        activeProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace? = nil,
        pipelineGeneration: UInt64? = nil,
        deliveryCompleted: (@MainActor @Sendable () -> Void)? = nil
    ) {
        log("finishWithText chars=\(text.count) rawChars=\(rawTranscript.count)")
        if let pipelineGeneration,
           !pipelineDeliveryGate.claimDelivery(for: pipelineGeneration) {
            log("duplicate delivery suppressed pipeline_generation=\(pipelineGeneration)")
            deliveryCompleted?()
            return
        }
        // A delivery whose recording has been superseded (or that would land mid-recording)
        // is abandoned outright: the transcript is persisted to the library, and nothing may
        // paste into whatever the user is doing now.
        if isRecording || Self.shouldAbandonDelivery(
            pipelineGeneration: pipelineGeneration,
            currentGeneration: recordingGeneration,
            isRecording: isRecording
        ) {
            log("delivery abandoned for superseded recording pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
            deliveryCompleted?()
            return
        }

        let execute: @MainActor @Sendable (RoutedSpeechAction, IntentDecisionOrigin, Bool) -> Void = { [weak self] action, origin, transcriptRetainedInRecent in
            guard let self else {
                deliveryCompleted?()
                return
            }
            self.executeRoutedAction(
                action,
                origin: origin,
                transcriptRetainedInRecent: transcriptRetainedInRecent,
                text: text,
                rawTranscript: rawTranscript,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                selectionToken: selectionToken,
                canonicalProjectId: canonicalProjectId,
                activeProjectId: activeProjectId,
                activeProjectName: activeProjectName,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        }

        // Voice shortcuts are explicit user-configured expansions and take precedence over
        // intent inference, exactly as they preceded routing before this flow existed.
        if let shortcutText = voiceShortcuts?.match(rawTranscript) {
            log("voice shortcut matched — pasting shortcut content")
            pasteIntoFrontApp(
                shortcutText,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                restoreClipboard: true,
                deliveryKind: .ordinaryDictation,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
            insertRecentTranscription(
                rawText: rawTranscript,
                processedText: shortcutText,
                projectId: activeProjectId,
                projectName: activeProjectName
            )
            return
        }

        // Intent is always decided on the raw transcript — never on post-processed output,
        // which the enhancement pipeline may have rewritten.
        let routingContext = IntentRoutingContext(
            detectionEnabled: processingConfiguration.intentDetectionEnabled,
            hasSelection: selectionToken != nil,
            accessibilityTrusted: accessibilityTrustCheck()
        )
        if !routingContext.detectionEnabled {
            execute(IntentRouter.route(decision: nil, context: routingContext), .localScreen, false)
            return
        }
        if let localDecision = IntentScreen.screen(text: rawTranscript, hasSelection: routingContext.hasSelection) {
            log("intent decided locally intent=\(localDecision.intent.rawValue) reason=\(localDecision.reason)")
            execute(
                IntentRouter.route(decision: localDecision, context: routingContext),
                .localScreen,
                false
            )
            return
        }

        // Consult the classifier. New recordings are blocked while the decision is pending,
        // and the generation is re-checked afterwards so a stale (or user-cancelled)
        // decision can never act on a later recording.
        // The transcript enters Recent before the pending phase begins: cancelling while
        // Deciding (or any later phase) promises "transcript saved to Recent", so it must
        // already be there.
        insertRecentTranscription(
            rawText: rawTranscript,
            processedText: nil,
            projectId: activeProjectId,
            projectName: activeProjectName
        )
        let deliveryGeneration = pipelineGeneration ?? recordingGeneration
        beginIntentDelivery(for: deliveryGeneration)
        updateDeliveryStatus("Deciding...", kind: .progress, pipelineGeneration: pipelineGeneration)
        if let pipelineTrace { log(pipelineTrace.message(stage: "intent_classification_started")) }
        let classifier = intentClassifier
        let intentModel = processingConfiguration.intentModel
        let hasSelection = routingContext.hasSelection
        let trustCheck = accessibilityTrustCheck
        Task { [weak self] in
            let outcome = await classifier.classify(
                transcript: rawTranscript,
                hasSelection: hasSelection,
                model: intentModel
            )
            guard let self else {
                deliveryCompleted?()
                return
            }
            self.endIntentDelivery(for: deliveryGeneration)
            guard deliveryGeneration == self.recordingGeneration, !self.isRecording else {
                self.log("stale intent decision abandoned pipeline_generation=\(deliveryGeneration)")
                deliveryCompleted?()
                return
            }
            let decision: IntentDecision?
            switch outcome {
            case .decision(let classified):
                decision = classified
                self.log("intent classified intent=\(classified.intent.rawValue) confidence=\(classified.confidence) reason=\(classified.reason)")
            case .unavailable(let message):
                decision = nil
                self.log("intent classifier unavailable — failing closed to dictation: \(message)")
            }
            if let pipelineTrace { self.log(pipelineTrace.message(stage: "intent_classification_complete")) }
            let action = IntentRouter.route(
                decision: decision,
                context: IntentRoutingContext(
                    detectionEnabled: true,
                    hasSelection: hasSelection,
                    accessibilityTrusted: trustCheck()
                )
            )
            execute(action, .classifier, true)
        }
    }

    func executeRoutedAction(
        _ action: RoutedSpeechAction,
        origin: IntentDecisionOrigin,
        transcriptRetainedInRecent: Bool,
        text: String,
        rawTranscript: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        activeProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace?,
        pipelineGeneration: UInt64?,
        deliveryCompleted: (@MainActor @Sendable () -> Void)?
    ) {
        switch action {
        case .paste(let reason, let literalRawTranscript):
            log("intent route=paste origin=\(origin.rawValue) literal=\(literalRawTranscript) reason=\(reason)")
            let output = literalRawTranscript ? rawTranscript : text
            pasteIntoFrontApp(
                output,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                restoreClipboard: true,
                deliveryKind: .ordinaryDictation,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
            if transcriptRetainedInRecent {
                attachProcessedTextToRecentTranscription(
                    rawText: rawTranscript,
                    processedText: output == rawTranscript ? nil : output
                )
            } else {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: output == rawTranscript ? nil : output,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
        case .rewriteSelection(let reason):
            log("intent route=rewriteSelection origin=\(origin.rawValue) reason=\(reason)")
            // Retention before processing: the Rewriting phase can be cancelled (or fail),
            // and the Cancel affordance promises the transcript stays in Recent.
            if !transcriptRetainedInRecent {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: nil,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
            runCommandMode(
                instruction: rawTranscript,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                selectionToken: selectionToken,
                canonicalProjectId: canonicalProjectId,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        case .answerConversation(let reason):
            log("intent route=answerConversation origin=\(origin.rawValue) reason=\(reason)")
            if !transcriptRetainedInRecent {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: nil,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
            runConversationMode(
                question: rawTranscript,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        }
    }

    func insertRecentTranscription(
        rawText: String,
        processedText: String?,
        projectId: String?,
        projectName: String?
    ) {
        recentTranscriptions.insert(
            TranscriptionResult(
                rawText: rawText,
                processedText: processedText,
                timestamp: Date(),
                projectId: projectId,
                projectName: projectName
            ),
            at: 0
        )
        if recentTranscriptions.count > 20 { recentTranscriptions.removeLast() }
    }

    /// Backfills the processed text onto a transcript that entered Recent when its pending
    /// phase began, so the entry shows exactly what was pasted. The original timestamp is
    /// preserved.
    func attachProcessedTextToRecentTranscription(rawText: String, processedText: String?) {
        guard let processedText,
              let index = recentTranscriptions.firstIndex(where: { $0.rawText == rawText }) else { return }
        let existing = recentTranscriptions[index]
        recentTranscriptions[index] = TranscriptionResult(
            rawText: existing.rawText,
            processedText: processedText,
            timestamp: existing.timestamp,
            projectId: existing.projectId,
            projectName: existing.projectName
        )
    }

    func writeCapturedWAV(to path: String) -> Bool {
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

    nonisolated static func saveRealtimeTranscript(
        text: String,
        audioPath: String?,
        pcmData: Data,
        durationMs: Int,
        activeProjectId: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        language: String,
        recordingId: String,
        homePath: String,
        pipelineTrace: RecordingPipelineTrace
    ) async -> RealtimeFastPathSaveResult {
        await Task.detached(priority: .utility) {
            do {
                var savedAudioPath: String?
                if let audioPath, !pcmData.isEmpty {
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "wav_write_started", detail: "pcm_bytes=\(pcmData.count)"),
                        homePath: homePath
                    )
                    try Self.writeWAV(
                        pcmData: pcmData,
                        sampleRate: 24_000,
                        channelCount: 1,
                        bitsPerSample: 16,
                        to: URL(fileURLWithPath: audioPath)
                    )
                    savedAudioPath = audioPath
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "wav_write_complete", detail: "path=\(audioPath) pcm_bytes=\(pcmData.count)"),
                        homePath: homePath
                    )
                }

                let textFile = try Self.writeTemporaryTranscript(text: text, homePath: homePath)
                defer { try? FileManager.default.removeItem(atPath: textFile) }

                let args = saveTextCLIArgs(
                    textFile: textFile,
                    audioPath: savedAudioPath,
                    activeProjectId: activeProjectId,
                    transcriberPrompt: processingConfiguration.transcriberPrompt,
                    postProcessingMode: processingConfiguration.postProcessingMode,
                    language: language,
                    transcriptionModel: processingConfiguration.transcriptionModel,
                    transcriberModel: processingConfiguration.transcriberModel,
                    enhancementModel: processingConfiguration.enhancementModel,
                    enhanceTriggersJSON: processingConfiguration.enhanceTriggersJSON,
                    keywordTransformsJSON: processingConfiguration.keywordTransformsJSON,
                    recordingId: recordingId,
                    durationMs: durationMs,
                    source: "realtime_fast_path",
                    modelUsed: RealtimeTranscriptionClient.transcriptionModelID
                )
                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_started", detail: "operation=save_text"),
                    homePath: homePath
                )
                let output = CLIRunner.run(args, home: homePath)
                if let error = CLIRunner.parseError(output) {
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "helper_processing_store_failed", detail: "error=\(NativeErrorSanitizer.sanitize(error))"),
                        homePath: homePath
                    )
                    return RealtimeFastPathSaveResult(text: nil, error: error)
                }

                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_processing_store_complete"),
                    homePath: homePath
                )
                return RealtimeFastPathSaveResult(text: CLIRunner.parseJSON(output) ?? text, error: nil)
            } catch {
                NativeAppLog.write(
                    pipelineTrace.message(stage: "persistence_failed", detail: "error=\(NativeErrorSanitizer.sanitize(error.localizedDescription))"),
                    homePath: homePath
                )
                return RealtimeFastPathSaveResult(text: nil, error: error.localizedDescription)
            }
        }.value
    }

    nonisolated static func writeTemporaryTranscript(text: String, homePath: String) throws -> String {
        let dir = URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("recordings", isDirectory: true)
            .appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("realtime-\(UUID().uuidString).txt")
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    nonisolated static func writeWAV(pcmData: Data, sampleRate: UInt32, channelCount: UInt16, bitsPerSample: UInt16, to url: URL) throws {
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

    static func timestampForFilename() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return formatter.string(from: Date())
    }

}
