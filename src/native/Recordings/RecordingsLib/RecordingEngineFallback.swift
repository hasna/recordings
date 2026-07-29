import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    // MARK: - Fallback Transcription

    func recoverAsyncPersistenceFailure(
        error: String,
        audioPath: String?,
        pcmData: Data,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        displayProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace,
        pipelineGeneration: UInt64
    ) {
        let sanitizedError = NativeErrorSanitizer.sanitize(error)
        log(pipelineTrace.message(
            stage: "async_persistence_failed",
            detail: "error=\(sanitizedError)"
        ))
        updateBackgroundRecoveryStatus(
            "Pasted; recovering recording...",
            kind: .success,
            pipelineGeneration: pipelineGeneration
        )

        Task.detached {
            let recoveryAudioPath = Self.ensureBackgroundRecoveryAudio(
                audioPath: audioPath,
                pcmData: pcmData
            )

            await MainActor.run {
                guard let recoveryAudioPath else {
                    self.updateBackgroundRecoveryStatus(
                        "Pasted, but recording could not be saved: \(sanitizedError)",
                        kind: .failure,
                        pipelineGeneration: pipelineGeneration
                    )
                    return
                }
                self.fallbackTranscribe(
                    audioPath: recoveryAudioPath,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    selectionToken: selectionToken,
                    canonicalProjectId: canonicalProjectId,
                    displayProjectId: displayProjectId,
                    activeProjectName: activeProjectName,
                    processingConfiguration: processingConfiguration,
                    realtimeText: nil,
                    pipelineTrace: pipelineTrace,
                    deliverResult: false,
                    backgroundRecoveryGeneration: pipelineGeneration
                )
            }
        }
    }

    nonisolated static func ensureBackgroundRecoveryAudio(
        audioPath: String?,
        pcmData: Data
    ) -> String? {
        guard let audioPath else { return nil }
        if FileManager.default.fileExists(atPath: audioPath) {
            return audioPath
        }
        guard !pcmData.isEmpty else { return nil }
        do {
            try writeWAV(
                pcmData: pcmData,
                sampleRate: 24_000,
                channelCount: 1,
                bitsPerSample: 16,
                to: URL(fileURLWithPath: audioPath)
            )
            return audioPath
        } catch {
            return nil
        }
    }

    nonisolated static func shouldApplyBackgroundRecoveryStatus(
        recoveryGeneration: UInt64,
        currentGeneration: UInt64,
        isRecording: Bool,
        isTranscribing: Bool
    ) -> Bool {
        recoveryGeneration == currentGeneration && !isRecording && !isTranscribing
    }

    func updateBackgroundRecoveryStatus(
        _ message: String,
        kind: DeliveryStatusKind,
        pipelineGeneration: UInt64
    ) {
        guard Self.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: pipelineGeneration,
            currentGeneration: recordingGeneration,
            isRecording: isRecording,
            isTranscribing: isTranscribing
        ) else {
            log("background recovery status suppressed for superseded pipeline generation=\(pipelineGeneration)")
            return
        }
        statusMessage = message
        flowPhase = Self.flowPhase(forDeliveryStatus: message, kind: kind)
    }

    nonisolated static func fallbackCompletionAction(
        cliText: String?,
        cliError: String?,
        realtimeText: String?,
        deliverResult: Bool
    ) -> FallbackCompletionAction {
        let resolved = resolveFinalTranscript(
            cliText: cliText,
            cliError: cliError,
            realtimeText: realtimeText
        )
        guard let text = resolved.text else {
            let failure = resolved.failureStatus ?? "Transcription failed"
            return deliverResult ? .fail(failure) : .backgroundFailed(failure)
        }
        return deliverResult ? .deliver(text) : .backgroundRecovered
    }

    func fallbackTranscribe(
        audioPath: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        displayProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        realtimeText: String? = nil,
        pipelineTrace: RecordingPipelineTrace? = nil,
        pipelineGeneration: UInt64? = nil,
        deliverResult: Bool = true,
        backgroundRecoveryGeneration: UInt64? = nil
    ) {
        let homePath = home

        if deliverResult {
            isTranscribing = true
            statusMessage = Self.shouldLabelRewriting(
                postProcessingMode: processingConfiguration.postProcessingMode
            ) ? "Rewriting..." : "Transcribing..."
            flowPhase = .processing(statusMessage)
        } else {
            if let backgroundRecoveryGeneration {
                updateBackgroundRecoveryStatus(
                    "Pasted; recovering recording...",
                    kind: .success,
                    pipelineGeneration: backgroundRecoveryGeneration
                )
            }
        }

        // Only a proven canonical Store id may be persisted. The local display id remains
        // available to recent-transcript UI even when synchronization is degraded.
        let transcribeArgs = Self.transcribeCLIArgs(
            audioPath: audioPath,
            activeProjectId: canonicalProjectId,
            transcriberPrompt: processingConfiguration.transcriberPrompt,
            postProcessingMode: processingConfiguration.postProcessingMode,
            language: processingConfiguration.transcriptionLanguage,
            transcriptionPrompt: processingConfiguration.transcriptionPrompt,
            transcriptionModel: processingConfiguration.transcriptionModel,
            transcriberModel: processingConfiguration.transcriberModel,
            enhancementModel: processingConfiguration.enhancementModel,
            enhanceTriggersJSON: processingConfiguration.enhanceTriggersJSON,
            keywordTransformsJSON: processingConfiguration.keywordTransformsJSON,
            recordingId: pipelineTrace?.id
        )

        Task.detached {
            if let pipelineTrace {
                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_started", detail: "operation=batch_transcribe"),
                    homePath: homePath
                )
            }
            let output = CLIRunner.run(transcribeArgs, home: homePath)
            let cliError = CLIRunner.parseError(output)
            let cliText = cliError == nil ? CLIRunner.parseJSON(output) : nil
            let cliRawText = cliError == nil ? CLIRunner.parseRawTranscript(output) : nil

            await MainActor.run {
                if let pipelineTrace {
                    self.log(pipelineTrace.message(
                        stage: cliError == nil ? "helper_processing_store_complete" : "helper_processing_store_failed"
                    ))
                }
                if let cliError {
                    self.log("cli transcription failed error=\(cliError)")
                } else if cliText == nil {
                    self.log("cli transcription empty output=\(output.prefix(160))")
                }

                if cliText == nil {
                    self.log("using realtime transcript fallback chars=\(realtimeText?.count ?? 0)")
                } else {
                    self.log("cli transcription succeeded chars=\(cliText?.count ?? 0)")
                }
                self.recordPersistenceCompletion(savedText: cliError == nil ? cliText : nil)
                switch Self.fallbackCompletionAction(
                    cliText: cliText,
                    cliError: cliError,
                    realtimeText: realtimeText,
                    deliverResult: deliverResult
                ) {
                case .deliver(let text):
                    self.isTranscribing = false
                    self.finishWithText(
                        text,
                        rawTranscript: cliRawText ?? realtimeText ?? text,
                        targetAppBundleIdentifier: targetAppBundleIdentifier,
                        targetAppPid: targetAppPid,
                        selectionToken: selectionToken,
                        canonicalProjectId: canonicalProjectId,
                        activeProjectId: displayProjectId,
                        activeProjectName: activeProjectName,
                        processingConfiguration: processingConfiguration,
                        pipelineTrace: pipelineTrace,
                        pipelineGeneration: pipelineGeneration
                    )
                case .fail(let failure):
                    if let pipelineGeneration {
                        self.pipelineDeliveryGate.abandonPipeline(pipelineGeneration)
                    }
                    self.finish(failure)
                case .backgroundRecovered:
                    if let pipelineTrace {
                        self.log(pipelineTrace.message(stage: "async_persistence_recovered"))
                    }
                    if let backgroundRecoveryGeneration {
                        self.updateBackgroundRecoveryStatus(
                            "Pasted and saved",
                            kind: .success,
                            pipelineGeneration: backgroundRecoveryGeneration
                        )
                    }
                case .backgroundFailed(let failure):
                    if let backgroundRecoveryGeneration {
                        self.updateBackgroundRecoveryStatus(
                            "Pasted, but recording could not be saved: \(failure)",
                            kind: .failure,
                            pipelineGeneration: backgroundRecoveryGeneration
                        )
                    }
                }
            }
        }
    }

    func mostRecentAudioFile() -> String? {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: audioDir)) ?? []
        let wavFiles = files.filter { $0.hasSuffix(".wav") }.sorted().reversed()
        return wavFiles.first.map { "\(audioDir)/\($0)" }
    }

    nonisolated static func transcribeCLIArgs(
        audioPath: String,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String,
        language: String = "auto",
        transcriptionPrompt: String? = nil,
        transcriptionModel: String? = nil,
        transcriberModel: String? = nil,
        enhancementModel: String? = nil,
        enhanceTriggersJSON: String? = nil,
        keywordTransformsJSON: String? = nil,
        recordingId: String? = nil
    ) -> [String] {
        var args = ["--json"]
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += ["transcribe", audioPath]

        let languageHint = OpenAIAPIKeyStore.apiLanguageHint(for: language)
        if !languageHint.isEmpty {
            args += ["--language", languageHint]
        }
        if let recordingId, !recordingId.isEmpty {
            args += ["--recording-id", recordingId]
        }
        if let transcriptionPrompt, !transcriptionPrompt.isEmpty {
            args += ["--prompt", transcriptionPrompt]
        }
        if let transcriptionModel, !transcriptionModel.isEmpty {
            args += ["--transcription-model", transcriptionModel]
        }
        if let transcriberModel, !transcriberModel.isEmpty {
            args += ["--transcriber-model", transcriberModel]
        }
        if let enhancementModel, !enhancementModel.isEmpty {
            args += ["--enhancement-model", enhancementModel]
        }
        if let enhanceTriggersJSON, !enhanceTriggersJSON.isEmpty {
            args += ["--enhance-triggers-json", enhanceTriggersJSON]
        }
        if let keywordTransformsJSON, !keywordTransformsJSON.isEmpty {
            args += ["--keyword-transforms-json", keywordTransformsJSON]
        }

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
        transcriptionModel: String? = nil,
        transcriberModel: String? = nil,
        enhancementModel: String? = nil,
        enhanceTriggersJSON: String? = nil,
        keywordTransformsJSON: String? = nil,
        recordingId: String? = nil,
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
        if let recordingId, !recordingId.isEmpty {
            args += ["--recording-id", recordingId]
        }
        if let transcriptionModel, !transcriptionModel.isEmpty {
            args += ["--transcription-model", transcriptionModel]
        }
        if let transcriberModel, !transcriberModel.isEmpty {
            args += ["--transcriber-model", transcriberModel]
        }
        if let enhancementModel, !enhancementModel.isEmpty {
            args += ["--enhancement-model", enhancementModel]
        }
        if let enhanceTriggersJSON, !enhanceTriggersJSON.isEmpty {
            args += ["--enhance-triggers-json", enhanceTriggersJSON]
        }
        if let keywordTransformsJSON, !keywordTransformsJSON.isEmpty {
            args += ["--keyword-transforms-json", keywordTransformsJSON]
        }
        let prompt = transcriberPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            args += ["--transcriber-prompt", prompt]
        }
        return args
    }

    nonisolated static func rewriteCLIArgs(
        selectedText: String,
        instruction: String,
        activeProjectId: String?,
        processingConfiguration: RecordingProcessingConfiguration
    ) -> [String] {
        var args: [String] = []
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += [
            "rewrite",
            "--instruction", instruction,
            "--post-processing", processingConfiguration.postProcessingMode,
            "--language", processingConfiguration.transcriptionLanguage,
            "--prompt", processingConfiguration.transcriptionPrompt,
            "--transcriber-prompt", processingConfiguration.transcriberPrompt,
            "--transcription-model", processingConfiguration.transcriptionModel,
            "--transcriber-model", processingConfiguration.transcriberModel,
            "--enhancement-model", processingConfiguration.enhancementModel,
            "--enhance-triggers-json", processingConfiguration.enhanceTriggersJSON,
            "--keyword-transforms-json", processingConfiguration.keywordTransformsJSON,
            "--", selectedText,
        ]
        return args
    }

    func finish(_ msg: String) {
        log("finish status=\(msg)")
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = msg
        flowPhase = .failed(msg)
    }

    func resetRecordingIntent() {
        activeTrigger = nil
        microphonePermissionStartGate.cancel()
        keyboardShortcutIsDown = false
        fnKeyIsDown = false
        targetAppBundleIdentifier = nil
        targetAppPid = nil
    }

}
