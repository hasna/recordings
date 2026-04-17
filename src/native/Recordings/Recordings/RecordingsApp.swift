@preconcurrency import Cocoa
import SwiftUI
import KeyboardShortcuts

@main
struct RecordingsApp: App {
    @StateObject private var engine = RecordingEngine()
    @StateObject private var shortcuts = VoiceShortcuts()
    @StateObject private var projectStore = ProjectStore()

    init() {
        AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarPopover(engine: engine, shortcuts: shortcuts, projectStore: projectStore)
                .frame(width: 320, height: 420)
                .onAppear { engine.projectStore = projectStore }
        } label: {
            if engine.isRecording {
                Image(systemName: "record.circle.fill")
                    .symbolRenderingMode(.multicolor)
            } else if engine.isTranscribing {
                Image(systemName: "ellipsis.circle")
            } else {
                Image(systemName: "mic.fill")
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(engine: engine, shortcuts: shortcuts, projectStore: projectStore)
        }
    }
}
