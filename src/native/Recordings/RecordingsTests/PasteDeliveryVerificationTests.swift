import AppKit
import Testing
@testable import RecordingsLib

/// The defect these tests exist for: `CGEvent.post` returns `Void`, so the paste path used to
/// report success as soon as two key events had been *constructed*. Every log line and status
/// message that said "pasted" was therefore unfalsifiable — it said the same thing whether the
/// text landed in the focused field, went to another app, or went nowhere at all.
@MainActor
struct PasteDeliveryHonestyTests {
    private func makeCoordinator(
        scheduled: @escaping @MainActor @Sendable (@escaping @MainActor @Sendable () -> Void) -> Void,
        postPaste: @escaping PasteTransactionCoordinator.PastePoster
    ) -> PasteTransactionCoordinator {
        PasteTransactionCoordinator(
            schedule: { _, operation in scheduled(operation) },
            writeAndVerify: { _ in PasteboardWriteResult(verified: true, ownershipChangeCount: 1) },
            postPaste: postPaste
        )
    }

    @Test("a posted keystroke with no read-back never completes as pasted")
    func postedWithoutEvidenceIsNotPasted() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var posts = 0
        var outcomes: [PasteDeliveryOutcome] = []
        let coordinator = makeCoordinator(
            scheduled: { scheduled.append($0) },
            postPaste: {
                posts += 1
                return .posted
            }
        )

        // No `verify:` — exactly the situation the old code was in, where posting *was* the
        // success condition.
        #expect(coordinator.submit(text: "hello", generation: 1, delay: 0) { _, outcome in
            outcomes.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(posts == 1)
        #expect(outcomes == [.deliveredUnverified(.readBackNotAttempted)])
        #expect(outcomes.first != .pasted, "constructing and posting a CGEvent is not delivery")
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("only confirming read-back evidence can produce the pasted outcome")
    func onlyConfirmedEvidenceMapsToPasted() {
        #expect(PasteDeliveryOutcome.forDeliveryEvidence(.confirmedByFocusedValue) == .pasted)
        #expect(PasteDeliveryOutcome.forDeliveryEvidence(.confirmedBySelectedText) == .pasted)
        #expect(
            PasteDeliveryOutcome.forDeliveryEvidence(.notObservedFocusedValueUnchanged)
                == .deliveryNotObserved
        )
        for reason: PasteDeliveryUnverifiedReason in [
            .readBackNotAttempted,
            .emptyPayload,
            .baselineUnreadable(.elementUnavailable),
            .baselineUnreadable(.valueUnreadable),
            .baselineUnreadable(.valueTooLarge),
            .readBackUnreadable(.elementChanged),
            .changedWithoutMatch,
        ] {
            let outcome = PasteDeliveryOutcome.forDeliveryEvidence(.unverified(reason))
            #expect(outcome == .deliveredUnverified(reason))
            #expect(outcome != .pasted)
        }
    }

    @Test("an unverified delivery is never reported to the UI as a success")
    func unverifiedDeliveryIsItsOwnStatusKind() {
        #expect(RecordingEngine.deliveryStatusKind(for: .pasted) == .success)
        #expect(
            RecordingEngine.deliveryStatusKind(for: .deliveredUnverified(.changedWithoutMatch))
                == .unverified
        )
        #expect(RecordingEngine.deliveryStatusKind(for: .deliveryNotObserved) == .failure)
        #expect(
            RecordingEngine.deliveryStatusKind(
                for: .secureInputActive(SecureInputHolder(pid: 501, bundleIdentifier: nil))
            ) == .failure
        )
        #expect(RecordingEngine.deliveryStatusKind(for: .eventPostFailed) == .failure)
        #expect(RecordingEngine.pasteTraceStage(for: .pasted) == "paste_delivery_confirmed")
        #expect(
            RecordingEngine.pasteTraceStage(for: .deliveredUnverified(.readBackNotAttempted))
                == "paste_delivery_unverified"
        )
        #expect(
            RecordingEngine.pasteTraceStage(for: .deliveryNotObserved)
                == "paste_delivery_not_observed"
        )
    }

    @Test("secure input refuses the keystroke instead of reporting a paste")
    func secureInputRefusesAndReportsItself() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var verifyCalls = 0
        var outcomes: [PasteDeliveryOutcome] = []
        var settlements: [PasteDeliveryOutcome] = []
        let holder = SecureInputHolder(pid: 902, bundleIdentifier: "com.example.locked")
        let coordinator = makeCoordinator(
            scheduled: { scheduled.append($0) },
            postPaste: { .refusedSecureInput(holder) }
        )

        #expect(coordinator.submit(
            text: "hello",
            generation: 1,
            delay: 0,
            verify: {
                verifyCalls += 1
                return .confirmedByFocusedValue
            }
        ) { _, outcome in
            outcomes.append(outcome)
        } settlement: { _, outcome in
            settlements.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(outcomes == [.secureInputActive(holder)])
        #expect(settlements == [.secureInputActive(holder)])
        #expect(verifyCalls == 0, "nothing was posted, so there is nothing to verify")
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("only the unchanged-field verdict is retried, and a later confirmation wins")
    func readBackRetriesOnlyTheNegativeVerdict() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var verdicts: [PasteDeliveryEvidence] = [
            .notObservedFocusedValueUnchanged,
            .confirmedByFocusedValue,
        ]
        var outcomes: [PasteDeliveryOutcome] = []
        let coordinator = makeCoordinator(
            scheduled: { scheduled.append($0) },
            postPaste: { .posted }
        )

        #expect(coordinator.submit(
            text: "hello",
            generation: 1,
            delay: 0,
            verify: { verdicts.isEmpty ? .notObservedFocusedValueUnchanged : verdicts.removeFirst() },
            verificationDelay: 0.15,
            verificationAttempts: 3
        ) { _, outcome in
            outcomes.append(outcome)
        })

        scheduled.removeFirst()()            // paste hop: posts, then schedules the first read-back
        #expect(outcomes.isEmpty, "the transaction stays open until a read-back answers")
        #expect(coordinator.hasPendingTransaction)
        scheduled.removeFirst()()            // read-back 1: field unchanged -> retry
        #expect(outcomes.isEmpty)
        scheduled.removeFirst()()            // read-back 2: confirmed
        #expect(outcomes == [.pasted])
        #expect(scheduled.isEmpty, "a confirmed read-back must not schedule another")
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("an exhausted read-back budget reports the paste as not delivered")
    func exhaustedReadBackReportsNotObserved() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var verifyCalls = 0
        var outcomes: [PasteDeliveryOutcome] = []
        let coordinator = makeCoordinator(
            scheduled: { scheduled.append($0) },
            postPaste: { .posted }
        )

        #expect(coordinator.submit(
            text: "hello",
            generation: 1,
            delay: 0,
            verify: {
                verifyCalls += 1
                return .notObservedFocusedValueUnchanged
            },
            verificationDelay: 0.15,
            verificationAttempts: 2
        ) { _, outcome in
            outcomes.append(outcome)
        })

        scheduled.removeFirst()()
        scheduled.removeFirst()()
        #expect(outcomes.isEmpty)
        scheduled.removeFirst()()
        #expect(verifyCalls == 2)
        #expect(outcomes == [.deliveryNotObserved])
        #expect(!coordinator.hasPendingTransaction)
    }

    @Test("a failed event construction is still reported as a post failure")
    func constructionFailureIsNotADeliveryVerdict() {
        var scheduled: [@MainActor @Sendable () -> Void] = []
        var outcomes: [PasteDeliveryOutcome] = []
        let coordinator = makeCoordinator(
            scheduled: { scheduled.append($0) },
            postPaste: { .constructionFailed }
        )

        #expect(coordinator.submit(text: "hello", generation: 1, delay: 0) { _, outcome in
            outcomes.append(outcome)
        })
        scheduled.removeFirst()()

        #expect(outcomes == [.eventPostFailed])
    }
}

struct FocusedFieldEvidenceTests {
    private func read(_ value: String, selected: String? = nil) -> FocusedTextRead {
        .read(FocusedTextSnapshot(value: value, selectedText: selected))
    }

    @Test("a field that gained the pasted text confirms delivery")
    func gainedTextConfirms() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello world",
            baseline: read("draft: "),
            readBack: read("draft: hello world")
        ) == .confirmedByFocusedValue)
    }

    @Test("a field that did not change contradicts delivery")
    func unchangedFieldContradicts() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello world",
            baseline: read("draft: "),
            readBack: read("draft: ")
        ) == .notObservedFocusedValueUnchanged)
    }

    @Test("text that was already in the field cannot be counted as this paste")
    func preexistingTextIsNotEvidence() {
        // The transcript is already present (a previous dictation) and the field changed for
        // an unrelated reason. Counting occurrences instead of testing containment is what
        // keeps this from reading as a confirmation.
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello world",
            baseline: read("hello world"),
            readBack: read("hello world!")
        ) == .unverified(.changedWithoutMatch))
    }

    @Test("a second copy of the same text does confirm")
    func repeatedPasteConfirms() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello",
            baseline: read("hello"),
            readBack: read("hellohello")
        ) == .confirmedByFocusedValue)
    }

    @Test("line-ending rewrites still confirm; other transformations do not")
    func lineEndingsAreNormalized() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "first\r\nsecond",
            baseline: read(""),
            readBack: read("first\nsecond")
        ) == .confirmedByFocusedValue)
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "first second",
            baseline: read(""),
            readBack: read("FIRST SECOND")
        ) == .unverified(.changedWithoutMatch))
    }

    @Test("a selection that reads back as the pasted text confirms only when it changed")
    func selectionEvidenceRequiresAChange() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "rewritten",
            baseline: read("rewritten", selected: "rewritten"),
            readBack: read("rewritten", selected: "rewritten")
        ) == .notObservedFocusedValueUnchanged)
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "rewritten",
            baseline: read("original", selected: "original"),
            readBack: read("original", selected: "rewritten")
        ) == .confirmedBySelectedText)
    }

    @Test("an unreadable surface degrades to unverified, naming which read failed")
    func unreadableSurfacesAreDisclosed() {
        // Chrome/Electron web inputs, terminals, and apps with Accessibility disabled land
        // here. Unverified is the honest answer; success would be a fabrication and failure
        // would be a fabrication too.
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello",
            baseline: .unreadable(.valueUnreadable),
            readBack: read("hello")
        ) == .unverified(.baselineUnreadable(.valueUnreadable)))
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello",
            baseline: read(""),
            readBack: .unreadable(.elementChanged)
        ) == .unverified(.readBackUnreadable(.elementChanged)))
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "hello",
            baseline: .unreadable(.elementUnavailable),
            readBack: .unreadable(.elementUnavailable)
        ) == .unverified(.baselineUnreadable(.elementUnavailable)))
    }

    @Test("an empty payload is never confirmed")
    func emptyPayloadIsUnverifiable() {
        #expect(PasteDeliveryVerifier.classify(
            pastedText: "",
            baseline: read("a"),
            readBack: read("ab")
        ) == .unverified(.emptyPayload))
    }
}

struct SecureInputProbeTests {
    @Test("secure input is reported active, inactive, or unknown — never assumed off")
    func decisionTable() {
        #expect(SecureInputProbe.state(
            sessionAvailable: true,
            sessionMarkerPresent: true,
            secureInputPID: 733,
            resolveBundleIdentifier: { _ in "com.example.locked" }
        ) == .active(SecureInputHolder(pid: 733, bundleIdentifier: "com.example.locked")))
        #expect(SecureInputProbe.state(
            sessionAvailable: true,
            sessionMarkerPresent: true,
            secureInputPID: nil
        ) == .inactive)
        #expect(SecureInputProbe.state(
            sessionAvailable: true,
            sessionMarkerPresent: true,
            secureInputPID: 0
        ) == .inactive)
        // No window session (headless, ssh) and an unrecognisable session dictionary both mean
        // we cannot tell, which must not read as "safe to post".
        #expect(SecureInputProbe.state(
            sessionAvailable: false,
            sessionMarkerPresent: false,
            secureInputPID: nil
        ) == .unknown)
        #expect(SecureInputProbe.state(
            sessionAvailable: true,
            sessionMarkerPresent: false,
            secureInputPID: nil
        ) == .unknown)
        #expect(!SecureInputState.unknown.isActive)
        #expect(!SecureInputState.inactive.isActive)
    }
}

struct PasteDeliveryReportTests {
    private func report(
        attempt: PasteAttempt,
        secureInput: SecureInputState?,
        evidence: PasteDeliveryEvidence,
        readBackAttempts: Int
    ) -> PasteDeliveryReport {
        PasteDeliveryReport(
            targetBundleIdentifier: "com.example.editor",
            characterCount: 11,
            clipboardWriteVerified: true,
            clipboardChangeCountAdvanced: true,
            attempt: attempt,
            secureInput: secureInput,
            evidence: evidence,
            readBackAttempts: readBackAttempts
        )
    }

    @Test("the log line separates clipboard, keystroke, secure input, and delivery")
    func logLineKeepsTheStepsSeparate() {
        let confirmed = report(
            attempt: .posted,
            secureInput: .inactive,
            evidence: .confirmedByFocusedValue,
            readBackAttempts: 1
        ).logLine
        #expect(confirmed.hasPrefix("paste_delivery target=com.example.editor chars=11"))
        #expect(confirmed.contains("clipboard=verified"))
        #expect(confirmed.contains("clipboard_change_count=advanced"))
        #expect(confirmed.contains("events=constructed_and_posted"))
        #expect(confirmed.contains("secure_input=inactive"))
        #expect(confirmed.contains("delivery=confirmed_focused_value"))
        #expect(confirmed.contains("read_back_attempts=1"))
    }

    @Test("a posted-but-unproven paste never prints a confirmed delivery")
    func unprovenPasteReadsAsUnverified() {
        let unverified = report(
            attempt: .posted,
            secureInput: .unknown,
            evidence: .unverified(.baselineUnreadable(.valueUnreadable)),
            readBackAttempts: 1
        ).logLine
        #expect(unverified.contains("events=constructed_and_posted"))
        #expect(unverified.contains("delivery=unverified:baseline_unreadable:focused_value_unreadable"))
        #expect(!unverified.contains("delivery=confirmed"))
        #expect(unverified.contains("secure_input=unknown"))

        let refused = report(
            attempt: .refusedSecureInput(SecureInputHolder(pid: 61, bundleIdentifier: "com.example.vault")),
            secureInput: .active(SecureInputHolder(pid: 61, bundleIdentifier: "com.example.vault")),
            evidence: .unverified(.readBackNotAttempted),
            readBackAttempts: 0
        ).logLine
        #expect(refused.contains("events=not_posted_secure_input"))
        #expect(refused.contains("secure_input=active(pid=61,app=com.example.vault)"))
        #expect(refused.contains("delivery=unverified:read_back_not_attempted"))
        #expect(!refused.contains("delivery=confirmed"))
    }

    @Test("a paste that never reached the keystroke says so instead of implying one")
    func preKeystrokeFailuresReportNoAttempt() {
        #expect(PasteAttempt.forOutcome(.targetUnavailable) == .notAttempted)
        #expect(PasteAttempt.forOutcome(.clipboardWriteFailed) == .notAttempted)
        #expect(PasteAttempt.forOutcome(.clipboardOwnershipLost) == .notAttempted)
        #expect(PasteAttempt.forOutcome(.eventPostFailed) == .constructionFailed)
        #expect(PasteAttempt.forOutcome(.pasted) == .posted)
        #expect(PasteAttempt.forOutcome(.deliveryNotObserved) == .posted)
        #expect(PasteAttempt.forOutcome(.deliveredUnverified(.emptyPayload)) == .posted)
        let holder = SecureInputHolder(pid: 5, bundleIdentifier: nil)
        #expect(PasteAttempt.forOutcome(.secureInputActive(holder)) == .refusedSecureInput(holder))

        let notAttempted = PasteDeliveryReport(
            targetBundleIdentifier: nil,
            characterCount: 4,
            clipboardWriteVerified: false,
            clipboardChangeCountAdvanced: false,
            attempt: .notAttempted,
            secureInput: nil,
            evidence: .unverified(.readBackNotAttempted),
            readBackAttempts: 0
        ).logLine
        #expect(notAttempted.contains("target=?"))
        #expect(notAttempted.contains("clipboard=unverified"))
        #expect(notAttempted.contains("clipboard_change_count=unchanged"))
        #expect(notAttempted.contains("events=not_attempted"))
        #expect(notAttempted.contains("secure_input=not_probed"))
        #expect(notAttempted.contains("read_back_attempts=0"))
    }
}

struct PasteboardWriteEvidenceTests {
    @Test("a clipboard write reports both that the pasteboard moved and that it holds our text")
    func clipboardWriteReportsChangeCountMovement() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("recordings-write-evidence-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("previous", forType: .string)
        let changeCountBefore = pasteboard.changeCount

        let result = RecordingEngine.writeClipboardAttempt("dictated text", to: pasteboard)

        #expect(result.verified)
        #expect(result.changeCountAdvanced)
        #expect(result.ownershipChangeCount > changeCountBefore)
        #expect(pasteboard.string(forType: .string) == "dictated text")
    }
}
