import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    nonisolated static func outcomeLeavesTranscriptOnClipboard(_ outcome: PasteDeliveryOutcome) -> Bool {
        switch outcome {
        case .targetUnavailable: true
        case .pasted, .deliveryNotObserved, .deliveredUnverified, .clipboardOwnershipLost,
             .clipboardWriteFailed, .eventPostFailed, .secureInputActive: false
        }
    }

    nonisolated static func clipboardOwnershipWasLostAfterPasteFailure(
        outcome: PasteDeliveryOutcome,
        hasOwnershipToken: Bool,
        stillOwnsPayload: Bool
    ) -> Bool {
        // Switched rather than compared against `.targetUnavailable` so the compiler forces a
        // decision here when an outcome is added. A `==` comparison answers `false` for every
        // new case without anyone having considered it, and this predicate decides whether the
        // engine still believes it owns the transcript — guessing wrong loses the text.
        let outcomeCanStrandThePayload: Bool
        switch outcome {
        case .targetUnavailable:
            outcomeCanStrandThePayload = true
        // Secure input cannot strand the payload: nothing else wrote to the clipboard, and the
        // transcript is deliberately kept there.
        case .pasted, .deliveryNotObserved, .deliveredUnverified, .clipboardOwnershipLost,
             .clipboardWriteFailed, .eventPostFailed, .secureInputActive:
            outcomeCanStrandThePayload = false
        }
        return outcomeCanStrandThePayload && hasOwnershipToken && !stillOwnsPayload
    }

    @discardableResult
    nonisolated static func writeClipboard(_ text: String, to pasteboard: NSPasteboard) -> Bool {
        writeClipboardAttempt(text, to: pasteboard).verified
    }

    @discardableResult
    nonisolated static func writeClipboardPreservingOnFailure(
        _ text: String,
        to pasteboard: NSPasteboard
    ) -> Bool {
        let previousClipboard = ClipboardSnapshot(pasteboard: pasteboard)
        let result = writeClipboardAttempt(text, to: pasteboard)
        guard !result.verified else { return true }
        if pasteboard.changeCount == result.ownershipChangeCount {
            previousClipboard.restore(to: pasteboard)
        }
        return false
    }

    nonisolated static func writeClipboardAttempt(
        _ text: String,
        to pasteboard: NSPasteboard
    ) -> PasteboardWriteResult {
        let changeCountBeforeWrite = pasteboard.changeCount
        let clearedChangeCount = pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            return PasteboardWriteResult(
                verified: false,
                ownershipChangeCount: clearedChangeCount,
                changeCountAdvanced: clearedChangeCount > changeCountBeforeWrite
            )
        }
        let writtenChangeCount = pasteboard.changeCount
        let storedText = pasteboard.string(forType: .string)
        return PasteboardWriteResult(
            verified: pasteboard.changeCount == writtenChangeCount && storedText == text,
            ownershipChangeCount: writtenChangeCount,
            changeCountAdvanced: writtenChangeCount > changeCountBeforeWrite
        )
    }

    nonisolated static func clipboardStillOwned(
        _ pasteboard: NSPasteboard,
        text: String,
        changeCount: Int
    ) -> Bool {
        pasteboard.changeCount == changeCount && pasteboard.string(forType: .string) == text
    }

    nonisolated static func pasteTargetIsReady(
        expectedPid: pid_t,
        expectedBundleIdentifier: String?,
        frontmostPid: pid_t?,
        frontmostBundleIdentifier: String?,
        accessibilityTrusted: Bool,
        expectedLaunchDate: Date? = nil,
        frontmostLaunchDate: Date? = nil,
        requiresProcessIdentity: Bool = false
    ) -> Bool {
        let processIdentityMatches = if requiresProcessIdentity {
            expectedLaunchDate != nil && frontmostLaunchDate == expectedLaunchDate
        } else {
            expectedLaunchDate == nil || frontmostLaunchDate == expectedLaunchDate
        }
        return accessibilityTrusted
            && frontmostPid == expectedPid
            && frontmostBundleIdentifier == expectedBundleIdentifier
            && processIdentityMatches
    }

    nonisolated static func shouldCopyPasteFallback(deliveryKind: PasteDeliveryKind) -> Bool {
        deliveryKind != .commandRewrite
    }

    nonisolated static func shouldCopyAfterPasteFailure(
        outcome: PasteDeliveryOutcome,
        deliveryKind: PasteDeliveryKind,
        accessibilityTrusted: Bool,
        clipboardOwnershipWasLost: Bool = false,
        completedTranscriptAlreadyOnClipboard: Bool = false
    ) -> Bool {
        // Switched for the same reason as `clipboardOwnershipWasLostAfterPasteFailure`: a `==`
        // test silently answers `false` for any outcome added later. Secure input already leaves
        // the transcript on the clipboard, so re-copying it would be redundant at best — but that
        // is a decision the compiler should make someone state, not one to inherit by accident.
        let outcomeNeedsClipboardFallback: Bool
        switch outcome {
        case .targetUnavailable:
            outcomeNeedsClipboardFallback = true
        case .pasted, .deliveryNotObserved, .deliveredUnverified, .clipboardOwnershipLost,
             .clipboardWriteFailed, .eventPostFailed, .secureInputActive:
            outcomeNeedsClipboardFallback = false
        }
        return outcomeNeedsClipboardFallback
            && !accessibilityTrusted
            && !clipboardOwnershipWasLost
            && !completedTranscriptAlreadyOnClipboard
            && shouldCopyPasteFallback(deliveryKind: deliveryKind)
    }

    nonisolated static func targetUnavailableDeliveryStatus(
        deliveryKind: PasteDeliveryKind,
        accessibilityTrusted: Bool,
        clipboardOwnershipWasLost: Bool,
        completedTranscriptAlreadyOnClipboard: Bool,
        fallbackWriteRequested: Bool,
        fallbackWriteSucceeded: Bool
    ) -> String {
        if fallbackWriteSucceeded {
            return "Copied — Accessibility permission changed"
        }
        if completedTranscriptAlreadyOnClipboard {
            return accessibilityTrusted
                ? "Copied — target app lost focus"
                : "Copied — Accessibility permission changed"
        }
        if clipboardOwnershipWasLost {
            return "Paste cancelled because the clipboard changed"
        }
        if !accessibilityTrusted && deliveryKind == .commandRewrite {
            return "Paste cancelled because Accessibility permission changed"
        }
        if fallbackWriteRequested {
            return "Transcription ready, but the clipboard could not be updated"
        }
        return "Paste cancelled because the target app lost focus"
    }

    nonisolated static func stableAccessibilityDocumentIdentifier(_ candidate: String?) -> String? {
        guard let candidate,
              !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return candidate
    }

    nonisolated static func stableAccessibilityContextIdentifier(
        documentIdentifier: String?,
        elementIdentifier: String?
    ) -> String? {
        if let documentIdentifier = stableAccessibilityDocumentIdentifier(documentIdentifier) {
            return "document:\(documentIdentifier)"
        }
        // AXIdentifier identifies a control, not the document shown in it. Editors
        // commonly reuse one control and window across tabs, so fail closed without
        // an independently document-specific AX identity.
        _ = elementIdentifier
        return nil
    }

    enum DeliveryStatusKind: Equatable, Sendable {
        case progress
        case success
        /// The pipeline finished but delivery could not be observed. Presented like a finished
        /// run — the recording is safe and the text is on the clipboard — while the message
        /// itself says the paste is unconfirmed. Never folded into `.success`: that is the
        /// false positive this state exists to avoid.
        case unverified
        case failure
    }

    nonisolated static func flowPhase(
        forDeliveryStatus message: String,
        kind: DeliveryStatusKind
    ) -> RecordingFlowPhase {
        switch kind {
        case .progress: .processing(message)
        case .success, .unverified: .ready(message)
        case .failure: .failed(message)
        }
    }

    /// Whether an outcome leaves a blocker the owner has to act on, so its explanation must
    /// outlive the delivery status rather than being overwritten with "Ready".
    ///
    /// Written as an exhaustive switch rather than `if case`, so adding a `PasteDeliveryOutcome`
    /// forces a decision here instead of silently defaulting to invisible.
    nonisolated static func isSecureInputOutcome(_ outcome: PasteDeliveryOutcome) -> Bool {
        switch outcome {
        case .secureInputActive: true
        case .pasted, .deliveryNotObserved, .deliveredUnverified, .targetUnavailable,
             .clipboardOwnershipLost, .clipboardWriteFailed, .eventPostFailed: false
        }
    }

    /// Only observed delivery is a success. An unreadable target is its own state, and both a
    /// contradicted read-back and a refused post are failures.
    nonisolated static func deliveryStatusKind(for outcome: PasteDeliveryOutcome) -> DeliveryStatusKind {
        switch outcome {
        case .pasted: .success
        case .deliveredUnverified: .unverified
        case .deliveryNotObserved, .secureInputActive, .targetUnavailable,
             .clipboardOwnershipLost, .clipboardWriteFailed, .eventPostFailed: .failure
        }
    }

    /// Pipeline-timing stage name. `paste_posted` used to be emitted for every posted
    /// keystroke, which made the timing trace read like a delivery record; the three delivery
    /// verdicts are now distinct stages.
    nonisolated static func pasteTraceStage(for outcome: PasteDeliveryOutcome) -> String {
        switch outcome {
        case .pasted: "paste_delivery_confirmed"
        case .deliveredUnverified: "paste_delivery_unverified"
        case .deliveryNotObserved: "paste_delivery_not_observed"
        case .secureInputActive, .targetUnavailable, .clipboardOwnershipLost,
             .clipboardWriteFailed, .eventPostFailed: "paste_failed"
        }
    }

    func updateDeliveryStatus(
        _ message: String,
        kind: DeliveryStatusKind,
        pipelineGeneration: UInt64?
    ) {
        if let pipelineGeneration {
            guard pipelineDeliveryGate.shouldApplyStatus(
                deliveryGeneration: pipelineGeneration,
                currentGeneration: recordingGeneration,
                isRecording: isRecording,
                isTranscribing: isTranscribing
            ) else {
                log("delivery status suppressed for superseded pipeline generation=\(pipelineGeneration)")
                return
            }
        }
        statusMessage = message
        flowPhase = Self.flowPhase(forDeliveryStatus: message, kind: kind)
        // A delivery status that actually reaches the screen replaces whatever explanation was
        // there, so a persisted reason must not survive it — otherwise `updateStatus()`
        // resurfaces it on the next return to idle. This closes the two leaks that produce no
        // `PasteDeliveryOutcome` at all, and which clearing on `startRecording()` therefore
        // cannot reach: the "Finish the previous paste before trying again" rejection, and the
        // conversation route's "Answered".
        //
        // ORDERING: the secure-input caller must call this FIRST and re-set its reason after,
        // which it does. `macos-shortcut-contract.test.ts` asserts that order, because getting it
        // backwards silently reinstates the invisible-blocked bug with every test still green.
        setBlockedReason(nil, for: .delivery)
        setBlockedReason(nil, for: .pressConsumed)
    }

    func selectedRunningPasteTarget(
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        frontmostPid: pid_t?,
        pipelineGeneration: UInt64?
    ) -> NSRunningApplication? {
        let myPID = ProcessInfo.processInfo.processIdentifier
        let runningApps = NSWorkspace.shared.runningApplications
        let candidates = runningApps.map {
            PasteTargetCandidate(
                pid: $0.processIdentifier,
                bundleIdentifier: $0.bundleIdentifier,
                isRegularApp: $0.activationPolicy == .regular,
                launchDate: $0.launchDate
            )
        }
        let requiredProcessIdentity = pipelineGeneration.flatMap {
            pasteTargetProcessIdentityByGeneration[$0]
        }
        let selectedTarget = Self.selectPasteTarget(
            candidates: candidates,
            currentPid: myPID,
            targetBundleIdentifier: targetAppBundleIdentifier,
            targetPid: targetAppPid,
            frontmostPid: frontmostPid,
            requiredProcessIdentity: requiredProcessIdentity,
            requiresProcessIdentity: pipelineGeneration != nil && targetAppPid != nil
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
        frontmostPid: pid_t? = nil,
        requiredProcessIdentity: PasteTargetProcessIdentity? = nil,
        requiresProcessIdentity: Bool = false
    ) -> PasteTargetCandidate? {
        if let targetPid {
            guard let targetBundleIdentifier else { return nil }
            let selected = candidates.first {
                $0.pid == targetPid
                    && $0.pid != currentPid
                    && $0.bundleIdentifier == targetBundleIdentifier
            }
            guard let selected else { return nil }
            if requiresProcessIdentity {
                guard let requiredProcessIdentity,
                      requiredProcessIdentity.pid == targetPid,
                      requiredProcessIdentity.bundleIdentifier == targetBundleIdentifier,
                      requiredProcessIdentity.matches(selected) else { return nil }
            } else if let requiredProcessIdentity,
                      !requiredProcessIdentity.matches(selected) {
                return nil
            }
            return selected
        }
        if let targetBundleIdentifier {
            return candidates.first {
                $0.pid != currentPid
                    && $0.isRegularApp
                    && $0.bundleIdentifier == targetBundleIdentifier
            }
        }
        return candidates.first {
            guard let frontmostPid else { return false }
            return $0.pid == frontmostPid && $0.pid != currentPid && $0.isRegularApp
        }
    }

    nonisolated static func monotonicMilliseconds() -> UInt64 {
        UInt64(ProcessInfo.processInfo.systemUptime * 1_000)
    }

    nonisolated static func realtimePeriodicCommitIsDue(
        nowMilliseconds: UInt64,
        lastCommitMilliseconds: UInt64?
    ) -> Bool {
        guard let lastCommitMilliseconds else { return true }
        guard nowMilliseconds >= lastCommitMilliseconds else { return false }
        return nowMilliseconds - lastCommitMilliseconds >= realtimePeriodicCommitIntervalMilliseconds
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

    func log(_ message: String) {
        NativeAppLog.write(message, homePath: home)
    }
}
}
