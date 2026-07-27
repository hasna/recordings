import Foundation

/// A recording attempt that produced nothing the user can see anywhere else.
///
/// Recordings is an `LSUIElement` app: its only always-on surface is the menu-bar glyph.
/// `statusMessage` and the Record pane both sit behind a click, so an outcome delivered only
/// there is invisible to someone who pressed the key while looking at their editor — which is
/// how a swallowed attempt reads as "the app is still broken" no matter what the log says.
///
/// This is a message vocabulary, not a surface. The engine discloses these through
/// `setBlockedReason(_:for: .pressConsumed)` — the single published `blockedReason` field, which
/// `MenuBarPresentation` already renders with its own icon and its own VoiceOver label, and which
/// `startRecording` already clears. A second published field for the same idea would undo the
/// collapse that field exists to be.
public enum RecordingAttemptAlert: Equatable, Sendable {
    /// The trigger was released before the microphone delivered its first sample, so no audio
    /// ever existed to transcribe.
    case releasedBeforeAudio
    /// Capture ran to completion but the microphone produced no audio at all.
    case noAudioCaptured

    /// Shown on the menu-bar status line and in the Record pane. Kept short enough to fit the
    /// 260 pt popover without wrapping past two lines, and phrased as the corrective action
    /// rather than a diagnosis.
    ///
    /// Deliberately carries no millisecond figure. The hold a user has to manage is the cold
    /// audio engine plus one input buffer period, and the buffer period is a property of
    /// whichever device is selected — so any number printed here would be wrong on some
    /// machines.
    public var message: String {
        switch self {
        case .releasedBeforeAudio: "Released too soon — hold the key a moment longer"
        case .noAudioCaptured: "No audio captured"
        }
    }
}
