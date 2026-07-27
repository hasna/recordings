import Foundation

/// State contract for the menu-bar surface. The visual vocabulary is deliberately tiny and
/// unchanged (mic / waveform / ellipsis, one status line, one primary button); what this
/// type guarantees is truthfulness: whenever the engine would reject `startRecording` —
/// including while an intent decision, answer, or rewrite is pending — the menu bar must
/// present a busy state and a disabled Start affordance, never an idle state it would
/// then refuse.
public struct MenuBarPresentation: Equatable, Sendable {
    /// Symbol for idle-but-blocked. `exclamationmark.triangle.fill` on purpose: it has shipped
    /// since macOS 11, so it cannot resolve to nothing. An invalid `Image(systemName:)` renders
    /// an EMPTY image, which would make the blocked state *less* visible than the bug it fixes.
    public static let blockedIconName = "exclamationmark.triangle.fill"
    public static let idleIconName = "mic.fill"

    public let iconName: String
    public let accessibilityLabel: String
    public let statusText: String
    /// Whether the primary button is available. While recording the same button is the
    /// (always enabled) Stop affordance; otherwise it is Start and must match
    /// `RecordingEngine.canStartRecording` exactly.
    public let primaryActionEnabled: Bool
    /// Whether this is the idle-but-blocked state. Published so a view can tint or badge without
    /// string-matching `statusText` to guess.
    public let isBlocked: Bool

    /// - Parameter blockedReason: `RecordingEngine.blockedReason` — why the app cannot record or
    ///   deliver, when the reason outlives one status write.
    ///
    /// `blockedReason` is a parameter rather than something inferred from `statusMessage` because
    /// the always-visible menu-bar item renders **only** `iconName` and `accessibilityLabel`
    /// (`MenuBarStatusView.swift`: `Image(systemName:).accessibilityLabel(...)`). Until this
    /// existed, the idle branch set `mic.fill` / "Recordings" and discarded `statusMessage`
    /// entirely — so a blocked app was **byte-identical to Ready** in that surface, for sighted
    /// and VoiceOver users alike, and the only channel carrying "press Cmd-V" was a popover the
    /// user had to click open. A reason with no view consumer is not a disclosure.
    /// - Parameter isWarmingUpCapture: `RecordingEngine.isWarmingUpCapture` — the microphone is
    ///   open but has not delivered a sample yet. No default: `false` is the *invisible* value,
    ///   and a surface that forgot it would compile and drop the glyph to the busy ellipsis for
    ///   ~100 ms in the middle of a hold.
    public init(
        isRecording: Bool,
        isWarmingUpCapture: Bool,
        canStartRecording: Bool,
        statusMessage: String,
        blockedReason: String? = nil
    ) {
        // Warm-up presents as recording. The user is holding the key and Stop is live; anything
        // else would read as a dead app for the ~100 ms between `recorder.start()` returning and
        // the first PCM chunk.
        if isRecording || isWarmingUpCapture {
            iconName = "waveform"
            accessibilityLabel = "Recordings, recording"
            statusText = "Recording"
            primaryActionEnabled = true
            isBlocked = false
        } else if !canStartRecording {
            let normalizedBusyStatus = statusMessage.trimmingCharacters(in: .punctuationCharacters)
            iconName = "ellipsis.circle"
            accessibilityLabel = "Recordings, \(normalizedBusyStatus.lowercased())"
            statusText = normalizedBusyStatus
            primaryActionEnabled = false
            isBlocked = false
        } else if let blockedReason, !blockedReason.isEmpty {
            // Idle and startable, but something the owner has to act on is wrong. Distinct icon
            // AND distinct label: the icon is the only signal a sighted user gets from the menu
            // bar, and the label is the only signal VoiceOver gets. Fixing one and not the other
            // leaves half the users exactly where they were.
            iconName = Self.blockedIconName
            accessibilityLabel = "Recordings, blocked: \(blockedReason)"
            statusText = blockedReason
            // Still true, and still this type's other contract: a blocked trigger or a blocked
            // paste does not make Start unavailable, and `canStartRecording` is what governs.
            primaryActionEnabled = true
            isBlocked = true
        } else {
            iconName = Self.idleIconName
            accessibilityLabel = "Recordings"
            statusText = statusMessage
            primaryActionEnabled = true
            isBlocked = false
        }
    }
}
