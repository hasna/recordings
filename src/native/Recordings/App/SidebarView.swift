import SwiftUI
import RecordingsLib

/// Narrow violet sidebar: Record · Library · Projects · Modes · Storage. White text/tint
/// over the gradient; selected rows get a translucent white highlight (Liquid Glass refracts
/// the violet beneath).
struct SidebarView: View {
    @ObservedObject var store: RecordingsStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var addingProject = false
    @State private var newProjectName = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                workspaceSection
                librarySection
                projectsSection
                if hasAnyMode { modesSection }
                storageSection
                Spacer(minLength: 8)
            }
            .padding(14)
            .padding(.top, 24)
        }
        .scrollContentBackground(.hidden)
        .foregroundStyle(.white)
        .tint(.white)
    }

    // MARK: - Workspace

    private var workspaceSection: some View {
        section(title: "Workspace") {
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { store.pane = .record }
            } label: {
                rowLabel(icon: "mic.fill", label: "Record", count: nil,
                         selected: store.pane == .record, accentDot: store.engine.isRecording)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Library

    private var librarySection: some View {
        section(title: "Library") {
            filterRow(.all, icon: "waveform", label: "All Recordings")
            if store.count(for: .noProject) > 0 {
                filterRow(.noProject, icon: "tray", label: "No Project")
            }
        }
    }

    // MARK: - Projects

    private var projectsSection: some View {
        section(title: "Projects", trailing: {
            Button { addingProject = true; newProjectName = "" } label: {
                Image(systemName: "plus").font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .help("Add Project")
            .popover(isPresented: $addingProject, arrowEdge: .trailing) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("New Project").font(.headline)
                    TextField("Project name", text: $newProjectName)
                        .textFieldStyle(.roundedBorder).frame(width: 200)
                        .onSubmit(commitNewProject)
                    HStack {
                        Spacer()
                        Button("Cancel") { addingProject = false }
                        Button("Add") { commitNewProject() }
                            .keyboardShortcut(.defaultAction)
                            .disabled(newProjectName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                .padding(14)
            }
        }) {
            if store.projects.isEmpty {
                Text("No projects")
                    .font(.caption).foregroundStyle(.white.opacity(0.5)).padding(.leading, 6)
            }
            ForEach(store.projects) { project in
                filterRow(.project(project.id), icon: "folder", label: project.name)
                    .contextMenu {
                        Button("Delete", role: .destructive) {
                            store.projectStore.removeProject(id: project.id)
                        }
                    }
            }
        }
    }

    private func commitNewProject() {
        let name = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        store.projectStore.addProject(name: name)
        addingProject = false
        newProjectName = ""
    }

    // MARK: - Modes

    private var hasAnyMode: Bool {
        store.count(for: .mode("enhanced")) > 0 || store.count(for: .mode("raw")) > 0
    }

    private var modesSection: some View {
        section(title: "Modes") {
            if store.count(for: .mode("enhanced")) > 0 {
                filterRow(.mode("enhanced"), icon: "wand.and.stars", label: "Enhanced")
            }
            if store.count(for: .mode("raw")) > 0 {
                filterRow(.mode("raw"), icon: "text.quote", label: "Raw")
            }
        }
    }

    // MARK: - Storage

    private var storageSection: some View {
        section(title: "Storage", trailing: {
            Button { store.syncCloud() } label: {
                if case .syncing = store.syncState {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11, weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .help("Sync local ⇄ cloud")
        }) {
            if store.count(for: .thisMachine) > 0 {
                filterRow(.thisMachine, icon: "desktopcomputer", label: "This Mac")
            }
            ForEach(otherMachines, id: \.self) { machine in
                filterRow(.machine(machine), icon: "macpro.gen3.server", label: machine)
            }
            HStack(spacing: 6) {
                Image(systemName: store.storage?.enabled == true ? "cloud.fill" : "internaldrive")
                    .font(.system(size: 11))
                Text(storageLabel).font(.caption2)
                Spacer()
            }
            .foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 9).padding(.top, 2)
            if case .failed(let msg) = store.syncState {
                Text(msg).font(.caption2).foregroundStyle(.white.opacity(0.6)).lineLimit(2).padding(.leading, 9)
            }
        }
    }

    private var storageLabel: String {
        guard let s = store.storage else { return "Local only" }
        if s.enabled { return "Cloud: \(s.mode)" }
        return "Local only"
    }

    private var otherMachines: [String] {
        store.machines.filter { $0 != store.localMachineID }
    }

    // MARK: - Building blocks

    @ViewBuilder
    private func section<Trailing: View, Content: View>(
        title: String,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() },
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .padding(.leading, 6)
                Spacer()
                trailing().foregroundStyle(.white.opacity(0.85)).padding(.trailing, 6)
            }
            content()
        }
    }

    private func filterRow(_ target: LibraryFilter, icon: String, label: String) -> some View {
        let selected = store.pane == .library && store.filter == target
        let count = store.count(for: target)
        return Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                store.filter = target
                store.pane = .library
                if !store.visibleRecordings.contains(where: { $0.id == store.selection }) {
                    store.selection = store.visibleRecordings.first?.id
                }
            }
        } label: {
            rowLabel(icon: icon, label: label, count: count > 0 ? count : nil, selected: selected, accentDot: false)
        }
        .buttonStyle(.plain)
    }

    private func rowLabel(icon: String, label: String, count: Int?, selected: Bool, accentDot: Bool) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon).font(.system(size: 12, weight: .medium)).frame(width: 16)
            Text(label).font(.system(.subheadline, design: .rounded)).lineLimit(1)
            Spacer(minLength: 4)
            if accentDot {
                Circle().fill(Theme.recordRed).frame(width: 7, height: 7)
            } else if let count {
                Text("\(count)").font(.caption2.monospacedDigit()).foregroundStyle(.white.opacity(0.55))
            }
        }
        .foregroundStyle(.white.opacity(selected ? 1 : 0.85))
        .padding(.horizontal, 9).padding(.vertical, 7)
        .contentShape(Rectangle())
        .background {
            if selected {
                RoundedRectangle(cornerRadius: Theme.cornerSmall, style: .continuous).fill(.white.opacity(0.22))
            }
        }
    }
}
