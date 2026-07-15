import AppKit
import Testing
@testable import RecordingsLib

struct PasteTargetTests {
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

    @Test("command paste precondition failures preserve the current clipboard")
    func commandPasteFailureDoesNotCopyFallback() {
        #expect(!RecordingEngine.shouldCopyPasteFallback(restoreClipboard: true))
        #expect(RecordingEngine.shouldCopyPasteFallback(restoreClipboard: false))
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
}
