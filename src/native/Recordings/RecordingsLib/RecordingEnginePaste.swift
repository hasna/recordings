import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
    // MARK: - Paste

    /// Copies text without pasting, preserving the previous clipboard if the write fails.
    /// Used by explicit "Copy" affordances in the UI.
    @discardableResult
    public func copyToClipboard(_ text: String) -> Bool {
        Self.writeClipboardPreservingOnFailure(text, to: .general)
    }

    public func pasteIntoFrontApp(
        _ text: String,
        targetAppBundleIdentifier: String? = nil,
        targetAppPid: pid_t? = nil,
        restoreClipboard: Bool = false
    ) {
        pasteIntoFrontApp(
            text,
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            restoreClipboard: restoreClipboard,
            deliveryKind: .manualPaste,
            pipelineTrace: nil,
            pipelineGeneration: nil,
            deliveryCompleted: nil
        )
    }

    func pasteIntoFrontApp(
        _ text: String,
        targetAppBundleIdentifier: String? = nil,
        targetAppPid: pid_t? = nil,
        restoreClipboard: Bool = false,
        deliveryKind: PasteDeliveryKind,
        selectionToken: AccessibilitySelectionToken? = nil,
        pipelineTrace: RecordingPipelineTrace?,
        pipelineGeneration: UInt64?,
        deliveryCompleted: (@MainActor @Sendable () -> Void)?
    ) {
        if let pipelineTrace { log(pipelineTrace.message(stage: "paste_requested", detail: "chars=\(text.count)")) }
        log("paste requested chars=\(text.count) target=\(targetAppBundleIdentifier ?? "nil") pid=\(targetAppPid.map(String.init) ?? "nil") accessibility=\(accessibilityTrustCheck())")
        // A paste bound to a superseded generation (a cancelled or replaced recording) is
        // abandoned before it can touch the clipboard or the target app.
        if Self.shouldAbandonDelivery(
            pipelineGeneration: pipelineGeneration,
            currentGeneration: recordingGeneration,
            isRecording: isRecording
        ) {
            log("paste abandoned for superseded recording pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
            deliveryCompleted?()
            return
        }
        if let pasteInterceptorForTesting {
            pasteInterceptorForTesting(text, deliveryKind, pipelineGeneration)
            deliveryCompleted?()
            return
        }
        let pb = NSPasteboard.general
        var previousClipboard: ClipboardSnapshot?

        let accessibility = protectedOperationTrust()
        guard accessibility.trusted else {
            let shouldCopy = Self.shouldCopyPasteFallback(deliveryKind: deliveryKind)
            let copied = shouldCopy && Self.writeClipboardPreservingOnFailure(text, to: pb)
            log("paste blocked by accessibility permission")
            let message = if deliveryKind == .commandRewrite {
                "Paste cancelled because Accessibility permission changed"
            } else if !copied {
                "Transcription ready, but the clipboard could not be updated"
            } else if accessibility.didPrompt {
                "Copied — approve Accessibility for this Recordings app"
            } else {
                "Copied — waiting for Accessibility approval"
            }
            updateDeliveryStatus(message, kind: .failure, pipelineGeneration: pipelineGeneration)
            deliveryCompleted?()
            return
        }

        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let requiredProcessIdentity = pipelineGeneration.flatMap {
            pasteTargetProcessIdentityByGeneration[$0]
        }
        let targetApp = selectedRunningPasteTarget(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            frontmostPid: frontmostPid,
            pipelineGeneration: pipelineGeneration
        )

        guard let app = targetApp else {
            let shouldCopy = Self.shouldCopyPasteFallback(deliveryKind: deliveryKind)
            let copied = shouldCopy && Self.writeClipboardPreservingOnFailure(text, to: pb)
            log("paste target app not found")
            updateDeliveryStatus(
                deliveryKind == .commandRewrite
                    ? "Paste cancelled because the target app is unavailable"
                    : copied
                        ? "Copied — no target app found"
                        : "Transcription ready, but the clipboard could not be updated",
                kind: .failure,
                pipelineGeneration: pipelineGeneration
            )
            deliveryCompleted?()
            return
        }

        // Activate the exact app that owned focus when recording started, then paste after focus settles.
        let alreadyFrontmost = app.processIdentifier == frontmostPid
        if !alreadyFrontmost {
            app.activate()
        }

        let pasteDelay: TimeInterval = alreadyFrontmost ? 0.15 : 0.5
        var ownedPasteboardChangeCount: Int?
        var clipboardWrite: PasteboardWriteResult?
        var clipboardOwnershipWasLost = false
        // Focused field of the target app as it read immediately before the keystroke. The
        // read-back after the keystroke is compared against this and against nothing else.
        var deliveryProbe: FocusedTextProbe?
        // What the read-back proved, and how many reads it took. Both stay at their initial
        // values when the paste failed before the keystroke, so the log reports "no read-back"
        // rather than borrowing a verdict from a previous paste.
        var deliveryEvidence: PasteDeliveryEvidence = .unverified(.readBackNotAttempted)
        var readBackAttempts = 0
        lastPasteSecureInputProbe = nil
        updateDeliveryStatus("Pasting...", kind: .progress, pipelineGeneration: pipelineGeneration)
        let accepted = pasteTransactionCoordinator.submit(
            text: text,
            generation: pipelineGeneration,
            delay: pasteDelay,
            settlementDelay: restoreClipboard ? 0.6 : 0,
            targetIsReady: {
                let frontmost = NSWorkspace.shared.frontmostApplication
                let appIsReady = Self.pasteTargetIsReady(
                    expectedPid: app.processIdentifier,
                    expectedBundleIdentifier: app.bundleIdentifier,
                    frontmostPid: frontmost?.processIdentifier,
                    frontmostBundleIdentifier: frontmost?.bundleIdentifier,
                    accessibilityTrusted: AXIsProcessTrusted(),
                    expectedLaunchDate: requiredProcessIdentity?.launchDate,
                    frontmostLaunchDate: frontmost?.launchDate,
                    requiresProcessIdentity: pipelineGeneration != nil && targetAppPid != nil
                )
                guard appIsReady else { return false }
                return selectionToken?.matchesCurrentSelection(for: app.processIdentifier) ?? true
            },
            payloadIsReady: {
                guard let ownedPasteboardChangeCount else { return false }
                return Self.clipboardStillOwned(
                    NSPasteboard.general,
                    text: text,
                    changeCount: ownedPasteboardChangeCount
                )
            },
            prepare: {
                if restoreClipboard {
                    previousClipboard = ClipboardSnapshot(pasteboard: .general)
                }
                // Captured before the clipboard write rather than immediately before the
                // keystroke: the readiness checks that follow re-validate focus anyway, and
                // two Accessibility round trips must not sit between the payload check and
                // the keystroke. A focus move in the gap is caught by the read-back, which
                // refuses to compare across a changed element.
                deliveryProbe = FocusedTextProbe.capture(pid: app.processIdentifier)
            },
            writeAttempted: { result in
                ownedPasteboardChangeCount = result.ownershipChangeCount
                clipboardWrite = result
            },
            verify: {
                guard let deliveryProbe else { return .unverified(.readBackNotAttempted) }
                readBackAttempts += 1
                let evidence = PasteDeliveryVerifier.classify(
                    pastedText: text,
                    baseline: deliveryProbe.baseline,
                    readBack: deliveryProbe.readBack()
                )
                deliveryEvidence = evidence
                return evidence
            },
            verificationDelay: Self.pasteReadBackInterval,
            verificationAttempts: Self.pasteReadBackAttempts
        ) { transaction, outcome in
            let accessibilityTrusted = AXIsProcessTrusted()
            // Same reason the two static predicates below switch instead of comparing: a `==`
            // test answers `false` for any outcome added later, and this feeds
            // `shouldCopyAfterPasteFailure`, which decides whether the transcript is re-copied.
            let completedTranscriptAlreadyOnClipboard = Self.outcomeLeavesTranscriptOnClipboard(outcome)
                && !restoreClipboard
                && (ownedPasteboardChangeCount.map {
                    Self.clipboardStillOwned(.general, text: transaction.text, changeCount: $0)
                } ?? false)
            let shouldCopyAfterFailure = Self.shouldCopyAfterPasteFailure(
                outcome: outcome,
                deliveryKind: deliveryKind,
                accessibilityTrusted: accessibilityTrusted,
                clipboardOwnershipWasLost: clipboardOwnershipWasLost,
                completedTranscriptAlreadyOnClipboard: completedTranscriptAlreadyOnClipboard
            )
            let copiedAfterFailure = shouldCopyAfterFailure
                && Self.writeClipboardPreservingOnFailure(transaction.text, to: .general)
            self.log("paste outcome=\(outcome) target=\(app.bundleIdentifier ?? "?") alreadyFrontmost=\(alreadyFrontmost) transaction=\(transaction.id)")
            // The line to read when asking "did the text land?". Every step reports itself, so
            // a posted keystroke can no longer stand in for delivery.
            self.log(PasteDeliveryReport(
                targetBundleIdentifier: app.bundleIdentifier,
                characterCount: transaction.text.count,
                clipboardWriteVerified: clipboardWrite?.verified ?? false,
                clipboardChangeCountAdvanced: clipboardWrite?.changeCountAdvanced ?? false,
                attempt: .forOutcome(outcome),
                secureInput: self.lastPasteSecureInputProbe,
                evidence: deliveryEvidence,
                readBackAttempts: readBackAttempts
            ).logLine)
            if let pipelineTrace {
                self.log(pipelineTrace.message(
                    stage: Self.pasteTraceStage(for: outcome),
                    detail: "chars=\(transaction.text.count)"
                ))
            }
            deliveryCompleted?()
            let message = switch outcome {
            case .pasted: "Pasted (\(transaction.text.count) chars)"
            case .deliveryNotObserved: restoreClipboard
                ? "Paste did not reach the target app"
                : "Paste did not reach the target app — text kept on the clipboard"
            case .deliveredUnverified: restoreClipboard
                ? "Paste sent, delivery unconfirmed"
                : "Paste sent, delivery unconfirmed — text kept on the clipboard"
            // One message either way, because the clipboard is kept either way — see the
            // `shouldRestore` switch in `settlement`. Telling the owner to press Cmd-V is only
            // honest if the transcript is still there, so this branch may not depend on
            // `restoreClipboard`. When restore WAS requested, say that it was overridden
            // rather than letting the owner discover it.
            case .secureInputActive: restoreClipboard
                ? "This field blocks typing (secure input) — transcript kept on the clipboard "
                    + "instead of restoring it, press Cmd-V"
                : "This field blocks typing (secure input) — transcript copied, press Cmd-V"
            case .targetUnavailable: Self.targetUnavailableDeliveryStatus(
                deliveryKind: deliveryKind,
                accessibilityTrusted: accessibilityTrusted,
                clipboardOwnershipWasLost: clipboardOwnershipWasLost,
                completedTranscriptAlreadyOnClipboard: completedTranscriptAlreadyOnClipboard,
                fallbackWriteRequested: shouldCopyAfterFailure,
                fallbackWriteSucceeded: copiedAfterFailure
            )
            case .clipboardOwnershipLost: "Paste cancelled because the clipboard changed"
            case .clipboardWriteFailed: "Paste failed because the clipboard could not be updated"
            case .eventPostFailed: restoreClipboard
                ? "Paste failed because the paste event could not be posted"
                : "Copied, but paste event could not be posted"
            }
            // `updateDeliveryStatus` writes `statusMessage`, and `updateStatus()` rewrites it to
            // "Ready" on the next return to idle. A transient success line can afford that;
            // "press Cmd-V" cannot, because it is the only thing telling the owner their
            // transcript is recoverable. So the secure-input reason is persisted through the
            // one field every surface reads.
            //
            // ONLY this outcome persists, deliberately. `.deliveryNotObserved` also leaves the
            // transcript on the clipboard, but it has a documented false negative — pasting text
            // identical to the selection it replaces reads as "unchanged" — so persisting it
            // would raise a standing warning over a paste that worked. `.deliveredUnverified`
            // means "could not tell", and a standing blocked banner would over-claim it. Secure
            // input has no such path: it is measured from the window-session dictionary, and an
            // uninterrogable session yields `.unknown`, which never reaches here.
            // AFTER `updateDeliveryStatus`, not before: that call clears the delivery reason so
            // statuses which produce no outcome cannot leave a stale one behind, and this is the
            // one caller whose reason has to outlive its own status line.
            self.updateDeliveryStatus(
                message,
                kind: Self.deliveryStatusKind(for: outcome),
                pipelineGeneration: transaction.generation
            )
            // Stamped with the delivery's OWN generation, not the engine's current one: this
            // closure can run after `recordingGeneration` has advanced, and binding to the
            // current value would mark a superseded reason fresh. `updateStatus()` expires it.
            self.setBlockedReason(
                Self.isSecureInputOutcome(outcome) ? message : nil,
                for: .delivery,
                generation: transaction.generation
            )
        } settlement: { transaction, outcome in
            let pasteboard = NSPasteboard.general
            let stillOwnsChangeCount = ownedPasteboardChangeCount.map {
                pasteboard.changeCount == $0
            } ?? false
            let stillOwnsPayload = ownedPasteboardChangeCount.map {
                Self.clipboardStillOwned(pasteboard, text: transaction.text, changeCount: $0)
            } ?? false
            if Self.clipboardOwnershipWasLostAfterPasteFailure(
                outcome: outcome,
                hasOwnershipToken: ownedPasteboardChangeCount != nil,
                stillOwnsPayload: stillOwnsPayload
            ) {
                clipboardOwnershipWasLost = true
            }
            guard let previousClipboard else { return }
            let shouldRestore = switch outcome {
            case .clipboardWriteFailed:
                stillOwnsChangeCount
            // Never restore over secure input, even when `restoreClipboard` was requested.
            // By the time this outcome is reachable the payload writer has already run, so the
            // transcript IS the clipboard — and the status line has just told the owner to press
            // Cmd-V. Restoring would delete the exact text the app told them to paste. This
            // deliberately overrides an explicit opt-in, which is why the status message for
            // this outcome says the clipboard was kept instead of restored.
            case .secureInputActive:
                false
            case .targetUnavailable, .clipboardOwnershipLost, .eventPostFailed, .pasted,
                 .deliveryNotObserved, .deliveredUnverified:
                stillOwnsPayload
            }
            if shouldRestore {
                previousClipboard.restore(to: pasteboard)
            }
        }
        guard accepted else {
            log("paste transaction rejected because another delivery is pending")
            updateDeliveryStatus(
                "Finish the previous paste before trying again",
                kind: .failure,
                pipelineGeneration: pipelineGeneration
            )
            deliveryCompleted?()
            return
        }
    }

    /// Whether an outcome ends with the transcript still sitting on the clipboard because the
    /// paste never consumed it — so re-copying it would be redundant.
    ///
    /// Exhaustive on purpose. `.secureInputActive` answers `false` here even though it *does*
    /// leave the transcript on the clipboard: it gets there because `shouldRestore` refuses to
    /// restore, not because the paste was abandoned before the clipboard was written, and
    /// `shouldCopyAfterPasteFailure` is additionally gated on `!accessibilityTrusted`, which is
    /// never the path secure input takes.
}
