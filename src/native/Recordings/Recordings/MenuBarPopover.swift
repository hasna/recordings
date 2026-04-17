import SwiftUI
import KeyboardShortcuts

struct MenuBarPopover: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts
    @ObservedObject var projectStore: ProjectStore
    @State private var copiedIndex: Int?
    @State private var filterProjectId: String?

    private var filteredTranscriptions: [TranscriptionResult] {
        guard let filter = filterProjectId else {
            return engine.recentTranscriptions
        }
        if filter == "__none__" {
            return engine.recentTranscriptions.filter { $0.projectId == nil }
        }
        return engine.recentTranscriptions.filter { $0.projectId == filter }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            Divider()
            recordingArea
                .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            if !engine.recentTranscriptions.isEmpty {
                filterBar
                    .padding(.horizontal, 16).padding(.vertical, 6)
                Divider()
            }
            recentList
                .frame(maxHeight: 200)
            Divider()
            footerMenu
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
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
            if !projectStore.settings.projects.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "folder.fill")
                        .foregroundColor(projectStore.activeProject != nil ? .accentColor : .secondary)
                    Menu {
                        Button("None") { projectStore.setActive(nil) }
                        Divider()
                        ForEach(projectStore.settings.projects) { project in
                            Button {
                                projectStore.setActive(project.id)
                            } label: {
                                HStack {
                                    Text(project.name)
                                    if project.id == projectStore.settings.activeProjectId {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        Text(projectStore.activeProject?.name ?? "No project")
                            .foregroundStyle(projectStore.activeProject == nil ? .secondary : .primary)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    Spacer()
                }
            }
        }
    }

    // MARK: - Recording Area

    private var recordingArea: some View {
        Group {
            if engine.isRecording {
                VStack(spacing: 6) {
                    HStack {
                        Circle().fill(.red).frame(width: 8, height: 8)
                        Text(fmt(engine.recordingDuration))
                            .monospacedDigit()
                        Spacer()
                        Button("Stop") { engine.stopAndTranscribe() }
                            .controlSize(.small)
                    }
                    if let project = projectStore.activeProject {
                        HStack(spacing: 4) {
                            Image(systemName: "folder.fill").foregroundStyle(.tint)
                            Text(project.name).foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
                }
                .padding(10)
                .glassEffect(.regular)
            } else if engine.isTranscribing {
                VStack(spacing: 6) {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Transcribing...")
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    if let project = projectStore.activeProject {
                        HStack(spacing: 4) {
                            Image(systemName: "folder.fill").foregroundStyle(.tint)
                            Text(project.name).foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
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

    // MARK: - Filter Bar

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                FilterChip(label: "All", isActive: filterProjectId == nil) {
                    filterProjectId = nil
                }
                ForEach(projectStore.settings.projects) { project in
                    let count = engine.recentTranscriptions.filter { $0.projectId == project.id }.count
                    if count > 0 {
                        FilterChip(
                            label: "\(project.name) (\(count))",
                            isActive: filterProjectId == project.id
                        ) {
                            filterProjectId = filterProjectId == project.id ? nil : project.id
                        }
                    }
                }
                let noProjectCount = engine.recentTranscriptions.filter { $0.projectId == nil }.count
                if noProjectCount > 0 {
                    FilterChip(
                        label: "No project (\(noProjectCount))",
                        isActive: filterProjectId == "__none__"
                    ) {
                        filterProjectId = filterProjectId == "__none__" ? nil : "__none__"
                    }
                }
            }
        }
    }

    // MARK: - Recent

    private var recentList: some View {
        Group {
            if filteredTranscriptions.isEmpty {
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(filteredTranscriptions.indices, id: \.self) { i in
                            let item = filteredTranscriptions[i]
                            TranscriptionRow(
                                item: item,
                                showProject: filterProjectId == nil,
                                isCopied: copiedIndex == i
                            ) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(item.displayText, forType: .string)
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
            SettingsLink {
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

// MARK: - Filter Chip

struct FilterChip: View {
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(isActive ? Color.accentColor.opacity(0.15) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .foregroundStyle(isActive ? .primary : .secondary)
    }
}

// MARK: - Transcription Row

struct TranscriptionRow: View {
    let item: TranscriptionResult
    let showProject: Bool
    let isCopied: Bool
    let onCopy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
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
            if showProject, let name = item.projectName {
                HStack(spacing: 3) {
                    Image(systemName: "folder")
                    Text(name)
                }
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
