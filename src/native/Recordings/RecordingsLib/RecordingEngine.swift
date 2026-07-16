import AVFoundation
@preconcurrency import ApplicationServices
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

struct PasteDeliveryTransaction: Equatable, Sendable {
    let id: UUID
    let text: String
    let generation: UInt64?
}

enum PasteDeliveryOutcome: Equatable, Sendable {
    case pasted
    case targetUnavailable
    case clipboardOwnershipLost
    case clipboardWriteFailed
    case eventPostFailed
}

struct PasteboardWriteResult: Equatable, Sendable {
    let verified: Bool
    let ownershipChangeCount: Int
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
    typealias PastePoster = @MainActor @Sendable () -> Bool
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
            guard self.postPaste() else {
                settlement(transaction, .eventPostFailed)
                self.state = .idle
                completion(transaction, .eventPostFailed)
                return
            }
            completion(transaction, .pasted)
            guard settlementDelay > 0 else {
                settlement(transaction, .pasted)
                self.state = .idle
                return
            }
            self.schedule(settlementDelay) { [weak self] in
                guard let self, self.state == .settling(transaction.id) else { return }
                settlement(transaction, .pasted)
                self.state = .idle
            }
        }
        return true
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

struct RecordingPipelineTrace: Sendable {
    let id = UUID().uuidString
    let startedUptimeMilliseconds = UInt64(ProcessInfo.processInfo.systemUptime * 1_000)

    func message(stage: String, detail: String = "") -> String {
        let nowMilliseconds = UInt64(ProcessInfo.processInfo.systemUptime * 1_000)
        let elapsedMilliseconds = nowMilliseconds >= startedUptimeMilliseconds
            ? nowMilliseconds - startedUptimeMilliseconds
            : 0
        let suffix = detail.isEmpty ? "" : " \(detail)"
        return "pipeline_timing pipeline_id=\(id) stage=\(stage) elapsed_ms=\(elapsedMilliseconds)\(suffix)"
    }
}

public enum RecordingTrigger: Equatable, Sendable {
    case manual
    case fnKey
    case keyboardShortcut
}

struct MicrophonePermissionStartGate {
    private(set) var activeRequestID: UUID?

    var isAwaitingResponse: Bool {
        activeRequestID != nil
    }

    mutating func reserve(requestID: UUID = UUID()) -> UUID? {
        guard activeRequestID == nil else { return nil }
        activeRequestID = requestID
        return requestID
    }

    mutating func consumeResponse(for requestID: UUID) -> Bool {
        guard activeRequestID == requestID else { return false }
        activeRequestID = nil
        return true
    }

    mutating func cancel() {
        activeRequestID = nil
    }
}

struct PasteTargetCandidate: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String?
    let isRegularApp: Bool
    let launchDate: Date?

    init(
        pid: pid_t,
        bundleIdentifier: String?,
        isRegularApp: Bool,
        launchDate: Date? = nil
    ) {
        self.pid = pid
        self.bundleIdentifier = bundleIdentifier
        self.isRegularApp = isRegularApp
        self.launchDate = launchDate
    }
}

struct PasteTargetProcessIdentity: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String
    let launchDate: Date

    func matches(_ candidate: PasteTargetCandidate) -> Bool {
        candidate.pid == pid
            && candidate.bundleIdentifier == bundleIdentifier
            && candidate.launchDate == launchDate
    }
}

enum PasteDeliveryKind: Equatable, Sendable {
    case ordinaryDictation
    case commandRewrite
    case manualPaste
}

private final class PCMStreamPipe: @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private let processor: Task<Data, Never>

    init(chunkSize: Int, client: RealtimeTranscriptionClient?) {
        var streamContinuation: AsyncStream<Data>.Continuation!
        let stream = AsyncStream<Data>(bufferingPolicy: .unbounded) { continuation in
            streamContinuation = continuation
        }
        continuation = streamContinuation
        processor = Task {
            var recordedPCM = Data()
            var pendingChunk = Data()

            for await data in stream {
                guard !data.isEmpty else { continue }
                recordedPCM.append(data)
                pendingChunk.append(data)

                while pendingChunk.count >= chunkSize {
                    await client?.sendAudio(pendingChunk.prefixData(count: chunkSize))
                    pendingChunk.removeFirst(chunkSize)
                }
            }

            if !pendingChunk.isEmpty {
                await client?.sendAudio(pendingChunk)
            }
            return recordedPCM
        }
    }

    func append(_ data: Data) {
        continuation.yield(data)
    }

    func finish() async -> Data {
        continuation.finish()
        return await processor.value
    }

    func cancel() {
        continuation.finish()
        processor.cancel()
    }
}

private extension Data {
    func prefixData(count: Int) -> Data {
        Data(prefix(count))
    }
}

// MARK: - Recording Engine

@MainActor
public final class RecordingEngine: ObservableObject {
    @Published public var isRecording = false
    @Published public var useFnKey: Bool = false {
        didSet {
            UserDefaults.standard.set(useFnKey, forKey: "useFnKey")
            updateFnMonitor()
            updateStatus()
        }
    }
    /// Advanced fallback policy (Settings only): when off, every recording is dictated
    /// literally and the classifier is never consulted.
    @Published public var intentDetectionEnabled: Bool = true {
        didSet {
            UserDefaults.standard.set(intentDetectionEnabled, forKey: "intentDetectionEnabled")
        }
    }
    /// Typed Record-page state; views render idle/listening/finalizing/processing/ready/error
    /// from this instead of parsing `statusMessage`.
    @Published public private(set) var flowPhase: RecordingFlowPhase = .idle
    /// Latest conversational answer. Cleared whenever a new recording starts so a stale reply
    /// can never be attributed to a later recording.
    @Published public private(set) var conversationReply: ConversationReply?
    @Published public var recentTranscriptions: [TranscriptionResult] = []
    @Published public var statusMessage = "Starting..."
    @Published public var isTranscribing = false
    @Published public var recordingDuration: TimeInterval = 0
    @Published public var liveTranscriptionText = ""
    @Published public var transcriptionLanguage = OpenAIAPIKeyStore.defaultLanguage {
        didSet {
            UserDefaults.standard.set(transcriptionLanguage, forKey: "recordingsLanguage")
            try? OpenAIAPIKeyStore.saveLanguage(language: transcriptionLanguage, homePath: home)
        }
    }

    private var nativeRecorder: PCMRecordingSource?
    private var recordingTimer: Timer?
    private var activeTrigger: RecordingTrigger?
    private var microphonePermissionStartGate = MicrophonePermissionStartGate()
    private var keyboardShortcutIsDown = false
    private var fnKeyIsDown = false
    private var targetAppBundleIdentifier: String?
    private var targetAppPid: pid_t?
    private var pasteTargetProcessIdentityByGeneration: [UInt64: PasteTargetProcessIdentity] = [:]
    public var projectStore: ProjectStore?
    public var voiceShortcuts: VoiceShortcuts?

    // MARK: - Injectable boundaries
    // Production defaults perform the real I/O; tests replace them to drive the production
    // start/delivery paths without microphone, Accessibility, network, or CLI access.
    var microphoneAuthorization: () -> AVAuthorizationStatus = {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }
    var accessibilityTrustCheck: @Sendable () -> Bool = { AXIsProcessTrusted() }
    lazy var protectedOperationTrust: () -> AccessibilityTrustResult = { [accessibilityPromptGate] in
        accessibilityPromptGate.trustForProtectedOperation()
    }
    var frontmostAppSnapshot: () -> FrontmostAppSnapshot? = {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return FrontmostAppSnapshot(
            pid: app.processIdentifier,
            bundleIdentifier: app.bundleIdentifier,
            launchDate: app.launchDate
        )
    }
    var recorderFactory: (@escaping @Sendable (Data) -> Void) -> PCMRecordingSource = {
        NativePCMRecorder(onPCM: $0)
    }
    var selectionCapture: @Sendable (pid_t) -> AccessibilitySelectionToken? = {
        AccessibilitySelectionToken.capture(for: $0)
    }
    var focusedWindowTitleLookup: @Sendable (pid_t) -> String? = {
        RecordingEngine.focusedWindowTitle(pid: $0)
    }
    var commandCLI: @Sendable (_ args: [String], _ home: String, _ timeout: TimeInterval) -> String = { args, home, ceiling in
        // The caller's timeout is the public ceiling on *observable* wall time. CLIRunner's
        // total deadline (execution, termination grace, kill grace, pipe drain) sits a full
        // return margin below it: spawn setup, waitid poll granularity, capture shutdown,
        // and the hop back to the caller all run outside CLIRunner's clamped waits and must
        // fit inside the reserved margin.
        let cliDeadline = ceiling - RecordingEngine.commandRewriteReturnMargin
        return CLIRunner.run(args, home: home, timeout: cliDeadline, totalWallClockBudget: cliDeadline)
    }
    /// Resolves and revalidates the frozen rewrite target immediately before a rewrite:
    /// re-finds the recorded target app, activates it, waits for focus to settle, and
    /// re-reads the frozen Accessibility selection. Production performs real NSWorkspace/AX
    /// I/O; tests replace it to drive the rewrite pipeline (Rewriting busy state, CLI
    /// budget, cancellation, staleness) headless.
    lazy var rewriteSelectionResolver: @MainActor (
        _ targetAppBundleIdentifier: String?,
        _ targetAppPid: pid_t?,
        _ selectionToken: AccessibilitySelectionToken?,
        _ pipelineGeneration: UInt64?
    ) async -> RewriteTargetResolution = { [weak self] bundleIdentifier, pid, token, generation in
        guard let self else { return .targetAppMissing }
        return await self.resolveRewriteSelection(
            targetAppBundleIdentifier: bundleIdentifier,
            targetAppPid: pid,
            selectionToken: token,
            pipelineGeneration: generation
        )
    }
    lazy var openAIAPIKeyProvider: () -> String = { [home] in
        OpenAIAPIKeyStore.load(homePath: home)
    }
    /// Test-only delivery tap. When set, a routed paste stops at this boundary — everything
    /// up to it (routing, payload selection, generation guards) is the production path.
    var pasteInterceptorForTesting: (@MainActor (_ text: String, _ deliveryKind: PasteDeliveryKind, _ pipelineGeneration: UInt64?) -> Void)?

    // Real-time streaming
    private var realtimeClient: RealtimeTranscriptionClient?
    private var streamingTask: Task<Void, Never>?
    private var pcmStreamPipe: PCMStreamPipe?
    private var streamingText = ""
    private var recordedPCM = Data()
    private var activeAudioPath: String?
    private let accessibilityPromptGate = AccessibilityPromptGate.processShared
    private(set) var recordingGeneration: UInt64 = 0
    private var activeCaptureConfiguration: RecordingCaptureConfiguration?
    var pipelineDeliveryGate = PipelineDeliveryGate()
    /// Generation whose intent delivery (Deciding/Answering/Rewriting) is in flight, or nil.
    /// Scoped to the generation so a stale completion can never clear a newer pending state.
    private var intentDeliveryPendingGeneration: UInt64?
    lazy var intentClassifier = SpeechIntentClassifier(
        apiKeyProvider: { [home] in OpenAIAPIKeyStore.load(homePath: home) }
    )
    private lazy var pasteTransactionCoordinator = makePasteTransactionCoordinator(
        schedule: { delay, operation in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                MainActor.assumeIsolated { operation() }
            }
        },
        writeAndVerify: { text in
            let pasteboard = NSPasteboard.general
            return RecordingEngine.writeClipboardAttempt(text, to: pasteboard)
        },
        postPaste: {
            let source = CGEventSource(stateID: .hidSystemState)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false) else {
                return false
            }
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cgSessionEventTap)
            up.post(tap: .cgSessionEventTap)
            return true
        }
    )

    /// Every coordinator the engine owns must publish its idle transitions:
    /// `canStartRecording` derives from coordinator state, and settlement back to idle is
    /// otherwise invisible to observers — the menu bar would stay busy with Start disabled
    /// until some unrelated published change.
    private func makePasteTransactionCoordinator(
        schedule: @escaping PasteTransactionCoordinator.Scheduler,
        writeAndVerify: @escaping PasteTransactionCoordinator.PayloadWriter,
        postPaste: @escaping PasteTransactionCoordinator.PastePoster
    ) -> PasteTransactionCoordinator {
        let coordinator = PasteTransactionCoordinator(
            schedule: schedule,
            writeAndVerify: writeAndVerify,
            postPaste: postPaste
        )
        coordinator.pendingTransactionWillChange = { [weak self] in
            self?.objectWillChange.send()
        }
        return coordinator
    }

    #if DEBUG
    /// Test-only: swaps in a coordinator with injected I/O while keeping the production
    /// observation wiring, so settlement observability can be driven deterministically.
    @discardableResult
    func installPasteCoordinatorForTesting(
        schedule: @escaping PasteTransactionCoordinator.Scheduler,
        writeAndVerify: @escaping PasteTransactionCoordinator.PayloadWriter,
        postPaste: @escaping PasteTransactionCoordinator.PastePoster
    ) -> PasteTransactionCoordinator {
        let coordinator = makePasteTransactionCoordinator(
            schedule: schedule,
            writeAndVerify: writeAndVerify,
            postPaste: postPaste
        )
        pasteTransactionCoordinator = coordinator
        return coordinator
    }
    #endif

    private nonisolated static let realtimePeriodicCommitIntervalMilliseconds: UInt64 = 900
    private nonisolated static let realtimeFinishTimeoutMilliseconds: UInt64 = 700
    /// Hard wall-clock budget for the rewrite helper (CLI spawn + one model call), covering
    /// execution *and* CLIRunner's termination grace, kill grace, and pipe drain — not just
    /// the child execution deadline. The user is waiting with recording blocked, so this
    /// matches the interactive answer ceiling (`SpeechIntentClassifier.conversationTimeout`)
    /// — never the generic 120 s CLI ceiling; cancellation stays available the whole time.
    /// The `commandCLI` seam hands CLIRunner `commandRewriteTimeout` minus
    /// `commandRewriteReturnMargin` so the runner's own deadline keeping plus the return
    /// path stays inside this ceiling.
    nonisolated static let commandRewriteTimeout: TimeInterval = 10
    /// Wall-clock margin reserved out of `commandRewriteTimeout` before it becomes
    /// CLIRunner's total deadline. CLIRunner clamps every wait to that deadline but still
    /// pays small unclamped costs around them — spawn setup, waitid poll granularity (each
    /// bounded wait can oversleep one 10 ms poll), synchronous capture shutdown, and the
    /// detached-task hop back to the MainActor. Reserving a full second keeps the
    /// *observable* rewrite time under the public ceiling even when the execution window,
    /// termination grace, and pipe drain all run to exhaustion.
    nonisolated static let commandRewriteReturnMargin: TimeInterval = 1

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    private let fnMonitor = FnKeyMonitor()
    private var permissionRetryTimer: Timer?

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var audioDir: String { "\(home)/.hasna/recordings/audio" }

    public init() {
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)
        log("RecordingEngine init; microphone=\(microphonePermissionLabel); accessibility=\(accessibilityPermissionLabel)")

        // Load preferences
        intentDetectionEnabled = UserDefaults.standard.object(forKey: "intentDetectionEnabled") as? Bool ?? true
        transcriptionLanguage = OpenAIAPIKeyStore.loadLanguage(homePath: home)
        useFnKey = UserDefaults.standard.object(forKey: "useFnKey") as? Bool ?? false
        if KeyboardShortcuts.getShortcut(for: .toggleRecording) == nil {
            KeyboardShortcuts.setShortcut(.init(.f5), for: .toggleRecording)
        }

        // Set up fn key monitor — hold fn to record, release to stop (like WisprFlow)
        fnMonitor.onFnKeyDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = true
                guard self.useFnKey, Self.canBeginRecording(
                    isRecording: self.isRecording,
                    isTranscribing: self.isTranscribing,
                    isAwaitingMicrophonePermission: self.microphonePermissionStartGate.isAwaitingResponse,
                    isDeliveryPending: self.deliveryIsPending
                ) else { return }
                self.startRecording(trigger: .fnKey)
            }
        }
        fnMonitor.onFnKeyUp = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = false
                guard self.useFnKey, self.activeTrigger == .fnKey else { return }
                guard self.isRecording else {
                    self.log("fn released before recording started; cancelling pending start")
                    self.resetRecordingIntent()
                    self.updateStatus()
                    return
                }
                self.stopAndTranscribe()
            }
        }
        updateFnMonitor(allowAutomaticPrompt: false)

        KeyboardShortcuts.onKeyDown(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = true
                guard Self.canBeginRecording(
                    isRecording: self.isRecording,
                    isTranscribing: self.isTranscribing,
                    isAwaitingMicrophonePermission: self.microphonePermissionStartGate.isAwaitingResponse,
                    isDeliveryPending: self.deliveryIsPending
                ) else { return }
                self.startRecording(trigger: .keyboardShortcut)
            }
        }
        KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = false
                guard self.activeTrigger == .keyboardShortcut else { return }
                guard self.isRecording else {
                    self.log("shortcut released before recording started; cancelling pending start")
                    self.resetRecordingIntent()
                    self.updateStatus()
                    return
                }
                self.stopAndTranscribe()
            }
        }

        // Granting Accessibility does not revive a tap that failed to create,
        // so retry until permissions arrive instead of requiring a relaunch.
        permissionRetryTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.useFnKey, !self.fnMonitor.isRunning, AXIsProcessTrusted() else { return }
                self.log("accessibility granted — retrying fn monitor")
                self.updateFnMonitor()
            }
        }

        updateStatus()
    }

    public var microphonePermissionLabel: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return "Microphone allowed"
        case .notDetermined:
            return "Microphone not requested"
        case .denied:
            return "Microphone denied"
        case .restricted:
            return "Microphone restricted"
        @unknown default:
            return "Microphone unknown"
        }
    }

    public var accessibilityPermissionLabel: String {
        AXIsProcessTrusted() ? "Accessibility allowed" : "Accessibility needed"
    }

    public func requestMicrophonePermission() {
        log("requestMicrophonePermission status=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log("requestMicrophonePermission result granted=\(granted)")
                self.statusMessage = granted
                    ? "Microphone allowed"
                    : "Enable Microphone permission for Recordings in System Settings"
                self.objectWillChange.send()
            }
        }
    }

    public func requestAccessibilityPermission() {
        let result = accessibilityPromptGate.requestExplicitly()
        log("requestAccessibilityPermission trusted=\(result.trusted)")
        statusMessage = result.trusted
            ? "Accessibility allowed"
            : "Enable Accessibility permission for Recordings to paste"
        objectWillChange.send()
    }

    public func openMicrophoneSettings() {
        openPrivacySettings("Privacy_Microphone")
    }

    public func openAccessibilitySettings() {
        openPrivacySettings("Privacy_Accessibility")
    }

    private func openPrivacySettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func updateFnMonitor(allowAutomaticPrompt: Bool = true) {
        if useFnKey {
            let ok = fnMonitor.start()
            log("fn monitor start ok=\(ok)")
            if !ok {
                if allowAutomaticPrompt {
                    let result = accessibilityPromptGate.trustForProtectedOperation()
                    log("fn monitor accessibility trusted=\(result.trusted) prompted=\(result.didPrompt)")
                }
                statusMessage = "fn needs Input Monitoring / Accessibility permission, and Globe must be set to Do Nothing"
            }
        } else {
            fnMonitor.stop()
        }
    }

    public func updateStatus() {
        if isRecording || isTranscribing || deliveryIsPending { return }
        statusMessage = "Ready"
        flowPhase = .idle
    }

    // MARK: - Toggle

    public func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording(trigger: .manual) }
    }

    // MARK: - Start Recording (Streaming)

    public func startRecording(trigger: RecordingTrigger = .manual) {
        guard Self.canBeginRecording(
            isRecording: isRecording,
            isTranscribing: isTranscribing,
            isAwaitingMicrophonePermission: microphonePermissionStartGate.isAwaitingResponse,
            isDeliveryPending: deliveryIsPending
        ) else {
            if isTranscribing {
                statusMessage = "Finish transcribing before recording again"
            } else if deliveryIsPending {
                statusMessage = "Still delivering the last recording"
            }
            return
        }
        log("startRecording trigger=\(trigger) microphoneStatus=\(microphoneAuthorization().rawValue) accessibility=\(accessibilityTrustCheck())")
        recordingGeneration &+= 1
        if pasteTargetProcessIdentityByGeneration.count >= 32 {
            let oldestRetainedGeneration = recordingGeneration > 16 ? recordingGeneration - 16 : 0
            pasteTargetProcessIdentityByGeneration = pasteTargetProcessIdentityByGeneration.filter {
                $0.key >= oldestRetainedGeneration
            }
        }
        activeTrigger = trigger
        keyboardShortcutIsDown = trigger == .keyboardShortcut
        conversationReply = nil

        let myPID = ProcessInfo.processInfo.processIdentifier
        let frontmostApp = frontmostAppSnapshot()
        let isOwnApp = frontmostApp?.pid == myPID
        targetAppBundleIdentifier = isOwnApp ? nil : frontmostApp?.bundleIdentifier
        targetAppPid = isOwnApp ? nil : frontmostApp?.pid
        if !isOwnApp,
           let pid = frontmostApp?.pid,
           let bundleIdentifier = frontmostApp?.bundleIdentifier,
           let launchDate = frontmostApp?.launchDate {
            pasteTargetProcessIdentityByGeneration[recordingGeneration] = PasteTargetProcessIdentity(
                pid: pid,
                bundleIdentifier: bundleIdentifier,
                launchDate: launchDate
            )
        } else {
            pasteTargetProcessIdentityByGeneration[recordingGeneration] = nil
        }

        // The selection is still frozen for every recording (not only an exposed "command
        // mode"), so a later command decision can only ever act on the exact text and
        // element that were selected when the user started speaking. The Accessibility IPC
        // that reads it runs on a detached task, concurrently with recorder start: the
        // microphone must never wait on a beachballing target app, and the MainActor stays
        // free to process the key-up that stops the recording. Skipped entirely when intent
        // detection is off — no command route exists to consume it.
        let shouldCaptureSelection = Self.shouldCaptureSelection(
            targetPid: targetAppPid,
            accessibilityTrusted: accessibilityTrustCheck(),
            intentDetectionEnabled: intentDetectionEnabled
        )
        let capturePid = targetAppPid
        let captureSelection = selectionCapture
        let windowTitleLookup = focusedWindowTitleLookup
        let windowTitlePid = frontmostApp?.pid
        let axSnapshotTask = Task.detached(priority: .userInitiated) { () -> RecordingStartAXSnapshot in
            let selectionToken = shouldCaptureSelection ? capturePid.flatMap { captureSelection($0) } : nil
            let focusedWindowTitle = windowTitlePid.flatMap { windowTitleLookup($0) }
            return RecordingStartAXSnapshot(
                selectionToken: selectionToken,
                focusedWindowTitle: focusedWindowTitle
            )
        }

        // Project auto-selection and the processing configuration resolve with the
        // snapshot, still once per recording start and frozen for this generation; the
        // recording pipeline awaits this context only after the recorder has stopped.
        let generation = recordingGeneration
        let projectStore = projectStore
        let targetBundleIdentifierForProjects = targetAppBundleIdentifier
        let transcriptionLanguageAtStart = transcriptionLanguage
        let intentDetectionEnabledAtStart = intentDetectionEnabled
        let homePath = home
        let startContext = Task { @MainActor [weak self] () -> RecordingStartResolvedContext in
            let axSnapshot = await axSnapshotTask.value
            if let self, generation == self.recordingGeneration, let store = projectStore {
                let projects = store.settings.projects
                let detected = ProjectStore.matchProject(
                    windowTitle: axSnapshot.focusedWindowTitle,
                    bundleId: targetBundleIdentifierForProjects,
                    projects: projects
                )
                if let detected,
                   detected.id != store.settings.activeProjectId,
                   store.canMutateProjects {
                    do {
                        try store.setActive(detected.id)
                    } catch {
                        self.log("project auto-selection failed; continuing capture with the last active project: \(error.localizedDescription)")
                    }
                }
                if let warning = store.synchronizationError ?? store.persistenceError {
                    self.log("project synchronization degraded; continuing capture: \(warning)")
                }
            }
            let modelSelection = OpenAIAPIKeyStore.loadProcessingModelSelection(homePath: homePath)
            return RecordingStartResolvedContext(
                selectionToken: axSnapshot.selectionToken,
                canonicalProjectId: projectStore?.activeCanonicalProjectIdForRecording,
                displayProjectId: projectStore?.settings.activeProjectId,
                activeProjectName: projectStore?.activeProject?.name,
                processing: RecordingProcessingConfiguration(
                    transcriptionPrompt: modelSelection.transcriptionPrompt,
                    transcriberPrompt: projectStore?.effectiveSystemPrompt ?? "",
                    postProcessingMode: projectStore?.effectivePostProcessingMode ?? PostProcessingMode.auto.rawValue,
                    transcriptionLanguage: transcriptionLanguageAtStart,
                    transcriptionModel: modelSelection.transcriptionModel,
                    transcriberModel: modelSelection.transcriberModel,
                    enhancementModel: modelSelection.enhancementModel,
                    intentModel: modelSelection.intentModel,
                    intentDetectionEnabled: intentDetectionEnabledAtStart,
                    enhanceTriggersJSON: modelSelection.enhanceTriggersJSON,
                    keywordTransformsJSON: modelSelection.keywordTransformsJSON
                )
            )
        }

        switch microphoneAuthorization() {
        case .authorized:
            startNativeRecording(startContext: startContext)
        case .notDetermined:
            guard let requestID = microphonePermissionStartGate.reserve() else { return }
            statusMessage = "Allow microphone access to record"
            log("requesting microphone access before recording")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard self.microphonePermissionStartGate.consumeResponse(for: requestID) else {
                        self.log("ignoring stale microphone permission response")
                        return
                    }
                    self.log("microphone access response granted=\(granted)")
                    if granted {
                        guard self.shouldContinueStarting(trigger: trigger) else {
                            self.log("recording start cancelled before microphone permission completed trigger=\(trigger)")
                            self.resetRecordingIntent()
                            self.updateStatus()
                            return
                        }
                        self.startNativeRecording(startContext: startContext)
                    } else {
                        self.resetRecordingIntent()
                        self.statusMessage = "Microphone permission denied"
                        self.flowPhase = .failed(self.statusMessage)
                    }
                }
            }
        case .denied, .restricted:
            resetRecordingIntent()
            log("microphone permission blocked status=\(microphoneAuthorization().rawValue)")
            statusMessage = "Enable Microphone permission for Recordings in System Settings"
            flowPhase = .failed(statusMessage)
        @unknown default:
            resetRecordingIntent()
            statusMessage = "Microphone permission unavailable"
            flowPhase = .failed(statusMessage)
        }
    }

    nonisolated static func canBeginRecording(
        isRecording: Bool,
        isTranscribing: Bool,
        isAwaitingMicrophonePermission: Bool = false,
        isDeliveryPending: Bool = false
    ) -> Bool {
        !isRecording && !isTranscribing && !isAwaitingMicrophonePermission && !isDeliveryPending
    }

    nonisolated static func shouldCaptureSelection(
        targetPid: pid_t?,
        accessibilityTrusted: Bool,
        intentDetectionEnabled: Bool
    ) -> Bool {
        targetPid != nil && accessibilityTrusted && intentDetectionEnabled
    }

    nonisolated static func recordingStatus(
        trigger: RecordingTrigger
    ) -> String {
        switch trigger {
        case .manual: "Recording — click Stop when finished"
        case .fnKey, .keyboardShortcut: "Recording — release to stop"
        }
    }

    private var deliveryIsPending: Bool {
        intentDeliveryPendingGeneration != nil || pasteTransactionCoordinator.hasPendingTransaction
    }

    private func beginIntentDelivery(for generation: UInt64) {
        intentDeliveryPendingGeneration = generation
    }

    private func endIntentDelivery(for generation: UInt64) {
        if intentDeliveryPendingGeneration == generation {
            intentDeliveryPendingGeneration = nil
        }
    }

    /// Truthful start availability for UI surfaces. Mirrors exactly the gate
    /// `startRecording` applies, so a menu bar or button can never present Start while the
    /// engine would reject it.
    public var canStartRecording: Bool {
        Self.canBeginRecording(
            isRecording: isRecording,
            isTranscribing: isTranscribing,
            isAwaitingMicrophonePermission: microphonePermissionStartGate.isAwaitingResponse,
            isDeliveryPending: deliveryIsPending
        )
    }

    /// Whether an in-flight Deciding/Answering/Rewriting delivery can be cancelled. Once a
    /// paste transaction is submitted the remaining window is sub-second and has its own
    /// target/clipboard safety rails, so cancellation stops being offered.
    public var canCancelIntentDelivery: Bool {
        intentDeliveryPendingGeneration != nil && !pasteTransactionCoordinator.hasPendingTransaction
    }

    /// Cancels the pending intent delivery. Every phase that can be pending here —
    /// Deciding, Answering, Rewriting — inserted the transcript into Recent before the
    /// phase began (and the recording was already persisted to the library), so cancelling
    /// only abandons the delivery: "transcript saved to Recent" is literally true. Bumping
    /// the generation makes every in-flight completion stale, and every completion path
    /// re-checks the generation before touching state, the clipboard, or the target app —
    /// a cancelled decision, answer, or rewrite can never land later.
    public func cancelIntentProcessing() {
        guard canCancelIntentDelivery else { return }
        log("intent delivery cancelled by user generation=\(recordingGeneration)")
        recordingGeneration &+= 1
        intentDeliveryPendingGeneration = nil
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = "Cancelled — transcript saved to Recent"
        flowPhase = .idle
    }

    #if DEBUG
    /// Test-only: advances and registers a pipeline generation the way a recording
    /// start/stop pair would, so delivery tests can drive `finishWithText` repeatedly.
    func beginPipelineForTesting() -> UInt64 {
        recordingGeneration &+= 1
        pipelineDeliveryGate.registerPipeline(recordingGeneration)
        return recordingGeneration
    }
    #endif

    /// Single staleness rule for generation-bound deliveries: anything bound to a
    /// superseded generation — or arriving mid-recording — is abandoned.
    nonisolated static func shouldAbandonDelivery(
        pipelineGeneration: UInt64?,
        currentGeneration: UInt64,
        isRecording: Bool
    ) -> Bool {
        guard let pipelineGeneration else { return false }
        return isRecording || pipelineGeneration != currentGeneration
    }

    nonisolated static func shouldContinueStartingAfterPermission(
        trigger: RecordingTrigger,
        keyboardShortcutIsDown: Bool,
        fnKeyIsDown: Bool
    ) -> Bool {
        switch trigger {
        case .manual:
            return true
        case .keyboardShortcut:
            return keyboardShortcutIsDown
        case .fnKey:
            return fnKeyIsDown
        }
    }

    private func shouldContinueStarting(trigger: RecordingTrigger) -> Bool {
        activeTrigger == trigger && Self.shouldContinueStartingAfterPermission(
            trigger: trigger,
            keyboardShortcutIsDown: keyboardShortcutIsDown,
            fnKeyIsDown: fnKeyIsDown
        )
    }

    private func startNativeRecording(startContext: Task<RecordingStartResolvedContext, Never>) {
        let apiKey = openAIAPIKeyProvider()
        let captureConfiguration = RecordingCaptureConfiguration(
            targetAppBundleIdentifier: targetAppBundleIdentifier,
            targetAppPid: targetAppPid,
            startContext: startContext
        )
        activeCaptureConfiguration = captureConfiguration
        log("startNativeRecording apiKeyConfigured=\(!apiKey.isEmpty)")
        if !apiKey.isEmpty {
            startRealtimeStreaming(
                apiKey: apiKey,
                transcriptionLanguage: transcriptionLanguage
            )
        }

        let client = realtimeClient
        let streamPipe = PCMStreamPipe(chunkSize: 4_800, client: client)
        pcmStreamPipe = streamPipe
        let homePath = home
        let firstChunkLogged = LockedFlag()
        let recorder = recorderFactory { data in
            if firstChunkLogged.take() {
                NativeAppLog.write("native recorder received first PCM chunk bytes=\(data.count)", homePath: homePath)
            }
            streamPipe.append(data)
        }

        do {
            try recorder.start()
            log("native recorder started")
            nativeRecorder = recorder
            isRecording = true
            recordingDuration = 0
            streamingText = ""
            liveTranscriptionText = ""
            recordedPCM.removeAll(keepingCapacity: true)
            activeAudioPath = "\(audioDir)/recording-\(Self.timestampForFilename()).wav"
            let trigger = activeTrigger ?? .manual
            statusMessage = Self.recordingStatus(trigger: trigger)
            flowPhase = .listening

            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.recordingDuration += 0.1
                }
            }
        } catch {
            log("native recorder failed error=\(error.localizedDescription)")
            realtimeClient?.stop()
            realtimeClient = nil
            streamingTask?.cancel()
            streamingTask = nil
            pcmStreamPipe?.cancel()
            pcmStreamPipe = nil
            activeCaptureConfiguration = nil
            resetRecordingIntent()
            statusMessage = "Failed: \(error.localizedDescription)"
            flowPhase = .failed(statusMessage)
        }
    }

    // MARK: - Real-time Streaming

    private func startRealtimeStreaming(apiKey: String, transcriptionLanguage: String) {
        let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)
        realtimeClient = client
        let language = OpenAIAPIKeyStore.apiLanguageHint(for: transcriptionLanguage)
        log("realtime streaming task starting language=\(language.isEmpty ? "auto" : language)")

        streamingTask = Task {
            await client.startStreaming(language: language)
            self.log("realtime start completed streaming=\(client.isStreaming) error=\(client.error ?? "")")

            var lastPeriodicCommitAt: UInt64?

            // Receive deltas
            while client.isStreaming {
                try? await Task.sleep(for: .milliseconds(100))
                let now = Self.monotonicMilliseconds()
                let periodicCommitIsDue = Self.realtimePeriodicCommitIsDue(
                    nowMilliseconds: now,
                    lastCommitMilliseconds: lastPeriodicCommitAt
                )
                if self.isRecording, periodicCommitIsDue {
                    if await client.commitInput(reason: "periodic") {
                        lastPeriodicCommitAt = now
                    }
                }
                let text = client.accumulatedText
                if text != streamingText {
                    await MainActor.run {
                        self.streamingText = text
                        self.liveTranscriptionText = Self.cleanRealtimeArtifactText(text)
                    }
                }
            }

            if let message = client.error, !message.isEmpty {
                await MainActor.run {
                    self.log("realtime unavailable message=\(message)")
                    if self.isRecording {
                        self.statusMessage = "Live preview unavailable — will transcribe after recording"
                    }
                }
            }
        }
    }

    // MARK: - Cancel (discard without transcribing)

    public func cancelRecording() {
        guard isRecording else { return }
        log("cancelRecording")

        recordingTimer?.invalidate()
        recordingTimer = nil

        let recorder = nativeRecorder
        nativeRecorder = nil
        recorder?.stop()

        realtimeClient?.stop()
        realtimeClient = nil
        streamingTask?.cancel()
        streamingTask = nil
        pcmStreamPipe?.cancel()
        pcmStreamPipe = nil

        isRecording = false
        isTranscribing = false
        liveTranscriptionText = ""
        recordedPCM.removeAll(keepingCapacity: true)
        activeAudioPath = nil
        activeCaptureConfiguration = nil
        resetRecordingIntent()
        statusMessage = "Ready"
        flowPhase = .idle
    }

    // MARK: - Stop & Transcribe

    public func stopAndTranscribe() {
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
                timeoutMilliseconds: Self.realtimeFinishTimeoutMilliseconds,
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
                    intentDetectionEnabled: processingConfiguration.intentDetectionEnabled
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
                    self.finish(resolved.failureStatus ?? "No audio captured")
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

    /// Delivery may only run ahead of persistence for transcripts the local screen already
    /// decided are plain dictation: the paste is near-instant, so persistence is deferred by
    /// milliseconds. Command/conversation-shaped transcripts persist first — their delivery
    /// can block on the classifier, the assistant, or the rewrite CLI, and the recording
    /// must already be durable by then.
    nonisolated static func shouldPasteBeforePersistence(
        postProcessingMode: String,
        transcript: String,
        hasSelection: Bool,
        intentDetectionEnabled: Bool
    ) -> Bool {
        guard PostProcessingMode(rawValue: postProcessingMode) == .off else { return false }
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

    private nonisolated static func removeStandaloneRealtimeArtifacts(from text: String) -> String {
        let artifactTokens: Set<String> = ["어", "음", "um", "umm", "uh", "uhh", "erm", "hmm", "eh"]
        let words = text.split(separator: " ").compactMap { rawWord -> String? in
            let normalized = rawWord
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            return artifactTokens.contains(normalized) ? nil : String(rawWord)
        }
        return words.joined(separator: " ")
    }

    private nonisolated static func normalizedTranscriptText(_ text: String) -> String {
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

    private nonisolated static func canonicalTranscriptWords(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).compactMap { rawWord in
            let normalized = String(rawWord)
                .trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines))
                .lowercased()
            guard !normalized.isEmpty else { return nil }
            return normalized
        }
    }

    private nonisolated static func canonicalTranscriptWordsPreservingSpeechTokens(_ text: String) -> [String] {
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

    private nonisolated static func collapseAdjacentDuplicateWords(in text: String) -> String {
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

    private nonisolated static func collapseAdjacentDuplicatePhrases(in text: String) -> String {
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

    private nonisolated static func normalizedTranscriptWord(_ word: String) -> String {
        word.trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines)).lowercased()
    }

    private nonisolated static func latinLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter { scalar in
            (65...90).contains(Int(scalar.value)) || (97...122).contains(Int(scalar.value))
        }.count
    }

    private nonisolated static func cjkLetterCount(in text: String) -> Int {
        text.unicodeScalars.filter(isCJKScalar).count
    }

    private nonisolated static func containsCJKArtifact(in text: String) -> Bool {
        cjkLetterCount(in: text) > 0
    }

    private nonisolated static func isCJKScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF:
            return true
        default:
            return false
        }
    }

    func finishWithText(
        _ text: String,
        rawTranscript: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        activeProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace? = nil,
        pipelineGeneration: UInt64? = nil,
        deliveryCompleted: (@MainActor @Sendable () -> Void)? = nil
    ) {
        log("finishWithText chars=\(text.count) rawChars=\(rawTranscript.count)")
        if let pipelineGeneration,
           !pipelineDeliveryGate.claimDelivery(for: pipelineGeneration) {
            log("duplicate delivery suppressed pipeline_generation=\(pipelineGeneration)")
            deliveryCompleted?()
            return
        }
        // A delivery whose recording has been superseded (or that would land mid-recording)
        // is abandoned outright: the transcript is persisted to the library, and nothing may
        // paste into whatever the user is doing now.
        if isRecording || Self.shouldAbandonDelivery(
            pipelineGeneration: pipelineGeneration,
            currentGeneration: recordingGeneration,
            isRecording: isRecording
        ) {
            log("delivery abandoned for superseded recording pipeline_generation=\(pipelineGeneration.map(String.init) ?? "nil")")
            deliveryCompleted?()
            return
        }

        let execute: @MainActor @Sendable (RoutedSpeechAction, IntentDecisionOrigin, Bool) -> Void = { [weak self] action, origin, transcriptRetainedInRecent in
            guard let self else {
                deliveryCompleted?()
                return
            }
            self.executeRoutedAction(
                action,
                origin: origin,
                transcriptRetainedInRecent: transcriptRetainedInRecent,
                text: text,
                rawTranscript: rawTranscript,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                selectionToken: selectionToken,
                canonicalProjectId: canonicalProjectId,
                activeProjectId: activeProjectId,
                activeProjectName: activeProjectName,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        }

        // Voice shortcuts are explicit user-configured expansions and take precedence over
        // intent inference, exactly as they preceded routing before this flow existed.
        if let shortcutText = voiceShortcuts?.match(rawTranscript) {
            log("voice shortcut matched — pasting shortcut content")
            pasteIntoFrontApp(
                shortcutText,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                restoreClipboard: true,
                deliveryKind: .ordinaryDictation,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
            insertRecentTranscription(
                rawText: rawTranscript,
                processedText: shortcutText,
                projectId: activeProjectId,
                projectName: activeProjectName
            )
            return
        }

        // Intent is always decided on the raw transcript — never on post-processed output,
        // which the enhancement pipeline may have rewritten.
        let routingContext = IntentRoutingContext(
            detectionEnabled: processingConfiguration.intentDetectionEnabled,
            hasSelection: selectionToken != nil,
            accessibilityTrusted: accessibilityTrustCheck()
        )
        if !routingContext.detectionEnabled {
            execute(IntentRouter.route(decision: nil, context: routingContext), .localScreen, false)
            return
        }
        if let localDecision = IntentScreen.screen(text: rawTranscript, hasSelection: routingContext.hasSelection) {
            log("intent decided locally intent=\(localDecision.intent.rawValue) reason=\(localDecision.reason)")
            execute(
                IntentRouter.route(decision: localDecision, context: routingContext),
                .localScreen,
                false
            )
            return
        }

        // Consult the classifier. New recordings are blocked while the decision is pending,
        // and the generation is re-checked afterwards so a stale (or user-cancelled)
        // decision can never act on a later recording.
        // The transcript enters Recent before the pending phase begins: cancelling while
        // Deciding (or any later phase) promises "transcript saved to Recent", so it must
        // already be there.
        insertRecentTranscription(
            rawText: rawTranscript,
            processedText: nil,
            projectId: activeProjectId,
            projectName: activeProjectName
        )
        let deliveryGeneration = pipelineGeneration ?? recordingGeneration
        beginIntentDelivery(for: deliveryGeneration)
        updateDeliveryStatus("Deciding...", kind: .progress, pipelineGeneration: pipelineGeneration)
        if let pipelineTrace { log(pipelineTrace.message(stage: "intent_classification_started")) }
        let classifier = intentClassifier
        let intentModel = processingConfiguration.intentModel
        let hasSelection = routingContext.hasSelection
        let trustCheck = accessibilityTrustCheck
        Task { [weak self] in
            let outcome = await classifier.classify(
                transcript: rawTranscript,
                hasSelection: hasSelection,
                model: intentModel
            )
            guard let self else {
                deliveryCompleted?()
                return
            }
            self.endIntentDelivery(for: deliveryGeneration)
            guard deliveryGeneration == self.recordingGeneration, !self.isRecording else {
                self.log("stale intent decision abandoned pipeline_generation=\(deliveryGeneration)")
                deliveryCompleted?()
                return
            }
            let decision: IntentDecision?
            switch outcome {
            case .decision(let classified):
                decision = classified
                self.log("intent classified intent=\(classified.intent.rawValue) confidence=\(classified.confidence) reason=\(classified.reason)")
            case .unavailable(let message):
                decision = nil
                self.log("intent classifier unavailable — failing closed to dictation: \(message)")
            }
            if let pipelineTrace { self.log(pipelineTrace.message(stage: "intent_classification_complete")) }
            let action = IntentRouter.route(
                decision: decision,
                context: IntentRoutingContext(
                    detectionEnabled: true,
                    hasSelection: hasSelection,
                    accessibilityTrusted: trustCheck()
                )
            )
            execute(action, .classifier, true)
        }
    }

    private func executeRoutedAction(
        _ action: RoutedSpeechAction,
        origin: IntentDecisionOrigin,
        transcriptRetainedInRecent: Bool,
        text: String,
        rawTranscript: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        activeProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace?,
        pipelineGeneration: UInt64?,
        deliveryCompleted: (@MainActor @Sendable () -> Void)?
    ) {
        switch action {
        case .paste(let reason, let literalRawTranscript):
            log("intent route=paste origin=\(origin.rawValue) literal=\(literalRawTranscript) reason=\(reason)")
            let output = literalRawTranscript ? rawTranscript : text
            pasteIntoFrontApp(
                output,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                restoreClipboard: true,
                deliveryKind: .ordinaryDictation,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
            if transcriptRetainedInRecent {
                attachProcessedTextToRecentTranscription(
                    rawText: rawTranscript,
                    processedText: output == rawTranscript ? nil : output
                )
            } else {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: output == rawTranscript ? nil : output,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
        case .rewriteSelection(let reason):
            log("intent route=rewriteSelection origin=\(origin.rawValue) reason=\(reason)")
            // Retention before processing: the Rewriting phase can be cancelled (or fail),
            // and the Cancel affordance promises the transcript stays in Recent.
            if !transcriptRetainedInRecent {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: nil,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
            runCommandMode(
                instruction: rawTranscript,
                targetAppBundleIdentifier: targetAppBundleIdentifier,
                targetAppPid: targetAppPid,
                selectionToken: selectionToken,
                canonicalProjectId: canonicalProjectId,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        case .answerConversation(let reason):
            log("intent route=answerConversation origin=\(origin.rawValue) reason=\(reason)")
            if !transcriptRetainedInRecent {
                insertRecentTranscription(
                    rawText: rawTranscript,
                    processedText: nil,
                    projectId: activeProjectId,
                    projectName: activeProjectName
                )
            }
            runConversationMode(
                question: rawTranscript,
                processingConfiguration: processingConfiguration,
                pipelineTrace: pipelineTrace,
                pipelineGeneration: pipelineGeneration,
                deliveryCompleted: deliveryCompleted
            )
        }
    }

    private func insertRecentTranscription(
        rawText: String,
        processedText: String?,
        projectId: String?,
        projectName: String?
    ) {
        recentTranscriptions.insert(
            TranscriptionResult(
                rawText: rawText,
                processedText: processedText,
                timestamp: Date(),
                projectId: projectId,
                projectName: projectName
            ),
            at: 0
        )
        if recentTranscriptions.count > 20 { recentTranscriptions.removeLast() }
    }

    /// Backfills the processed text onto a transcript that entered Recent when its pending
    /// phase began, so the entry shows exactly what was pasted. The original timestamp is
    /// preserved.
    private func attachProcessedTextToRecentTranscription(rawText: String, processedText: String?) {
        guard let processedText,
              let index = recentTranscriptions.firstIndex(where: { $0.rawText == rawText }) else { return }
        let existing = recentTranscriptions[index]
        recentTranscriptions[index] = TranscriptionResult(
            rawText: existing.rawText,
            processedText: processedText,
            timestamp: existing.timestamp,
            projectId: existing.projectId,
            projectName: existing.projectName
        )
    }

    private func writeCapturedWAV(to path: String) -> Bool {
        guard !recordedPCM.isEmpty else { return false }
        do {
            try Self.writeWAV(
                pcmData: recordedPCM,
                sampleRate: 24_000,
                channelCount: 1,
                bitsPerSample: 16,
                to: URL(fileURLWithPath: path)
            )
            log("wrote wav path=\(path) pcmBytes=\(recordedPCM.count)")
            return true
        } catch {
            log("failed to save wav error=\(error.localizedDescription)")
            statusMessage = "Failed to save audio"
            return false
        }
    }

    private nonisolated static func saveRealtimeTranscript(
        text: String,
        audioPath: String?,
        pcmData: Data,
        durationMs: Int,
        activeProjectId: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        language: String,
        recordingId: String,
        homePath: String,
        pipelineTrace: RecordingPipelineTrace
    ) async -> RealtimeFastPathSaveResult {
        await Task.detached(priority: .utility) {
            do {
                var savedAudioPath: String?
                if let audioPath, !pcmData.isEmpty {
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "wav_write_started", detail: "pcm_bytes=\(pcmData.count)"),
                        homePath: homePath
                    )
                    try Self.writeWAV(
                        pcmData: pcmData,
                        sampleRate: 24_000,
                        channelCount: 1,
                        bitsPerSample: 16,
                        to: URL(fileURLWithPath: audioPath)
                    )
                    savedAudioPath = audioPath
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "wav_write_complete", detail: "path=\(audioPath) pcm_bytes=\(pcmData.count)"),
                        homePath: homePath
                    )
                }

                let textFile = try Self.writeTemporaryTranscript(text: text, homePath: homePath)
                defer { try? FileManager.default.removeItem(atPath: textFile) }

                let args = saveTextCLIArgs(
                    textFile: textFile,
                    audioPath: savedAudioPath,
                    activeProjectId: activeProjectId,
                    transcriberPrompt: processingConfiguration.transcriberPrompt,
                    postProcessingMode: processingConfiguration.postProcessingMode,
                    language: language,
                    transcriptionModel: processingConfiguration.transcriptionModel,
                    transcriberModel: processingConfiguration.transcriberModel,
                    enhancementModel: processingConfiguration.enhancementModel,
                    enhanceTriggersJSON: processingConfiguration.enhanceTriggersJSON,
                    keywordTransformsJSON: processingConfiguration.keywordTransformsJSON,
                    recordingId: recordingId,
                    durationMs: durationMs,
                    source: "realtime_fast_path",
                    modelUsed: RealtimeTranscriptionClient.transcriptionModelID
                )
                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_started", detail: "operation=save_text"),
                    homePath: homePath
                )
                let output = CLIRunner.run(args, home: homePath)
                if let error = CLIRunner.parseError(output) {
                    NativeAppLog.write(
                        pipelineTrace.message(stage: "helper_processing_store_failed", detail: "error=\(NativeErrorSanitizer.sanitize(error))"),
                        homePath: homePath
                    )
                    return RealtimeFastPathSaveResult(text: nil, error: error)
                }

                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_processing_store_complete"),
                    homePath: homePath
                )
                return RealtimeFastPathSaveResult(text: CLIRunner.parseJSON(output) ?? text, error: nil)
            } catch {
                NativeAppLog.write(
                    pipelineTrace.message(stage: "persistence_failed", detail: "error=\(NativeErrorSanitizer.sanitize(error.localizedDescription))"),
                    homePath: homePath
                )
                return RealtimeFastPathSaveResult(text: nil, error: error.localizedDescription)
            }
        }.value
    }

    private nonisolated static func writeTemporaryTranscript(text: String, homePath: String) throws -> String {
        let dir = URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("recordings", isDirectory: true)
            .appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("realtime-\(UUID().uuidString).txt")
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    private nonisolated static func writeWAV(pcmData: Data, sampleRate: UInt32, channelCount: UInt16, bitsPerSample: UInt16, to url: URL) throws {
        let byteRate = sampleRate * UInt32(channelCount) * UInt32(bitsPerSample / 8)
        let blockAlign = channelCount * (bitsPerSample / 8)
        let dataSize = UInt32(pcmData.count)
        let fileSize = UInt32(36) + dataSize

        var wav = Data()
        func appendASCII(_ string: String) {
            wav.append(contentsOf: string.utf8)
        }
        func appendUInt16LE(_ value: UInt16) {
            wav.append(UInt8(value & 0xff))
            wav.append(UInt8((value >> 8) & 0xff))
        }
        func appendUInt32LE(_ value: UInt32) {
            wav.append(UInt8(value & 0xff))
            wav.append(UInt8((value >> 8) & 0xff))
            wav.append(UInt8((value >> 16) & 0xff))
            wav.append(UInt8((value >> 24) & 0xff))
        }

        appendASCII("RIFF")
        appendUInt32LE(fileSize)
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32LE(16)
        appendUInt16LE(1)
        appendUInt16LE(channelCount)
        appendUInt32LE(sampleRate)
        appendUInt32LE(byteRate)
        appendUInt16LE(blockAlign)
        appendUInt16LE(bitsPerSample)
        appendASCII("data")
        appendUInt32LE(dataSize)
        wav.append(pcmData)

        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try wav.write(to: url, options: .atomic)
    }

    private static func timestampForFilename() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return formatter.string(from: Date())
    }

    // MARK: - Fallback Transcription

    private func recoverAsyncPersistenceFailure(
        error: String,
        audioPath: String?,
        pcmData: Data,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        displayProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        pipelineTrace: RecordingPipelineTrace,
        pipelineGeneration: UInt64
    ) {
        let sanitizedError = NativeErrorSanitizer.sanitize(error)
        log(pipelineTrace.message(
            stage: "async_persistence_failed",
            detail: "error=\(sanitizedError)"
        ))
        updateBackgroundRecoveryStatus(
            "Pasted; recovering recording...",
            kind: .success,
            pipelineGeneration: pipelineGeneration
        )

        Task.detached {
            let recoveryAudioPath = Self.ensureBackgroundRecoveryAudio(
                audioPath: audioPath,
                pcmData: pcmData
            )

            await MainActor.run {
                guard let recoveryAudioPath else {
                    self.updateBackgroundRecoveryStatus(
                        "Pasted, but recording could not be saved: \(sanitizedError)",
                        kind: .failure,
                        pipelineGeneration: pipelineGeneration
                    )
                    return
                }
                self.fallbackTranscribe(
                    audioPath: recoveryAudioPath,
                    targetAppBundleIdentifier: targetAppBundleIdentifier,
                    targetAppPid: targetAppPid,
                    selectionToken: selectionToken,
                    canonicalProjectId: canonicalProjectId,
                    displayProjectId: displayProjectId,
                    activeProjectName: activeProjectName,
                    processingConfiguration: processingConfiguration,
                    realtimeText: nil,
                    pipelineTrace: pipelineTrace,
                    deliverResult: false,
                    backgroundRecoveryGeneration: pipelineGeneration
                )
            }
        }
    }

    nonisolated static func ensureBackgroundRecoveryAudio(
        audioPath: String?,
        pcmData: Data
    ) -> String? {
        guard let audioPath else { return nil }
        if FileManager.default.fileExists(atPath: audioPath) {
            return audioPath
        }
        guard !pcmData.isEmpty else { return nil }
        do {
            try writeWAV(
                pcmData: pcmData,
                sampleRate: 24_000,
                channelCount: 1,
                bitsPerSample: 16,
                to: URL(fileURLWithPath: audioPath)
            )
            return audioPath
        } catch {
            return nil
        }
    }

    nonisolated static func shouldApplyBackgroundRecoveryStatus(
        recoveryGeneration: UInt64,
        currentGeneration: UInt64,
        isRecording: Bool,
        isTranscribing: Bool
    ) -> Bool {
        recoveryGeneration == currentGeneration && !isRecording && !isTranscribing
    }

    private func updateBackgroundRecoveryStatus(
        _ message: String,
        kind: DeliveryStatusKind,
        pipelineGeneration: UInt64
    ) {
        guard Self.shouldApplyBackgroundRecoveryStatus(
            recoveryGeneration: pipelineGeneration,
            currentGeneration: recordingGeneration,
            isRecording: isRecording,
            isTranscribing: isTranscribing
        ) else {
            log("background recovery status suppressed for superseded pipeline generation=\(pipelineGeneration)")
            return
        }
        statusMessage = message
        flowPhase = Self.flowPhase(forDeliveryStatus: message, kind: kind)
    }

    nonisolated static func fallbackCompletionAction(
        cliText: String?,
        cliError: String?,
        realtimeText: String?,
        deliverResult: Bool
    ) -> FallbackCompletionAction {
        let resolved = resolveFinalTranscript(
            cliText: cliText,
            cliError: cliError,
            realtimeText: realtimeText
        )
        guard let text = resolved.text else {
            let failure = resolved.failureStatus ?? "Transcription failed"
            return deliverResult ? .fail(failure) : .backgroundFailed(failure)
        }
        return deliverResult ? .deliver(text) : .backgroundRecovered
    }

    private func fallbackTranscribe(
        audioPath: String,
        targetAppBundleIdentifier: String?,
        targetAppPid: pid_t?,
        selectionToken: AccessibilitySelectionToken?,
        canonicalProjectId: String?,
        displayProjectId: String?,
        activeProjectName: String?,
        processingConfiguration: RecordingProcessingConfiguration,
        realtimeText: String? = nil,
        pipelineTrace: RecordingPipelineTrace? = nil,
        pipelineGeneration: UInt64? = nil,
        deliverResult: Bool = true,
        backgroundRecoveryGeneration: UInt64? = nil
    ) {
        let homePath = home

        if deliverResult {
            isTranscribing = true
            statusMessage = Self.shouldLabelRewriting(
                postProcessingMode: processingConfiguration.postProcessingMode
            ) ? "Rewriting..." : "Transcribing..."
            flowPhase = .processing(statusMessage)
        } else {
            if let backgroundRecoveryGeneration {
                updateBackgroundRecoveryStatus(
                    "Pasted; recovering recording...",
                    kind: .success,
                    pipelineGeneration: backgroundRecoveryGeneration
                )
            }
        }

        // Only a proven canonical Store id may be persisted. The local display id remains
        // available to recent-transcript UI even when synchronization is degraded.
        let transcribeArgs = Self.transcribeCLIArgs(
            audioPath: audioPath,
            activeProjectId: canonicalProjectId,
            transcriberPrompt: processingConfiguration.transcriberPrompt,
            postProcessingMode: processingConfiguration.postProcessingMode,
            language: processingConfiguration.transcriptionLanguage,
            transcriptionPrompt: processingConfiguration.transcriptionPrompt,
            transcriptionModel: processingConfiguration.transcriptionModel,
            transcriberModel: processingConfiguration.transcriberModel,
            enhancementModel: processingConfiguration.enhancementModel,
            enhanceTriggersJSON: processingConfiguration.enhanceTriggersJSON,
            keywordTransformsJSON: processingConfiguration.keywordTransformsJSON,
            recordingId: pipelineTrace?.id
        )

        Task.detached {
            if let pipelineTrace {
                NativeAppLog.write(
                    pipelineTrace.message(stage: "helper_started", detail: "operation=batch_transcribe"),
                    homePath: homePath
                )
            }
            let output = CLIRunner.run(transcribeArgs, home: homePath)
            let cliError = CLIRunner.parseError(output)
            let cliText = cliError == nil ? CLIRunner.parseJSON(output) : nil
            let cliRawText = cliError == nil ? CLIRunner.parseRawTranscript(output) : nil

            await MainActor.run {
                if let pipelineTrace {
                    self.log(pipelineTrace.message(
                        stage: cliError == nil ? "helper_processing_store_complete" : "helper_processing_store_failed"
                    ))
                }
                if let cliError {
                    self.log("cli transcription failed error=\(cliError)")
                } else if cliText == nil {
                    self.log("cli transcription empty output=\(output.prefix(160))")
                }

                if cliText == nil {
                    self.log("using realtime transcript fallback chars=\(realtimeText?.count ?? 0)")
                } else {
                    self.log("cli transcription succeeded chars=\(cliText?.count ?? 0)")
                }
                switch Self.fallbackCompletionAction(
                    cliText: cliText,
                    cliError: cliError,
                    realtimeText: realtimeText,
                    deliverResult: deliverResult
                ) {
                case .deliver(let text):
                    self.isTranscribing = false
                    self.finishWithText(
                        text,
                        rawTranscript: cliRawText ?? realtimeText ?? text,
                        targetAppBundleIdentifier: targetAppBundleIdentifier,
                        targetAppPid: targetAppPid,
                        selectionToken: selectionToken,
                        canonicalProjectId: canonicalProjectId,
                        activeProjectId: displayProjectId,
                        activeProjectName: activeProjectName,
                        processingConfiguration: processingConfiguration,
                        pipelineTrace: pipelineTrace,
                        pipelineGeneration: pipelineGeneration
                    )
                case .fail(let failure):
                    if let pipelineGeneration {
                        self.pipelineDeliveryGate.abandonPipeline(pipelineGeneration)
                    }
                    self.finish(failure)
                case .backgroundRecovered:
                    if let pipelineTrace {
                        self.log(pipelineTrace.message(stage: "async_persistence_recovered"))
                    }
                    if let backgroundRecoveryGeneration {
                        self.updateBackgroundRecoveryStatus(
                            "Pasted and saved",
                            kind: .success,
                            pipelineGeneration: backgroundRecoveryGeneration
                        )
                    }
                case .backgroundFailed(let failure):
                    if let backgroundRecoveryGeneration {
                        self.updateBackgroundRecoveryStatus(
                            "Pasted, but recording could not be saved: \(failure)",
                            kind: .failure,
                            pipelineGeneration: backgroundRecoveryGeneration
                        )
                    }
                }
            }
        }
    }

    private func mostRecentAudioFile() -> String? {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: audioDir)) ?? []
        let wavFiles = files.filter { $0.hasSuffix(".wav") }.sorted().reversed()
        return wavFiles.first.map { "\(audioDir)/\($0)" }
    }

    nonisolated static func transcribeCLIArgs(
        audioPath: String,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String,
        language: String = "auto",
        transcriptionPrompt: String? = nil,
        transcriptionModel: String? = nil,
        transcriberModel: String? = nil,
        enhancementModel: String? = nil,
        enhanceTriggersJSON: String? = nil,
        keywordTransformsJSON: String? = nil,
        recordingId: String? = nil
    ) -> [String] {
        var args = ["--json"]
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += ["transcribe", audioPath]

        let languageHint = OpenAIAPIKeyStore.apiLanguageHint(for: language)
        if !languageHint.isEmpty {
            args += ["--language", languageHint]
        }
        if let recordingId, !recordingId.isEmpty {
            args += ["--recording-id", recordingId]
        }
        if let transcriptionPrompt, !transcriptionPrompt.isEmpty {
            args += ["--prompt", transcriptionPrompt]
        }
        if let transcriptionModel, !transcriptionModel.isEmpty {
            args += ["--transcription-model", transcriptionModel]
        }
        if let transcriberModel, !transcriberModel.isEmpty {
            args += ["--transcriber-model", transcriberModel]
        }
        if let enhancementModel, !enhancementModel.isEmpty {
            args += ["--enhancement-model", enhancementModel]
        }
        if let enhanceTriggersJSON, !enhanceTriggersJSON.isEmpty {
            args += ["--enhance-triggers-json", enhanceTriggersJSON]
        }
        if let keywordTransformsJSON, !keywordTransformsJSON.isEmpty {
            args += ["--keyword-transforms-json", keywordTransformsJSON]
        }

        let mode = PostProcessingMode(rawValue: postProcessingMode)?.rawValue ?? PostProcessingMode.auto.rawValue
        args += ["--post-processing", mode]

        let prompt = transcriberPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            args += ["--transcriber-prompt", prompt]
        }

        return args
    }

    nonisolated static func saveTextCLIArgs(
        textFile: String,
        audioPath: String?,
        activeProjectId: String?,
        transcriberPrompt: String,
        postProcessingMode: String,
        language: String,
        transcriptionModel: String? = nil,
        transcriberModel: String? = nil,
        enhancementModel: String? = nil,
        enhanceTriggersJSON: String? = nil,
        keywordTransformsJSON: String? = nil,
        recordingId: String? = nil,
        durationMs: Int,
        source: String,
        modelUsed: String
    ) -> [String] {
        var args = ["--json"]
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += [
            "save-text",
            "--text-file", textFile,
            "--source", source,
            "--model-used", modelUsed,
            "--post-processing", PostProcessingMode(rawValue: postProcessingMode)?.rawValue ?? PostProcessingMode.auto.rawValue,
        ]
        if let audioPath, !audioPath.isEmpty {
            args += ["--audio-path", audioPath]
        }
        if durationMs > 0 {
            args += ["--duration-ms", String(durationMs)]
        }
        if !language.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args += ["--language", language]
        }
        if let recordingId, !recordingId.isEmpty {
            args += ["--recording-id", recordingId]
        }
        if let transcriptionModel, !transcriptionModel.isEmpty {
            args += ["--transcription-model", transcriptionModel]
        }
        if let transcriberModel, !transcriberModel.isEmpty {
            args += ["--transcriber-model", transcriberModel]
        }
        if let enhancementModel, !enhancementModel.isEmpty {
            args += ["--enhancement-model", enhancementModel]
        }
        if let enhanceTriggersJSON, !enhanceTriggersJSON.isEmpty {
            args += ["--enhance-triggers-json", enhanceTriggersJSON]
        }
        if let keywordTransformsJSON, !keywordTransformsJSON.isEmpty {
            args += ["--keyword-transforms-json", keywordTransformsJSON]
        }
        let prompt = transcriberPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            args += ["--transcriber-prompt", prompt]
        }
        return args
    }

    nonisolated static func rewriteCLIArgs(
        selectedText: String,
        instruction: String,
        activeProjectId: String?,
        processingConfiguration: RecordingProcessingConfiguration
    ) -> [String] {
        var args: [String] = []
        if let activeProjectId, !activeProjectId.isEmpty {
            args += ["--project", activeProjectId]
        }
        args += [
            "rewrite",
            "--instruction", instruction,
            "--post-processing", processingConfiguration.postProcessingMode,
            "--language", processingConfiguration.transcriptionLanguage,
            "--prompt", processingConfiguration.transcriptionPrompt,
            "--transcriber-prompt", processingConfiguration.transcriberPrompt,
            "--transcription-model", processingConfiguration.transcriptionModel,
            "--transcriber-model", processingConfiguration.transcriberModel,
            "--enhancement-model", processingConfiguration.enhancementModel,
            "--enhance-triggers-json", processingConfiguration.enhanceTriggersJSON,
            "--keyword-transforms-json", processingConfiguration.keywordTransformsJSON,
            "--", selectedText,
        ]
        return args
    }

    private func finish(_ msg: String) {
        log("finish status=\(msg)")
        isTranscribing = false
        liveTranscriptionText = ""
        statusMessage = msg
        flowPhase = .failed(msg)
    }

    private func resetRecordingIntent() {
        activeTrigger = nil
        microphonePermissionStartGate.cancel()
        keyboardShortcutIsDown = false
        fnKeyIsDown = false
        targetAppBundleIdentifier = nil
        targetAppPid = nil
    }

    // MARK: - Conversation

    private func runConversationMode(
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

    private func runCommandMode(
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
    private func resolveRewriteSelection(
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

    private func canOwnBusyState(pipelineGeneration: UInt64?) -> Bool {
        guard let pipelineGeneration else { return true }
        return pipelineGeneration == recordingGeneration && !isRecording
    }

    // MARK: - Window Title (Accessibility API)

    /// Runs off the MainActor in the recording-start snapshot; every IPC round trip is
    /// bounded so an unresponsive app delays project detection, never recording.
    private nonisolated static func focusedWindowTitle(pid: pid_t?) -> String? {
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

    private func pasteIntoFrontApp(
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
        var clipboardOwnershipWasLost = false
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
            },
            writeAttempted: { result in
                ownedPasteboardChangeCount = result.ownershipChangeCount
            }
        ) { transaction, outcome in
            let posted = outcome == .pasted
            let accessibilityTrusted = AXIsProcessTrusted()
            let completedTranscriptAlreadyOnClipboard = outcome == .targetUnavailable
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
            if let pipelineTrace {
                self.log(pipelineTrace.message(
                    stage: posted ? "paste_posted" : "paste_failed",
                    detail: "chars=\(transaction.text.count)"
                ))
            }
            deliveryCompleted?()
            let message = switch outcome {
            case .pasted: "Pasted (\(transaction.text.count) chars)"
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
            self.updateDeliveryStatus(
                message,
                kind: posted ? .success : .failure,
                pipelineGeneration: transaction.generation
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
            case .targetUnavailable, .clipboardOwnershipLost, .eventPostFailed, .pasted:
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

    nonisolated static func clipboardOwnershipWasLostAfterPasteFailure(
        outcome: PasteDeliveryOutcome,
        hasOwnershipToken: Bool,
        stillOwnsPayload: Bool
    ) -> Bool {
        outcome == .targetUnavailable && hasOwnershipToken && !stillOwnsPayload
    }

    @discardableResult
    private nonisolated static func writeClipboard(_ text: String, to pasteboard: NSPasteboard) -> Bool {
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
        let clearedChangeCount = pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            return PasteboardWriteResult(
                verified: false,
                ownershipChangeCount: clearedChangeCount
            )
        }
        let writtenChangeCount = pasteboard.changeCount
        let storedText = pasteboard.string(forType: .string)
        return PasteboardWriteResult(
            verified: pasteboard.changeCount == writtenChangeCount && storedText == text,
            ownershipChangeCount: writtenChangeCount
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
        outcome == .targetUnavailable
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
        case failure
    }

    nonisolated static func flowPhase(
        forDeliveryStatus message: String,
        kind: DeliveryStatusKind
    ) -> RecordingFlowPhase {
        switch kind {
        case .progress: .processing(message)
        case .success: .ready(message)
        case .failure: .failed(message)
        }
    }

    private func updateDeliveryStatus(
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
    }

    private func selectedRunningPasteTarget(
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

    private nonisolated static func monotonicMilliseconds() -> UInt64 {
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

    private func log(_ message: String) {
        NativeAppLog.write(message, homePath: home)
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true

    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard value else { return false }
        value = false
        return true
    }
}

private struct ClipboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init(pasteboard: NSPasteboard) {
        let capturedItems = pasteboard.pasteboardItems?.compactMap { item -> [NSPasteboard.PasteboardType: Data]? in
            let dataByType = item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { result, type in
                if let data = item.data(forType: type) {
                    result[type] = data
                }
            }
            return dataByType.isEmpty ? nil : dataByType
        } ?? []
        items = capturedItems
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let pasteboardItems = items.map { itemData in
            let item = NSPasteboardItem()
            for (type, data) in itemData {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(pasteboardItems)
    }
}

// MARK: - CLI Runner

private final class ProcessDataCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()
    private var finished = false

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        storage.append(data)
    }

    func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return false }
        finished = true
        return true
    }

    var data: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

enum CLIRunner: Sendable {
    enum CaptureOperation: Sendable {
        case read
        case poll

        fileprivate var description: String {
            switch self {
            case .read: "reading"
            case .poll: "waiting for"
            }
        }
    }

    enum ExecutionError: Error, LocalizedError, Equatable {
        case timedOut(executable: String, seconds: TimeInterval)
        case captureFailed(operation: CaptureOperation, code: Int32)

        var errorDescription: String? {
            switch self {
            case let .timedOut(executable, seconds):
                return "Command timed out after \(seconds.formatted()) seconds: \(executable)"
            case let .captureFailed(operation, code):
                return "Failed to capture command output while \(operation.description): \(String(cString: strerror(code)))"
            }
        }
    }

    struct Command: Sendable {
        let executable: String
        let argumentsPrefix: [String]
    }

    struct ProcessOutput: Sendable {
        let stdout: String
        let stderr: String
        let terminationStatus: Int32
    }

    enum ProcessLifecycleEvent: Equatable, Sendable {
        case leaderExitObserved
        case processGroupSignaled(Int32)
        case leaderReaped(Int32)
    }

    typealias LeaderReaper = (
        _ processIdentifier: pid_t,
        _ lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Int32

    static func run(
        _ args: [String],
        home: String,
        timeout: TimeInterval = 120,
        totalWallClockBudget: TimeInterval? = nil
    ) -> String {
        let command = resolveCommand(home: home)
        let arguments = command.argumentsPrefix + args
        let environment = ProcessInfo.processInfo.environment.merging([
            "PATH": "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        ]) { _, new in new }
        do {
            let output = try runExecutable(
                command.executable,
                arguments: arguments,
                environment: environment,
                executionTimeout: timeout,
                totalWallClockBudget: totalWallClockBudget
            )
            if output.terminationStatus != 0 {
                let details = output.stderr.isEmpty ? output.stdout : output.stderr
                return "ERROR: \(NativeErrorSanitizer.sanitize(details.trimmingCharacters(in: .whitespacesAndNewlines)))"
            }
            return output.stdout.isEmpty
                ? NativeErrorSanitizer.sanitize(output.stderr)
                : output.stdout
        } catch {
            return "ERROR: \(NativeErrorSanitizer.sanitize(error.localizedDescription))"
        }
    }

    static func resolveCommand(
        home: String,
        bundleURL: URL = Bundle.main.bundleURL,
        fileManager: FileManager = .default
    ) -> Command {
        let bundled = bundleURL.appendingPathComponent("Contents/Helpers/recordings")
        let isPackagedApp = bundleURL.pathExtension.caseInsensitiveCompare("app") == .orderedSame
        if isPackagedApp || fileManager.fileExists(atPath: bundled.path) {
            return Command(executable: bundled.path, argumentsPrefix: [])
        }

        // SwiftPM development and test runs do not have an app bundle. Retain an
        // explicit local fallback there; packaged apps exclusively use their helper.
        let userCLI = "\(home)/.bun/bin/recordings"
        if fileManager.fileExists(atPath: userCLI) {
            return Command(executable: userCLI, argumentsPrefix: [])
        }
        return Command(executable: "/usr/bin/env", argumentsPrefix: ["recordings"])
    }

    /// Wall-clock time reserved out of the execution window when `totalWallClockBudget` is
    /// set, so termination grace, kill grace, and pipe drain land inside the budget with
    /// scheduling margin to spare.
    static let wallClockCleanupReserve: TimeInterval = 1

    static func runExecutable(
        _ executable: String,
        arguments: [String],
        environment: [String: String]? = nil,
        executionTimeout: TimeInterval = 120,
        terminationGracePeriod: TimeInterval = 0.5,
        forceKillGracePeriod: TimeInterval = 1,
        pipeDrainTimeout: TimeInterval = 2,
        totalWallClockBudget: TimeInterval? = nil,
        beforeExecutionDeadline: (() -> Void)? = nil,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)? = nil,
        leaderReaper: LeaderReaper? = nil,
        captureSystemCalls: PipeCaptureReader.SystemCalls = .live
    ) throws -> ProcessOutput {
        precondition(executionTimeout.isFinite && executionTimeout > 0)
        precondition(terminationGracePeriod.isFinite && terminationGracePeriod >= 0)
        precondition(forceKillGracePeriod.isFinite && forceKillGracePeriod >= 0)
        precondition(pipeDrainTimeout.isFinite && pipeDrainTimeout >= 0)
        if let totalWallClockBudget {
            precondition(totalWallClockBudget.isFinite && totalWallClockBudget > wallClockCleanupReserve)
        }

        // The budget clock starts before the spawn so setup latency cannot extend the
        // observable wall time. Every wait below is clamped to what is left of it.
        let wallClockDeadline = totalWallClockBudget.map { monotonicUptimeDeadline(after: $0) }
        func clampedToWallClockBudget(
            _ phaseTimeout: TimeInterval,
            reserving reserve: TimeInterval = 0
        ) -> TimeInterval {
            guard let wallClockDeadline else { return phaseTimeout }
            let now = DispatchTime.now().uptimeNanoseconds
            let remaining = wallClockDeadline > now
                ? Double(wallClockDeadline - now) / 1_000_000_000 - reserve
                : 0
            return max(0, min(phaseTimeout, remaining))
        }
        let contractualExecutionTimeout = totalWallClockBudget
            .map { min(executionTimeout, $0 - wallClockCleanupReserve) } ?? executionTimeout

        let stdoutReader = try PipeCaptureReader(systemCalls: captureSystemCalls)
        let stderrReader: PipeCaptureReader
        do {
            stderrReader = try PipeCaptureReader(systemCalls: captureSystemCalls)
        } catch {
            stdoutReader.closeWriteDescriptor()
            _ = finishCaptures([stdoutReader], pipeDrainTimeout: 0)
            throw error
        }
        let captureReaders = [stdoutReader, stderrReader]

        let processIdentifier: pid_t
        do {
            processIdentifier = try spawnProcessGroup(
                executable,
                arguments: arguments,
                environment: environment,
                stdoutDescriptor: stdoutReader.writeDescriptor,
                stderrDescriptor: stderrReader.writeDescriptor,
                stdoutReadDescriptor: stdoutReader.readDescriptor,
                stderrReadDescriptor: stderrReader.readDescriptor
            )
        } catch {
            stdoutReader.closeWriteDescriptor()
            stderrReader.closeWriteDescriptor()
            _ = finishCaptures(captureReaders, pipeDrainTimeout: 0)
            throw error
        }
        stdoutReader.closeWriteDescriptor()
        stderrReader.closeWriteDescriptor()

        beforeExecutionDeadline?()
        let leaderExitWasObserved: Bool
        let didTimeOut: Bool
        do {
            leaderExitWasObserved = try waitForUnreapedLeaderExit(
                processIdentifier,
                timeout: clampedToWallClockBudget(executionTimeout, reserving: wallClockCleanupReserve),
                lifecycleObserver: lifecycleObserver
            )
            didTimeOut = !leaderExitWasObserved
        } catch {
            signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
            reapLeaderInBackground(processIdentifier)
            _ = finishCaptures(
                captureReaders,
                pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
            )
            throw error
        }

        // Keep the direct child unreaped until every group-directed signal has
        // been sent. Its zombie reserves the process-group identifier, so a PID
        // reuse cannot redirect cleanup to an unrelated process group.
        signalProcessGroup(processIdentifier, signal: SIGTERM, lifecycleObserver: lifecycleObserver)
        var confirmedExit = leaderExitWasObserved
        if didTimeOut {
            do {
                confirmedExit = try waitForUnreapedLeaderExit(
                    processIdentifier,
                    timeout: clampedToWallClockBudget(terminationGracePeriod),
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        } else {
            let drainDeadline = monotonicDispatchDeadline(
                after: clampedToWallClockBudget(terminationGracePeriod)
            )
            for reader in captureReaders {
                reader.waitUntilExited(deadline: drainDeadline)
            }
        }
        signalProcessGroup(processIdentifier, signal: SIGKILL, lifecycleObserver: lifecycleObserver)
        if !confirmedExit {
            do {
                confirmedExit = try waitForUnreapedLeaderExit(
                    processIdentifier,
                    timeout: clampedToWallClockBudget(forceKillGracePeriod),
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        }
        let terminationStatus: Int32?
        if confirmedExit {
            do {
                terminationStatus = try leaderReaper?(
                    processIdentifier,
                    lifecycleObserver
                ) ?? reapLeader(
                    processIdentifier,
                    lifecycleObserver: lifecycleObserver
                )
            } catch {
                reapLeaderInBackground(processIdentifier)
                _ = finishCaptures(
                    captureReaders,
                    pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
                )
                throw error
            }
        } else {
            reapLeaderInBackground(processIdentifier)
            terminationStatus = nil
        }

        let captureError = finishCaptures(
            captureReaders,
            pipeDrainTimeout: clampedToWallClockBudget(pipeDrainTimeout)
        )

        if didTimeOut {
            throw ExecutionError.timedOut(executable: executable, seconds: contractualExecutionTimeout)
        }
        if let captureError {
            throw captureError
        }

        // Both readers are joined by now, so these snapshots can never observe a
        // truncated mid-append state.
        return ProcessOutput(
            stdout: String(decoding: stdoutReader.data, as: UTF8.self),
            stderr: String(decoding: stderrReader.data, as: UTF8.self),
            terminationStatus: terminationStatus ?? 1
        )
    }

    private static func spawnProcessGroup(
        _ executable: String,
        arguments: [String],
        environment: [String: String]?,
        stdoutDescriptor: Int32,
        stderrDescriptor: Int32,
        stdoutReadDescriptor: Int32,
        stderrReadDescriptor: Int32
    ) throws -> pid_t {
        var duplicatedDescriptors: [Int32] = []
        defer {
            for descriptor in duplicatedDescriptors {
                Darwin.close(descriptor)
            }
        }
        let childStdoutDescriptor = try nonStandardDescriptor(
            stdoutDescriptor,
            duplicates: &duplicatedDescriptors
        )
        let childStderrDescriptor = try nonStandardDescriptor(
            stderrDescriptor,
            duplicates: &duplicatedDescriptors
        )

        var fileActions: posix_spawn_file_actions_t?
        try checkPOSIX(posix_spawn_file_actions_init(&fileActions), operation: "initialize spawn file actions")
        defer { posix_spawn_file_actions_destroy(&fileActions) }

        try checkPOSIX(
            posix_spawn_file_actions_adddup2(&fileActions, childStdoutDescriptor, STDOUT_FILENO),
            operation: "configure command stdout"
        )
        try checkPOSIX(
            posix_spawn_file_actions_adddup2(&fileActions, childStderrDescriptor, STDERR_FILENO),
            operation: "configure command stderr"
        )
        let inheritedDescriptors = Set([
            stdoutReadDescriptor,
            stderrReadDescriptor,
            stdoutDescriptor,
            stderrDescriptor,
            childStdoutDescriptor,
            childStderrDescriptor,
        ]).filter { $0 != STDOUT_FILENO && $0 != STDERR_FILENO }
        for descriptor in inheritedDescriptors {
            try checkPOSIX(
                posix_spawn_file_actions_addclose(&fileActions, descriptor),
                operation: "close inherited command descriptor"
            )
        }

        var attributes: posix_spawnattr_t?
        try checkPOSIX(posix_spawnattr_init(&attributes), operation: "initialize spawn attributes")
        defer { posix_spawnattr_destroy(&attributes) }
        var defaultSignals = sigset_t()
        Darwin.sigemptyset(&defaultSignals)
        Darwin.sigaddset(&defaultSignals, SIGTERM)
        try checkPOSIX(
            posix_spawnattr_setsigdefault(&attributes, &defaultSignals),
            operation: "reset command termination signal"
        )
        var unblockedSignals = sigset_t()
        Darwin.sigemptyset(&unblockedSignals)
        try checkPOSIX(
            posix_spawnattr_setsigmask(&attributes, &unblockedSignals),
            operation: "unblock command signals"
        )
        let spawnFlags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        try checkPOSIX(
            posix_spawnattr_setflags(&attributes, Int16(spawnFlags)),
            operation: "configure command process group"
        )
        try checkPOSIX(
            posix_spawnattr_setpgroup(&attributes, 0),
            operation: "configure command process group leader"
        )

        let environmentValues = (environment ?? ProcessInfo.processInfo.environment)
            .map { "\($0.key)=\($0.value)" }
        var processIdentifier: pid_t = 0
        let spawnResult = withMutableCStringArray([executable] + arguments) { argumentVector in
            withMutableCStringArray(environmentValues) { environmentVector in
                posix_spawn(
                    &processIdentifier,
                    executable,
                    &fileActions,
                    &attributes,
                    argumentVector,
                    environmentVector
                )
            }
        }
        try checkPOSIX(spawnResult, operation: "launch command")
        return processIdentifier
    }

    private static func nonStandardDescriptor(
        _ descriptor: Int32,
        duplicates: inout [Int32]
    ) throws -> Int32 {
        guard descriptor == STDOUT_FILENO || descriptor == STDERR_FILENO else {
            return descriptor
        }
        let duplicate = Darwin.fcntl(descriptor, F_DUPFD_CLOEXEC, 3)
        guard duplicate != -1 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "Failed to duplicate command descriptor: \(String(cString: strerror(errno)))"]
            )
        }
        duplicates.append(duplicate)
        return duplicate
    }

    private static func withMutableCStringArray<Result>(
        _ strings: [String],
        body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
    ) rethrows -> Result {
        var pointers = strings.map { strdup($0) }
        pointers.append(nil)
        defer {
            for pointer in pointers where pointer != nil {
                free(pointer)
            }
        }
        return try pointers.withUnsafeMutableBufferPointer { buffer in
            try body(buffer.baseAddress!)
        }
    }

    private static func checkPOSIX(_ result: Int32, operation: String) throws {
        guard result == 0 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(result),
                userInfo: [NSLocalizedDescriptionKey: "Failed to \(operation): \(String(cString: strerror(result)))"]
            )
        }
    }

    private static func waitForUnreapedLeaderExit(
        _ processIdentifier: pid_t,
        timeout: TimeInterval,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Bool {
        let deadline = monotonicUptimeDeadline(after: timeout)
        repeat {
            var information = siginfo_t()
            var result: Int32
            repeat {
                result = Darwin.waitid(
                    P_PID,
                    id_t(processIdentifier),
                    &information,
                    WEXITED | WNOHANG | WNOWAIT
                )
            } while result == -1 && errno == EINTR
            guard result == 0 else {
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errno),
                    userInfo: [NSLocalizedDescriptionKey: "Failed to observe command exit: \(String(cString: strerror(errno)))"]
                )
            }
            if information.si_pid == processIdentifier {
                lifecycleObserver?(.leaderExitObserved)
                return true
            }
            if DispatchTime.now().uptimeNanoseconds >= deadline { return false }
            usleep(10_000)
        } while true
    }

    private static func signalProcessGroup(
        _ processGroup: pid_t,
        signal: Int32,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) {
        lifecycleObserver?(.processGroupSignaled(signal))
        _ = Darwin.kill(-processGroup, signal)
    }

    private static func reapLeader(
        _ processIdentifier: pid_t,
        lifecycleObserver: ((ProcessLifecycleEvent) -> Void)?
    ) throws -> Int32 {
        var waitStatus: Int32 = 0
        var waitResult: pid_t
        repeat {
            waitResult = Darwin.waitpid(processIdentifier, &waitStatus, 0)
        } while waitResult == -1 && errno == EINTR
        guard waitResult == processIdentifier else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "Failed to reap command: \(String(cString: strerror(errno)))"]
            )
        }
        let terminationStatus = decode(waitStatus: waitStatus)
        lifecycleObserver?(.leaderReaped(terminationStatus))
        return terminationStatus
    }

    private static func reapLeaderInBackground(_ processIdentifier: pid_t) {
        DispatchQueue.global(qos: .utility).async {
            var waitStatus: Int32 = 0
            var waitResult: pid_t
            repeat {
                waitResult = Darwin.waitpid(processIdentifier, &waitStatus, 0)
            } while waitResult == -1 && errno == EINTR
        }
    }

    private static func decode(waitStatus: Int32) -> Int32 {
        let signal = waitStatus & 0x7f
        if signal == 0 {
            return (waitStatus >> 8) & 0xff
        }
        return 128 + signal
    }

    private static func monotonicDispatchDeadline(after timeout: TimeInterval) -> DispatchTime {
        DispatchTime(uptimeNanoseconds: monotonicUptimeDeadline(after: timeout))
    }

    private static func monotonicUptimeDeadline(after timeout: TimeInterval) -> UInt64 {
        let now = DispatchTime.now().uptimeNanoseconds
        let maximumDelay = min(UInt64(Int64.max), UInt64.max - now)
        let requestedNanoseconds = timeout * 1_000_000_000
        let nanoseconds = requestedNanoseconds >= Double(maximumDelay)
            ? maximumDelay
            : UInt64(requestedNanoseconds.rounded(.up))
        return now + nanoseconds
    }

    /// Shuts capture down deterministically. Waits up to `pipeDrainTimeout` for the
    /// readers to observe end-of-file on their own — the complete-output path — then
    /// cancels and joins whatever is still running. Both reader threads have provably
    /// exited and both pipe read ends are closed before this returns: a silent escaped
    /// descendant still holding a write end observes a widowed pipe at that point, and no
    /// snapshot of captured output can race a reader mid-append.
    private static func finishCaptures(
        _ readers: [PipeCaptureReader],
        pipeDrainTimeout: TimeInterval
    ) -> ExecutionError? {
        let deadline = monotonicDispatchDeadline(after: pipeDrainTimeout)
        for reader in readers {
            reader.waitUntilExited(deadline: deadline)
        }
        for reader in readers {
            reader.cancel()
        }
        for reader in readers {
            reader.join()
        }
        return readers.lazy.compactMap(\.terminalError).first
    }

    /// Owns one capture pipe end to end: it creates the pipe, lends the write end to the
    /// spawn, and consumes the read end on a dedicated thread that multiplexes the
    /// nonblocking pipe with a private wakeup pipe through poll(2). `cancel()` writes one
    /// wakeup byte, so the thread deterministically leaves poll even when a silent
    /// escaped descendant keeps the write end open forever without writing a byte — POSIX
    /// does not promise that replacing or closing a descriptor interrupts a read(2)
    /// already blocked on it, so the blocking-read + dup2 revocation this replaces could
    /// leave the reader thread and the process's pipe reference alive indefinitely.
    ///
    /// The runner must keep owning every reference to the read descriptor itself:
    /// `FileHandle.readabilityHandler` keeps a private duplicate of the descriptor that
    /// can survive `close()` while data is flowing, which would leave the pipe readable
    /// forever — a descendant that inherited the write end would never observe EPIPE, and
    /// the descriptor would leak in this process. Never reintroduce it here.
    final class PipeCaptureReader: @unchecked Sendable {
        struct SystemCalls: @unchecked Sendable {
            let makePipe: (_ operation: String) throws -> (read: Int32, write: Int32)
            let fcntl: (_ descriptor: Int32, _ command: Int32, _ value: Int32?) -> Int32
            let close: (_ descriptor: Int32) -> Int32
            let read: (
                _ descriptor: Int32,
                _ buffer: UnsafeMutableRawPointer?,
                _ count: Int
            ) -> Int
            let poll: (
                _ descriptors: UnsafeMutablePointer<pollfd>?,
                _ count: nfds_t,
                _ timeout: Int32
            ) -> Int32

            init(
                makePipe: @escaping (_ operation: String) throws -> (read: Int32, write: Int32) = {
                    try PipeCaptureReader.makePipe(operation: $0)
                },
                fcntl: @escaping (
                    _ descriptor: Int32,
                    _ command: Int32,
                    _ value: Int32?
                ) -> Int32 = { descriptor, command, value in
                    if let value {
                        return Darwin.fcntl(descriptor, command, value)
                    }
                    return Darwin.fcntl(descriptor, command)
                },
                close: @escaping (_ descriptor: Int32) -> Int32 = { Darwin.close($0) },
                read: @escaping (
                    _ descriptor: Int32,
                    _ buffer: UnsafeMutableRawPointer?,
                    _ count: Int
                ) -> Int = { Darwin.read($0, $1, $2) },
                poll: @escaping (
                    _ descriptors: UnsafeMutablePointer<pollfd>?,
                    _ count: nfds_t,
                    _ timeout: Int32
                ) -> Int32 = { Darwin.poll($0, $1, $2) }
            ) {
                self.makePipe = makePipe
                self.fcntl = fcntl
                self.close = close
                self.read = read
                self.poll = poll
            }

            static let live = SystemCalls()
        }

        /// Write end lent to the spawned child; the runner closes it through
        /// `closeWriteDescriptor()` once the child holds its own copies.
        let writeDescriptor: Int32
        /// Read end consumed — and eventually closed — exclusively by the reader thread.
        let readDescriptor: Int32

        private let wakeupReadDescriptor: Int32
        private let wakeupWriteDescriptor: Int32
        private let systemCalls: SystemCalls
        private let capture = ProcessDataCapture()
        private let exited = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var cancelRequested = false
        private var writeDescriptorClosed = false
        private var wakeupDescriptorsClosed = false
        private var storedTerminalError: ExecutionError?

        /// Reads per drain burst between polls, so a flooding writer cannot starve the
        /// wakeup descriptor check.
        private static let drainReadLimit = 64
        /// Reads allowed after cancellation — comfortably above the kernel's largest pipe
        /// buffer, so an already-buffered tail is never dropped, yet `join()` stays
        /// prompt against a descendant that keeps writing.
        private static let cancelledDrainReadLimit = 16

        init(systemCalls: SystemCalls = .live) throws {
            let dataPipe = try systemCalls.makePipe("create capture pipe")
            let wakeupPipe: (read: Int32, write: Int32)
            do {
                wakeupPipe = try systemCalls.makePipe("create capture wakeup pipe")
            } catch {
                _ = systemCalls.close(dataPipe.read)
                _ = systemCalls.close(dataPipe.write)
                throw error
            }

            let descriptors = [dataPipe.read, dataPipe.write, wakeupPipe.read, wakeupPipe.write]
            var setupSucceeded = false
            defer {
                if !setupSucceeded {
                    for descriptor in descriptors {
                        _ = systemCalls.close(descriptor)
                    }
                }
            }

            for descriptor in descriptors {
                let descriptorFlags = try Self.checkedFcntl(
                    descriptor,
                    command: F_GETFD,
                    operation: "read capture descriptor flags",
                    systemCalls: systemCalls
                )
                _ = try Self.checkedFcntl(
                    descriptor,
                    command: F_SETFD,
                    value: descriptorFlags | FD_CLOEXEC,
                    operation: "protect capture descriptor from inheritance",
                    systemCalls: systemCalls
                )
            }
            let readFlags = try Self.checkedFcntl(
                dataPipe.read,
                command: F_GETFL,
                operation: "read capture pipe status flags",
                systemCalls: systemCalls
            )
            _ = try Self.checkedFcntl(
                dataPipe.read,
                command: F_SETFL,
                value: readFlags | O_NONBLOCK,
                operation: "make capture pipe nonblocking",
                systemCalls: systemCalls
            )

            readDescriptor = dataPipe.read
            writeDescriptor = dataPipe.write
            wakeupReadDescriptor = wakeupPipe.read
            wakeupWriteDescriptor = wakeupPipe.write
            self.systemCalls = systemCalls
            setupSucceeded = true
            Thread.detachNewThread { [self] in consumePipe() }
        }

        deinit {
            // The reader thread retains this object until it has closed the read end.
            // Callers must still close/cancel/join; this only releases any remaining
            // owner-side descriptors after the reader has already exited.
            if !writeDescriptorClosed { _ = systemCalls.close(writeDescriptor) }
            if !wakeupDescriptorsClosed {
                _ = systemCalls.close(wakeupReadDescriptor)
                _ = systemCalls.close(wakeupWriteDescriptor)
            }
        }

        /// Everything captured so far; stable and complete once `join()` has returned.
        var data: Data { capture.data }

        /// A terminal capture failure, stable once `join()` has returned. Cancellation
        /// and ordinary end-of-file are not failures.
        var terminalError: ExecutionError? {
            lock.lock()
            defer { lock.unlock() }
            return storedTerminalError
        }

        func closeWriteDescriptor() {
            lock.lock()
            defer { lock.unlock() }
            guard !writeDescriptorClosed else { return }
            writeDescriptorClosed = true
            _ = systemCalls.close(writeDescriptor)
        }

        /// Waits until `deadline` for the reader thread to exit on its own — that is,
        /// for end-of-file once every write end is closed. Returns whether it has.
        @discardableResult
        func waitUntilExited(deadline: DispatchTime) -> Bool {
            guard exited.wait(timeout: deadline) == .success else { return false }
            exited.signal()
            return true
        }

        /// Wakes the reader thread out of poll(2) even when the capture pipe never
        /// becomes readable again. Idempotent; never blocks.
        func cancel() {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelRequested, !wakeupDescriptorsClosed else { return }
            cancelRequested = true
            var wakeupByte: UInt8 = 1
            var result: Int
            repeat {
                result = Darwin.write(wakeupWriteDescriptor, &wakeupByte, 1)
            } while result == -1 && errno == EINTR
        }

        /// Blocks until the reader thread has provably exited and closed the pipe read
        /// end, then releases the wakeup pipe. Callers must `cancel()` first whenever the
        /// pipe may never reach end-of-file; the wakeup then bounds this wait to thread
        /// scheduling plus one final drain burst. Idempotent.
        func join() {
            exited.wait()
            exited.signal()
            lock.lock()
            defer { lock.unlock() }
            guard !wakeupDescriptorsClosed else { return }
            wakeupDescriptorsClosed = true
            _ = systemCalls.close(wakeupReadDescriptor)
            _ = systemCalls.close(wakeupWriteDescriptor)
        }

        private func consumePipe() {
            Thread.current.name = "CLIRunner.PipeCaptureReader"
            var buffer = [UInt8](repeating: 0, count: 65_536)
            var cancelled = false
            readLoop: while true {
                var reads = 0
                var sawEndOfFile = false
                var sawFailure = false
                let readLimit = cancelled ? Self.cancelledDrainReadLimit : Self.drainReadLimit
                while reads < readLimit {
                    let count = buffer.withUnsafeMutableBytes {
                        systemCalls.read(readDescriptor, $0.baseAddress, $0.count)
                    }
                    if count > 0 {
                        capture.append(Data(bytes: buffer, count: count))
                        reads += 1
                        continue
                    }
                    if count == 0 {
                        sawEndOfFile = true
                    } else if errno == EINTR {
                        continue
                    } else if errno != EAGAIN {
                        storeTerminalError(operation: .read, code: errno)
                        sawFailure = true
                    }
                    break
                }
                if sawEndOfFile || sawFailure || cancelled { break readLoop }
                var descriptors = [
                    pollfd(fd: readDescriptor, events: Int16(POLLIN), revents: 0),
                    pollfd(fd: wakeupReadDescriptor, events: Int16(POLLIN), revents: 0),
                ]
                let events = systemCalls.poll(&descriptors, 2, -1)
                if events == -1 {
                    if errno == EINTR { continue readLoop }
                    storeTerminalError(operation: .poll, code: errno)
                    break readLoop
                }
                if descriptors[0].revents & Int16(POLLNVAL) != 0 {
                    storeTerminalError(operation: .poll, code: EBADF)
                    break readLoop
                }
                if descriptors[0].revents & Int16(POLLERR) != 0 {
                    storeTerminalError(operation: .poll, code: EIO)
                    break readLoop
                }
                if descriptors[1].revents & Int16(POLLNVAL) != 0 {
                    storeTerminalError(operation: .poll, code: EBADF)
                    break readLoop
                }
                if descriptors[1].revents & Int16(POLLERR) != 0 {
                    storeTerminalError(operation: .poll, code: EIO)
                    break readLoop
                }
                if descriptors[1].revents != 0 {
                    // One final bounded drain of already-buffered data, then exit.
                    cancelled = true
                }
            }
            _ = capture.finish()
            _ = systemCalls.close(readDescriptor)
            exited.signal()
        }

        private func storeTerminalError(operation: CaptureOperation, code: Int32) {
            lock.lock()
            defer { lock.unlock() }
            guard storedTerminalError == nil else { return }
            storedTerminalError = .captureFailed(operation: operation, code: code)
        }

        private static func makePipe(operation: String) throws -> (read: Int32, write: Int32) {
            var ends: [Int32] = [0, 0]
            guard Darwin.pipe(&ends) == 0 else {
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errno),
                    userInfo: [NSLocalizedDescriptionKey: "Failed to \(operation): \(String(cString: strerror(errno)))"]
                )
            }
            return (ends[0], ends[1])
        }

        private static func checkedFcntl(
            _ descriptor: Int32,
            command: Int32,
            value: Int32? = nil,
            operation: String,
            systemCalls: SystemCalls
        ) throws -> Int32 {
            var result: Int32
            repeat {
                result = systemCalls.fcntl(descriptor, command, value)
            } while result == -1 && errno == EINTR
            guard result != -1 else {
                let errorNumber = errno
                throw NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(errorNumber),
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Failed to \(operation): \(String(cString: strerror(errorNumber)))"
                    ]
                )
            }
            return result
        }
    }

    static func parseError(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("ERROR:") else { return nil }
        let message = NativeErrorSanitizer.sanitize(
            trimmed.dropFirst("ERROR:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let lowercased = message.lowercased()
        if lowercased.contains("401") || lowercased.contains("incorrect api key")
            || lowercased.contains("invalid_api_key") || lowercased.contains("invalid or expired") {
            return "OpenAI API key invalid or expired — update it in Recordings Settings"
        }
        if lowercased.contains("429") || lowercased.contains("exceeded your current quota")
            || lowercased.contains("insufficient_quota") || lowercased.contains("quota exceeded") {
            return "OpenAI quota exceeded — check the OpenAI account billing"
        }
        if message.contains("OpenAI API key not configured") {
            return "OpenAI API key not configured on this Mac"
        }
        if message.isEmpty {
            return "Transcription failed"
        }
        return String(message.prefix(120))
    }

    /// The raw (pre-enhancement) transcript from a CLI JSON envelope. Intent decisions must
    /// run on this, never on `processed_text`.
    static func parseRawTranscript(_ output: String) -> String? {
        guard let s = output.range(of: "{"), let e = output.range(of: "}", options: .backwards),
              s.lowerBound < e.upperBound else { return nil }
        let json = String(output[s.lowerBound..<e.upperBound])
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["raw_text"] as? String,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return raw
    }

    static func parseJSON(_ output: String) -> String? {
        if let s = output.range(of: "{"), let e = output.range(of: "}", options: .backwards),
           s.lowerBound < e.upperBound {
            let json = String(output[s.lowerBound..<e.upperBound])
            if let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let t = obj["processed_text"] as? String, !t.isEmpty { return t }
                if let t = obj["raw_text"] as? String, !t.isEmpty { return t }
            }
        }
        return output.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.hasPrefix("{") && !$0.contains("Transcribing") && !$0.hasPrefix("Saved") && !$0.hasPrefix("ERROR:") }
    }
}
