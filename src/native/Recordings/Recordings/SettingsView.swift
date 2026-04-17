import SwiftUI
import KeyboardShortcuts

struct SettingsView: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts
    @ObservedObject var projectStore: ProjectStore

    var body: some View {
        TabView {
            generalTab.tabItem { Label("General", systemImage: "gear") }
            projectsTab.tabItem { Label("Projects", systemImage: "folder") }
            shortcutsTab.tabItem { Label("Voice Shortcuts", systemImage: "text.badge.star") }
        }
        .frame(width: 520, height: 440)
    }

    // MARK: - General

    private var generalTab: some View {
        Form {
            Section("Recording Shortcut") {
                HStack {
                    Text("Shortcut")
                    Spacer()
                    KeyboardShortcuts.Recorder(for: .toggleRecording) { _ in
                        engine.updateStatus()
                    }
                }
                Text("Hold to record, release to transcribe and paste.")
                    .foregroundStyle(.secondary)
            }

            Section("System Prompt") {
                TextEditor(text: $projectStore.settings.globalSystemPrompt)
                    .frame(height: 80)
                    .onChange(of: projectStore.settings.globalSystemPrompt) {
                        projectStore.save()
                    }
                Text("Applied to all transcription enhancements.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped).padding()
    }

    // MARK: - Projects

    @State private var newProjectName = ""
    @State private var editingProject: RecProject?

    private var projectsTab: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("New project name", text: $newProjectName)
                    .textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !newProjectName.isEmpty else { return }
                    projectStore.addProject(name: newProjectName)
                    newProjectName = ""
                }
                .disabled(newProjectName.isEmpty)
            }
            .padding()

            Divider()

            if projectStore.settings.projects.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "folder").font(.largeTitle).foregroundStyle(.quaternary)
                    Text("No projects yet").foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                List {
                    ForEach(projectStore.settings.projects) { project in
                        ProjectRow(project: project) {
                            editingProject = project
                        }
                    }
                    .onDelete { indexSet in
                        for i in indexSet {
                            projectStore.removeProject(id: projectStore.settings.projects[i].id)
                        }
                    }
                }
            }
        }
        .sheet(item: $editingProject) { project in
            ProjectEditView(project: project, store: projectStore) {
                editingProject = nil
            }
        }
    }

    // MARK: - Voice Shortcuts

    @State private var newTrigger = ""
    @State private var newContent = ""

    private var shortcutsTab: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("Trigger phrase", text: $newTrigger).textFieldStyle(.roundedBorder)
                TextField("Text to insert", text: $newContent).textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !newTrigger.isEmpty, !newContent.isEmpty else { return }
                    shortcuts.add(trigger: newTrigger, content: newContent)
                    newTrigger = ""; newContent = ""
                }
                .disabled(newTrigger.isEmpty || newContent.isEmpty)
            }
            .padding()

            Divider()

            if shortcuts.shortcuts.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "text.badge.star").font(.largeTitle).foregroundStyle(.quaternary)
                    Text("No voice shortcuts yet").foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                List {
                    ForEach(shortcuts.shortcuts) { s in
                        VStack(alignment: .leading) {
                            Text(s.trigger).bold()
                            Text(s.content).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .onDelete(perform: shortcuts.remove)
                }
            }
        }
    }
}

// MARK: - Project Row

struct ProjectRow: View {
    let project: RecProject
    let onEdit: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                if let path = project.path, !path.isEmpty {
                    Text(path).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Button("Edit") { onEdit() }
                .controlSize(.small)
        }
    }
}

// MARK: - Project Edit

struct ProjectEditView: View {
    @State var project: RecProject
    let store: ProjectStore
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Project") {
                    TextField("Name", text: $project.name)
                    TextField("Path", text: Binding(
                        get: { project.path ?? "" },
                        set: { project.path = $0.isEmpty ? nil : $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                }

                Section("System Prompt") {
                    TextEditor(text: Binding(
                        get: { project.systemPrompt ?? "" },
                        set: { project.systemPrompt = $0.isEmpty ? nil : $0 }
                    ))
                    .frame(height: 100)
                    Text("Additional context for transcription enhancement in this project.")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button("Cancel") { onDismiss() }
                Button("Save") {
                    store.updateProject(project)
                    onDismiss()
                }
            }
            .padding()
        }
        .frame(width: 420, height: 340)
    }
}
