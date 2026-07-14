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

@MainActor
final class RecordingsAppState: ObservableObject {
    let store: RecordingsStore?

    init(plan: PermissionRequestLaunchPlan) {
        store = plan.installsGlobalHandlers ? RecordingsStore() : nil
    }
}

@main
struct RecordingsApp: App {
    @NSApplicationDelegateAdaptor(RecordingsAppDelegate.self) private var appDelegate
    @StateObject private var state: RecordingsAppState

    init() {
        let plan = PermissionRequestLaunchPlan(arguments: CommandLine.arguments)
        _state = StateObject(wrappedValue: RecordingsAppState(plan: plan))
        if plan.isHelper {
            Self.handlePermissionRequest(plan)
        } else {
            AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            )
        }
    }

    var body: some Scene {
        WindowGroup("Recordings") {
            if let store = state.store {
                ContentView(store: store)
            } else {
                Color.clear
                    .frame(width: 1, height: 1)
                    .onAppear {
                        NSApplication.shared.windows.forEach { $0.orderOut(nil) }
                    }
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 760)
        .commands {
            if let store = state.store {
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
        }

        Settings {
            if let store = state.store {
                SettingsView(engine: store.engine, shortcuts: store.voiceShortcuts, projectStore: store.projectStore)
            } else {
                EmptyView()
            }
        }
    }

    private static func handlePermissionRequest(_ plan: PermissionRequestLaunchPlan) {
        NSApplication.shared.setActivationPolicy(.accessory)
        NativeAppLog.write("request-permissions argument received")
        let work = DispatchGroup()
        work.enter()
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            NativeAppLog.write("request-permissions microphone granted=\(granted)")
            work.leave()
        }

        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
        NativeAppLog.write("request-permissions accessibility trusted=\(trusted)")

        if plan.opensPermissionSettings {
            work.enter()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                if let microphone = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                    NSWorkspace.shared.open(microphone)
                }
                if let accessibility = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                    NSWorkspace.shared.open(accessibility)
                }
                work.leave()
            }
        }
        work.notify(queue: .main) {
            NativeAppLog.write("request-permissions helper completed")
            NSApplication.shared.terminate(nil)
        }
    }
}
