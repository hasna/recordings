import SwiftUI
@preconcurrency import KeyboardShortcuts

public struct SettingsView: View {
    @ObservedObject public var engine: RecordingEngine
    @ObservedObject public var shortcuts: VoiceShortcuts
    @ObservedObject public var projectStore: ProjectStore
    @AppStorage("openAIAPIKey") private var openAIAPIKey = ""

    public init(engine: RecordingEngine, shortcuts: VoiceShortcuts, projectStore: ProjectStore) {
        self.engine = engine
        self.shortcuts = shortcuts
        self.projectStore = projectStore
    }

    public var body: some View {
        TabView {
            generalTab.tabItem { Label("General", systemImage: "gear") }
            projectsTab.tabItem { Label("Projects", systemImage: "folder") }
            shortcutsTab.tabItem { Label("Voice Shortcuts", systemImage: "text.badge.star") }
        }
        .frame(width: 520, height: 500)
        .alert("Project Settings Error", isPresented: Binding(
            get: { projectStore.persistenceError != nil },
            set: { if !$0 { projectStore.clearPersistenceError() } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(projectStore.persistenceError ?? "The project settings could not be saved.")
        }
    }

    // MARK: - General

    private var generalTab: some View {
        Form {
            Section("OpenAI") {
                SecureField("API key", text: $openAIAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: openAIAPIKey) {
                        // Keep the CLI config in sync — final transcription shells out to it.
                        try? OpenAIAPIKeyStore.save(key: openAIAPIKey, homePath: engine.home)
                    }
                Picker("Language", selection: $engine.transcriptionLanguage) {
                    Text("English").tag("en")
                    Text("Auto Detect").tag("auto")
                }
                Text("Used for live transcription and the final paste. Stored in ~/.hasna/recordings/config.json.")
                    .foregroundStyle(.secondary)
            }

            Section("Intent") {
                Toggle("Detect questions and edit commands", isOn: $engine.intentDetectionEnabled)
                Text("When on, Recordings infers whether you dictated, asked a question, or asked it to edit the selected text. Anything uncertain is typed out literally. When off, every recording is typed out.")
                    .foregroundStyle(.secondary)
            }

            Section("Recording Shortcut") {
                HStack {
                    Text("Shortcut")
                    Spacer()
                    // Re-evaluate on change, not just log: a chord the system already
                    // reserves has to be reported the moment it is picked, not at next launch.
                    KeyboardShortcuts.Recorder(for: .toggleRecording) { _ in
                        engine.refreshTriggerDiagnostics()
                    }
                    Button("Reset to F5") {
                        KeyboardShortcuts.setShortcut(.init(.f5), for: .toggleRecording)
                        engine.refreshTriggerDiagnostics()
                    }
                }
                // No .onChange here: `RecordingEngine.useFnKey`'s own didSet re-arms the
                // monitor and logs the resolved trigger, so it also covers a change made
                // from the CLI or anywhere else — a view-local hook would not.
                Toggle("Use fn/Globe as recording key", isOn: $engine.useFnKey)
                Text("Hold to record, release to transcribe and paste. fn needs Accessibility; the hotkey above needs no permission.")
                    .foregroundStyle(.secondary)
                // A trigger that is switched on but cannot arm must say so next to its own
                // switch. Silence here is what made 51 recorded hotkey presses look like a
                // working trigger while nothing was delivered.
                //
                // Scoped to the trigger sources, and the button keyed to each reason's own
                // remedy. Rendering the composed `engine.blockedReason` here instead meant a
                // secure-input paste failure showed "transcript copied, press Cmd-V" under
                // Recording Shortcut beside an "Open Accessibility Settings" button — wrong
                // remedy, wrong section, wrong cause. A hotkey collision took that button too,
                // and the Accessibility pane does nothing for a chord clash either.
                ForEach(engine.blockedReasonEntries.filter(\.isTriggerHealth)) { entry in
                    Label(entry.message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    // `switch`, not `==`. This file's engine forbids `==` against an enum case in
                    // three separate comments for the same reason: it answers `false` for every
                    // case added later, so a fourth remedy carrying a button would silently render
                    // none. Exhaustive here means adding one forces the decision.
                    switch entry.remedy {
                    case .openAccessibilitySettings:
                        Button("Open Accessibility Settings") {
                            engine.openAccessibilitySettings()
                        }
                    case .chooseAnotherShortcut, .messageOnly:
                        EmptyView()
                    }
                }
            }

            // Delivery reasons are not trigger health, but they are the ONLY message telling the
            // owner their transcript is still recoverable — so they need a surface here, not just
            // a wordless warning triangle in the menu bar and a caption behind a click. Scoping
            // the trigger section was right; dropping these entirely was not.
            if !engine.blockedReasonEntries.filter({ !$0.isTriggerHealth }).isEmpty {
                Section("Last Delivery") {
                    ForEach(engine.blockedReasonEntries.filter { !$0.isTriggerHealth }) { entry in
                        Label(entry.message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }

            Section("Permissions") {
                HStack {
                    Text("Microphone")
                    Spacer()
                    Text(engine.microphonePermissionLabel)
                        .foregroundStyle(.secondary)
                }
                Button("Request Microphone") {
                    engine.requestMicrophonePermission()
                }
                HStack {
                    Text("Accessibility")
                    Spacer()
                    Text(engine.accessibilityPermissionLabel)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Button("Request Accessibility") {
                        engine.requestAccessibilityPermission()
                    }
                    Button("Open Accessibility Settings") {
                        engine.openAccessibilitySettings()
                    }
                }
            }

            Section("Transcription Cleanup") {
                Picker("Mode", selection: $projectStore.settings.postProcessingMode) {
                    ForEach(PostProcessingMode.allCases) { mode in
                        Text(mode.label).tag(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: projectStore.settings.postProcessingMode) {
                    try? projectStore.save()
                }
                TextEditor(text: $projectStore.settings.globalSystemPrompt)
                    .frame(height: 80)
                    .onChange(of: projectStore.settings.globalSystemPrompt) {
                        try? projectStore.save()
                    }
                Text("Instructions for post-transcription cleanup and formatting.")
                    .foregroundStyle(.secondary)
            }
            .disabled(!projectStore.canMutateProjects)
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
                    let name = newProjectName
                    Task {
                        do {
                            try await projectStore.addProject(name: name)
                            newProjectName = ""
                        } catch {}
                    }
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
                            try? projectStore.removeProject(id: projectStore.settings.projects[i].id)
                        }
                    }
                }
            }
        }
        .disabled(!projectStore.canMutateProjects)
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

                Section("Transcriber Instructions") {
                    TextEditor(text: Binding(
                        get: { project.systemPrompt ?? "" },
                        set: { project.systemPrompt = $0.isEmpty ? nil : $0 }
                    ))
                    .frame(height: 100)
                    Text("Project-specific cleanup and formatting instructions.")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .disabled(!store.canMutateProjects)

            HStack {
                Spacer()
                Button("Cancel") { onDismiss() }
                Button("Save") {
                    do {
                        try store.updateProject(project)
                        onDismiss()
                    } catch {}
                }
                .disabled(!store.canMutateProjects)
            }
            .padding()
        }
        .frame(width: 420, height: 340)
    }
}
