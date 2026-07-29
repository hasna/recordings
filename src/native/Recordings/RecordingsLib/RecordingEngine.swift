import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
public final class RecordingEngine: ObservableObject {
    /// Audio is arriving. Not "a start was requested": `AVAudioEngine.start()` returns before
    /// the input tap delivers its first sample (measured cold on Apple silicon:
    /// `native recorder started` at +541 ms, `native recorder received first PCM chunk` at
    /// +644 ms), and a hold released inside that window captured nothing at all. Flipping this
    /// on `start()` returning is what let a short tap fall through to the transcription
    /// pipeline with an empty buffer and finish silently.
    @Published public private(set) var isRecording = false
    /// The microphone is open but has not produced a sample yet — the ~100 ms window above.
    /// Surfaces render this as recording (the user is holding the key), and every teardown
    /// path can abandon it, but nothing may treat it as audio that exists.
    @Published public private(set) var isWarmingUpCapture = false
    @Published public var useFnKey: Bool = false {
        didSet {
            UserDefaults.standard.set(useFnKey, forKey: "useFnKey")
            updateFnMonitor()
            refreshTriggerDiagnostics()
        }
    }
    /// Where a blocked reason came from. The published reason is composed across these rather
    /// than written per-source, because more than one can hold at once — fn and the hotkey can
    /// both be blocked, and a delivery can be blocked while a trigger is too. A per-source
    /// writer lets whichever ran last erase the others, which is the erasure bug this whole
    /// mechanism exists to prevent.
    ///
    /// `Comparable` by declaration order, so the composed string is stable no matter which
    /// source was written last: a reason that reorders itself between renders reads as two
    /// different problems.
    enum BlockedReasonSource: Int, CaseIterable, Comparable, Sendable {
        /// The last delivery could not reach the target app and the transcript is sitting on
        /// the clipboard waiting for the user. Cleared by the next recording, not by the next
        /// status write.
        ///
        /// FIRST deliberately. This is the only reason that tells the owner their transcript is
        /// still recoverable ("press Cmd-V"), and it used to sort LAST — so with a blocked
        /// trigger as well it landed at the tail of a `.font(.caption)` `Text` in a 260-pt
        /// popover, behind two reasons about key bindings. Data-recovery advice leads; the
        /// trigger reasons are about a next press, which can wait.
        case delivery
        /// The keyboard shortcut collides with an enabled system shortcut.
        case hotkey
        /// The fn monitor cannot run (Accessibility).
        case fnKey
        /// A trigger fired but the press was consumed before recording could start — the
        /// permission-prompt case. Transient, and cleared by the next start.
        case pressConsumed

        static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

        /// Whether this source describes trigger *health* — the subject of the Settings
        /// "Recording Shortcut" section. Exhaustive so a new source has to make the decision
        /// rather than defaulting into a section whose remedy does not fit it.
        var isTriggerHealth: Bool {
            switch self {
            // `.pressConsumed` IS trigger health: it is written from the fn and hotkey release
            // handlers and says "press and hold again to record". Classifying it as non-trigger
            // dropped it from the one section documented as "a trigger that is switched on but
            // cannot arm must say so next to its own switch". `remedy` alone suppresses the wrong
            // button, so the row belongs here.
            case .hotkey, .fnKey, .pressConsumed: true
            // Delivery is about the last paste, not about a binding. It gets its own row.
            case .delivery: false
            }
        }

        /// The action that actually fixes this cause, so a surface offering a *button* keys it to
        /// the cause instead of to whatever text happened to be composed.
        var remedy: BlockedReasonEntry.Remedy {
            switch self {
            case .fnKey: .openAccessibilitySettings
            // A chord collision is not a permissions problem; the Accessibility pane does
            // nothing for it and the shortcut recorder is already on screen.
            case .hotkey: .chooseAnotherShortcut
            // Both say what to do in the message itself — "press Cmd-V", "press and hold
            // again" — so a button would be a second, competing instruction.
            case .delivery, .pressConsumed: .messageOnly
            }
        }
    }

    /// One source's reason together with the remedy that fixes it.
    ///
    /// The composed `blockedReason` string is what the menu bar renders, and it is enough there
    /// because that surface only reports. A Settings section that offers a *button* needs to know
    /// WHICH problem it is offering to fix: rendering the composed string under "Recording
    /// Shortcut" next to "Open Accessibility Settings" meant a secure-input paste failure showed
    /// "transcript copied, press Cmd-V" beside a button that opens the Accessibility pane — the
    /// wrong remedy, in the wrong section, for the wrong cause.
    public struct BlockedReasonEntry: Identifiable, Equatable, Sendable {
        public enum Remedy: Equatable, Sendable {
            /// Grant Accessibility — what the fn monitor needs before its tap can be created.
            case openAccessibilitySettings
            /// Pick a different chord; the recorder that does it is in the same section.
            case chooseAnotherShortcut
            /// The message is the whole remedy. No button.
            case messageOnly
        }

        let source: BlockedReasonSource
        public let message: String
        public var remedy: Remedy { source.remedy }
        /// Whether this belongs in the Settings trigger section.
        public var isTriggerHealth: Bool { source.isTriggerHealth }
        public var id: Int { source.rawValue }
    }

    /// Why the app currently cannot record or deliver, when the reason outlives one status
    /// write. Held separately from `statusMessage` because `updateStatus()` rewrites that on
    /// every return to idle; see `updateStatus()`.
    ///
    /// This is the collapse of what were two fields — `triggerBlockedReason` (trigger health)
    /// and `blockedReason` (secure-input delivery). Two published fields describing "the app
    /// cannot do the thing you asked" is two places for a view to forget to read, and the
    /// menu bar forgot to read either of them. One field, one writer.
    @Published public private(set) var blockedReason: String?
    /// The same reasons, per source and in precedence order. `blockedReason` is composed from
    /// exactly this array, in the same call, so the two cannot disagree — this is the structured
    /// form of one field, not a second field describing the same thing.
    @Published public private(set) var blockedReasonEntries: [BlockedReasonEntry] = []
    /// The ONLY writer of `blockedReason` is `setBlockedReason(_:for:)`. Do not assign the
    /// published property anywhere else; `macos-shortcut-contract.test.ts` asserts that.
    var blockedReasons: [BlockedReasonSource: String] = [:]
    /// The recording generation the `.delivery` reason was written for, or nil when none is held.
    ///
    /// The `.delivery` reason is the only one that is a claim about a *specific* recording:
    /// "press Cmd-V" is true of the clipboard that recording wrote, and stops being true once the
    /// generation moves on. Tracked so `updateStatus()` can expire it structurally instead of
    /// relying on someone having enumerated every path that ought to clear it.
    var deliveryBlockedReasonGeneration: UInt64?
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
    /// Advances only after the CLI confirms that a recording has been persisted. The app
    /// store observes this independently of the Record pane so asynchronous saves and
    /// background recovery refresh the Library even after that pane has been unmounted.
    @Published public private(set) var persistedRecordingRevision: UInt64 = 0
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

    var nativeRecorder: PCMRecordingSource?
    var recordingTimer: Timer?
    var activeTrigger: RecordingTrigger?
    var microphonePermissionStartGate = MicrophonePermissionStartGate()
    var keyboardShortcutIsDown = false
    var fnKeyIsDown = false
    var targetAppBundleIdentifier: String?
    var targetAppPid: pid_t?
    var pasteTargetProcessIdentityByGeneration: [UInt64: PasteTargetProcessIdentity] = [:]
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
    var realtimeClient: RealtimeTranscriptionClient?
    var streamingTask: Task<Void, Never>?
    var pcmStreamPipe: PCMStreamPipe?
    var streamingText = ""
    var recordedPCM = Data()
    var activeAudioPath: String?
    let accessibilityPromptGate = AccessibilityPromptGate.processShared
    private(set) var recordingGeneration: UInt64 = 0
    var activeCaptureConfiguration: RecordingCaptureConfiguration?
    var pipelineDeliveryGate = PipelineDeliveryGate()
    /// Generation whose intent delivery (Deciding/Answering/Rewriting) is in flight, or nil.
    /// Scoped to the generation so a stale completion can never clear a newer pending state.
    var intentDeliveryPendingGeneration: UInt64?
    lazy var intentClassifier = SpeechIntentClassifier(
        apiKeyProvider: { [home] in OpenAIAPIKeyStore.load(homePath: home) }
    )
    lazy var pasteTransactionCoordinator = makePasteTransactionCoordinator(
        schedule: { delay, operation in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                MainActor.assumeIsolated { operation() }
            }
        },
        writeAndVerify: { text in
            let pasteboard = NSPasteboard.general
            return RecordingEngine.writeClipboardAttempt(text, to: pasteboard)
        },
        postPaste: { [weak self] in
            // Secure input is checked here, on the posting turn, rather than earlier: a
            // password field can take it between the readiness checks and the keystroke, and
            // while it is held the window server drops every synthetic event.
            let secureInput = SecureInputProbe.current()
            self?.lastPasteSecureInputProbe = secureInput
            if case .active(let holder) = secureInput {
                return .refusedSecureInput(holder)
            }
            let source = CGEventSource(stateID: .hidSystemState)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false) else {
                return .constructionFailed
            }
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cgSessionEventTap)
            up.post(tap: .cgSessionEventTap)
            // Probed AGAIN, after posting, because the pre-post reading cannot cover the case
            // that matters: a password field takes secure input between that probe and the
            // keystroke. The window server then drops both events, and the read-back — which
            // compares two AX reads of the focused field — can say "the text did not land" but
            // never "secure input ate it". Its vocabulary tops out at
            // `.notObservedFocusedValueUnchanged` / `.unverified(.readBackUnreadable)`, so the
            // outcome falls to `.deliveryNotObserved` or `.deliveredUnverified`, neither of which
            // is an `isSecureInputOutcome` — deliberately — so NOTHING is persisted: no warning
            // icon, no VoiceOver "blocked" label, and no "press Cmd-V", which is the only thing
            // telling the owner the transcript is still recoverable.
            //
            // And the log was not merely silent about the cause, it stated the opposite:
            // `lastPasteSecureInputProbe` still held the pre-post reading, so
            // `PasteDeliveryReport.logLine` recorded `secureInput=inactive` for a paste secure
            // input had actually eaten.
            //
            // Only an `.active` reading overwrites the stored probe. A post-post `.unknown` after
            // a definite pre-post `.inactive` is less informative about the posting turn, not
            // more, so it must not replace it. The residual race — secure input taken and
            // released entirely inside the posting window — is unobservable from here and stays
            // unobservable; this closes the case where it is still held.
            //
            // This reading does NOT change the return value, and that is the whole design of it.
            // Returning `.refusedSecureInput` here would be wrong twice over. The coordinator
            // answers that case with `failNow`, which settles immediately and never builds the
            // `PendingDelivery` — so the read-back, the ONLY evidence that can say whether the
            // keystroke actually landed, would be discarded at precisely the moment it is needed.
            // And a post-post `.active` reading cannot distinguish the two cases it spans: secure
            // input taken between `up.post()` and this probe leaves the events already dispatched
            // and probably delivered, while secure input taken during the posts drops them.
            // Calling that a refusal would tell the owner "transcript copied, press Cmd-V" for a
            // paste that already succeeded, and Cmd-V would paste it a second time — a worse
            // failure than the missing disclosure it was meant to fix. It would also make the log
            // say `not_posted_secure_input` for events that WERE posted, trading one false
            // statement for another. `.refusedSecureInput` means "nothing was posted"; it must
            // keep meaning that.
            //
            // So the read-back stays the arbiter (#28's ruling) and this probe makes the LOG
            // honest: `PasteDeliveryReport` now carries the post-post reading, where it previously
            // carried the pre-post one and recorded `secure_input=inactive` for a paste secure
            // input may have eaten — asserting the opposite of what happened rather than merely
            // omitting it.
            //
            // NOT restored, and deliberately: attribution strong enough to reach the persistence
            // and visibility path. Making a non-confirming read-back settle as
            // `.secureInputActive` needs a new keystroke-attempt case threaded through
            // `PasteAttempt`, or the log token lies about whether events were posted. That
            // widening is a design change, left for review rather than smuggled in here.
            let secureInputAfterPost = SecureInputProbe.current()
            switch secureInputAfterPost {
            // Held after the posts: the reading the log must carry.
            case .active: self?.lastPasteSecureInputProbe = secureInputAfterPost
            // Definite after an indefinite pre-post reading is strictly more informative, so it
            // replaces it; the reverse would discard a definite reading for an indefinite one.
            case .inactive: if case .unknown = secureInput { self?.lastPasteSecureInputProbe = secureInputAfterPost }
            case .unknown: break
            }
            // Constructed and posted. Nothing here observes delivery, which is why this
            // returns `.posted` and not a success.
            return .posted
        }
    )
    /// Secure-input reading taken on the last posting turn, or nil when no paste has reached
    /// the posting step. Kept so the delivery log can say whether synthetic input was even
    /// possible instead of leaving the reader to guess.
    var lastPasteSecureInputProbe: SecureInputState?

    /// Every coordinator the engine owns must publish its idle transitions:
    /// `canStartRecording` derives from coordinator state, and settlement back to idle is
    /// otherwise invisible to observers — the menu bar would stay busy with Start disabled
    /// until some unrelated published change.
    func makePasteTransactionCoordinator(
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

    nonisolated static let realtimePeriodicCommitIntervalMilliseconds: UInt64 = 900
    /// Floor of the post-release settlement budget. The settlement wait polls every 10 ms
    /// and returns the moment the final transcription lands, so the budget is only ever
    /// paid in full when the realtime session is still unsettled — the common settled case
    /// costs its actual settle time (measured 0.6-1.6 s on station-class hardware).
    nonisolated static let realtimeSettleBudgetFloorMilliseconds: UInt64 = 1_500
    /// Additional settlement budget granted per second of captured audio. A settlement
    /// miss falls back to re-transcribing the whole recording through the batch API, which
    /// costs roughly a quarter of the recording's duration (measured: 4 s floor + ~25%
    /// of audio length) — so the longer the recording, the more waiting is worth it.
    nonisolated static let realtimeSettleBudgetPerAudioSecondMilliseconds: UInt64 = 25
    /// Ceiling of the settlement budget: past this point the user has watched
    /// "Transcribing..." for so long that starting the recoverable batch path is the
    /// better trade even for very long recordings.
    nonisolated static let realtimeSettleBudgetCeilingMilliseconds: UInt64 = 5_000
    /// PCM byte rate of the capture pipeline (24 kHz, 16-bit, mono) — used to convert
    /// captured byte counts back into audio seconds for the settlement budget.
    nonisolated static let capturedPCMBytesPerSecond = 48_000

    /// Settlement budget for `RealtimeTranscriptionClient.finish` scaled to the captured
    /// audio length. The previous fixed 700 ms budget was routinely missed by real
    /// sessions (final transcription completions arrive ~0.6-1.6 s after release), which
    /// silently demoted nearly every recording to the duration-proportional batch path —
    /// the "one minute to transcribe" failure mode this budget exists to prevent.
    public nonisolated static func realtimeSettleBudgetMilliseconds(pcmByteCount: Int) -> UInt64 {
        let audioSeconds = UInt64(max(pcmByteCount, 0)) / UInt64(capturedPCMBytesPerSecond)
        let (scaled, overflowed) = audioSeconds.multipliedReportingOverflow(
            by: realtimeSettleBudgetPerAudioSecondMilliseconds
        )
        guard !overflowed else { return realtimeSettleBudgetCeilingMilliseconds }
        let (budget, budgetOverflowed) = realtimeSettleBudgetFloorMilliseconds
            .addingReportingOverflow(scaled)
        guard !budgetOverflowed else { return realtimeSettleBudgetCeilingMilliseconds }
        return min(budget, realtimeSettleBudgetCeilingMilliseconds)
    }
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
    /// Wait before each read-back of the target app's focused field. The window server
    /// delivers the posted keystroke asynchronously and the app then does its own work, so a
    /// read taken on the posting turn would report "unchanged" for a paste that is simply
    /// still in flight.
    nonisolated static let pasteReadBackInterval: TimeInterval = 0.15
    /// How many read-backs before "the field did not change" is accepted as the verdict.
    /// Four reads spaced by `pasteReadBackInterval` give a slow target app ~0.6 s to show the
    /// paste; a confirmation on any read ends the wait immediately. The transaction stays
    /// pending for that window, which is why the budget is bounded rather than generous.
    nonisolated static let pasteReadBackAttempts = 4

    // fn key monitor (CGEventTap-based, swallows fn to prevent emoji picker)
    let fnMonitor = FnKeyMonitor()
    var permissionRetryTimer: Timer?

    /// Filesystem root for every artifact the engine owns: the audio spool, the
    /// API-key/language store (`config.json`), `Recordings.log`, and the `recordings` CLI it
    /// shells out to. This is the same `homePath:` seam `NativeAppLog.write` and
    /// `OpenAIAPIKeyStore` already expose, defaulted the same way — production keeps the real
    /// home and is unchanged.
    ///
    /// Unlike the closure seams above it must be supplied before `init` returns, because
    /// `init` already creates `audioDir` and logs; hence an `init(homePath:)` parameter
    /// rather than a settable property. Tests must pass a temp directory: with the default,
    /// every engine a test builds appends the suite's synthetic fixtures
    /// (`target=com.example.editor pid=99999`) to the operator's live `Recordings.log` and
    /// rewrites their real `config.json`.
    let home: String
    var audioDir: String { "\(home)/.hasna/recordings/audio" }

    public init(homePath: String = FileManager.default.homeDirectoryForCurrentUser.path) {
        home = homePath
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)
        log("RecordingEngine init; microphone=\(microphonePermissionLabel); accessibility=\(accessibilityPermissionLabel)")

        // Load preferences
        intentDetectionEnabled = UserDefaults.standard.object(forKey: "intentDetectionEnabled") as? Bool ?? true
        transcriptionLanguage = OpenAIAPIKeyStore.loadLanguage(homePath: home)
        useFnKey = UserDefaults.standard.object(forKey: "useFnKey") as? Bool ?? false
        if KeyboardShortcuts.getShortcut(for: .toggleRecording) == nil {
            KeyboardShortcuts.setShortcut(.init(.f5), for: .toggleRecording)
        }
        refreshHotkeyDiagnostics()
        logResolvedTrigger()

        // Set up fn key monitor — hold fn to record, release to stop (like WisprFlow)
        fnMonitor.onFnKeyDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = true
                guard self.useFnKey else { return }
                guard Self.canBeginRecording(
                    isRecording: self.isRecording,
                    isTranscribing: self.isTranscribing,
                    isWarmingUpCapture: self.isWarmingUpCapture,
                    isAwaitingMicrophonePermission: self.microphonePermissionStartGate.isAwaitingResponse,
                    isDeliveryPending: self.deliveryIsPending
                ) else {
                    self.logIgnoredTrigger(.fnKey)
                    return
                }
                self.startRecording(trigger: .fnKey)
            }
        }
        fnMonitor.onFnKeyUp = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.fnKeyIsDown = false
                guard self.useFnKey else { return }
                self.handleTriggerRelease(.fnKey)
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
                    isWarmingUpCapture: self.isWarmingUpCapture,
                    isAwaitingMicrophonePermission: self.microphonePermissionStartGate.isAwaitingResponse,
                    isDeliveryPending: self.deliveryIsPending
                ) else {
                    self.logIgnoredTrigger(.keyboardShortcut)
                    return
                }
                self.startRecording(trigger: .keyboardShortcut)
            }
        }
        KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.keyboardShortcutIsDown else { return }
                self.keyboardShortcutIsDown = false
                self.handleTriggerRelease(.keyboardShortcut)
            }
        }

        // Granting Accessibility does not revive a tap that failed to create,
        // so retry until permissions arrive instead of requiring a relaunch.
        permissionRetryTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshFnMonitorHealth()
            }
        }

        updateStatus()
    }

}
