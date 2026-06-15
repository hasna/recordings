@preconcurrency import Cocoa
import AVFoundation
import SwiftUI
import KeyboardShortcuts
import RecordingsLib

@main
struct RecordingsApp: App {
    @StateObject private var engine = RecordingEngine()
    @StateObject private var shortcuts = VoiceShortcuts()
    @StateObject private var projectStore = ProjectStore()

    init() {
        Self.terminateDuplicateInstances()
        AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
        Self.handlePermissionRequestArguments()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarPopover(engine: engine, shortcuts: shortcuts, projectStore: projectStore)
                .frame(width: 320, height: 420)
                .onAppear {
                    engine.projectStore = projectStore
                    engine.voiceShortcuts = shortcuts
                }
        } label: {
            if engine.isRecording {
                Image(systemName: "waveform")
                    .symbolEffect(.variableColor.iterative, isActive: true)
            } else if engine.isTranscribing {
                Image(systemName: "ellipsis.circle")
                    .symbolEffect(.pulse, isActive: true)
            } else {
                Image(systemName: "mic.fill")
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(engine: engine, shortcuts: shortcuts, projectStore: projectStore)
        }
    }

    private static func terminateDuplicateInstances() {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.hasna.recordings")
            where app.processIdentifier != currentPID {
            app.terminate()
        }
    }

    private static func handlePermissionRequestArguments() {
        let arguments = CommandLine.arguments
        guard arguments.contains("--request-permissions") else { return }

        NativeAppLog.write("request-permissions argument received")
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            NativeAppLog.write("request-permissions microphone granted=\(granted)")
        }

        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
        NativeAppLog.write("request-permissions accessibility trusted=\(trusted)")

        guard arguments.contains("--open-permission-settings") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if let microphone = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(microphone)
            }
            if let accessibility = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                NSWorkspace.shared.open(accessibility)
            }
        }
    }
}
