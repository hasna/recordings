import Testing
@testable import RecordingsLib

struct RecordingStartControlPresentationTests {
    @Test(
        "every recording start control follows the engine start gate",
        arguments: RecordingStartControlPresentation.Kind.allCases
    )
    func startControlsFollowEngineGate(kind: RecordingStartControlPresentation.Kind) {
        let settling = RecordingStartControlPresentation(
            kind: kind,
            canStartRecording: false
        )
        let available = RecordingStartControlPresentation(
            kind: kind,
            canStartRecording: true
        )

        #expect(!settling.isEnabled)
        #expect(available.isEnabled)
        #expect(!settling.accessibilityLabel.isEmpty)
    }

    @Test("ready and error controls keep their accessible action names")
    func retryControlLabels() {
        let ready = RecordingStartControlPresentation(
            kind: .recordAgain,
            canStartRecording: false
        )
        let failed = RecordingStartControlPresentation(
            kind: .tryAgain,
            canStartRecording: false
        )

        #expect(ready.title == "Record Again")
        #expect(ready.accessibilityLabel == "Start a new recording")
        #expect(!ready.isEnabled)
        #expect(failed.title == "Try Again")
        #expect(failed.accessibilityLabel == "Try recording again")
        #expect(!failed.isEnabled)
    }
}
