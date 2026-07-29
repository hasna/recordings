import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    // MARK: - Conversation

    func runConversationMode(
        question: String,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace?,
        pipelineGeneration: UInt64?,
        deliveryCompleted: (@MainActor @Sendable () -> Void)?
    ) {
        let deliveryGeneration = pipelineGeneration ?? recordingGeneration
        beginIntentDelivery(for: deliveryGeneration)
        updateDeliveryStatus("Answering...", kind: .progress, pipelineGeneration: pipelineGeneration)
        if let pipelineTrace { log(pipelineTrace.message(stage: "conversation_started")) }
        let classifier = intentClassifier
        let model = processingConfiguration.intentModel
        Task { [weak self] in
            let outcome = await classifier.answer(question: question, model: model)
            guard let self else {
                deliveryCompleted?()
                return
            }
            self.endIntentDelivery(for: deliveryGeneration)
            if let pipelineTrace { self.log(pipelineTrace.message(stage: "conversation_complete")) }
            // The conversation route never touches the clipboard: the reply card has an
            // explicit Copy affordance, and clobbering whatever the user had copied would be
            // an irreversible side effect of a possibly-misclassified recording.
            switch outcome {
            case .answer(let answer):
                if Self.shouldApplyConversationReply(
                    replyGeneration: pipelineGeneration,
                    currentGeneration: self.recordingGeneration,
                    isRecording: self.isRecording
                ) {
                    self.conversationReply = ConversationReply(question: question, answer: answer)
                    self.updateDeliveryStatus("Answered", kind: .success, pipelineGeneration: pipelineGeneration)
                } else {
                    self.log("stale conversation reply dropped pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
                }
            case .unavailable(let message):
                // The delayed answer failed; never auto-paste this late. Fail closed to the
                // preview path: the transcript is persisted and stays in Recent.
                self.log("conversation unavailable: \(message)")
                self.updateDeliveryStatus(
                    "Couldn't answer — transcript saved to Recent",
                    kind: .failure,
                    pipelineGeneration: pipelineGeneration
                )
            }
            deliveryCompleted?()
        }
    }

    nonisolated static func shouldApplyConversationReply(
        replyGeneration: UInt64?,
        currentGeneration: UInt64,
        isRecording: Bool
    ) -> Bool {
        guard !isRecording else { return false }
        // No generation means the reply cannot be proven current — fail closed.
        guard let replyGeneration else { return false }
        return replyGeneration == currentGeneration
    }

    // MARK: - Command Mode

    func runCommandMode(
        instruction: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace?,
        pipelineGeneration: UInt64?,
        deliveryCompleted: (@MainActor @Sendable () -> Void)?
    ) {
        let deliveryGeneration = pipelineGeneration ?? recordingGeneration
        beginIntentDelivery(for: deliveryGeneration)
        let finishCommandDelivery: @MainActor @Sendable () -> Void = { [weak self] in
            self?.endIntentDelivery(for: deliveryGeneration)
            deliveryCompleted?()
        }
        guard protectedOperationTrust().trusted else {
            log("command mode blocked by accessibility permission")
            updateDeliveryStatus(
                "Enable Accessibility permission for Recordings to rewrite selected text",
                kind: .failure,
                pipelineGeneration: pipelineGeneration
            )
            finishCommandDelivery()
            return
        }

        let homePath = home
        let resolveTarget = rewriteSelectionResolver
        Task { @MainActor in
            let resolution = await resolveTarget(
                targetAppBundleIdentifier,
                targetAppPid,
                selectionToken,
                pipelineGeneration
            )
            let selected: String
            switch resolution {
            case .targetAppMissing:
                self.log("command mode target app not found")
                self.updateDeliveryStatus("No target app found", kind: .failure, pipelineGeneration: pipelineGeneration)
                finishCommandDelivery()
                return
            case .selectionUnavailable:
                self.updateDeliveryStatus("No text selected", kind: .failure, pipelineGeneration: pipelineGeneration)
                finishCommandDelivery()
                return
            case .selection(let validated):
                selected = validated
            }
            // A cancellation (or newer recording) during target resolution makes the whole
            // rewrite stale — never spawn the CLI for a delivery that can only be abandoned.
            guard !Self.shouldAbandonDelivery(
                pipelineGeneration: pipelineGeneration,
                currentGeneration: self.recordingGeneration,
                isRecording: self.isRecording
            ) else {
                self.log("stale rewrite abandoned before CLI pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
                finishCommandDelivery()
                return
            }
            if self.canOwnBusyState(pipelineGeneration: pipelineGeneration) {
                self.statusMessage = "Rewriting..."
                self.flowPhase = .processing("Rewriting...")
                self.isTranscribing = true
            }

            let rewriteArguments = Self.rewriteCLIArgs(
                selectedText: selected,
                instruction: instruction,
                activeProjectId: canonicalProjectId,
                processingConfiguration: processingConfiguration
            )
            let runCLI = self.commandCLI
            let result = await Task.detached {
                runCLI(rewriteArguments, homePath, Self.commandRewriteTimeout)
            }.value
            if self.canOwnBusyState(pipelineGeneration: pipelineGeneration) {
                self.isTranscribing = false
                self.liveTranscriptionText = ""
            }
            // A rewrite finishing after the user cancelled (or after a newer recording
            // superseded it) must never paste, even if the frozen selection still matches.
            guard !Self.shouldAbandonDelivery(
                pipelineGeneration: pipelineGeneration,
                currentGeneration: self.recordingGeneration,
                isRecording: self.isRecording
            ) else {
                self.log("stale rewrite abandoned pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
                finishCommandDelivery()
                return
            }
            if CLIRunner.parseError(result) == nil, !result.isEmpty {
                self.pasteIntoFrontApp(
                    result,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    restoreClipboard: true,
                    deliveryKind: .commandRewrite,
                    selectionToken: selectionToken,
                    pipelineTrace: pipelineTrace,
                    pipelineGeneration: pipelineGeneration,
                    deliveryCompleted: finishCommandDelivery
                )
            } else {
                self.updateDeliveryStatus(
                    CLIRunner.parseError(result) ?? "Rewrite failed",
                    kind: .failure,
                    pipelineGeneration: pipelineGeneration
                )
                finishCommandDelivery()
            }
        }
    }

    /// Production body of `rewriteSelectionResolver`: real NSWorkspace/AX I/O. The frozen
    /// target app is re-found and activated, focus settles, and the frozen selection is
    /// revalidated element-for-element before any rewrite may run.
    func resolveRewriteSelection(
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        pipelineGeneration: UInt64?
    ) async -> RewriteTargetResolution {
        let requiredProcessIdentity = pipelineGeneration.flatMap {
            pasteTargetProcessIdentityByGeneration[$0]
        }
        let targetApp = selectedRunningPasteTarget(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            pipelineGeneration: pipelineGeneration
        )
        guard let targetApp else {
            return .targetAppMissing
        }
        let alreadyFrontmost = targetApp.processIdentifier == NSWorkspace.shared.frontmostApplication?.processIdentifier
        if !alreadyFrontmost {
            targetApp.activate()
        }

        let focusDelay: TimeInterval = alreadyFrontmost ? 0.05 : 0.35
        try? await Task.sleep(for: .milliseconds(Int(focusDelay * 1_000)))
        let frontmostBeforeRead = NSWorkspace.shared.frontmostApplication
        guard Self.pasteTargetIsReady(
            expectedPid: targetApp.processIdentifier,
            expectedBundleIdentifier: targetApp.bundleIdentifier,
            frontmostPid: frontmostBeforeRead?.processIdentifier,
            frontmostBundleIdentifier: frontmostBeforeRead?.bundleIdentifier,
            accessibilityTrusted: AXIsProcessTrusted(),
            expectedLaunchDate: requiredProcessIdentity?.launchDate,
            frontmostLaunchDate: frontmostBeforeRead?.launchDate,
            requiresProcessIdentity: pipelineGeneration != nil && targetAppPid != nil
        ) else {
            return .selectionUnavailable
        }
        let frontmostAfterRead = NSWorkspace.shared.frontmostApplication
        let selected = Self.validAccessibilitySelection(
            selectionToken?.selectedText,
            targetStillFrontmost: Self.pasteTargetIsReady(
                expectedPid: targetApp.processIdentifier,
                expectedBundleIdentifier: targetApp.bundleIdentifier,
                frontmostPid: frontmostAfterRead?.processIdentifier,
                frontmostBundleIdentifier: frontmostAfterRead?.bundleIdentifier,
                accessibilityTrusted: AXIsProcessTrusted(),
                expectedLaunchDate: requiredProcessIdentity?.launchDate,
                frontmostLaunchDate: frontmostAfterRead?.launchDate,
                requiresProcessIdentity: pipelineGeneration != nil && targetAppPid != nil
            )
        )
        guard let selected,
              selectionToken?.matchesCurrentSelection(
                for: targetApp.processIdentifier
              ) == true else {
            return .selectionUnavailable
        }
        return .selection(selected)
    }

    nonisolated static func validAccessibilitySelection(
        _ candidate: String?,
        targetStillFrontmost: Bool
    ) -> String? {
        let text = candidate ?? ""
        guard targetStillFrontmost,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    func canOwnBusyState(pipelineGeneration: UInt64?) -> Bool {
        guard let pipelineGeneration else { return true }
        return pipelineGeneration == recordingGeneration && !isRecording
    }

    // MARK: - Window Title (Accessibility API)

    /// Runs off the MainActor in the recording-start snapshot; every IPC round trip is
    /// bounded so an unresponsive app delays project detection, never recording.
    nonisolated static func focusedWindowTitle(pid: pid_t?) -> String? {
        guard let pid else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, AccessibilitySelectionToken.captureMessagingTimeout)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let window = windowRef,
              CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        let windowElement = window as! AXUIElement
        AXUIElementSetMessagingTimeout(windowElement, AccessibilitySelectionToken.captureMessagingTimeout)
        var titleRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(windowElement, kAXTitleAttribute as CFString, &titleRef) == .success,
              let title = titleRef as? String else { return nil }
        return title
    }

}
