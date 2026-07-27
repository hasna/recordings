import AppKit
@preconcurrency import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Why a paste cannot be proven

/// `CGEvent.post` returns `Void`. macOS never tells the sender whether a synthetic keystroke
/// reached a consumer, so "we posted Cmd-V" is not evidence that text landed anywhere. The
/// only evidence available to this process is reading the target app's focused field back
/// over the Accessibility API and observing that it gained the pasted text.
///
/// Every value in this file exists to keep three separable facts separable:
///   1. the pasteboard write succeeded and we still own the payload,
///   2. the key events were constructed and posted,
///   3. the text was observed to land.
/// Only (3) is delivery. (1) and (2) are preconditions and are reported as such.

/// Why one Accessibility read of the focused field produced no comparable text.
enum FocusedTextReadFailure: String, Equatable, Sendable {
    /// The target app exposes no focused element (AX disabled, no key window, app busy).
    case elementUnavailable = "focused_element_unavailable"
    /// The focused element has no readable `kAXValue` string. Normal for Chrome/Electron web
    /// inputs that publish no value, terminals, and canvas-drawn editors.
    case valueUnreadable = "focused_value_unreadable"
    /// The field holds more text than we are willing to copy and compare on the paste path.
    case valueTooLarge = "focused_value_too_large"
    /// Focus moved to a different element between the baseline and the read-back, so the two
    /// reads describe different fields and cannot be compared.
    case elementChanged = "focused_element_changed"
}

/// Why a paste could not be *confirmed*. Every case means "we do not know that the text
/// landed" — never "it landed".
enum PasteDeliveryUnverifiedReason: Equatable, Sendable {
    /// No read-back was wired up (test seams, and the default so a caller that forgets to
    /// verify cannot accidentally inherit a success).
    case readBackNotAttempted
    case emptyPayload
    case baselineUnreadable(FocusedTextReadFailure)
    case readBackUnreadable(FocusedTextReadFailure)
    /// The field changed but not in a way that accounts for our text: the app may have
    /// transformed, truncated, or rejected it, or the change may be unrelated typing.
    case changedWithoutMatch

    var logToken: String {
        switch self {
        case .readBackNotAttempted: "read_back_not_attempted"
        case .emptyPayload: "empty_payload"
        case .baselineUnreadable(let failure): "baseline_unreadable:\(failure.rawValue)"
        case .readBackUnreadable(let failure): "read_back_unreadable:\(failure.rawValue)"
        case .changedWithoutMatch: "changed_without_match"
        }
    }
}

/// What the post-paste read of the focused field actually showed.
enum PasteDeliveryEvidence: Equatable, Sendable {
    /// The focused field gained an occurrence of the pasted text. This is the only kind of
    /// evidence that justifies telling the user the paste worked.
    case confirmedByFocusedValue
    /// The field's selection reads back as exactly the pasted text and did not before the
    /// paste — the shape a paste over a selection leaves in some editors.
    case confirmedBySelectedText
    /// The field was readable before and after and did not change: the keystroke did not
    /// reach it. A paste that landed somewhere else is not a paste that landed here.
    case notObservedFocusedValueUnchanged
    case unverified(PasteDeliveryUnverifiedReason)

    var isConfirmed: Bool {
        switch self {
        case .confirmedByFocusedValue, .confirmedBySelectedText: true
        case .notObservedFocusedValueUnchanged, .unverified: false
        }
    }

    var logToken: String {
        switch self {
        case .confirmedByFocusedValue: "confirmed_focused_value"
        case .confirmedBySelectedText: "confirmed_selected_text"
        case .notObservedFocusedValueUnchanged: "not_observed_focused_value_unchanged"
        case .unverified(let reason): "unverified:\(reason.logToken)"
        }
    }
}

// MARK: - Secure input

/// The process holding secure event input, when one does. `bundleIdentifier` is best effort:
/// the pid may belong to a process we cannot resolve or one that has already exited.
struct SecureInputHolder: Equatable, Sendable {
    let pid: pid_t?
    let bundleIdentifier: String?

    var logToken: String {
        "pid=\(pid.map(String.init) ?? "unknown"),app=\(bundleIdentifier ?? "unknown")"
    }
}

/// Secure event input is a window-server mode a password field turns on. While it is on,
/// every synthetic key event is dropped for every consumer — a posted Cmd-V cannot paste,
/// and nothing in the posting API says so.
enum SecureInputState: Equatable, Sendable {
    case inactive
    case active(SecureInputHolder)
    /// The window session could not be interrogated (no GUI session at all, or the session
    /// dictionary did not carry the keys we know how to read). Reported, never assumed off.
    case unknown

    var isActive: Bool {
        switch self {
        case .active: true
        case .inactive, .unknown: false
        }
    }

    var logToken: String {
        switch self {
        case .inactive: "inactive"
        case .active(let holder): "active(\(holder.logToken))"
        case .unknown: "unknown"
        }
    }
}

enum SecureInputProbe {
    /// Window-session dictionary keys. CoreGraphics publishes these as C string macros that
    /// Swift does not import, so the key strings are named here once rather than spelled at
    /// the call site. `secureInputPIDKey` is only present while some process holds secure
    /// input, which is why its absence is read together with a session marker key: absent
    /// key plus a recognisable session means "off", absent key plus no session means
    /// "unknown".
    static let secureInputPIDKey = "kCGSSessionSecureInputPID"
    static let onConsoleKey = "kCGSSessionOnConsoleKey"
    static let userIDKey = "kCGSSessionUserIDKey"

    @MainActor
    static func current() -> SecureInputState {
        guard let rawSession = CGSessionCopyCurrentDictionary() else {
            return state(sessionAvailable: false, sessionMarkerPresent: false, secureInputPID: nil)
        }
        let session = rawSession as NSDictionary
        return state(
            sessionAvailable: true,
            sessionMarkerPresent: session[onConsoleKey] != nil || session[userIDKey] != nil,
            secureInputPID: (session[secureInputPIDKey] as? NSNumber)?.intValue,
            resolveBundleIdentifier: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
        )
    }

    /// Pure decision table, so the three outcomes can be tested without a window session.
    static func state(
        sessionAvailable: Bool,
        sessionMarkerPresent: Bool,
        secureInputPID: Int?,
        resolveBundleIdentifier: (pid_t) -> String? = { _ in nil }
    ) -> SecureInputState {
        guard sessionAvailable, sessionMarkerPresent else { return .unknown }
        guard let secureInputPID, secureInputPID > 0 else { return .inactive }
        let pid = pid_t(secureInputPID)
        return .active(SecureInputHolder(pid: pid, bundleIdentifier: resolveBundleIdentifier(pid)))
    }
}

// MARK: - Reading the focused field

struct FocusedTextSnapshot: Equatable, Sendable {
    let value: String
    let selectedText: String?
}

enum FocusedTextRead: Equatable, Sendable {
    case read(FocusedTextSnapshot)
    case unreadable(FocusedTextReadFailure)
}

/// Holds the focused element captured before a paste so the read-back compares the same
/// element rather than whatever happens to be focused afterwards. AX calls are Mach IPC and
/// thread safe; the stored elements are never mutated.
///
/// CAPABILITY DISCLOSURE — read this before extending anything in here.
///
/// This type is the reason a dictation app can see text the user did not dictate. It reads the
/// **full value** of the focused field in the target application, plus its current selection,
/// twice around each paste. That is a meaningful widening of what the app can observe and it is
/// deliberate: `CGEvent.post` returns `Void`, so nothing else can distinguish a paste that
/// landed from one the window server discarded, and the alternative is the app claiming a paste
/// it never proved.
///
/// The constraints that make it acceptable are load-bearing, not incidental:
///
/// - the read-back text is **never logged and never persisted** — only the verdict is;
/// - values above `maximumComparableCharacterCount` are reported unverifiable instead of copied;
/// - no new permission is requested: this rides the Accessibility grant the keystroke already
///   needs, which is precisely why the capability has to be documented rather than inferred.
///
/// A change that logs, stores, transmits or forwards a `FocusedTextSnapshot` value breaks that
/// contract. `README.md` ("What the app reads to confirm a paste") states this to users; keep
/// the two in step.
final class FocusedTextProbe: @unchecked Sendable {
    /// Cap on the field text copied into this process for comparison. A large document is
    /// reported unverifiable rather than copied and scanned on the paste path.
    static let maximumComparableCharacterCount = 20_000
    /// Tighter than `AccessibilitySelectionToken.captureMessagingTimeout`: this read happens
    /// twice around the keystroke, so a slow target app must not delay the paste or the
    /// verdict. A timeout surfaces as `elementUnavailable`/`valueUnreadable`, never success.
    static let messagingTimeout: Float = 0.12

    private let applicationElement: AXUIElement
    private let focusedElement: AXUIElement?
    let baseline: FocusedTextRead

    private init(
        applicationElement: AXUIElement,
        focusedElement: AXUIElement?,
        baseline: FocusedTextRead
    ) {
        self.applicationElement = applicationElement
        self.focusedElement = focusedElement
        self.baseline = baseline
    }

    static func capture(pid: pid_t) -> FocusedTextProbe {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, messagingTimeout)
        guard let focused = resolveFocusedElement(of: application) else {
            return FocusedTextProbe(
                applicationElement: application,
                focusedElement: nil,
                baseline: .unreadable(.elementUnavailable)
            )
        }
        AXUIElementSetMessagingTimeout(focused, messagingTimeout)
        return FocusedTextProbe(
            applicationElement: application,
            focusedElement: focused,
            baseline: read(focused)
        )
    }

    /// Re-reads the element the baseline came from, refusing to compare across a focus move.
    func readBack() -> FocusedTextRead {
        guard let focusedElement else { return .unreadable(.elementUnavailable) }
        guard let current = Self.resolveFocusedElement(of: applicationElement) else {
            return .unreadable(.elementUnavailable)
        }
        guard CFEqual(current, focusedElement) else { return .unreadable(.elementChanged) }
        return Self.read(focusedElement)
    }

    private static func resolveFocusedElement(of application: AXUIElement) -> AXUIElement? {
        var focusedElementRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &focusedElementRef
        ) == .success,
        let focusedElementRef,
        CFGetTypeID(focusedElementRef) == AXUIElementGetTypeID() else { return nil }
        return (focusedElementRef as! AXUIElement)
    }

    private static func read(_ element: AXUIElement) -> FocusedTextRead {
        guard let value = stringAttribute(kAXValueAttribute as CFString, on: element) else {
            return .unreadable(.valueUnreadable)
        }
        guard value.count <= maximumComparableCharacterCount else {
            return .unreadable(.valueTooLarge)
        }
        let selectedText = stringAttribute(kAXSelectedTextAttribute as CFString, on: element)
        return .read(FocusedTextSnapshot(
            value: value,
            selectedText: selectedText.flatMap {
                $0.count <= maximumComparableCharacterCount ? $0 : nil
            }
        ))
    }

    private static func stringAttribute(_ attribute: CFString, on element: AXUIElement) -> String? {
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &valueRef) == .success else {
            return nil
        }
        return valueRef as? String
    }
}

// MARK: - Verdict

enum PasteDeliveryVerifier {
    /// Decides what two reads of the focused field prove. Ordered so that the positive
    /// verdicts require an observed *gain* of the pasted text: text that was already in the
    /// field before the paste can never be counted as this paste's delivery.
    ///
    /// Known false negative, in the safe direction and deliberately not chased: pasting text
    /// identical to the selection it replaces (baseline `hello WORLD`, selection `WORLD`,
    /// transcript `WORLD`) leaves both the value and the occurrence count unchanged, so a
    /// successful delivery classifies as `.notObservedFocusedValueUnchanged`. Distinguishing it
    /// would mean treating an unchanged field as a possible success, which is the direction that
    /// manufactures false confirmations. Under-claiming is the correct failure mode here, and
    /// the case name says "not observed" rather than "failed" so the log does not overstate it.
    static func classify(
        pastedText: String,
        baseline: FocusedTextRead,
        readBack: FocusedTextRead
    ) -> PasteDeliveryEvidence {
        guard !pastedText.isEmpty else { return .unverified(.emptyPayload) }

        switch (baseline, readBack) {
        case (.unreadable(let failure), _):
            return .unverified(.baselineUnreadable(failure))
        case (_, .unreadable(let failure)):
            return .unverified(.readBackUnreadable(failure))
        case (.read(let before), .read(let after)):
            let occurrencesBefore = occurrences(of: pastedText, in: before.value)
            let occurrencesAfter = occurrences(of: pastedText, in: after.value)
            if occurrencesAfter > occurrencesBefore { return .confirmedByFocusedValue }
            if selectionConfirms(before: before, after: after, pastedText: pastedText) {
                return .confirmedBySelectedText
            }
            if normalized(after.value) == normalized(before.value) {
                return .notObservedFocusedValueUnchanged
            }
            return .unverified(.changedWithoutMatch)
        }
    }

    /// A selection that already read as the pasted text before the paste is indistinguishable
    /// from a paste that never happened, so it does not count.
    private static func selectionConfirms(
        before: FocusedTextSnapshot,
        after: FocusedTextSnapshot,
        pastedText: String
    ) -> Bool {
        guard let selected = after.selectedText, !selected.isEmpty else { return false }
        guard normalized(selected) == normalized(pastedText) else { return false }
        return normalized(before.selectedText ?? "") != normalized(pastedText)
    }

    /// Line endings are the one transformation apps routinely apply to pasted text; anything
    /// beyond that is reported as `changedWithoutMatch` rather than guessed at.
    static func normalized(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    static func occurrences(of needle: String, in haystack: String) -> Int {
        let normalizedNeedle = normalized(needle)
        guard !normalizedNeedle.isEmpty else { return 0 }
        let normalizedHaystack = normalized(haystack)
        var count = 0
        var searchStart = normalizedHaystack.startIndex
        while searchStart < normalizedHaystack.endIndex,
              let found = normalizedHaystack.range(
                  of: normalizedNeedle,
                  range: searchStart..<normalizedHaystack.endIndex
              ) {
            count += 1
            searchStart = found.upperBound
        }
        return count
    }
}

// MARK: - What the keystroke attempt itself did

/// Outcome of the posting step alone. `posted` claims nothing about delivery — it means two
/// `CGEvent`s were constructed and handed to the window server.
enum PasteAttempt: Equatable, Sendable {
    case posted
    case constructionFailed
    case refusedSecureInput(SecureInputHolder)
    /// The paste failed before the keystroke step (no target, clipboard write failed, payload
    /// ownership lost). Reported so the log never implies a keystroke that never happened.
    case notAttempted

    var logToken: String {
        switch self {
        case .posted: "constructed_and_posted"
        case .constructionFailed: "construction_failed"
        case .refusedSecureInput: "not_posted_secure_input"
        case .notAttempted: "not_attempted"
        }
    }

    /// What the posting step did, read back off the transaction outcome so the log line and
    /// the outcome can never disagree.
    static func forOutcome(_ outcome: PasteDeliveryOutcome) -> PasteAttempt {
        switch outcome {
        case .pasted, .deliveryNotObserved, .deliveredUnverified: .posted
        case .eventPostFailed: .constructionFailed
        case .secureInputActive(let holder): .refusedSecureInput(holder)
        case .targetUnavailable, .clipboardOwnershipLost, .clipboardWriteFailed: .notAttempted
        }
    }
}

// MARK: - One log line per delivery

/// The record a human reads after trying a dictation. Each field answers a different
/// question, so a failure cannot hide behind a neighbouring success:
///   `clipboard=`             did the payload reach the pasteboard and stay ours
///   `clipboard_change_count=` did the pasteboard actually advance for our write
///   `events=`                were the key events constructed and posted
///   `secure_input=`          could any synthetic event have been delivered at all
///   `delivery=`              was the text observed to land in the focused field
struct PasteDeliveryReport: Equatable, Sendable {
    let targetBundleIdentifier: String?
    let characterCount: Int
    let clipboardWriteVerified: Bool
    let clipboardChangeCountAdvanced: Bool
    let attempt: PasteAttempt
    let secureInput: SecureInputState?
    let evidence: PasteDeliveryEvidence
    let readBackAttempts: Int

    var logLine: String {
        "paste_delivery target=\(targetBundleIdentifier ?? "?")"
            + " chars=\(characterCount)"
            + " clipboard=\(clipboardWriteVerified ? "verified" : "unverified")"
            + " clipboard_change_count=\(clipboardChangeCountAdvanced ? "advanced" : "unchanged")"
            + " events=\(attempt.logToken)"
            + " secure_input=\(secureInput?.logToken ?? "not_probed")"
            + " delivery=\(evidence.logToken)"
            + " read_back_attempts=\(readBackAttempts)"
    }
}
