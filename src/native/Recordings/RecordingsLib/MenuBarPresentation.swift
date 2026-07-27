import Foundation

/// State contract for the menu-bar surface. The visual vocabulary is deliberately tiny
/// (mic / waveform / ellipsis / mic.slash, one status line, one primary button); what this
/// type guarantees is truthfulness: whenever the engine would reject `startRecording` —
/// including while an intent decision, answer, or rewrite is pending — the menu bar must
/// present a busy state and a disabled Start affordance, never an idle state it would
/// then refuse.
///
/// The glyph is also this app's only always-on surface, so it carries one more job: a
/// recording attempt that produced nothing has to be visible *here*, not only in a status
/// line the user would have to open the popover to read.
public struct MenuBarPresentation: Equatable, Sendable {
    public let iconName: String
    public let accessibilityLabel: String
    public let statusText: String
    /// Whether the primary button is available. While recording the same button is the
    /// (always enabled) Stop affordance; otherwise it is Start and must match
    /// `RecordingEngine.canStartRecording` exactly.
    public let primaryActionEnabled: Bool

    /// Neither new argument has a default. `isWarmingUpCapture: false` and `attemptAlert: nil`
    /// are the *invisible* values — a surface that forgot them would compile and quietly render
    /// warm-up as busy and a failed attempt as idle, which is the class of bug this type exists
    /// to prevent. Every caller states both.
    public init(
        isRecording: Bool,
        isWarmingUpCapture: Bool,
        canStartRecording: Bool,
        statusMessage: String,
        attemptAlert: RecordingAttemptAlert?
    ) {
        if isRecording || isWarmingUpCapture {
            // The warm-up window — microphone open, first sample not yet delivered — presents
            // as recording: the user is holding the key and Stop is live, so anything else
            // would read as a dead app for ~100 ms.
            iconName = "waveform"
            accessibilityLabel = "Recordings, recording"
            statusText = "Recording"
            primaryActionEnabled = true
        } else if let attemptAlert {
            // A terminal "nothing was captured" outcome outranks the generic busy/idle
            // rendering for a few seconds. Start stays governed by `canStartRecording`, so the
            // truthfulness contract above still holds exactly.
            iconName = attemptAlert.iconName
            accessibilityLabel = "Recordings, \(attemptAlert.message.lowercased())"
            statusText = attemptAlert.message
            primaryActionEnabled = canStartRecording
        } else if !canStartRecording {
            let normalizedBusyStatus = statusMessage.trimmingCharacters(in: .punctuationCharacters)
            iconName = "ellipsis.circle"
            accessibilityLabel = "Recordings, \(normalizedBusyStatus.lowercased())"
            statusText = normalizedBusyStatus
            primaryActionEnabled = false
        } else {
            iconName = "mic.fill"
            accessibilityLabel = "Recordings"
            statusText = statusMessage
            primaryActionEnabled = true
        }
    }
}
