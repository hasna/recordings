import Foundation
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
        #expect(!plan.declaresMenuBar)
        #expect(plan.terminatesAfterHandling)
        #expect(plan.requestsAccessibilityPrompt)
    }

    @Test("regular launch retains global handlers and never self-terminates")
    func regularLaunchPlan() {
        let plan = PermissionRequestLaunchPlan(arguments: ["Recordings"])

        #expect(!plan.isHelper)
        #expect(plan.installsGlobalHandlers)
        #expect(plan.declaresMainWindow)
        #expect(plan.declaresMenuBar)
        #expect(!plan.terminatesAfterHandling)
        #expect(!plan.requestsAccessibilityPrompt)
    }

    @Test("runtime smoke plans install no handlers and never request permissions")
    func runtimeSmokeLaunchPlans() {
        let normal = PermissionRequestLaunchPlan(arguments: [
            "Recordings", "--runtime-smoke", "normal", "--runtime-smoke-output", "/tmp/result.json",
        ])
        #expect(normal.isRuntimeSmoke)
        #expect(!normal.installsGlobalHandlers)
        #expect(normal.declaresMenuBar)
        #expect(normal.runtimeSmokeOutputPath == "/tmp/result.json")
        #expect(!normal.requestsAccessibilityPrompt)

        let helper = PermissionRequestLaunchPlan(arguments: [
            "Recordings", "--request-permissions", "--runtime-smoke", "permission-helper",
            "--runtime-smoke-output", "/tmp/result.json",
        ])
        #expect(helper.isRuntimeSmoke)
        #expect(!helper.installsGlobalHandlers)
        #expect(!helper.declaresMenuBar)
        #expect(helper.isHelper)
        #expect(!helper.requestsAccessibilityPrompt)
    }

    @Test("first untrusted protected operation prompts once per process")
    func firstProtectedOperationPromptsOnce() {
        let gate = AccessibilityPromptGate()
        var trustChecks = 0
        var prompts = 0

        let first = gate.trustForProtectedOperation(
            isTrusted: {
                trustChecks += 1
                return false
            },
            requestPrompt: {
                prompts += 1
                return false
            }
        )
        let second = gate.trustForProtectedOperation(
            isTrusted: {
                trustChecks += 1
                return false
            },
            requestPrompt: {
                prompts += 1
                return false
            }
        )

        #expect(!first.trusted)
        #expect(first.didPrompt)
        #expect(!second.trusted)
        #expect(!second.didPrompt)
        #expect(trustChecks == 2)
        #expect(prompts == 1)
        #expect(gate.promptRequestCount == 1)
    }

    @Test("explicit Accessibility action may prompt after the automatic attempt")
    func explicitAccessibilityActionMayPromptAgain() {
        let gate = AccessibilityPromptGate()
        var prompts = 0

        _ = gate.trustForProtectedOperation(
            isTrusted: { false },
            requestPrompt: {
                prompts += 1
                return false
            }
        )
        let explicit = gate.requestExplicitly {
            prompts += 1
            return false
        }

        #expect(!explicit.trusted)
        #expect(explicit.didPrompt)
        #expect(prompts == 2)
        #expect(gate.promptRequestCount == 2)
    }

    @Test("trusted protected operation never invokes the prompt API")
    func trustedProtectedOperationDoesNotPrompt() {
        let gate = AccessibilityPromptGate()
        var prompts = 0

        let result = gate.trustForProtectedOperation(
            isTrusted: { true },
            requestPrompt: {
                prompts += 1
                return true
            }
        )

        #expect(result.trusted)
        #expect(!result.didPrompt)
        #expect(prompts == 0)
        #expect(gate.promptRequestCount == 0)
    }

    @Test("explicit prompt consumes the automatic allowance for later protected operations")
    func explicitPromptPreventsUnexpectedAutomaticReprompt() {
        let gate = AccessibilityPromptGate()
        var prompts = 0

        _ = gate.requestExplicitly {
            prompts += 1
            return false
        }
        let protectedOperation = gate.trustForProtectedOperation(
            isTrusted: { false },
            requestPrompt: {
                prompts += 1
                return false
            }
        )

        #expect(!protectedOperation.trusted)
        #expect(!protectedOperation.didPrompt)
        #expect(prompts == 1)
        #expect(gate.promptRequestCount == 1)
    }

    @Test("permission helper outcome reports both permission results truthfully")
    func permissionHelperOutcome() {
        #expect(PermissionRequestOutcome(
            microphoneGranted: true,
            accessibilityTrusted: true
        ).succeeded)
        #expect(!PermissionRequestOutcome(
            microphoneGranted: false,
            accessibilityTrusted: true
        ).succeeded)
        #expect(!PermissionRequestOutcome(
            microphoneGranted: true,
            accessibilityTrusted: false
        ).succeeded)
    }

    @Test("recording cannot begin while already recording or transcribing")
    func cannotBeginWhenBusy() {
        #expect(RecordingEngine.canBeginRecording(isRecording: false, isTranscribing: false) == true)
        #expect(RecordingEngine.canBeginRecording(isRecording: true, isTranscribing: false) == false)
        #expect(RecordingEngine.canBeginRecording(isRecording: false, isTranscribing: true) == false)
        #expect(RecordingEngine.canBeginRecording(
            isRecording: false,
            isTranscribing: false,
            isAwaitingMicrophonePermission: true
        ) == false)
    }

    @Test("microphone permission start gate admits one current continuation")
    func permissionStartGateRejectsDuplicateAndStaleContinuations() {
        let firstRequestID = UUID()
        let currentRequestID = UUID()
        var gate = MicrophonePermissionStartGate()

        let firstReservation = gate.reserve(requestID: firstRequestID)
        #expect(firstReservation == firstRequestID)
        #expect(gate.isAwaitingResponse)
        let duplicateReservation = gate.reserve(requestID: currentRequestID)
        #expect(duplicateReservation == nil)
        #expect(gate.activeRequestID == firstRequestID)

        gate.cancel()
        let currentReservation = gate.reserve(requestID: currentRequestID)
        #expect(currentReservation == currentRequestID)
        let staleResponseConsumed = gate.consumeResponse(for: firstRequestID)
        #expect(!staleResponseConsumed)
        #expect(gate.activeRequestID == currentRequestID)
        let currentResponseConsumed = gate.consumeResponse(for: currentRequestID)
        #expect(currentResponseConsumed)
        #expect(!gate.isAwaitingResponse)
        let repeatedResponseConsumed = gate.consumeResponse(for: currentRequestID)
        #expect(!repeatedResponseConsumed)
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
