import AVFoundation
@preconcurrency import ApplicationServices
// CopySymbolicHotKeys lives in Carbon's HIToolbox.
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

// MARK: - Custom shortcut (not fn — fn is handled by FnKeyMonitor)

extension KeyboardShortcuts.Name {
    @MainActor public static let toggleRecording = Self("toggleRecording", default: .init(.f5))
}

// MARK: - Transcription Result

public struct TranscriptionResult: Identifiable, Sendable {
    public let id = UUID()
    let rawText: String
    let processedText: String?
    let timestamp: Date
    let projectId: String?
    let projectName: String?
    public var displayText: String { processedText ?? rawText }

    init(rawText: String, processedText: String?, timestamp: Date, projectId: String?, projectName: String?) {
        self.rawText = rawText
        self.processedText = processedText
        self.timestamp = timestamp
        self.projectId = projectId
        self.projectName = projectName
    }
}

struct RealtimeFastPathSaveResult: Sendable {
    let text: String?
    let error: String?
}

enum FallbackCompletionAction: Equatable, Sendable {
    case deliver(String)
    case fail(String)
    case backgroundRecovered
    case backgroundFailed(String)
}

struct RecordingProcessingConfiguration: Equatable, Sendable {
    let transcriptionPrompt: String
    let transcriberPrompt: String
    let postProcessingMode: String
    let transcriptionLanguage: String
    let transcriptionModel: String
    let transcriberModel: String
    let enhancementModel: String
    let intentModel: String
    let intentDetectionEnabled: Bool
    let enhanceTriggersJSON: String
    let keywordTransformsJSON: String
}

/// Accessibility state frozen near recording start. Captured on a detached task so the
/// recorder never waits on Accessibility IPC to a possibly-unresponsive target app.
struct RecordingStartAXSnapshot: Sendable {
    let selectionToken: AccessibilitySelectionToken?
    let focusedWindowTitle: String?
}

/// Everything about the recording that is only known once the start-time Accessibility
/// snapshot and project auto-selection have resolved. Bound to one recording generation via
/// the task stored in `RecordingCaptureConfiguration`.
struct RecordingStartResolvedContext: Sendable {
    let selectionToken: AccessibilitySelectionToken?
    let canonicalProjectId: String?
    let displayProjectId: String?
    let activeProjectName: String?
    let processing: RecordingProcessingConfiguration
}

struct RecordingCaptureConfiguration: Sendable {
    let targetAppBundleIdentifier: String?
    let targetAppPid: pid_t?
    /// Resolves the frozen selection token, project binding, and processing configuration.
    /// Started at recording start and awaited only after the recorder has stopped, so
    /// capture latency can never delay microphone start.
    let startContext: Task<RecordingStartResolvedContext, Never>
}

/// The frontmost-application identity `startRecording` freezes. Abstracted from
/// `NSWorkspace` so production-path tests can drive recording starts headlessly.
struct FrontmostAppSnapshot: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String?
    let launchDate: Date?
}

/// The one capability `RecordingEngine` needs from an audio recorder; lets tests run the
/// production start path without microphone hardware or TCC grants.
protocol PCMRecordingSource: AnyObject {
    func start() throws
    func stop()
}

extension NativePCMRecorder: PCMRecordingSource {}

struct AccessibilitySelectionIdentity<Element: Equatable & Sendable>: Equatable, Sendable {
    let element: Element
    let window: Element
    let documentIdentifier: String
    let rangeLocation: Int
    let rangeLength: Int
    let selectedText: String

    func matches(
        element currentElement: Element,
        window currentWindow: Element,
        documentIdentifier currentDocumentIdentifier: String,
        rangeLocation currentRangeLocation: Int,
        rangeLength currentRangeLength: Int,
        selectedText currentSelectedText: String
    ) -> Bool {
        element == currentElement
            && window == currentWindow
            && documentIdentifier == currentDocumentIdentifier
            && rangeLocation == currentRangeLocation
            && rangeLength == currentRangeLength
            && selectedText == currentSelectedText
    }
}

private struct AXElementIdentity: Equatable, @unchecked Sendable {
    let element: AXUIElement

    static func == (lhs: Self, rhs: Self) -> Bool {
        let element = lhs.element
        let currentElement = rhs.element
        return CFEqual(element, currentElement)
    }
}

/// Captured off the MainActor (Accessibility calls are Mach IPC and thread-safe); the token
/// itself is immutable after capture, so later MainActor revalidation reads are safe.
final class AccessibilitySelectionToken: @unchecked Sendable {
    private let identity: AccessibilitySelectionIdentity<AXElementIdentity>

    var selectedText: String { identity.selectedText }

    private init(
        element: AXUIElement,
        window: AXUIElement,
        documentIdentifier: String,
        range: CFRange,
        selectedText: String
    ) {
        identity = AccessibilitySelectionIdentity(
            element: AXElementIdentity(element: element),
            window: AXElementIdentity(element: window),
            documentIdentifier: documentIdentifier,
            rangeLocation: range.location,
            rangeLength: range.length,
            selectedText: selectedText
        )
    }

    /// Cap for each Accessibility IPC round trip during capture. Capture runs off the
    /// recorder-start path, but revalidation still happens synchronously before a paste or
    /// rewrite, so a beachballing target app must never stall behind the multi-second
    /// system default.
    static let captureMessagingTimeout: Float = 0.25

    #if DEBUG
    /// Test-only token whose AX elements point at this process; revalidation against a real
    /// target fails closed, which is exactly what delivery tests need to observe.
    static func unsafeTestToken(selectedText: String) -> AccessibilitySelectionToken {
        let element = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        return AccessibilitySelectionToken(
            element: element,
            window: element,
            documentIdentifier: "document:test",
            range: CFRange(location: 0, length: (selectedText as NSString).length),
            selectedText: selectedText
        )
    }
    #endif

    static func capture(for pid: pid_t) -> AccessibilitySelectionToken? {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, captureMessagingTimeout)
        var focusedElementRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &focusedElementRef
        ) == .success,
        let focusedElementRef,
        CFGetTypeID(focusedElementRef) == AXUIElementGetTypeID() else { return nil }
        let focusedElement = focusedElementRef as! AXUIElement
        AXUIElementSetMessagingTimeout(focusedElement, captureMessagingTimeout)

        var focusedWindowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedWindowAttribute as CFString,
            &focusedWindowRef
        ) == .success,
        let focusedWindowRef,
        CFGetTypeID(focusedWindowRef) == AXUIElementGetTypeID() else { return nil }
        let focusedWindow = focusedWindowRef as! AXUIElement
        AXUIElementSetMessagingTimeout(focusedWindow, captureMessagingTimeout)

        let documentIdentifier = stringAttribute(
            kAXDocumentAttribute as CFString,
            on: focusedElement
        ) ?? stringAttribute(
            kAXDocumentAttribute as CFString,
            on: focusedWindow
        )
        guard let contextIdentifier = RecordingEngine.stableAccessibilityContextIdentifier(
            documentIdentifier: documentIdentifier,
            elementIdentifier: stringAttribute(kAXIdentifierAttribute as CFString, on: focusedElement)
        ) else { return nil }

        guard let selectedRange = selectedRange(for: focusedElement),
              let selectedText = selectedText(for: focusedElement, range: selectedRange) else {
            return nil
        }
        return AccessibilitySelectionToken(
            element: focusedElement,
            window: focusedWindow,
            documentIdentifier: contextIdentifier,
            range: selectedRange,
            selectedText: selectedText
        )
    }

    func matchesCurrentSelection(for pid: pid_t) -> Bool {
        guard let current = Self.capture(for: pid) else { return false }
        return identity.matches(
            element: current.identity.element,
            window: current.identity.window,
            documentIdentifier: current.identity.documentIdentifier,
            rangeLocation: current.identity.rangeLocation,
            rangeLength: current.identity.rangeLength,
            selectedText: current.identity.selectedText
        )
    }

    private static func stringAttribute(_ attribute: CFString, on element: AXUIElement) -> String? {
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &valueRef) == .success else {
            return nil
        }
        return valueRef as? String
    }

    private static func selectedRange(for element: AXUIElement) -> CFRange? {
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeRef
        ) == .success,
        let rangeRef,
        CFGetTypeID(rangeRef) == AXValueGetTypeID() else { return nil }

        let rangeValue = rangeRef as! AXValue
        var selectedRange = CFRange()
        guard AXValueGetType(rangeValue) == .cfRange,
              AXValueGetValue(rangeValue, .cfRange, &selectedRange),
              selectedRange.location >= 0,
              selectedRange.length > 0 else { return nil }
        return selectedRange
    }

    private static func selectedText(for element: AXUIElement, range: CFRange) -> String? {
        var selectedTextRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            &selectedTextRef
        ) == .success,
        let selectedText = selectedTextRef as? String {
            return (selectedText as NSString).length == range.length ? selectedText : nil
        }

        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &valueRef
        ) == .success,
        let value = valueRef as? String else { return nil }
        let valueLength = (value as NSString).length
        guard range.location <= valueLength,
              range.length <= valueLength - range.location else { return nil }
        return (value as NSString).substring(
            with: NSRange(location: range.location, length: range.length)
        )
    }
}

