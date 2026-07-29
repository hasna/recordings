import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

@MainActor
extension RecordingEngine {
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

    func openPrivacySettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Record which trigger is actually bound, at launch and whenever it changes.
    ///
    /// The log already showed `startRecording trigger=keyboardShortcut`, but never which
    /// key was registered — so a hotkey silently rebound to a key the keyboard cannot send
    /// was indistinguishable from a working one. Log the resolved binding so "is the
    /// trigger armed, and to what" is answerable from the log alone.
    public func logResolvedTrigger() {
        let stored = KeyboardShortcuts.getShortcut(for: .toggleRecording)
        let bound = stored
            .map { "carbonKeyCode=\($0.carbonKeyCode) carbonModifiers=\($0.carbonModifiers)" }
            ?? "none"
        // `getShortcut` is a UserDefaults read, so it says what is *configured*, never what
        // is *armed*: KeyboardShortcuts 1.12.0 discards RegisterEventHotKey's OSStatus, so a
        // chord already owned by another app is indistinguishable from a working one here.
        // Say "unknown" rather than let a stored value read as a live binding.
        let systemReserved = stored.map {
            Self.systemReservedShortcuts().contains([$0.carbonKeyCode, $0.carbonModifiers])
        }
        // The permission labels belong on the same line: a press that fires but delivers
        // nothing is a permission problem, and correlating two log lines by timestamp was
        // the only way to tell that apart from a trigger that never fired.
        log(
            "trigger bindings: shortcutStored=\(bound) "
                + "shortcutArmed=unknown(carbon-registration-status-not-exposed) "
                + "shortcutSystemReserved=\(systemReserved.map(String.init(describing:)) ?? "n/a") "
                + "useFnKey=\(useFnKey) fnMonitorRunning=\(fnMonitor.isRunning) "
                + "microphone=\(microphonePermissionLabel) accessibility=\(accessibilityPermissionLabel) "
                + "blocked=\(blockedReason ?? "none")"
        )
    }

    /// Both global triggers used to `return` silently when the engine was busy, so a press
    /// that produced nothing left no trace at all — indistinguishable from a trigger that
    /// never fired. Name the refusal instead.
    ///
    /// Every field the start gate consults must appear here, `isWarmingUpCapture` included:
    /// a press arriving during the ~100 ms warm-up is refused by that field alone, and
    /// omitting it would print every reason as false and reproduce the exact silence this
    /// function was added to end.
    func logIgnoredTrigger(_ trigger: RecordingTrigger) {
        log(
            "trigger ignored trigger=\(trigger) isRecording=\(isRecording) "
                + "isWarmingUpCapture=\(isWarmingUpCapture) "
                + "isTranscribing=\(isTranscribing) deliveryPending=\(deliveryIsPending) "
                + "awaitingMicrophonePermission=\(microphonePermissionStartGate.isAwaitingResponse)"
        )
    }

    /// Accessibility is the gate in practice: `FnKeyMonitor` creates an *active* tap
    /// (`options: .defaultTap`, and it returns nil to swallow fn), and an event-modifying
    /// tap requires Accessibility. Only a listen-only tap would fall under Input
    /// Monitoring, so naming both grants sent people to the wrong pane.
    static let fnAccessibilityBlockedMessage =
        "fn needs Accessibility: System Settings > Privacy & Security > Accessibility"

    /// Periodic reconciliation of the fn tap against reality.
    ///
    /// Two failures this closes. Granting Accessibility does not revive a tap that failed to
    /// create, so it has to be retried — and the retry used to run `updateFnMonitor()`
    /// without `updateStatus()`, so the stale "fn needs Accessibility" line survived the
    /// grant. And a tap can die *after* creation (Accessibility revoked at runtime), which
    /// no creation-time check can see; `FnKeyMonitor.isRunning` now reflects whether the tap
    /// is actually enabled, so that case is detected here instead of reading as "Ready".
    func refreshFnMonitorHealth() {
        guard useFnKey else { return }
        if fnMonitor.isRunning {
            if blockedReasons[.fnKey] != nil {
                setBlockedReason(nil, for: .fnKey)
                updateStatus()
            }
            return
        }
        if AXIsProcessTrusted() {
            log("fn monitor not running while trusted — retrying")
            updateFnMonitor()
        } else {
            setBlockedReason(Self.fnAccessibilityBlockedMessage, for: .fnKey)
        }
        updateStatus()
    }

    func updateFnMonitor(allowAutomaticPrompt: Bool = true) {
        // Decided as a local first, then handed to the single writer once. Assigning the
        // published property from each branch is how the per-source erasure bug got in.
        var reason: String?
        if useFnKey {
            let ok = fnMonitor.start()
            log("fn monitor start ok=\(ok)")
            if !ok {
                if allowAutomaticPrompt {
                    let result = accessibilityPromptGate.trustForProtectedOperation()
                    log("fn monitor accessibility trusted=\(result.trusted) prompted=\(result.didPrompt)")
                }
                reason = Self.fnAccessibilityBlockedMessage
                log("trigger blocked: \(Self.fnAccessibilityBlockedMessage)")
            }
        } else {
            fnMonitor.stop()
        }
        setBlockedReason(reason, for: .fnKey)
    }

    /// Record or clear one source's reason and recompute the published value. Each source owns
    /// its own slot; this is the **only** writer of `blockedReason`.
    ///
    /// - Parameter generation: the recording generation a `.delivery` reason belongs to. Passed
    ///   explicitly by the paste completion because that closure can run *after*
    ///   `recordingGeneration` has already moved on — binding to the current value there would
    ///   stamp a superseded reason as fresh, which is the whole failure this parameter closes.
    ///   Ignored for every other source, none of which is recording-scoped.
    func setBlockedReason(
        _ reason: String?,
        for source: BlockedReasonSource,
        generation: UInt64? = nil
    ) {
        if let reason, !reason.isEmpty {
            // Refuse the write outright when the reason belongs to a superseded recording. The
            // expiry in `updateStatus()` is lazy — no production caller runs it on the delivery
            // completion or the return to idle — so a superseded reason written here would render
            // and stay rendered until the owner next touched a trigger. Declining the store is the
            // pre-render gate; the expiry remains as defence against a generation bump that
            // happens AFTER a legitimate write.
            if source == .delivery, let generation, generation != recordingGeneration {
                log("delivery blocked reason refused for superseded generation=\(generation) current=\(recordingGeneration)")
                return
            }
            blockedReasons[source] = reason
            if source == .delivery {
                // `nil` means unscoped, NOT "current". The public `pasteIntoFrontApp` route has no
                // pipeline generation, so there is nothing that can supersede its reason and it
                // must not be stamped with a generation it never belonged to.
                deliveryBlockedReasonGeneration = generation
            }
        } else {
            blockedReasons.removeValue(forKey: source)
            if source == .delivery {
                deliveryBlockedReasonGeneration = nil
            }
        }
        let entries = blockedReasons
            .sorted { $0.key < $1.key }
            .map { BlockedReasonEntry(source: $0.key, message: $0.value) }
        blockedReasonEntries = entries
        let composed = entries
            .map(\.message)
            .joined(separator: " · ")
        blockedReason = composed.isEmpty ? nil : composed
    }

    /// Enabled system-reserved shortcuts, read straight from Carbon.
    ///
    /// KeyboardShortcuts has an equivalent `Shortcut.isTakenBySystem`, but it sits in a
    /// plain (internal) extension in the pinned 1.12.0 source, so it cannot be reached from
    /// here. Only shortcuts flagged enabled count: a disabled system binding does not
    /// contend for the key.
    static func systemReservedShortcuts() -> Set<[Int]> {
        var unmanaged: Unmanaged<CFArray>?
        guard
            CopySymbolicHotKeys(&unmanaged) == noErr,
            let entries = unmanaged?.takeRetainedValue() as? [[String: Any]]
        else {
            return []
        }
        var reserved: Set<[Int]> = []
        for entry in entries {
            guard
                (entry[kHISymbolicHotKeyEnabled] as? Bool) == true,
                let code = entry[kHISymbolicHotKeyCode] as? Int,
                let modifiers = entry[kHISymbolicHotKeyModifiers] as? Int
            else {
                continue
            }
            reserved.insert([code, modifiers])
        }
        return reserved
    }

    /// Re-evaluate whether the stored hotkey can plausibly arm.
    ///
    /// This is the honest half of a hard limit. `RegisterEventHotKey`'s `OSStatus` is
    /// swallowed inside KeyboardShortcuts 1.12.0 (`CarbonKeyboardShortcuts.register` guards
    /// on `registerError == noErr` and returns Void), so a hotkey stolen by *another
    /// application* is not observable from here at all. A collision with an enabled
    /// *system* shortcut is observable, and it is the case that silently wins, so it gets a
    /// real blocked reason instead of a "Ready" that is not true.
    /// Re-evaluate every trigger's health, push it to the UI, and record it. The one entry
    /// point callers should use after anything changes a binding.
    public func refreshTriggerDiagnostics() {
        refreshHotkeyDiagnostics()
        updateStatus()
        logResolvedTrigger()
    }

    func refreshHotkeyDiagnostics() {
        guard let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) else {
            setBlockedReason(nil, for: .hotkey)
            return
        }
        let key = [shortcut.carbonKeyCode, shortcut.carbonModifiers]
        var reason: String?
        if Self.systemReservedShortcuts().contains(key) {
            reason = "macOS already reserves this shortcut — pick another in Settings > Recording Shortcut"
            log("trigger blocked: hotkey collides with an enabled system shortcut \(key)")
        }
        setBlockedReason(reason, for: .hotkey)
    }

    /// Message shown after a trigger fired but the press was consumed before recording could
    /// start — in practice, the first fn press after a microphone permission prompt. Cancelling
    /// is correct for push-to-talk (releasing the key before the recorder starts must not leave
    /// a recording running with no key held); saying nothing about it is not.
    static let pressConsumedByPermissionPromptMessage =
        "Permission was requested — press and hold again to record"

    /// The only writer of the idle status pair. Nothing else may set `statusMessage` to
    /// "Ready" — three separate callers had grown their own copy of that assignment, and each
    /// one silently bypassed the `blockedReason` branch below, overwriting a live "the app
    /// cannot do the thing you asked" disclosure with a cheerful "Ready". Route every
    /// return-to-idle through here so a fourth copy cannot appear.
    public func updateStatus() {
        if captureIsActive || isTranscribing || deliveryIsPending { return }
        expireStaleDeliveryBlockedReason()
        // A blocked trigger outlives one status write. `init` and every `useFnKey` change
        // called `updateFnMonitor()` and then `updateStatus()`, so the fn permission
        // warning was overwritten with "Ready" before it could ever be read — an enabled
        // trigger that could not arm looked exactly like a working one. Idle now carries
        // the reason until the blocker clears.
        if let blockedReason {
            statusMessage = blockedReason
            flowPhase = .idle
            return
        }
        statusMessage = "Ready"
        flowPhase = .idle
    }

    /// Drop a `.delivery` reason whose recording has been superseded since it was written.
    ///
    /// Lazily, and deliberately named as such: this runs only from `updateStatus()`, and no
    /// production caller invokes that on the delivery completion or on the return to idle. It is
    /// therefore NOT the pre-render gate — `setBlockedReason` declining the write is. This covers
    /// the other half: a generation bump that happens after a legitimate write, which
    /// `cancelIntentProcessing()` does.
    ///
    /// This is the structural half of the delivery reason's lifetime, and it exists because the
    /// two halves are asymmetric: `updateDeliveryStatus` refuses to write a *status* for a
    /// superseded generation and clears nothing on that path, while the paste completion's
    /// `setBlockedReason(…, for: .delivery)` is ungated. A suppressed completion therefore
    /// withholds the status line and persists "press Cmd-V" anyway — pointing at a clipboard that
    /// has moved on, on the app's own instruction.
    ///
    /// A generation check here rather than a fifth enumerated clear site: the four existing clear
    /// sites cover the paths someone thought of, and the paths that matter are the ones nobody
    /// did. `cancelIntentProcessing()` is already one of them — it bumps `recordingGeneration`
    /// without clearing — and `PasteTransactionCoordinator.failNow` releases the pending fence
    /// *before* running the completion closure, so the interleaving is one inserted `await` away
    /// from being reachable rather than latent.
    func expireStaleDeliveryBlockedReason() {
        guard let generation = deliveryBlockedReasonGeneration,
              generation != recordingGeneration else { return }
        log("delivery blocked reason expired generation=\(generation) current=\(recordingGeneration)")
        setBlockedReason(nil, for: .delivery)
    }

    // MARK: - Trigger release

    /// Single key-up path for both hold-to-record triggers, so fn and the configurable
    /// shortcut can never diverge on the only question that matters here: whether any audio
    /// exists yet. A release that lands before the first PCM chunk is a tap that captured
    /// nothing, and it is abandoned rather than transcribed.
    func handleTriggerRelease(_ trigger: RecordingTrigger) {
        guard activeTrigger == trigger else { return }
        guard isRecording else {
            log("\(trigger) released before audio started; cancelling pending start")
            cancelPendingStart()
            return
        }
        stopAndTranscribe()
    }

    /// Key-up with no audio yet. Two windows reach this: the microphone permission prompt
    /// (nothing was ever started, so there is nothing to tear down) and the warm-up window
    /// (the microphone is open and a realtime session may be negotiating, both of which must
    /// be closed).
    func cancelPendingStart() {
        if isWarmingUpCapture {
            abandonWarmingCapture(
                reason: "trigger released before first audio",
                alert: .releasedBeforeAudio
            )
            return
        }
        // Nothing was started: the press landed while the microphone permission prompt was up
        // and was consumed by it. Both key-up handlers used to carry a copy of this disclosure;
        // it belongs here, once, with the rest of the no-audio branch.
        let consumedByPermissionPrompt = microphonePermissionStartGate.isAwaitingResponse
        resetRecordingIntent()
        if consumedByPermissionPrompt {
            setBlockedReason(Self.pressConsumedByPermissionPromptMessage, for: .pressConsumed)
        }
        updateStatus()
    }

    // MARK: - Toggle

    public func toggleRecording() {
        if captureIsActive { stopAndTranscribe() } else { startRecording(trigger: .manual) }
    }

}
