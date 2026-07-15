@preconcurrency import Cocoa
import AVFoundation
import SwiftUI
import KeyboardShortcuts
import RecordingsLib

/// Recordings — a full native macOS app. The main window is the Recordings workspace
/// (record + library); the menu-bar surface, global shortcuts, and dictation/command modes
/// keep working while the window is in the background.
/// Keeps the app (and therefore the RecordingEngine + global shortcuts) alive after the
/// last window is closed, so background dictation/command shortcuts keep working.
@MainActor
final class RecordingsAppDelegate: NSObject, NSApplicationDelegate {
    weak var state: RecordingsAppState?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        state?.startRuntimeSmokeIfNeeded()
    }

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
    let declaresMenuBar: Bool
    let runtimeSmokeProbe: RuntimeSmokeProbe?
    private let runtimeSmokeMode: String?
    private let runtimeSmokeOutputPath: String?
    private var mainWindow: NSWindow?
    private(set) var windowCreationCount = 0
    private(set) var windowActivationCount = 0

    init(plan: PermissionRequestLaunchPlan) {
        declaresMenuBar = plan.declaresMenuBar
        runtimeSmokeMode = plan.runtimeSmokeMode
        runtimeSmokeOutputPath = plan.runtimeSmokeOutputPath
        runtimeSmokeProbe = plan.runtimeSmokeMode == "normal" ? RuntimeSmokeProbe() : nil
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
        showWindow(contentView: NSHostingView(rootView: ContentView(store: store)))
    }

    private func showRuntimeSmokeWindow() {
        showWindow(contentView: NSHostingView(rootView: Text("Recordings runtime smoke")))
    }

    private func showWindow(contentView: NSView) {
        windowActivationCount += 1
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate()
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
        window.contentView = contentView
        window.center()
        window.makeKeyAndOrderFront(nil)
        mainWindow = window
        windowCreationCount += 1
    }

    func startRuntimeSmokeIfNeeded() {
        guard let mode = runtimeSmokeMode, runtimeSmokeOutputPath != nil else { return }
        if mode == "permission-helper" {
            NSApplication.shared.setActivationPolicy(.accessory)
            let accessibility = RuntimeSmokeAccessibilitySnapshot.currentProcessMenuBarExtras()
            finishRuntimeSmoke(
                mode: mode,
                surfaceCount: 0,
                labels: [],
                accessibility: accessibility
            )
            return
        }
        guard mode == "normal", let runtimeSmokeProbe else {
            finishRuntimeSmoke(
                mode: mode,
                surfaceCount: 0,
                labels: [],
                accessibility: RuntimeSmokeAccessibilitySnapshot.currentProcessMenuBarExtras()
            )
            return
        }
        runtimeSmokeProbe.completed = { [weak self, weak runtimeSmokeProbe] in
            guard let self, let runtimeSmokeProbe else { return }
            let accessibility = RuntimeSmokeAccessibilitySnapshot.currentProcessMenuBarExtras()
            self.showRuntimeSmokeWindow()
            let firstWindow = self.mainWindow
            self.showRuntimeSmokeWindow()
            self.finishRuntimeSmokeWhenWindowSettles(
                mode: mode,
                surfaceCount: runtimeSmokeProbe.surfaceAppearances,
                labels: runtimeSmokeProbe.renderedLabels,
                accessibility: accessibility,
                retainedWindowReused: firstWindow === self.mainWindow
            )
        }
    }

    private func finishRuntimeSmokeWhenWindowSettles(
        mode: String,
        surfaceCount: Int,
        labels: [String],
        accessibility: RuntimeSmokeAccessibilitySnapshot,
        retainedWindowReused: Bool,
        attempt: Int = 0
    ) {
        let windowSettled = NSApplication.shared.isActive && (mainWindow?.isKeyWindow ?? false)
        guard windowSettled || attempt >= 20 else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.finishRuntimeSmokeWhenWindowSettles(
                    mode: mode,
                    surfaceCount: surfaceCount,
                    labels: labels,
                    accessibility: accessibility,
                    retainedWindowReused: retainedWindowReused,
                    attempt: attempt + 1
                )
            }
            return
        }
        finishRuntimeSmoke(
            mode: mode,
            surfaceCount: surfaceCount,
            labels: labels,
            accessibility: accessibility,
            retainedWindowReused: retainedWindowReused
        )
    }

    private func finishRuntimeSmoke(
        mode: String,
        surfaceCount: Int,
        labels: [String],
        accessibility: RuntimeSmokeAccessibilitySnapshot,
        retainedWindowReused: Bool = false
    ) {
        guard let runtimeSmokeOutputPath else { return }
        let result = RuntimeSmokeResult(
            mode: mode,
            menuBarSurfaceCount: surfaceCount,
            renderedStatusLabels: labels,
            accessibilityMenuBarItemCount: accessibility.itemCount,
            accessibilityMenuBarLabels: accessibility.labels,
            globalHandlersInstalled: store != nil,
            permissionRequestsStarted: PermissionRequestRuntimeEvidence.invocationCount,
            windowCreationCount: windowCreationCount,
            windowActivationCount: windowActivationCount,
            retainedWindowReused: retainedWindowReused,
            applicationIsActive: NSApplication.shared.isActive,
            mainWindowIsVisible: mainWindow?.isVisible ?? false,
            mainWindowIsKey: mainWindow?.isKeyWindow ?? false
        )
        do {
            let data = try JSONEncoder().encode(result)
            try data.write(to: URL(fileURLWithPath: runtimeSmokeOutputPath), options: .atomic)
        } catch {
            fputs("Runtime smoke result failed: \(error)\n", stderr)
        }
        NSApplication.shared.terminate(nil)
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
        if plan.isRuntimeSmoke {
            // Runtime smoke retains the real launch classification but never invokes TCC APIs.
        } else if plan.isHelper {
            Self.handlePermissionRequest(plan)
        } else {
            AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            )
        }
    }

    @SceneBuilder var body: some Scene {
        MenuBarExtra(isInserted: menuBarInsertion) {
            if let store = state.store {
                MenuBarStatusView(store: store, showMainWindow: state.showMainWindow)
            } else if state.runtimeSmokeProbe != nil {
                EmptyView()
            }
        } label: {
            if let store = state.store {
                MenuBarStatusLabel(store: store)
            } else if let probe = state.runtimeSmokeProbe {
                RuntimeSmokeMenuBarLabel(probe: probe)
            } else {
                Image(systemName: "mic.fill")
                    .accessibilityLabel("Recordings")
            }
        }
        .menuBarExtraStyle(.window)

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

    private var menuBarInsertion: Binding<Bool> {
        Binding(
            get: { state.declaresMenuBar && (state.store != nil || state.runtimeSmokeProbe != nil) },
            set: { _ in }
        )
    }

    private static func handlePermissionRequest(_ plan: PermissionRequestLaunchPlan) {
        PermissionRequestRuntimeEvidence.invocationCount += 1
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
