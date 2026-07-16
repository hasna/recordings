import Foundation

/// State contract for the menu-bar surface. The visual vocabulary is deliberately tiny and
/// unchanged (mic / waveform / ellipsis, one status line, one primary button); what this
/// type guarantees is truthfulness: whenever the engine would reject `startRecording` —
/// including while an intent decision, answer, or rewrite is pending — the menu bar must
/// present a busy state and a disabled Start affordance, never an idle state it would
/// then refuse.
public struct MenuBarPresentation: Equatable, Sendable {
    public let iconName: String
    public let accessibilityLabel: String
    public let statusText: String
    /// Whether the primary button is available. While recording the same button is the
    /// (always enabled) Stop affordance; otherwise it is Start and must match
    /// `RecordingEngine.canStartRecording` exactly.
    public let primaryActionEnabled: Bool

    public init(isRecording: Bool, canStartRecording: Bool, statusMessage: String) {
        if isRecording {
            iconName = "waveform"
            accessibilityLabel = "Recordings, recording"
            statusText = "Recording"
            primaryActionEnabled = true
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
