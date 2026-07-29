struct PasteDeliveryTransaction: Equatable, Sendable {
    let id: UUID
    let text: String
    let generation: UInt64?
}

enum PasteDeliveryOutcome: Equatable, Sendable {
    /// Delivery *observed*: the focused field in the target app was read back after the
    /// keystroke and had gained the pasted text. Reachable only from confirming evidence —
    /// see `PasteDeliveryOutcome.forDeliveryEvidence`. A posted `CGEvent` never produces it,
    /// because `CGEvent.post` returns no delivery receipt.
    case pasted
    /// The keystroke was posted and the focused field, readable before and after, did not
    /// change. The paste did not land where it was aimed.
    case deliveryNotObserved
    /// The keystroke was posted and the target app's focused field could not be read back, so
    /// delivery is unknown. Carries the reason so the log says which surface refused to
    /// answer instead of implying success.
    case deliveredUnverified(PasteDeliveryUnverifiedReason)
    /// Secure event input is on, so no synthetic keystroke can reach any app. Nothing was
    /// posted; the payload is left on the clipboard for the user to paste.
    case secureInputActive(SecureInputHolder)
    case targetUnavailable
    case clipboardOwnershipLost
    case clipboardWriteFailed
    case eventPostFailed

    /// The single place delivery evidence is allowed to become `.pasted`. Kept next to the
    /// outcome so a reader can check the whole mapping at once: two confirming reads, one
    /// contradicting read, everything else unverified.
    static func forDeliveryEvidence(_ evidence: PasteDeliveryEvidence) -> PasteDeliveryOutcome {
        switch evidence {
        case .confirmedByFocusedValue, .confirmedBySelectedText: .pasted
        case .notObservedFocusedValueUnchanged: .deliveryNotObserved
        case .unverified(let reason): .deliveredUnverified(reason)
        }
    }
}

struct PasteboardWriteResult: Equatable, Sendable {
    let verified: Bool
    let ownershipChangeCount: Int
    /// Whether the pasteboard's `changeCount` actually advanced past its pre-write value.
    /// Weaker than `verified` (which also re-reads the stored string) and reported separately
    /// so a log reader can tell "the pasteboard moved" from "the pasteboard holds our text".
    var changeCountAdvanced: Bool = false
}

/// Outcome of revalidating the frozen rewrite target immediately before a rewrite runs.
/// Anything but a live, matching selection fails the rewrite closed.
enum RewriteTargetResolution: Equatable, Sendable {
    case selection(String)
    case targetAppMissing
    case selectionUnavailable
}

@MainActor
final class PasteTransactionCoordinator {
    private enum State: Equatable {
        case idle
        case scheduled(UUID)
        case settling(UUID)
    }

    typealias ScheduledOperation = @MainActor @Sendable () -> Void
    typealias Scheduler = @MainActor @Sendable (TimeInterval, @escaping ScheduledOperation) -> Void
    typealias PayloadWriter = @MainActor @Sendable (String) -> PasteboardWriteResult
    typealias PastePoster = @MainActor @Sendable () -> PasteKeystrokeAttempt
    /// Reads the target app back and reports what that read proves. Defaulted to
    /// `.unverified(.readBackNotAttempted)` at every entry point so a caller that supplies no
    /// verification gets an explicitly unverified outcome, never an assumed success.
    typealias DeliveryVerifier = @MainActor @Sendable () -> PasteDeliveryEvidence
    typealias WriteObserver = @MainActor @Sendable (PasteboardWriteResult) -> Void
    typealias Completion = @MainActor @Sendable (PasteDeliveryTransaction, PasteDeliveryOutcome) -> Void
    typealias Settlement = @MainActor @Sendable (PasteDeliveryTransaction, PasteDeliveryOutcome) -> Void

    private let schedule: Scheduler
    private let writeAndVerify: PayloadWriter
    private let postPaste: PastePoster
    /// Fires immediately before `hasPendingTransaction` changes value. The settlement hop
    /// back to idle runs on its own scheduled turn with no other state write, so an owner
    /// deriving gates from this coordinator (e.g. `canStartRecording`) must publish here or
    /// its observers never recompute after settlement.
    var pendingTransactionWillChange: (@MainActor () -> Void)?
    private var state: State = .idle {
        willSet {
            if (newValue == .idle) != (state == .idle) {
                pendingTransactionWillChange?()
            }
        }
    }

    init(
        schedule: @escaping Scheduler,
        writeAndVerify: @escaping PayloadWriter,
        postPaste: @escaping PastePoster
    ) {
        self.schedule = schedule
        self.writeAndVerify = writeAndVerify
        self.postPaste = postPaste
    }

    var hasPendingTransaction: Bool {
        state != .idle
    }

    @discardableResult
    func submit(
        text: String,
        generation: UInt64?,
        delay: TimeInterval,
        settlementDelay: TimeInterval = 0,
        targetIsReady: @escaping @MainActor @Sendable () -> Bool = { true },
        payloadIsReady: @escaping @MainActor @Sendable () -> Bool = { true },
        prepare: @escaping ScheduledOperation = {},
        writeAttempted: @escaping WriteObserver = { _ in },
        verify: @escaping DeliveryVerifier = { .unverified(.readBackNotAttempted) },
        // `verificationDelay` is the wait between posting the keystroke and reading the target
        // app back; zero verifies on the posting turn, which only makes sense for tests since a
        // real app cannot have processed the event yet. `verificationAttempts` bounds how many
        // read-backs may run before "the field did not change" is accepted as the verdict —
        // only that verdict is retried, and each retry costs one `verificationDelay`.
        verificationDelay: TimeInterval = 0,
        verificationAttempts: Int = 1,
        completion: @escaping Completion,
        settlement: @escaping Settlement = { _, _ in }
    ) -> Bool {
        guard state == .idle else { return false }
        let transaction = PasteDeliveryTransaction(id: UUID(), text: text, generation: generation)
        state = .scheduled(transaction.id)
        schedule(delay) { [weak self] in
            guard let self, self.state == .scheduled(transaction.id) else { return }
            self.state = .settling(transaction.id)
            guard targetIsReady() else {
                settlement(transaction, .targetUnavailable)
                self.state = .idle
                completion(transaction, .targetUnavailable)
                return
            }
            prepare()
            guard targetIsReady() else {
                settlement(transaction, .targetUnavailable)
                self.state = .idle
                completion(transaction, .targetUnavailable)
                return
            }
            let writeResult = self.writeAndVerify(transaction.text)
            writeAttempted(writeResult)
            guard writeResult.verified else {
                settlement(transaction, .clipboardWriteFailed)
                self.state = .idle
                completion(transaction, .clipboardWriteFailed)
                return
            }
            guard targetIsReady() else {
                settlement(transaction, .targetUnavailable)
                self.state = .idle
                completion(transaction, .targetUnavailable)
                return
            }
            guard payloadIsReady() else {
                settlement(transaction, .clipboardOwnershipLost)
                self.state = .idle
                completion(transaction, .clipboardOwnershipLost)
                return
            }
            // `@MainActor` is required, not decorative: a local function does not inherit the
            // enclosing closure's actor isolation, so without it `state` cannot be mutated and
            // `completion`/`settlement` cannot be called from here at all.
            @MainActor func failNow(with outcome: PasteDeliveryOutcome) {
                settlement(transaction, outcome)
                self.state = .idle
                completion(transaction, outcome)
            }

            switch self.postPaste() {
            case .constructionFailed:
                failNow(with: .eventPostFailed)
                return
            case .refusedSecureInput(let holder):
                // Nothing was posted: with secure input on, the window server drops synthetic
                // key events for every consumer, so posting would only manufacture a success
                // log for a paste that cannot happen.
                failNow(with: .secureInputActive(holder))
                return
            case .posted:
                break
            }

            // The keystroke is out. `CGEvent.post` returned no receipt, so the transaction
            // stays open: the outcome comes from reading the target app back.
            let pending = PendingDelivery(
                transaction: transaction,
                verify: verify,
                verificationDelay: verificationDelay,
                verificationAttempts: verificationAttempts,
                settlementDelay: settlementDelay,
                completion: completion,
                settlement: settlement
            )
            guard verificationDelay > 0 else {
                self.settleFromDeliveryEvidence(pending, readBackAttempt: verificationAttempts)
                return
            }
            self.schedule(verificationDelay) { [weak self] in
                guard let self, self.state == .settling(transaction.id) else { return }
                self.settleFromDeliveryEvidence(pending, readBackAttempt: 1)
            }
        }
        return true
    }

    /// Everything the read-back loop needs after the keystroke has been posted.
    private struct PendingDelivery: Sendable {
        let transaction: PasteDeliveryTransaction
        let verify: DeliveryVerifier
        let verificationDelay: TimeInterval
        let verificationAttempts: Int
        let settlementDelay: TimeInterval
        let completion: Completion
        let settlement: Settlement
    }

    /// Asks the verifier what the target app shows, retrying only the "field did not change"
    /// verdict: that is the one a slow app can turn into a confirmation, while a confirmed or
    /// unreadable result is already final.
    private func settleFromDeliveryEvidence(_ pending: PendingDelivery, readBackAttempt: Int) {
        let evidence = pending.verify()
        guard evidence == .notObservedFocusedValueUnchanged,
              readBackAttempt < pending.verificationAttempts else {
            complete(pending, outcome: .forDeliveryEvidence(evidence))
            return
        }
        schedule(pending.verificationDelay) { [weak self] in
            guard let self, self.state == .settling(pending.transaction.id) else { return }
            self.settleFromDeliveryEvidence(pending, readBackAttempt: readBackAttempt + 1)
        }
    }

    private func complete(_ pending: PendingDelivery, outcome: PasteDeliveryOutcome) {
        pending.completion(pending.transaction, outcome)
        guard pending.settlementDelay > 0 else {
            pending.settlement(pending.transaction, outcome)
            state = .idle
            return
        }
        schedule(pending.settlementDelay) { [weak self] in
            guard let self, self.state == .settling(pending.transaction.id) else { return }
            pending.settlement(pending.transaction, outcome)
            self.state = .idle
        }
    }
}

struct PipelineDeliveryGate: Sendable {
    private var pendingGenerations = Set<UInt64>()
    private var highestClaimedGeneration: UInt64?

    mutating func registerPipeline(_ generation: UInt64) {
        pendingGenerations.insert(generation)
    }

    mutating func abandonPipeline(_ generation: UInt64) {
        pendingGenerations.remove(generation)
    }

    mutating func claimDelivery(for generation: UInt64) -> Bool {
        if pendingGenerations.remove(generation) != nil {
            highestClaimedGeneration = max(highestClaimedGeneration ?? generation, generation)
            return true
        }
        if let highestClaimedGeneration, generation <= highestClaimedGeneration {
            return false
        }
        highestClaimedGeneration = generation
        return true
    }

    func shouldApplyStatus(
        deliveryGeneration: UInt64,
        currentGeneration: UInt64,
        isRecording: Bool,
        isTranscribing: Bool
    ) -> Bool {
        deliveryGeneration == currentGeneration && !isRecording && !isTranscribing
    }
}

