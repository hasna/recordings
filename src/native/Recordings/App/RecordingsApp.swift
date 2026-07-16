@preconcurrency import Cocoa
import AVFoundation
import Darwin
import SwiftUI
import KeyboardShortcuts
import RecordingsLib

private final class PermissionRequestResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var microphoneGranted = false

    func setMicrophoneGranted(_ granted: Bool) {
        lock.withLock { microphoneGranted = granted }
    }

    func outcome(accessibilityTrusted: Bool) -> PermissionRequestOutcome {
        lock.withLock {
            PermissionRequestOutcome(
                microphoneGranted: microphoneGranted,
                accessibilityTrusted: accessibilityTrusted
            )
        }
    }
}

/// Recordings — a full native macOS app. The main window is the Recordings workspace
/// (record + library); the menu-bar surface, global shortcuts, and the intent-routed
/// recording flow keep working while the window is in the background.
/// Keeps the app (and therefore the RecordingEngine + global shortcuts) alive after the
/// last window is closed, so background recording shortcuts keep working.
@MainActor
final class RecordingsAppDelegate: NSObject, NSApplicationDelegate {
    weak var state: RecordingsAppState?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        state?.startRuntimeSmokeIfNeeded()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            state?.openRecordings()
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
                    self?.openRecordings()
                }
            }
        } else {
            store = nil
        }
    }

    func openRecordings() {
        if let store {
            showWindow(contentView: NSHostingView(rootView: ContentView(store: store)))
        } else if runtimeSmokeMode == "normal" {
            showWindow(contentView: NSHostingView(rootView: Text("Recordings runtime smoke")))
        }
    }

    private func showWindow(contentView: NSView) {
        windowActivationCount += 1
        NSApplication.shared.setActivationPolicy(.regular)
        if let mainWindow {
            NSApplication.shared.activate()
            NSRunningApplication.current.activate(options: [.activateAllWindows])
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
        mainWindow = window
        windowCreationCount += 1
        NSApplication.shared.activate()
        NSRunningApplication.current.activate(options: [.activateAllWindows])
        window.makeKeyAndOrderFront(nil)
    }

    func startRuntimeSmokeIfNeeded() {
        guard let mode = runtimeSmokeMode, runtimeSmokeOutputPath != nil else { return }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15) {
            Darwin._exit(124)
        }
        if mode == "permission-helper" {
            NSApplication.shared.setActivationPolicy(.accessory)
            DispatchQueue.main.async { [weak self] in
                DispatchQueue.main.async {
                    self?.finishRuntimeSmoke(
                        mode: mode,
                        surfaceCount: 0,
                        labels: [],
                        accessibility: RuntimeSmokeAccessibilitySnapshot.processMenuBarExtras()
                    )
                }
            }
            return
        }
        if mode == "resolver" {
            let probeHome = FileManager.default.temporaryDirectory
                .appendingPathComponent("recordings-resolver-smoke-\(UUID().uuidString)")
            do {
                try FileManager.default.createDirectory(at: probeHome, withIntermediateDirectories: true)
                let probe = try RecordingsCLI.probePackagedCompanion(home: probeHome.path)
                try? FileManager.default.removeItem(at: probeHome)
                finishRuntimeSmoke(
                    mode: mode,
                    surfaceCount: 0,
                    labels: [],
                    accessibility: RuntimeSmokeAccessibilitySnapshot.processMenuBarExtras(),
                    resolvedCompanionPath: probe.executablePath,
                    companionCapabilitiesPassed: true
                )
            } catch {
                try? FileManager.default.removeItem(at: probeHome)
                fputs("Packaged companion resolver smoke failed: \(error)\n", stderr)
                finishRuntimeSmoke(
                    mode: mode,
                    surfaceCount: 0,
                    labels: [],
                    accessibility: RuntimeSmokeAccessibilitySnapshot.processMenuBarExtras(),
                    companionCapabilitiesPassed: false
                )
            }
            return
        }
        guard mode == "normal", let runtimeSmokeProbe else {
            finishRuntimeSmoke(
                mode: mode,
                surfaceCount: 0,
                labels: [],
                accessibility: RuntimeSmokeAccessibilitySnapshot.processMenuBarExtras()
            )
            return
        }
        runtimeSmokeProbe.completed = { [weak self, weak runtimeSmokeProbe] in
            guard let self, let runtimeSmokeProbe else { return }
            let accessibility = RuntimeSmokeAccessibilitySnapshot.processMenuBarExtras()
            self.openRecordings()
            let firstWindow = self.mainWindow
            self.openRecordings()
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
        guard windowSettled || attempt >= 60 else {
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
        retainedWindowReused: Bool = false,
        resolvedCompanionPath: String? = nil,
        companionCapabilitiesPassed: Bool = false
    ) {
        guard let runtimeSmokeOutputPath else { return }
        let result = RuntimeSmokeResult(
            mode: mode,
            processIdentifier: getpid(),
            menuBarSurfaceCount: surfaceCount,
            renderedStatusLabels: labels,
            accessibilityObservationStatus: accessibility.status.rawValue,
            accessibilityMenuBarItemCount: accessibility.itemCount,
            accessibilityMenuBarLabels: accessibility.labels,
            globalHandlersInstalled: store != nil,
            permissionRequestsStarted: AccessibilityPromptGate.processShared.promptRequestCount,
            windowCreationCount: windowCreationCount,
            windowActivationCount: windowActivationCount,
            retainedWindowReused: retainedWindowReused,
            applicationActivationPolicy: NSApplication.shared.activationPolicy().rawValue,
            applicationIsActive: NSApplication.shared.isActive,
            mainWindowIsVisible: mainWindow?.isVisible ?? false,
            mainWindowCanBecomeKey: mainWindow?.canBecomeKey ?? false,
            mainWindowIsKey: mainWindow?.isKeyWindow ?? false,
            resolvedCompanionPath: resolvedCompanionPath,
            companionCapabilitiesPassed: companionCapabilitiesPassed
        )
        do {
            let data = try JSONEncoder().encode(result)
            try data.write(to: URL(fileURLWithPath: runtimeSmokeOutputPath), options: .atomic)
        } catch {
            fputs("Runtime smoke result failed: \(error)\n", stderr)
        }
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
        } else if plan.requestsAccessibilityPrompt {
            Self.handlePermissionRequest(plan)
        }
    }

    @SceneBuilder var body: some Scene {
        MenuBarExtra(isInserted: menuBarInsertion) {
            if let store = state.store {
                MenuBarStatusView(store: store, openRecordings: state.openRecordings)
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
        NSApplication.shared.setActivationPolicy(.accessory)
        NativeAppLog.write("request-permissions argument received")
        let work = DispatchGroup()
        let resultBox = PermissionRequestResultBox()
        work.enter()
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            resultBox.setMicrophoneGranted(granted)
            NativeAppLog.write("request-permissions microphone granted=\(granted)")
            work.leave()
        }

        let accessibility = AccessibilityPromptGate.processShared.requestExplicitly()
        NativeAppLog.write("request-permissions accessibility trusted=\(accessibility.trusted)")

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
        work.notify(queue: .global(qos: .userInitiated)) {
            let completedAccessibility = AccessibilityPromptGate.processShared.waitForExplicitRequestCompletion(
                accessibility
            )
            let outcome = resultBox.outcome(accessibilityTrusted: completedAccessibility.trusted)
            NativeAppLog.write("request-permissions helper completed success=\(outcome.succeeded)")
            exit(outcome.succeeded ? EXIT_SUCCESS : EXIT_FAILURE)
        }
    }
}
