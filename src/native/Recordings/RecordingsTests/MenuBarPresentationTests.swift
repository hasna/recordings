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
            canStartRecording: true,
            statusMessage: "Ready"
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
            canStartRecording: false,
            statusMessage: "Recording — release to stop"
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
                canStartRecording: false,
                statusMessage: status
            )
            #expect(presentation.iconName == "ellipsis.circle", "expected busy icon for \(status)")
            #expect(!presentation.primaryActionEnabled, "Start must be disabled during \(status)")
            let trimmed = status.trimmingCharacters(in: .punctuationCharacters)
            #expect(presentation.statusText == trimmed)
            #expect(presentation.accessibilityLabel == "Recordings, \(trimmed.lowercased())")
        }
    }

    @Test("presentation follows canStartRecording exactly, not isTranscribing alone")
    func presentationTracksTheStartGate() {
        // A pending intent decision keeps canStartRecording false even though
        // isTranscribing is false — the old menu bar showed idle here and then rejected
        // the click. The contract requires busy.
        let deciding = MenuBarPresentation(
            isRecording: false,
            canStartRecording: false,
            statusMessage: "Deciding..."
        )
        #expect(!deciding.primaryActionEnabled)
        #expect(deciding.statusText == "Deciding")
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
