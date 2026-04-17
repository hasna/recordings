import SwiftUI
import KeyboardShortcuts

struct MenuBarPopover: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts
    @ObservedObject var projectStore: ProjectStore
    @State private var copiedIndex: Int?

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            Divider()
            if !projectStore.settings.projects.isEmpty {
                projectBar
                    .padding(.horizontal, 16).padding(.vertical, 6)
                Divider()
            }
            recordingArea
                .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            recentList
                .frame(maxHeight: 200)
            Divider()
            footerMenu
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Image(systemName: "mic.fill")
                .foregroundStyle(.tint)
            Text("Hasna Recordings")
            Spacer()
            if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
                Text(shortcut.description)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Project Bar

    private var projectBar: some View {
        HStack {
            Menu {
                Button("None") { projectStore.setActive(nil) }
                Divider()
                ForEach(projectStore.settings.projects) { project in
                    Button(project.name) { projectStore.setActive(project.id) }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "folder")
                    Text(projectStore.activeProject?.name ?? "No project")
                        .foregroundStyle(projectStore.activeProject == nil ? .secondary : .primary)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Spacer()
        }
    }

    // MARK: - Recording Area

    private var recordingArea: some View {
        Group {
            if engine.isRecording {
                HStack {
                    Circle().fill(.red).frame(width: 8, height: 8)
                    Text(fmt(engine.recordingDuration))
                        .monospacedDigit()
                    Spacer()
                    Button("Stop") { engine.stopAndTranscribe() }
                        .controlSize(.small)
                }
                .padding(10)
                .glassEffect(.regular)
            } else if engine.isTranscribing {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Transcribing...")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(10)
                .glassEffect(.regular)
            } else {
                VStack(spacing: 6) {
                    Button { engine.startRecording() } label: {
                        Label("Record", systemImage: "mic.circle.fill")
                    }
                    .controlSize(.regular)

                    if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
                        Text("or hold \(shortcut.description)")
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(10)
                .glassEffect(.regular)
            }
        }
    }

    // MARK: - Recent

    private var recentList: some View {
        Group {
            if engine.recentTranscriptions.isEmpty {
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(engine.recentTranscriptions.indices, id: \.self) { i in
                            TranscriptionRow(
                                item: engine.recentTranscriptions[i],
                                isCopied: copiedIndex == i
                            ) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(
                                    engine.recentTranscriptions[i].displayText,
                                    forType: .string
                                )
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    copiedIndex = i
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                    withAnimation { if copiedIndex == i { copiedIndex = nil } }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 6)
                }
            }
        }
    }

    // MARK: - Footer

    private var footerMenu: some View {
        VStack(spacing: 0) {
            Button {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            } label: {
                HStack {
                    Text("Settings...")
                    Spacer()
                    Text("⌘,").foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            Divider()

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                HStack {
                    Text("Quit Hasna Recordings")
                    Spacer()
                    Text("⌘Q").foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            .buttonStyle(.plain)
        }
    }

    private func fmt(_ t: TimeInterval) -> String {
        String(format: "%d:%02d", Int(t) / 60, Int(t) % 60)
    }
}

struct TranscriptionRow: View {
    let item: TranscriptionResult
    let isCopied: Bool
    let onCopy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(item.displayText)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isCopied {
                Image(systemName: "checkmark")
                    .foregroundStyle(.green)
                    .transition(.scale.combined(with: .opacity))
            } else {
                Text(relativeTime(item.timestamp))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .onTapGesture { onCopy() }
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let s = Date().timeIntervalSince(date)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        return "\(Int(s / 3600))h"
    }
}
