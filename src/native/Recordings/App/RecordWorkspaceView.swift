import SwiftUI
import RecordingsLib
@preconcurrency import KeyboardShortcuts

/// The Recordings workspace — the app's first screen. A large Liquid-Glass record hero with
/// live transcription, mode selection, the active project, and a quick view of the latest
/// transcripts. Drives the shared `RecordingEngine`.
struct RecordWorkspaceView: View {
    @ObservedObject var store: RecordingsStore
    @Environment(\.colorScheme) private var colorScheme
    @Namespace private var glass

    private var engine: RecordingEngine { store.engine }
    private var isBusy: Bool { engine.isRecording || engine.isTranscribing }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                GlassEffectContainer(spacing: 12) {
                    hero
                        .frame(maxWidth: 560)
                }
                .padding(.top, 28)

                if !isBusy {
                    modeSelector.frame(maxWidth: 420)
                }

                activeProjectRow

                if let synchronizationError = store.projectStore.synchronizationError {
                    projectSynchronizationWarning(synchronizationError)
                }

                if !engine.recentTranscriptions.isEmpty {
                    recentStrip
                }

                Spacer(minLength: 12)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 28)
            .padding(.bottom, 24)
        }
        .animation(.smooth(duration: 0.28), value: engine.isRecording)
        .animation(.smooth(duration: 0.28), value: engine.isTranscribing)
        .onChange(of: engine.isTranscribing) { wasTranscribing, isTranscribing in
            // When transcription finishes the CLI has persisted the recording — refresh the
            // library. Fires for every mode (incl. command) and on success or failure.
            if wasTranscribing && !isTranscribing { store.loadLibrary() }
        }
    }

    // MARK: - Hero (single morphing glass surface)

    private var hero: some View {
        VStack(spacing: 14) { heroContent }
            .frame(maxWidth: .infinity)
            .padding(26)
            .glassEffect(heroGlass, in: .rect(cornerRadius: Theme.cornerLarge))
            .glassEffectID("record-hero", in: glass)
    }

    private var heroGlass: Glass {
        if engine.isRecording { return .regular.tint(Theme.recordRed.opacity(0.18)) }
        if engine.isTranscribing { return .regular.tint(.orange.opacity(0.12)) }
        return .regular.interactive()
    }

    @ViewBuilder
    private var heroContent: some View {
        if engine.isRecording {
            recordingContent
        } else if engine.isTranscribing {
            transcribingContent
        } else {
            idleContent
        }
    }

    private var idleContent: some View {
        VStack(spacing: 14) {
            Button {
                engine.startRecording()
            } label: {
                VStack(spacing: 10) {
                    Image(systemName: "mic.fill").font(.system(size: 44, weight: .semibold)).foregroundStyle(.tint)
                    Text("Record").font(.system(.title, design: .rounded).weight(.semibold)).foregroundStyle(.primary)
                    Text(idleHint).font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 14).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start recording")

            Text(engine.statusMessage)
                .font(.caption)
                .foregroundStyle(engine.statusMessage == "Ready" ? Color.secondary : Color.orange)
                .multilineTextAlignment(.center)
        }
        .tint(Theme.accent)
    }

    private var idleHint: String {
        if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
            return engine.mode == .pushToTalk ? "Click, or hold \(shortcut.description)"
                                              : "Click, or press \(shortcut.description)"
        }
        return "Click to start"
    }

    private var recordingContent: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: true)
                    .foregroundStyle(Theme.recordRed).font(.largeTitle)
                Text(fmt(engine.recordingDuration))
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText())
            }
            modeTag
            liveText(placeholder: "Listening…")
            HStack(spacing: 12) {
                Button(role: .cancel) { engine.cancelRecording() } label: {
                    Label("Discard", systemImage: "xmark")
                }
                .buttonStyle(.glass)
                Button { engine.stopAndTranscribe() } label: {
                    Label("Stop & Transcribe", systemImage: "stop.fill")
                }
                .buttonStyle(.glassProminent).tint(Theme.recordRed)
            }
            .controlSize(.large)
        }
    }

    private var transcribingContent: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.large)
                Text(engine.statusMessage).font(.system(.title2, design: .rounded)).foregroundStyle(.secondary)
            }
            modeTag
            liveText(placeholder: "Finishing up…")
        }
    }

    private var modeTag: some View {
        HStack(spacing: 5) {
            Image(systemName: engine.mode.icon)
            Text(engine.mode.rawValue)
        }
        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(.quaternary, in: .capsule)
    }

    @ViewBuilder
    private func liveText(placeholder: String) -> some View {
        if !engine.liveTranscriptionText.isEmpty {
            Text(engine.liveTranscriptionText)
                .font(.system(.title3, design: .rounded))
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(6).contentTransition(.opacity)
        } else {
            Text(placeholder).font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Mode selector

    private var modeSelector: some View {
        Picker("Mode", selection: Binding(get: { engine.mode }, set: { engine.mode = $0 })) {
            ForEach(RecordingMode.allCases) { mode in
                Label(mode.shortName, systemImage: mode.icon).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .help(engine.mode.hint)
    }

    @ViewBuilder
    private var activeProjectRow: some View {
        if !store.projects.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(store.projectStore.activeProject != nil ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                Menu {
                    Button("None") { selectProject(nil) }
                    Divider()
                    ForEach(store.projects) { project in
                        Button {
                            selectProject(project.id)
                        } label: {
                            if project.id == store.projectStore.settings.activeProjectId {
                                Label(project.name, systemImage: "checkmark")
                            } else { Text(project.name) }
                        }
                    }
                } label: {
                    Text(store.projectStore.activeProject?.name ?? "No project")
                }
                .menuStyle(.borderlessButton).fixedSize()
                .disabled(!store.projectStore.canMutateProjects)
                Text("· transcripts are tagged to this project").font(.caption).foregroundStyle(.tertiary)
                Spacer()
            }
            .font(.system(.callout, design: .rounded))
            .tint(Theme.accent)
            .frame(maxWidth: 560)
        }
    }

    private func selectProject(_ id: String?) {
        do {
            try store.projectStore.setActive(id)
        } catch {
            store.operationError = store.projectStore.persistenceError ?? error.localizedDescription
        }
    }

    private func projectSynchronizationWarning(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            Button("Retry") { store.reconcileProjects() }
                .buttonStyle(.borderless)
                .disabled(store.projectStore.isSynchronizingProjects)
        }
        .frame(maxWidth: 560)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Recent strip

    private var recentStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("JUST NOW").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(engine.recentTranscriptions.prefix(3).indices, id: \.self) { i in
                let item = engine.recentTranscriptions[i]
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.alignleft").font(.caption).foregroundStyle(.tertiary).padding(.top, 2)
                    Text(item.displayText).font(.callout).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        engine.pasteIntoFrontApp(item.displayText)
                    } label: { Image(systemName: "arrow.up.right.square") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Paste into front app")
                }
                .padding(.vertical, 4)
                if i < min(2, engine.recentTranscriptions.count - 1) { Divider().opacity(0.3) }
            }
        }
        .frame(maxWidth: 560)
        .padding(14)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: Theme.cornerMedium))
    }

    private func fmt(_ t: TimeInterval) -> String {
        let total = Int(t)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
