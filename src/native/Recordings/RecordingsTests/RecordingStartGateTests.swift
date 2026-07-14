import Testing
@testable import RecordingsLib

struct RecordingStartGateTests {
    @Test("permission-only launch skips global handlers and terminates after handling")
    func permissionHelperLaunchPlan() {
        let plan = PermissionRequestLaunchPlan(arguments: [
            "/Applications/Recordings.app/Contents/MacOS/Recordings",
            "--request-permissions",
            "--open-permission-settings",
        ])

        #expect(plan.isHelper)
        #expect(plan.opensPermissionSettings)
        #expect(!plan.installsGlobalHandlers)
        #expect(!plan.declaresMainWindow)
        #expect(plan.terminatesAfterHandling)
    }

    @Test("regular launch retains global handlers and never self-terminates")
    func regularLaunchPlan() {
        let plan = PermissionRequestLaunchPlan(arguments: ["Recordings"])

        #expect(!plan.isHelper)
        #expect(plan.installsGlobalHandlers)
        #expect(plan.declaresMainWindow)
        #expect(!plan.terminatesAfterHandling)
    }

    @Test("recording cannot begin while already recording or transcribing")
    func cannotBeginWhenBusy() {
        #expect(RecordingEngine.canBeginRecording(isRecording: false, isTranscribing: false) == true)
        #expect(RecordingEngine.canBeginRecording(isRecording: true, isTranscribing: false) == false)
        #expect(RecordingEngine.canBeginRecording(isRecording: false, isTranscribing: true) == false)
    }

    @Test("manual recording can continue after permission grant")
    func manualPermissionContinuation() {
        #expect(RecordingEngine.shouldContinueStartingAfterPermission(
            trigger: .manual,
            keyboardShortcutIsDown: false,
            fnKeyIsDown: false
        ))
    }

    @Test("keyboard shortcut recording is cancelled when released before permission grant")
    func keyboardPermissionContinuationRequiresHeldKey() {
        #expect(RecordingEngine.shouldContinueStartingAfterPermission(
            trigger: .keyboardShortcut,
            keyboardShortcutIsDown: true,
            fnKeyIsDown: false
        ))
        #expect(RecordingEngine.shouldContinueStartingAfterPermission(
            trigger: .keyboardShortcut,
            keyboardShortcutIsDown: false,
            fnKeyIsDown: false
        ) == false)
    }

    @Test("fn recording is cancelled when released before permission grant")
    func fnPermissionContinuationRequiresHeldKey() {
        #expect(RecordingEngine.shouldContinueStartingAfterPermission(
            trigger: .fnKey,
            keyboardShortcutIsDown: false,
            fnKeyIsDown: true
        ))
        #expect(RecordingEngine.shouldContinueStartingAfterPermission(
            trigger: .fnKey,
            keyboardShortcutIsDown: false,
            fnKeyIsDown: false
        ) == false)
    }
}
