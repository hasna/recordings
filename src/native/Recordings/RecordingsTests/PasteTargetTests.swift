import AppKit
import Testing
@testable import RecordingsLib

struct PasteTargetTests {
    @Test("selection is frozen when recording starts, not after transcription")
    func selectionCapturePolicy() {
        #expect(RecordingEngine.shouldCaptureSelection(
            targetPid: 42,
            accessibilityTrusted: true,
            intentDetectionEnabled: true
        ))
        #expect(!RecordingEngine.shouldCaptureSelection(
            targetPid: nil,
            accessibilityTrusted: true,
            intentDetectionEnabled: true
        ))
        #expect(!RecordingEngine.shouldCaptureSelection(
            targetPid: 42,
            accessibilityTrusted: false,
            intentDetectionEnabled: true
        ))
        #expect(!RecordingEngine.shouldCaptureSelection(
            targetPid: 42,
            accessibilityTrusted: true,
            intentDetectionEnabled: false
        ))
    }

    @Test("serialized paste transactions write their own payload immediately before one post")
    @MainActor
    func serializedPasteTransactionsKeepPayloadsIsolated() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var pasteboardText = "original"
        var postedPayloads: [String] = []
        var completions: [(UInt64?, PasteDeliveryOutcome)] = []
        var preparations = 0
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { text in
                pasteboardText = text
                return PasteboardWriteResult(
                    verified: pasteboardText == text,
                    ownershipChangeCount: 1
                )
            },
            postPaste: {
                postedPayloads.append(pasteboardText)
                return true
            }
        )

        #expect(coordinator.submit(
            text: "recording A",
            generation: 41,
            delay: 0.5,
            settlementDelay: 0.6,
            prepare: { preparations += 1 }
        ) { transaction, outcome in
            completions.append((transaction.generation, outcome))
        })
        pasteboardText = "unrelated clipboard mutation"
        #expect(!coordinator.submit(text: "recording B", generation: 42, delay: 0.15) { _, _ in })
        #expect(coordinator.hasPendingTransaction)
        #expect(scheduled.count == 1)

        let scheduledA = scheduled.removeFirst()
        scheduledA()
        scheduledA()
        #expect(postedPayloads == ["recording A"])
        #expect(preparations == 1)
        #expect(completions.count == 1)
        #expect(completions.first?.0 == 41)
        #expect(completions.first?.1 == .pasted)
        #expect(coordinator.hasPendingTransaction)
        #expect(!coordinator.submit(text: "recording B", generation: 42, delay: 0) { _, _ in })

        scheduled.removeFirst()()
        #expect(!coordinator.hasPendingTransaction)

        #expect(coordinator.submit(text: "recording B", generation: 42, delay: 0) { transaction, outcome in
            completions.append((transaction.generation, outcome))
        })
        pasteboardText = "another mutation"
        scheduled.removeFirst()()
        #expect(postedPayloads == ["recording A", "recording B"])
        #expect(completions.map(\.0) == [41, 42])
        #expect(completions.map(\.1) == [.pasted, .pasted])
    }

    @Test("every idle transition — submit, failure, and delayed settlement — announces itself")
    @MainActor
    func pendingTransitionsAreObservable() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var announcements = 0
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in PasteboardWriteResult(verified: true, ownershipChangeCount: 1) },
            postPaste: { true }
        )
        coordinator.pendingTransactionWillChange = { announcements += 1 }

        #expect(coordinator.submit(text: "A", generation: 1, delay: 0.5, settlementDelay: 0.6) { _, _ in })
        #expect(announcements == 1, "entering the pending state must announce")

        scheduled.removeFirst()()
        #expect(announcements == 1, "scheduled → settling keeps hasPendingTransaction true — no announcement")
        #expect(coordinator.hasPendingTransaction)

        scheduled.removeFirst()()
        #expect(announcements == 2, "delayed settlement back to idle must announce — the menu bar recomputes from it")
        #expect(!coordinator.hasPendingTransaction)

        // A failing transaction announces its return to idle from the completion turn.
        let failing = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in PasteboardWriteResult(verified: false, ownershipChangeCount: 1) },
            postPaste: { false }
        )
        var failureAnnouncements = 0
        failing.pendingTransactionWillChange = { failureAnnouncements += 1 }
        #expect(failing.submit(text: "B", generation: 2, delay: 0) { _, _ in })
        scheduled.removeFirst()()
        #expect(failureAnnouncements == 2)
        #expect(!failing.hasPendingTransaction)
    }

    @Test("paste failures complete once with exact write and post outcomes")
    @MainActor
    func pasteFailureOutcomesAreExact() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var postCalls = 0
        var outcomes: [PasteDeliveryOutcome] = []
        var settlements: [PasteDeliveryOutcome] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in PasteboardWriteResult(verified: false, ownershipChangeCount: 1) },
            postPaste: {
                postCalls += 1
                return false
            }
        )

        #expect(coordinator.submit(text: "A", generation: 1, delay: 0) { _, outcome in
            outcomes.append(outcome)
        } settlement: { _, outcome in
            settlements.append(outcome)
        })
        let writeFailure = scheduled.removeFirst()
        writeFailure()
        writeFailure()
        #expect(outcomes == [.clipboardWriteFailed])
        #expect(settlements == [.clipboardWriteFailed])
        #expect(postCalls == 0)
        #expect(!coordinator.hasPendingTransaction)

        let postFailureCoordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in PasteboardWriteResult(verified: true, ownershipChangeCount: 1) },
            postPaste: {
                postCalls += 1
                return false
            }
        )
        #expect(postFailureCoordinator.submit(text: "B", generation: 2, delay: 0) { _, outcome in
            outcomes.append(outcome)
        } settlement: { _, outcome in
            settlements.append(outcome)
        })
        let postFailure = scheduled.removeFirst()
        postFailure()
        postFailure()
        #expect(outcomes == [.clipboardWriteFailed, .eventPostFailed])
        #expect(settlements == [.clipboardWriteFailed, .eventPostFailed])
        #expect(postCalls == 1)
        #expect(!postFailureCoordinator.hasPendingTransaction)
    }

    @Test("paste target is revalidated immediately before clipboard write and event post")
    @MainActor
    func lostPasteTargetCancelsTransactionExactlyOnce() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var writeCalls = 0
        var postCalls = 0
        var completions: [PasteDeliveryOutcome] = []
        var settlements: [PasteDeliveryOutcome] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                writeCalls += 1
                return PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: {
                postCalls += 1
                return true
            }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0.5,
            targetIsReady: { false }
        ) { _, outcome in
            completions.append(outcome)
        } settlement: { _, outcome in
            settlements.append(outcome)
        })
        let operation = scheduled.removeFirst()
        operation()
        operation()

        #expect(writeCalls == 0)
        #expect(postCalls == 0)
        #expect(completions == [.targetUnavailable])
        #expect(settlements == [.targetUnavailable])
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("paste target is revalidated after snapshot preparation immediately before write")
    @MainActor
    func targetLostDuringPreparationNeverWrites() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var targetIsReady = true
        var writeCalls = 0
        var completions: [PasteDeliveryOutcome] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                writeCalls += 1
                return PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0,
            targetIsReady: { targetIsReady },
            prepare: { targetIsReady = false }
        ) { _, outcome in
            completions.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(writeCalls == 0)
        #expect(completions == [.targetUnavailable])
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("paste target is revalidated again after clipboard write before event post")
    @MainActor
    func targetLostDuringClipboardWriteNeverPosts() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var targetIsReady = true
        var postCalls = 0
        var completions: [PasteDeliveryOutcome] = []
        var settlements: [PasteDeliveryOutcome] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                targetIsReady = false
                return PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: {
                postCalls += 1
                return true
            }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0.5,
            targetIsReady: { targetIsReady }
        ) { _, outcome in
            completions.append(outcome)
        } settlement: { _, outcome in
            settlements.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(postCalls == 0)
        #expect(completions == [.targetUnavailable])
        #expect(settlements == [.targetUnavailable])
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("clipboard payload ownership is revalidated immediately before event post")
    @MainActor
    func payloadLostAfterWriteNeverPosts() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var payloadIsReady = true
        var postCalls = 0
        var completions: [PasteDeliveryOutcome] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                payloadIsReady = false
                return PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: {
                postCalls += 1
                return true
            }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0,
            payloadIsReady: { payloadIsReady }
        ) { _, outcome in
            completions.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(postCalls == 0)
        #expect(completions == [.clipboardOwnershipLost])
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("command selection uses exact AX text only while the captured target remains frontmost")
    func commandSelectionRequiresFocusedAccessibilityText() {
        #expect(RecordingEngine.validAccessibilitySelection(
            nil,
            targetStillFrontmost: true
        ) == nil)
        #expect(RecordingEngine.validAccessibilitySelection(
            " \n\t ",
            targetStillFrontmost: true
        ) == nil)
        #expect(RecordingEngine.validAccessibilitySelection(
            "fresh selection",
            targetStillFrontmost: false
        ) == nil)
        #expect(RecordingEngine.validAccessibilitySelection(
            " fresh\nselection\t ",
            targetStillFrontmost: true
        ) == " fresh\nselection\t ")
    }

    @Test("command rewrite rejects a different focused field in the same app")
    func commandSelectionRejectsDifferentFocusedElement() {
        let captured = AccessibilitySelectionIdentity(
            element: "field-a",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        )

        #expect(!captured.matches(
            element: "field-b",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        ))
    }

    @Test("command rewrite rejects a changed selection in the same focused field")
    func commandSelectionRejectsChangedRangeOrText() {
        let captured = AccessibilitySelectionIdentity(
            element: "field-a",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        )

        #expect(!captured.matches(
            element: "field-a",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 5,
            rangeLength: 7,
            selectedText: "rewrite"
        ))
        #expect(!captured.matches(
            element: "field-a",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "changed"
        ))
        #expect(captured.matches(
            element: "field-a",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        ))
    }

    @Test("command rewrite rejects a changed window or document in the same focused field")
    func commandSelectionRejectsChangedDocumentContext() {
        let captured = AccessibilitySelectionIdentity(
            element: "shared-editor",
            window: "window-a",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        )

        #expect(!captured.matches(
            element: "shared-editor",
            window: "window-b",
            documentIdentifier: "file:///document-a",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        ))
        #expect(!captured.matches(
            element: "shared-editor",
            window: "window-a",
            documentIdentifier: "file:///document-b",
            rangeLocation: 4,
            rangeLength: 7,
            selectedText: "rewrite"
        ))
    }

    @Test("command selection requires a stable AX document identity")
    func commandSelectionRejectsMissingDocumentIdentity() {
        #expect(RecordingEngine.stableAccessibilityDocumentIdentifier(nil) == nil)
        #expect(RecordingEngine.stableAccessibilityDocumentIdentifier(" \n ") == nil)
        #expect(RecordingEngine.stableAccessibilityDocumentIdentifier(
            "file:///document-a"
        ) == "file:///document-a")
    }

    @Test("documentless command selection fails closed even with a stable AX control identifier")
    func commandSelectionRejectsControlIdentifierWithoutDocumentIdentity() {
        #expect(RecordingEngine.stableAccessibilityContextIdentifier(
            documentIdentifier: nil,
            elementIdentifier: "editor-field"
        ) == nil)
        #expect(RecordingEngine.stableAccessibilityContextIdentifier(
            documentIdentifier: "file:///document-a",
            elementIdentifier: "editor-field"
        ) == "document:file:///document-a")
        #expect(RecordingEngine.stableAccessibilityContextIdentifier(
            documentIdentifier: nil,
            elementIdentifier: " \n "
        ) == nil)
    }

    @Test("paste readiness requires the exact frontmost pid and current Accessibility trust")
    func pasteReadinessIncludesAccessibility() {
        #expect(RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.editor",
            accessibilityTrusted: true
        ))
        #expect(!RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 30,
            frontmostBundleIdentifier: "com.editor",
            accessibilityTrusted: true
        ))
        #expect(!RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.editor",
            accessibilityTrusted: false
        ))
        #expect(!RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.editor",
            accessibilityTrusted: true,
            expectedLaunchDate: Date(timeIntervalSince1970: 1_000),
            frontmostLaunchDate: Date(timeIntervalSince1970: 2_000),
            requiresProcessIdentity: true
        ))
        #expect(RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.editor",
            accessibilityTrusted: true,
            expectedLaunchDate: Date(timeIntervalSince1970: 1_000),
            frontmostLaunchDate: Date(timeIntervalSince1970: 1_000),
            requiresProcessIdentity: true
        ))
        #expect(!RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: "com.editor",
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.other",
            accessibilityTrusted: true
        ))
        #expect(!RecordingEngine.pasteTargetIsReady(
            expectedPid: 20,
            expectedBundleIdentifier: nil,
            frontmostPid: 20,
            frontmostBundleIdentifier: "com.other",
            accessibilityTrusted: true
        ))
    }

    @Test("Accessibility denial preserves dictation but command rewrite remains fail-closed")
    func accessibilityDeniedDeliveryPolicyDistinguishesDictationFromCommand() {
        #expect(RecordingEngine.shouldCopyPasteFallback(deliveryKind: .ordinaryDictation))
        #expect(RecordingEngine.shouldCopyPasteFallback(deliveryKind: .manualPaste))
        #expect(!RecordingEngine.shouldCopyPasteFallback(deliveryKind: .commandRewrite))
        #expect(RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .targetUnavailable,
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: false
        ))
        #expect(!RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .targetUnavailable,
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: true
        ))
        #expect(!RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .targetUnavailable,
            deliveryKind: .commandRewrite,
            accessibilityTrusted: false
        ))
        #expect(!RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .clipboardOwnershipLost,
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: false
        ))
        #expect(!RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .targetUnavailable,
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: false,
            clipboardOwnershipWasLost: true
        ))
        #expect(!RecordingEngine.shouldCopyAfterPasteFailure(
            outcome: .targetUnavailable,
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: false,
            completedTranscriptAlreadyOnClipboard: true
        ))
        #expect(RecordingEngine.targetUnavailableDeliveryStatus(
            deliveryKind: .manualPaste,
            accessibilityTrusted: true,
            clipboardOwnershipWasLost: false,
            completedTranscriptAlreadyOnClipboard: true,
            fallbackWriteRequested: false,
            fallbackWriteSucceeded: false
        ) == "Copied — target app lost focus")
        #expect(RecordingEngine.targetUnavailableDeliveryStatus(
            deliveryKind: .commandRewrite,
            accessibilityTrusted: false,
            clipboardOwnershipWasLost: false,
            completedTranscriptAlreadyOnClipboard: false,
            fallbackWriteRequested: false,
            fallbackWriteSucceeded: false
        ) == "Paste cancelled because Accessibility permission changed")
        #expect(RecordingEngine.targetUnavailableDeliveryStatus(
            deliveryKind: .ordinaryDictation,
            accessibilityTrusted: false,
            clipboardOwnershipWasLost: true,
            completedTranscriptAlreadyOnClipboard: false,
            fallbackWriteRequested: false,
            fallbackWriteSucceeded: false
        ) == "Paste cancelled because the clipboard changed")
    }

    @Test("manual paste records lost clipboard ownership before delayed Accessibility fallback")
    @MainActor
    func manualPasteDoesNotOverwriteNewClipboardOwnerAfterAccessibilityLoss() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var targetChecks = 0
        var clipboardOwnershipWasLost = false
        var fallbackCopied = false
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "completed dictation",
            generation: 1,
            delay: 0,
            targetIsReady: {
                targetChecks += 1
                return targetChecks < 3
            }
        ) { _, outcome in
            fallbackCopied = RecordingEngine.shouldCopyAfterPasteFailure(
                outcome: outcome,
                deliveryKind: .manualPaste,
                accessibilityTrusted: false,
                clipboardOwnershipWasLost: clipboardOwnershipWasLost
            )
        } settlement: { _, outcome in
            clipboardOwnershipWasLost = RecordingEngine.clipboardOwnershipWasLostAfterPasteFailure(
                outcome: outcome,
                hasOwnershipToken: true,
                stillOwnsPayload: false
            )
        })

        scheduled.removeFirst()()

        #expect(clipboardOwnershipWasLost)
        #expect(!fallbackCopied)
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("manual paste keeps its owned transcript without rewriting the clipboard")
    @MainActor
    func manualPasteDoesNotRewriteOwnedTranscriptAfterAccessibilityLoss() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var targetChecks = 0
        var completedTranscriptAlreadyOnClipboard = false
        var fallbackWriteRequested = true
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { _ in
                PasteboardWriteResult(verified: true, ownershipChangeCount: 1)
            },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "completed dictation",
            generation: 1,
            delay: 0,
            targetIsReady: {
                targetChecks += 1
                return targetChecks < 3
            }
        ) { _, outcome in
            fallbackWriteRequested = RecordingEngine.shouldCopyAfterPasteFailure(
                outcome: outcome,
                deliveryKind: .manualPaste,
                accessibilityTrusted: false,
                completedTranscriptAlreadyOnClipboard: completedTranscriptAlreadyOnClipboard
            )
        } settlement: { _, outcome in
            completedTranscriptAlreadyOnClipboard = outcome == .targetUnavailable
        })

        scheduled.removeFirst()()

        #expect(completedTranscriptAlreadyOnClipboard)
        #expect(!fallbackWriteRequested)
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("ordinary dictation fallback leaves the completed transcript on the clipboard")
    func dictationFallbackCopiesCompletedTranscript() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-dictation-fallback-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("previous value", forType: .string)

        #expect(RecordingEngine.writeClipboardPreservingOnFailure(
            "completed dictation",
            to: pasteboard
        ))
        #expect(pasteboard.string(forType: .string) == "completed dictation")
    }

    @Test("named pasteboard runtime preserves A/B payload isolation")
    @MainActor
    func namedPasteboardRuntimeProbe() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-paste-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var postedPayloads: [String] = []
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { text in RecordingEngine.writeClipboardAttempt(text, to: pasteboard) },
            postPaste: {
                guard let payload = pasteboard.string(forType: .string) else { return false }
                postedPayloads.append(payload)
                return true
            }
        )

        #expect(coordinator.submit(text: "A", generation: 1, delay: 0.5) { _, _ in })
        pasteboard.clearContents()
        pasteboard.setString("external", forType: .string)
        scheduled.removeFirst()()
        #expect(coordinator.submit(text: "B", generation: 2, delay: 0.15) { _, _ in })
        pasteboard.clearContents()
        pasteboard.setString("external again", forType: .string)
        scheduled.removeFirst()()

        #expect(postedPayloads == ["A", "B"])
    }

    @Test("named pasteboard restoration does not overwrite a same-text newer owner")
    @MainActor
    func namedPasteboardChangeCountPreventsABARestore() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-paste-aba-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("original", forType: .string)

        var scheduled: [@MainActor @Sendable () -> Void] = []
        var ownedChangeCount: Int?
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { text in RecordingEngine.writeClipboardAttempt(text, to: pasteboard) },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0,
            settlementDelay: 0.6,
            writeAttempted: { ownedChangeCount = $0.ownershipChangeCount }
        ) { _, _ in
        } settlement: { transaction, outcome in
            guard outcome == .pasted,
                  pasteboard.changeCount == ownedChangeCount,
                  pasteboard.string(forType: .string) == transaction.text else { return }
            pasteboard.clearContents()
            pasteboard.setString("original", forType: .string)
        })
        scheduled.removeFirst()()

        pasteboard.clearContents()
        pasteboard.setString("A", forType: .string)
        let externalChangeCount = pasteboard.changeCount
        scheduled.removeFirst()()

        #expect(pasteboard.string(forType: .string) == "A")
        #expect(pasteboard.changeCount == externalChangeCount)
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("failed write restoration does not overwrite a newer clipboard owner")
    @MainActor
    func failedWriteRestoresOnlyWhileOwningChangeCount() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-write-failure-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("original", forType: .string)

        var scheduled: [@MainActor @Sendable () -> Void] = []
        var attemptedChangeCount: Int?
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { text in
                let attempted = RecordingEngine.writeClipboardAttempt(text, to: pasteboard)
                pasteboard.clearContents()
                pasteboard.setString("new external value", forType: .string)
                return PasteboardWriteResult(
                    verified: false,
                    ownershipChangeCount: attempted.ownershipChangeCount
                )
            },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "A",
            generation: 1,
            delay: 0,
            writeAttempted: { attemptedChangeCount = $0.ownershipChangeCount }
        ) { _, _ in
        } settlement: { _, outcome in
            guard outcome == .clipboardWriteFailed,
                  pasteboard.changeCount == attemptedChangeCount else { return }
            pasteboard.clearContents()
            pasteboard.setString("original", forType: .string)
        })
        scheduled.removeFirst()()

        #expect(pasteboard.string(forType: .string) == "new external value")
    }

    @Test("separate command copy and paste transactions preserve a newer clipboard owner")
    @MainActor
    func commandRewriteDelayPreservesNewClipboardOwner() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-command-copy-paste-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("original", forType: .string)

        pasteboard.clearContents()
        pasteboard.setString("selected text", forType: .string)
        let selectionChangeCount = pasteboard.changeCount
        #expect(RecordingEngine.clipboardStillOwned(
            pasteboard,
            text: "selected text",
            changeCount: selectionChangeCount
        ))
        pasteboard.clearContents()
        pasteboard.setString("original", forType: .string)

        // A separate owner updates the clipboard while the helper rewrites in memory.
        pasteboard.clearContents()
        pasteboard.setString("new external value", forType: .string)
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var prePasteValue: String?
        var ownedChangeCount: Int?
        let coordinator = PasteTransactionCoordinator(
            schedule: { _, operation in scheduled.append(operation) },
            writeAndVerify: { text in RecordingEngine.writeClipboardAttempt(text, to: pasteboard) },
            postPaste: { true }
        )

        #expect(coordinator.submit(
            text: "rewritten text",
            generation: 1,
            delay: 0,
            settlementDelay: 0.6,
            prepare: { prePasteValue = pasteboard.string(forType: .string) },
            writeAttempted: { ownedChangeCount = $0.ownershipChangeCount }
        ) { _, _ in
        } settlement: { transaction, outcome in
            guard outcome == .pasted,
                  let ownedChangeCount,
                  RecordingEngine.clipboardStillOwned(
                    pasteboard,
                    text: transaction.text,
                    changeCount: ownedChangeCount
                  ) else { return }
            pasteboard.clearContents()
            pasteboard.setString(prePasteValue ?? "", forType: .string)
        })
        scheduled.removeFirst()()
        scheduled.removeFirst()()

        #expect(pasteboard.string(forType: .string) == "new external value")
    }

    @Test("same-text clipboard mutation loses ownership by change count")
    @MainActor
    func sameTextMutationLosesClipboardOwnership() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-copy-owner-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("marker", forType: .string)
        let ownedChangeCount = pasteboard.changeCount
        #expect(RecordingEngine.clipboardStillOwned(
            pasteboard,
            text: "marker",
            changeCount: ownedChangeCount
        ))

        pasteboard.clearContents()
        pasteboard.setString("marker", forType: .string)
        #expect(!RecordingEngine.clipboardStillOwned(
            pasteboard,
            text: "marker",
            changeCount: ownedChangeCount
        ))
    }

    @Test("paste target prefers captured process id over bundle fallback")
    func prefersCapturedPid() {
        let candidates = [
            PasteTargetCandidate(pid: 10, bundleIdentifier: "com.editor", isRegularApp: true),
            PasteTargetCandidate(pid: 20, bundleIdentifier: "com.editor", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20
        )

        #expect(selected?.pid == 20)
    }

    @Test("paste target does not choose arbitrary apps without a captured or frontmost target")
    func noArbitraryFallback() {
        let candidates = [
            PasteTargetCandidate(pid: 99, bundleIdentifier: "com.hasna.recordings", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil
        )

        #expect(selected == nil)
    }

    @Test("paste target prefers the frontmost app over an arbitrary regular app")
    func prefersFrontmostFallback() {
        let candidates = [
            PasteTargetCandidate(pid: 5, bundleIdentifier: "com.background", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil,
            frontmostPid: 30
        )

        #expect(selected?.pid == 30)
    }

    @Test("paste target never selects the recorder app even when frontmost")
    func skipsOwnAppWhenFrontmost() {
        let candidates = [
            PasteTargetCandidate(pid: 99, bundleIdentifier: "com.hasna.recordings", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: nil,
            frontmostPid: 99
        )

        #expect(selected == nil)
    }

    @Test("captured pid wins over frontmost fallback")
    func capturedPidBeatsFrontmost() {
        let candidates = [
            PasteTargetCandidate(pid: 10, bundleIdentifier: "com.editor", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 10,
            frontmostPid: 30
        )

        #expect(selected?.pid == 10)
    }

    @Test("missing captured pid never falls back to another app or same-bundle process")
    func missingCapturedPidHasNoFallback() {
        let candidates = [
            PasteTargetCandidate(pid: 10, bundleIdentifier: "com.editor", isRegularApp: true),
            PasteTargetCandidate(pid: 30, bundleIdentifier: "com.notes", isRegularApp: true),
        ]

        let selected = RecordingEngine.selectPasteTarget(
            candidates: candidates,
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20,
            frontmostPid: 30
        )

        #expect(selected == nil)
    }

    @Test("reused captured pid with a different bundle is rejected")
    func reusedCapturedPidRequiresBundleIdentity() {
        let selected = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(pid: 20, bundleIdentifier: "com.other", isRegularApp: true),
            ],
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20,
            frontmostPid: 20
        )

        #expect(selected == nil)

        let nilBundleCapture = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(pid: 20, bundleIdentifier: "com.other", isRegularApp: true),
            ],
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: 20,
            frontmostPid: 20
        )
        #expect(nilBundleCapture == nil)
    }

    @Test("captured pid with no bundle identity is rejected instead of trusting pid reuse")
    func nilBundleCaptureFailsClosed() {
        let selected = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(pid: 20, bundleIdentifier: nil, isRegularApp: true),
            ],
            currentPid: 99,
            targetBundleIdentifier: nil,
            targetPid: 20,
            frontmostPid: 20
        )

        #expect(selected == nil)
    }

    @Test("same-bundle PID reuse with a different process launch identity is rejected")
    func reusedCapturedPidRequiresProcessBirthIdentity() {
        let capturedLaunchDate = Date(timeIntervalSince1970: 1_000)
        let replacementLaunchDate = Date(timeIntervalSince1970: 2_000)
        let capturedIdentity = PasteTargetProcessIdentity(
            pid: 20,
            bundleIdentifier: "com.editor",
            launchDate: capturedLaunchDate
        )

        let rejected = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(
                    pid: 20,
                    bundleIdentifier: "com.editor",
                    isRegularApp: true,
                    launchDate: replacementLaunchDate
                ),
            ],
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20,
            frontmostPid: 20,
            requiredProcessIdentity: capturedIdentity,
            requiresProcessIdentity: true
        )
        let accepted = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(
                    pid: 20,
                    bundleIdentifier: "com.editor",
                    isRegularApp: true,
                    launchDate: capturedLaunchDate
                ),
            ],
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20,
            frontmostPid: 20,
            requiredProcessIdentity: capturedIdentity,
            requiresProcessIdentity: true
        )
        let missingIdentity = RecordingEngine.selectPasteTarget(
            candidates: [
                PasteTargetCandidate(
                    pid: 20,
                    bundleIdentifier: "com.editor",
                    isRegularApp: true,
                    launchDate: capturedLaunchDate
                ),
            ],
            currentPid: 99,
            targetBundleIdentifier: "com.editor",
            targetPid: 20,
            frontmostPid: 20,
            requiresProcessIdentity: true
        )

        #expect(rejected == nil)
        #expect(accepted?.pid == 20)
        #expect(missingIdentity == nil)
    }
}
