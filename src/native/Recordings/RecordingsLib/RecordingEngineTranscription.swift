import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    public func stopAndTranscribe() {
        // Stop during the warm-up window has nothing to transcribe — the microphone was opened
        // but has not delivered a sample. Abandon visibly instead of spending a transcription
        // pipeline (and a CLI round trip) on an empty buffer.
        if isWarmingUpCapture {
            abandonWarmingCapture(reason: "stopped during warm-up", alert: .releasedBeforeAudio)
            return
        }
        guard isRecording else { return }
        let pipelineTrace = RecordingPipelineTrace()
        log(pipelineTrace.message(stage: "release"))

        recordingTimer?.invalidate()
        recordingTimer = nil

        let recorder = nativeRecorder
        nativeRecorder = nil
        recorder?.stop()

        isRecording = false
        isTranscribing = true

        guard let captureConfiguration = activeCaptureConfiguration else {
            realtimeClient?.stop()
            realtimeClient = nil
            streamingTask?.cancel()
            streamingTask = nil
            pcmStreamPipe?.cancel()
            pcmStreamPipe = nil
            activeAudioPath = nil
            recordedPCM.removeAll(keepingCapacity: true)
            resetRecordingIntent()
            finish("Recording configuration unavailable")
            return
        }
        activeCaptureConfiguration = nil
        let targetAppBundleIdentifier = captureConfiguration.targetAppBundleIdentifier
        let targetAppPid = captureConfiguration.targetAppPid
        let audioPath = activeAudioPath
        let pcmStreamPipe = pcmStreamPipe
        let client = realtimeClient
        let pipelineGeneration = recordingGeneration
        pipelineDeliveryGate.registerPipeline(pipelineGeneration)
        statusMessage = "Transcribing..."
        flowPhase = .finalizing
        resetRecordingIntent()
        self.pcmStreamPipe = nil

        Task {
            if let pcmStreamPipe {
                self.recordedPCM = await pcmStreamPipe.finish()
            }
            self.log(pipelineTrace.message(
                stage: "pcm_drain_complete",
                detail: "pcm_bytes=\(self.recordedPCM.count)"
            ))

            let streamingResult = await client?.finish(
                timeoutMilliseconds: Self.realtimeSettleBudgetMilliseconds(
                    pcmByteCount: self.recordedPCM.count
                ),
                pipelineID: pipelineTrace.id,
                pipelineStartedUptimeMilliseconds: pipelineTrace.startedUptimeMilliseconds
            )
                ?? RealtimeFinishResult(text: "", settled: false, error: nil)
            self.log(pipelineTrace.message(
                stage: "realtime_finish_complete",
                detail: "settled=\(streamingResult.settled) chars=\(streamingResult.text.count)"
            ))

            // The start context was captured concurrently at recording start; by the time
            // the realtime transcript has settled it is resolved in all but pathological
            // cases, and its Accessibility reads are bounded either way.
            let startContext = await captureConfiguration.startContext.value
            let selectionToken = startContext.selectionToken
            let activeProjectId = startContext.displayProjectId
            let canonicalProjectId = startContext.canonicalProjectId
            let activeProjectName = startContext.activeProjectName
            let processingConfiguration = startContext.processing
            let postProcessingMode = processingConfiguration.postProcessingMode
            let busyLabel = Self.shouldLabelRewriting(
                postProcessingMode: postProcessingMode
            ) ? "Rewriting..." : "Transcribing..."

            self.realtimeClient = nil
            self.streamingTask?.cancel()
            self.streamingTask = nil
            if self.isTranscribing {
                self.statusMessage = busyLabel
                self.flowPhase = .processing(busyLabel)
            }

            if let error = streamingResult.error {
                self.log("realtime finish reported error=\(error)")
            }

            let realtimeText = Self.normalizedRealtimeTranscript(streamingResult.text)
            let safeRealtimeFallbackText = Self.settledRealtimeFallbackTranscript(
                finishResult: streamingResult,
                pcmByteCount: self.recordedPCM.count,
                language: processingConfiguration.transcriptionLanguage
            )
            let realtimeFastPathText = Self.settledRealtimeFastPathTranscript(
                finishResult: streamingResult,
                pcmByteCount: self.recordedPCM.count,
                language: processingConfiguration.transcriptionLanguage
            )

            self.liveTranscriptionText = ""

            if let realtimeFastPathText {
                let pcmData = self.recordedPCM
                let durationMs = Int(self.recordingDuration * 1_000)
                let language = OpenAIAPIKeyStore.apiLanguageHint(for: processingConfiguration.transcriptionLanguage)
                let homePath = self.home
                self.log(pipelineTrace.message(
                    stage: "realtime_fast_path_ready",
                    detail: "chars=\(realtimeFastPathText.count) pcm_bytes=\(pcmData.count)"
                ))
                let persist: @Sendable () async -> RealtimeFastPathSaveResult = {
                    await Self.saveRealtimeTranscript(
                        text: realtimeFastPathText,
                        audioPath: audioPath,
                        pcmData: pcmData,
                        durationMs: durationMs,
                        activeProjectId: canonicalProjectId,
                        processingConfiguration: processingConfiguration,
                        language: language,
                        recordingId: pipelineTrace.id,
                        homePath: homePath,
                        pipelineTrace: pipelineTrace
                    )
                }

                if Self.shouldPasteBeforePersistence(
                    postProcessingMode: postProcessingMode,
                    transcript: realtimeFastPathText,
                    hasSelection: selectionToken != nil,
                    intentDetectionEnabled: processingConfiguration.intentDetectionEnabled,
                    enhanceTriggersJSON: processingConfiguration.enhanceTriggersJSON
                ) {
                    self.isTranscribing = false
                    _ = Self.deliverRealtimeBeforePersistence(
                        text: realtimeFastPathText,
                        persist: persist,
                        deliver: { text in
                            await withCheckedContinuation { continuation in
                                self.finishWithText(
                                    text,
                                    rawTranscript: text,
                                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                                    targetAppPid: targetAppPid,
                                    selectionToken: selectionToken,
                                    canonicalProjectId: canonicalProjectId,
                                    activeProjectId: activeProjectId,
                                    activeProjectName: activeProjectName,
                                    processingConfiguration: processingConfiguration,
                                    pipelineTrace: pipelineTrace,
                                    pipelineGeneration: pipelineGeneration,
                                    deliveryCompleted: { continuation.resume() }
                                )
                            }
                        },
                        persistenceCompleted: { result in
                            self.recordPersistenceCompletion(savedText: result.text)
                            if result.text == nil {
                                self.recoverAsyncPersistenceFailure(
                                    error: result.error ?? "Realtime save returned no recording",
                                    audioPath: audioPath,
                                    pcmData: pcmData,
                                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                                    targetAppPid: targetAppPid,
                                    selectionToken: selectionToken,
                                    canonicalProjectId: canonicalProjectId,
                                    displayProjectId: activeProjectId,
                                    activeProjectName: activeProjectName,
                                    processingConfiguration: processingConfiguration,
                                    pipelineTrace: pipelineTrace,
                                    pipelineGeneration: pipelineGeneration
                                )
                            } else {
                                self.log(pipelineTrace.message(stage: "async_persistence_complete"))
                            }
                        }
                    )
                    self.activeAudioPath = nil
                    self.recordedPCM.removeAll(keepingCapacity: true)
                    return
                }

                let saveResult = await persist()
                self.recordPersistenceCompletion(savedText: saveResult.text)
                guard let savedText = saveResult.text else {
                    self.log("realtime fast-path save failed error=\(saveResult.error ?? "unknown")")
                    if let audioPath, FileManager.default.fileExists(atPath: audioPath) || self.writeCapturedWAV(to: audioPath) {
                        self.fallbackTranscribe(
                            audioPath: audioPath,
                            targetAppBundleIdentifier: targetAppBundleIdentifier,
                            targetAppPid: targetAppPid,
                            selectionToken: selectionToken,
                            canonicalProjectId: canonicalProjectId,
                            displayProjectId: activeProjectId,
                            activeProjectName: activeProjectName,
                            processingConfiguration: processingConfiguration,
                            realtimeText: safeRealtimeFallbackText,
                            pipelineTrace: pipelineTrace,
                            pipelineGeneration: pipelineGeneration
                        )
                    } else {
                        self.pipelineDeliveryGate.abandonPipeline(pipelineGeneration)
                        self.finish(saveResult.error ?? "Failed to save transcription")
                    }
                    self.activeAudioPath = nil
                    self.recordedPCM.removeAll(keepingCapacity: true)
                    return
                }
                self.isTranscribing = false
                self.finishWithText(
                    savedText,
                    rawTranscript: realtimeFastPathText,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    selectionToken: selectionToken,
                    canonicalProjectId: canonicalProjectId,
                    activeProjectId: activeProjectId,
                    activeProjectName: activeProjectName,
                    processingConfiguration: processingConfiguration,
                    pipelineTrace: pipelineTrace,
                    pipelineGeneration: pipelineGeneration
                )
            } else if let audioPath, self.writeCapturedWAV(to: audioPath) {
                self.log(pipelineTrace.message(stage: "wav_write_complete", detail: "path=\(audioPath)"))
                if realtimeText != nil, !streamingResult.settled {
                    self.log("realtime fast path skipped because final transcript did not settle")
                }
                self.log("transcribing captured full audio with quality model audioPath=\(audioPath) realtimePreviewChars=\(realtimeText?.count ?? 0)")
                self.fallbackTranscribe(
                    audioPath: audioPath,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    selectionToken: selectionToken,
                    canonicalProjectId: canonicalProjectId,
                    displayProjectId: activeProjectId,
                    activeProjectName: activeProjectName,
                    processingConfiguration: processingConfiguration,
                    realtimeText: safeRealtimeFallbackText,
                    pipelineTrace: pipelineTrace,
                    pipelineGeneration: pipelineGeneration
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
                        rawTranscript: text,
                        targetAppBundleIdentifier: targetAppBundleIdentifier,
                        targetAppPid: targetAppPid,
                        selectionToken: selectionToken,
                        canonicalProjectId: canonicalProjectId,
                        activeProjectId: activeProjectId,
                        activeProjectName: activeProjectName,
                        processingConfiguration: processingConfiguration,
                        pipelineTrace: pipelineTrace,
                        pipelineGeneration: pipelineGeneration
                    )
                } else {
                    self.log("no audio captured")
                    self.pipelineDeliveryGate.abandonPipeline(pipelineGeneration)
                    // The one failure the user has no other way to notice: nothing was typed,
                    // nothing appeared, and the status line lives behind a click on a menu-bar
                    // glyph that never changed. So disclose it on the glyph too.
                    //
                    // One message, used for both. `MenuBarPresentation` renders the blocked
                    // state as `statusText = blockedReason`, so passing the generic constant here
                    // while `finish` held a specific `failureStatus` would replace the specific
                    // diagnosis with "No audio captured" in every surface that reads the
                    // presentation — losing the more useful of the two.
                    let failure = resolved.failureStatus ?? RecordingAttemptAlert.noAudioCaptured.message
                    self.finish(failure)
                    self.setBlockedReason(failure, for: .pressConsumed)
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

    public nonisolated static func settledRealtimeFastPathTranscript(
        finishResult: RealtimeFinishResult,
        pcmByteCount: Int,
        language: String
    ) -> String? {
        guard let text = settledRealtimeFallbackTranscript(
            finishResult: finishResult,
            pcmByteCount: pcmByteCount,
            language: language
        ) else { return nil }
        return text
    }

    public nonisolated static func settledRealtimeFallbackTranscript(
        finishResult: RealtimeFinishResult,
        pcmByteCount: Int,
        language: String
    ) -> String? {
        guard finishResult.settled, finishResult.error == nil else { return nil }
        guard let text = safeRealtimeFallbackTranscript(
            realtimeText: finishResult.text,
            language: language
        ) else { return nil }
        return shouldFallbackFromPartialRealtime(text: text, pcmByteCount: pcmByteCount) ? nil : text
    }

    /// Delivery may only run ahead of persistence for transcripts the local screens already
    /// decided are plain dictation: the paste is near-instant, so persistence is deferred by
    /// milliseconds. Command/conversation-shaped transcripts persist first — their delivery
    /// can block on the classifier, the assistant, or the rewrite CLI, and the recording
    /// must already be durable by then.
    ///
    /// `off` mode never rewrites, so plain dictation always qualifies. `auto` mode
    /// qualifies only when `EnhancementScreen` proves the helper cannot rewrite the
    /// transcript — enhancement-eligible speech must keep pasting the helper's output,
    /// which only exists after persistence. `always` mode rewrites unconditionally and
    /// therefore always persists first.
    nonisolated static func shouldPasteBeforePersistence(
        postProcessingMode: String,
        transcript: String,
        hasSelection: Bool,
        intentDetectionEnabled: Bool,
        // No default: "[]" decodes successfully to "no configured triggers", which
        // silently fails OPEN for a caller that forgets the argument — the opposite
        // of the fail-closed contract documented on EnhancementScreen. Every caller
        // must state the configured triggers explicitly (review F2 on #30).
        enhanceTriggersJSON: String
    ) -> Bool {
        switch PostProcessingMode(rawValue: postProcessingMode) {
        case .off:
            break
        case .auto:
            guard !EnhancementScreen.mayRequireEnhancement(
                text: transcript,
                enhanceTriggersJSON: enhanceTriggersJSON
            ) else { return false }
        default:
            return false
        }
        guard intentDetectionEnabled else { return true }
        return IntentScreen.screen(text: transcript, hasSelection: hasSelection)?.intent == .dictate
    }

    nonisolated static func shouldLabelRewriting(
        postProcessingMode: String
    ) -> Bool {
        PostProcessingMode(rawValue: postProcessingMode) != .off
    }

    @MainActor
    static func deliverRealtimeBeforePersistence(
        text: String,
        persist: @escaping @Sendable () async -> RealtimeFastPathSaveResult,
        deliver: @escaping @MainActor @Sendable (String) async -> Void,
        persistenceCompleted: @escaping @MainActor @Sendable (RealtimeFastPathSaveResult) -> Void
    ) -> Task<Void, Never> {
        return Task {
            await deliver(text)
            let result = await persist()
            persistenceCompleted(result)
        }
    }

    /// Publishes a monotonic completion event only for confirmed persistence. A failed
    /// helper result must not make the Library appear current before recovery succeeds.
    func recordPersistenceCompletion(savedText: String?) {
        guard savedText != nil else { return }
        persistedRecordingRevision &+= 1
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

    nonisolated static func removeStandaloneRealtimeArtifacts(from text: String) -> String {
        let artifactTokens: Set<String> = ["어", "음", "um", "umm", "uh", "uhh", "erm", "hmm", "eh"]
        let words = text.split(separator: " ").compactMap { rawWord -> String? in
            let normalized = rawWord
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            return artifactTokens.contains(normalized) ? nil : String(rawWord)
        }
        return words.joined(separator: " ")
    }

    nonisolated static func normalizedTranscriptText(_ text: String) -> String {
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

    nonisolated static func canonicalTranscriptWords(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).compactMap { rawWord in
            let normalized = String(rawWord)
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            guard !normalized.isEmpty else { return nil }
            return normalized
        }
    }

    nonisolated static func canonicalTranscriptWordsPreservingSpeechTokens(_ text: String) -> [String] {
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

    nonisolated static func collapseAdjacentDuplicateWords(in text: String) -> String {
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

    nonisolated static func collapseAdjacentDuplicatePhrases(in text: String) -> String {
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

    nonisolated static func normalizedTranscriptWord(_ word: String) -> String {
        word.trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines)).lowercased()
    }

    nonisolated static func latinLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter { scalar in
            (65...90).contains(Int(scalar.value)) || (97...122).contains(Int(scalar.value))
        }.count
    }

    nonisolated static func cjkLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter(isCJKScalar).count
    }

    nonisolated static func containsCJKArtifact(in text: String) -> Bool {
        cjkLetterCount(in: text) > 0
    }

    nonisolated static func isCJKScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF:
            return true
        default:
            return false
        }
    }

}
