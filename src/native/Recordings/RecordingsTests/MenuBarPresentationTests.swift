import Foundation
import Testing
@testable import RecordingsLib

/// The menu bar's state contract: its presentation must agree with the engine's own start
/// gate in every state, so the surface can never offer a Start it would reject.
struct MenuBarPresentationTests {
    @Test("idle presents the mic and an enabled Start")
    func idle() {
        let presentation = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: true,
            statusMessage: "Ready",
            blockedReason: nil
        )
        #expect(presentation.iconName == "mic.fill")
        #expect(presentation.accessibilityLabel == "Recordings")
        #expect(presentation.statusText == "Ready")
        #expect(presentation.primaryActionEnabled)
    }

    @Test("recording presents the waveform and an enabled Stop affordance")
    func recording() {
        let presentation = MenuBarPresentation(
            isRecording: true,
            isWarmingUpCapture: false,
            canStartRecording: false,
            statusMessage: "Recording — release to stop",
            blockedReason: nil
        )
        #expect(presentation.iconName == "waveform")
        #expect(presentation.accessibilityLabel == "Recordings, recording")
        #expect(presentation.statusText == "Recording")
        #expect(presentation.primaryActionEnabled, "Stop must stay available while recording")
    }

    @Test("every non-startable processing state presents busy and disables Start")
    func busyStatesAreTruthful() {
        for status in ["Transcribing...", "Deciding...", "Answering...", "Rewriting...", "Pasting..."] {
            let presentation = MenuBarPresentation(
                isRecording: false,
                isWarmingUpCapture: false,
                canStartRecording: false,
                statusMessage: status,
                blockedReason: nil
            )
            #expect(presentation.iconName == "ellipsis.circle", "expected busy icon for \(status)")
            #expect(!presentation.primaryActionEnabled, "Start must be disabled during \(status)")
            let trimmed = status.trimmingCharacters(in: .punctuationCharacters)
            #expect(presentation.statusText == trimmed)
            #expect(presentation.accessibilityLabel == "Recordings, \(trimmed.lowercased())")
        }
    }

    /// The defect this pins: the idle branch discarded `statusMessage` and set `mic.fill` /
    /// "Recordings", and the always-visible menu-bar item renders ONLY the icon and the
    /// accessibility label. So a blocked app was byte-identical to Ready for sighted and
    /// VoiceOver users alike, and "press Cmd-V" lived only in a popover nobody had opened.
    @Test("a blocked idle app is distinguishable from Ready by BOTH icon and label")
    func blockedIsVisible() {
        let reason = "This field blocks typing (secure input) — transcript copied, press Cmd-V"
        let ready = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: true,
            statusMessage: "Ready",
            blockedReason: nil
        )
        let blocked = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: true,
            statusMessage: "Ready",
            blockedReason: reason
        )

        #expect(blocked.iconName != ready.iconName, "the icon is the only signal a sighted user gets")
        #expect(
            blocked.accessibilityLabel != ready.accessibilityLabel,
            "the label is the only signal VoiceOver gets"
        )
        #expect(blocked.iconName == MenuBarPresentation.blockedIconName)
        #expect(blocked.accessibilityLabel.contains(reason))
        #expect(blocked.statusText == reason)
        #expect(blocked.isBlocked)
        #expect(!ready.isBlocked)
        // A blocked trigger or a blocked paste does not make Start unavailable, and the
        // presentation must keep matching `canStartRecording` exactly.
        #expect(blocked.primaryActionEnabled)
    }

    @Test("an empty blocked reason is not a blocked state")
    func emptyReasonIsNotBlocked() {
        let presentation = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: true,
            statusMessage: "Ready",
            blockedReason: ""
        )
        #expect(presentation.iconName == MenuBarPresentation.idleIconName)
        #expect(!presentation.isBlocked)
    }

    @Test("recording and busy states outrank a blocked reason")
    func liveStatesWin() {
        let recording = MenuBarPresentation(
            isRecording: true,
            isWarmingUpCapture: false,
            canStartRecording: false,
            statusMessage: "Recording",
            blockedReason: "stale reason"
        )
        #expect(recording.iconName == "waveform")
        #expect(!recording.isBlocked)

        let busy = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: false,
            statusMessage: "Transcribing...",
            blockedReason: "stale reason"
        )
        #expect(busy.iconName == "ellipsis.circle")
        #expect(!busy.primaryActionEnabled)
        #expect(!busy.isBlocked)
    }

    @Test("presentation follows canStartRecording exactly, not isTranscribing alone")
    func presentationTracksTheStartGate() {
        // A pending intent decision keeps canStartRecording false even though
        // isTranscribing is false — the old menu bar showed idle here and then rejected
        // the click. The contract requires busy.
        let deciding = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: false,
            canStartRecording: false,
            statusMessage: "Deciding...",
            blockedReason: nil
        )
        #expect(!deciding.primaryActionEnabled)
        #expect(deciding.statusText == "Deciding")
    }

    @Test("the warm-up window presents as recording, never as busy or idle")
    func warmUpPresentsAsRecording() {
        // Between `recorder.start()` returning and the first PCM chunk the user is holding the
        // key. `isRecording` is false there — no audio exists yet — so without this branch the
        // glyph drops to the busy ellipsis for ~100 ms in the middle of a hold.
        let presentation = MenuBarPresentation(
            isRecording: false,
            isWarmingUpCapture: true,
            canStartRecording: false,
            statusMessage: "Recording — release to stop",
            blockedReason: nil
        )
        #expect(presentation.iconName == "waveform")
        #expect(presentation.accessibilityLabel == "Recordings, recording")
        #expect(presentation.statusText == "Recording")
        #expect(presentation.primaryActionEnabled, "Stop must be live during warm-up")
        #expect(!presentation.isBlocked)
    }

    @Test("an attempt that captured nothing is disclosed on the glyph, not just in a status line")
    func emptyAttemptIsDisclosedOnTheGlyph() {
        // Recordings is LSUIElement: a status line behind a popover click is not feedback. The
        // engine routes these through `blockedReason`, so they must reach the always-visible
        // icon and the VoiceOver label, and must not look like plain idle.
        for alert in [RecordingAttemptAlert.releasedBeforeAudio, .noAudioCaptured] {
            let presentation = MenuBarPresentation(
                isRecording: false,
                isWarmingUpCapture: false,
                canStartRecording: true,
                statusMessage: "Ready",
                blockedReason: alert.message
            )
            #expect(presentation.iconName == MenuBarPresentation.blockedIconName, "expected the blocked glyph for \(alert)")
            #expect(presentation.iconName != MenuBarPresentation.idleIconName)
            #expect(presentation.statusText == alert.message)
            #expect(presentation.accessibilityLabel == "Recordings, blocked: \(alert.message)")
            #expect(presentation.isBlocked)
            #expect(presentation.primaryActionEnabled, "the attempt is over — Start stays available")
        }
    }

    @Test("a hold in progress outranks a still-visible empty-attempt disclosure")
    func recordingOutranksADisclosure() {
        // `blockedReason` is cleared by the next `startRecording`, but the warm-up branch must
        // win regardless: showing "released too soon" over a live hold would be a lie.
        for warmingUp in [true, false] {
            let presentation = MenuBarPresentation(
                isRecording: !warmingUp,
                isWarmingUpCapture: warmingUp,
                canStartRecording: false,
                statusMessage: "Recording — release to stop",
                blockedReason: RecordingAttemptAlert.releasedBeforeAudio.message
            )
            #expect(presentation.iconName == "waveform")
            #expect(!presentation.isBlocked)
        }
    }
}

/// Reduce Transparency surface contract: chrome must resolve to an opaque surface — never
/// a translucent material — whenever the user has reduced transparency.
struct ChromeSurfaceTests {
    @Test("Reduce Transparency resolves to the opaque surface; otherwise Liquid Glass")
    func reducedTransparencyIsOpaque() {
        #expect(ChromeSurface.forReducedTransparency(true) == .opaque)
        #expect(ChromeSurface.forReducedTransparency(false) == .liquidGlass)
    }
}

/// Voice-shortcut matching contract: exact utterance only.
struct VoiceShortcutMatchingTests {
    @Test("a shortcut fires for the exact utterance, ignoring case, punctuation, and spacing")
    func exactUtteranceMatches() {
        #expect(VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "add disclaimer"))
        #expect(VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "Add disclaimer."))
        #expect(VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "  ADD   DISCLAIMER!  "))
        #expect(VoiceShortcuts.matches(trigger: "Add Disclaimer", transcript: "add disclaimer"))
    }

    @Test("ordinary sentences containing the trigger cannot hijack routing")
    func embeddedTriggerDoesNotMatch() {
        #expect(!VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "what does add disclaimer mean?"))
        #expect(!VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "please add disclaimer to the doc"))
        #expect(!VoiceShortcuts.matches(trigger: "add disclaimer", transcript: "add disclaimers"))
        #expect(!VoiceShortcuts.matches(trigger: "sig", transcript: "the signature looks wrong"))
    }

    @Test("empty or whitespace triggers never match")
    func emptyTriggerNeverMatches() {
        #expect(!VoiceShortcuts.matches(trigger: "", transcript: ""))
        #expect(!VoiceShortcuts.matches(trigger: "   ", transcript: "anything"))
    }
}
