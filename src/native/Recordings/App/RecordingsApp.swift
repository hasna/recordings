@preconcurrency import Cocoa
import AVFoundation
import SwiftUI
import KeyboardShortcuts
import RecordingsLib

/// Recordings — a full native macOS app. The main window is the Recordings workspace
/// (record + library); global shortcuts and dictation/command modes still work while the
/// window is in the background. (The former menu-bar-only surface has been removed.)
/// Keeps the app (and therefore the RecordingEngine + global shortcuts) alive after the
/// last window is closed, so background dictation/command shortcuts keep working.
final class RecordingsAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct RecordingsApp: App {
    @NSApplicationDelegateAdaptor(RecordingsAppDelegate.self) private var appDelegate
    @StateObject private var store = RecordingsStore()

    init() {
        AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
        Self.handlePermissionRequestArguments()
    }

    var body: some Scene {
        WindowGroup("Recordings") {
            ContentView(store: store)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Recording") {
                    store.pane = .record
                    store.engine.startRecording()
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            CommandGroup(after: .toolbar) {
                Button("Recordings Library") { store.pane = .library }
                    .keyboardShortcut("l", modifiers: .command)
            }
        }

        Settings {
            SettingsView(engine: store.engine, shortcuts: store.voiceShortcuts, projectStore: store.projectStore)
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
