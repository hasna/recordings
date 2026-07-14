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
@MainActor
final class RecordingsAppDelegate: NSObject, NSApplicationDelegate {
    weak var state: RecordingsAppState?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            state?.showMainWindow()
        }
        return true
    }
}

@MainActor
final class RecordingsAppState: ObservableObject {
    let store: RecordingsStore?
    private var mainWindow: NSWindow?

    init(plan: PermissionRequestLaunchPlan) {
        if plan.installsGlobalHandlers {
            let store = RecordingsStore()
            self.store = store
            if plan.declaresMainWindow {
                Task { @MainActor [weak self] in
                    self?.showMainWindow()
                }
            }
        } else {
            store = nil
        }
    }

    func showMainWindow() {
        guard let store else { return }
        if let mainWindow {
            mainWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Recordings"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ContentView(store: store))
        window.center()
        window.makeKeyAndOrderFront(nil)
        mainWindow = window
    }
}

@main
struct RecordingsApp: App {
    @NSApplicationDelegateAdaptor(RecordingsAppDelegate.self) private var appDelegate
    @StateObject private var state: RecordingsAppState

    init() {
        let plan = PermissionRequestLaunchPlan(arguments: CommandLine.arguments)
        let state = RecordingsAppState(plan: plan)
        _state = StateObject(wrappedValue: state)
        appDelegate.state = state
        if plan.isHelper {
            Self.handlePermissionRequest(plan)
        } else {
            AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            )
        }
    }

    var body: some Scene {
        Settings {
            if let store = state.store {
                SettingsView(engine: store.engine, shortcuts: store.voiceShortcuts, projectStore: store.projectStore)
            } else {
                EmptyView()
            }
        }
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
