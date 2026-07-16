/// Shared presentation contract for every control that starts a new recording. Keeping the
/// labels and enabled state together prevents a ready or error surface from offering an action
/// that `RecordingEngine` would reject while clipboard delivery is still settling.
public struct RecordingStartControlPresentation: Equatable, Sendable {
    public enum Kind: CaseIterable, Sendable {
        case record
        case recordAgain
        case tryAgain
    }

    public let title: String
    public let accessibilityLabel: String
    public let isEnabled: Bool

    public init(kind: Kind, canStartRecording: Bool) {
        switch kind {
        case .record:
            title = "Record"
            accessibilityLabel = "Start recording"
        case .recordAgain:
            title = "Record Again"
            accessibilityLabel = "Start a new recording"
        case .tryAgain:
            title = "Try Again"
            accessibilityLabel = "Try recording again"
        }
        isEnabled = canStartRecording
    }
}
