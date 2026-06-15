@preconcurrency import Cocoa
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
}
