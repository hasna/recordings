import SwiftUI
import KeyboardShortcuts

@main
struct RecordingsApp: App {
    @StateObject private var engine = RecordingEngine()
    @StateObject private var shortcuts = VoiceShortcuts()

    init() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarPopover(engine: engine, shortcuts: shortcuts)
                .frame(width: 320, height: 440)
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

        // Settings window — opened via SettingsLink
        Settings {
            SettingsView(engine: engine, shortcuts: shortcuts)
        }
    }
}
