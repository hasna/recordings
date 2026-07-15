@preconcurrency import Cocoa
import SwiftUI

@MainActor
final class RuntimeSmokeProbe: ObservableObject {
    enum Phase: Int, CaseIterable {
        case idle
        case recording
        case transcribing
    }

    @Published private(set) var phase: Phase = .idle
    private(set) var surfaceAppearances = 0
    private(set) var renderedLabels: [String] = []
    private var completionScheduled = false
    var completed: (() -> Void)? {
        didSet { finishIfReady() }
    }

    var presentation: MenuBarPresentation {
        MenuBarPresentation(
            isRecording: phase == .recording,
            isTranscribing: phase == .transcribing
        )
    }

    func surfaceAppeared() {
        surfaceAppearances += 1
        observeCurrentPresentation()
    }

    func presentationChanged() {
        observeCurrentPresentation()
    }

    private func observeCurrentPresentation() {
        let label = presentation.accessibilityLabel
        if renderedLabels.last != label {
            renderedLabels.append(label)
        }
        switch phase {
        case .idle:
            DispatchQueue.main.async { self.phase = .recording }
        case .recording:
            DispatchQueue.main.async { self.phase = .transcribing }
        case .transcribing:
            finishIfReady()
        }
    }

    private func finishIfReady() {
        guard phase == .transcribing,
              renderedLabels.count == Phase.allCases.count,
              !completionScheduled,
              completed != nil else { return }
        completionScheduled = true
        DispatchQueue.main.async { self.completed?() }
    }
}

struct RuntimeSmokeMenuBarLabel: View {
    @ObservedObject var probe: RuntimeSmokeProbe

    var body: some View {
        Image(systemName: probe.presentation.iconName)
            .accessibilityLabel(probe.presentation.accessibilityLabel)
            .onAppear { probe.surfaceAppeared() }
            .onChange(of: probe.phase) { _, _ in
                probe.presentationChanged()
            }
    }
}

struct RuntimeSmokeResult: Codable {
    let mode: String
    let processIdentifier: Int32
    let menuBarSurfaceCount: Int
    let renderedStatusLabels: [String]
    let accessibilityObservationStatus: String
    let accessibilityMenuBarItemCount: Int
    let accessibilityMenuBarLabels: [String]
    let globalHandlersInstalled: Bool
    let permissionRequestsStarted: Int
    let windowCreationCount: Int
    let windowActivationCount: Int
    let retainedWindowReused: Bool
    let applicationActivationPolicy: Int
    let applicationIsActive: Bool
    let mainWindowIsVisible: Bool
    let mainWindowCanBecomeKey: Bool
    let mainWindowIsKey: Bool
}

@MainActor
enum PermissionRequestRuntimeEvidence {
    static var invocationCount = 0
}

enum RuntimeSmokeAccessibilityObservationStatus: String {
    case available
    case absent
    case unavailable
}

struct RuntimeSmokeAccessibilitySnapshot {
    let status: RuntimeSmokeAccessibilityObservationStatus
    let itemCount: Int
    let labels: [String]

    static func processMenuBarExtras(processIdentifier: pid_t = getpid()) -> Self {
        let application = AXUIElementCreateApplication(processIdentifier)
        var menuBarValue: CFTypeRef?
        let menuBarError = AXUIElementCopyAttributeValue(
            application,
            kAXExtrasMenuBarAttribute as CFString,
            &menuBarValue
        )
        if menuBarError == .noValue || menuBarError == .attributeUnsupported {
            return Self(status: .absent, itemCount: 0, labels: [])
        }
        guard menuBarError == .success,
              let menuBarValue,
              CFGetTypeID(menuBarValue) == AXUIElementGetTypeID() else {
            return Self(status: .unavailable, itemCount: -1, labels: [])
        }

        let menuBar = menuBarValue as! AXUIElement
        var childrenValue: CFTypeRef?
        let childrenError = AXUIElementCopyAttributeValue(
            menuBar,
            kAXChildrenAttribute as CFString,
            &childrenValue
        )
        if childrenError == .noValue || childrenError == .attributeUnsupported {
            return Self(status: .unavailable, itemCount: -1, labels: [])
        }
        guard childrenError == .success,
              let children = childrenValue as? [AXUIElement] else {
            return Self(status: .unavailable, itemCount: -1, labels: [])
        }

        let labels = children.compactMap { child -> String? in
            for attribute in [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute] {
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(child, attribute as CFString, &value) == .success,
                   let label = value as? String,
                   !label.isEmpty {
                    return label
                }
            }
            return nil
        }
        return Self(
            status: children.isEmpty ? .absent : .available,
            itemCount: children.count,
            labels: labels
        )
    }
}
