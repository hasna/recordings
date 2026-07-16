import SwiftUI
import RecordingsLib
@preconcurrency import KeyboardShortcuts

/// The Recordings workspace — the app's first screen. One Liquid-Glass hero drives the whole
/// flow: speak, and the app types it, answers a question, or edits the selection. There is no
/// mode selector; the phase (idle → listening → finalizing → processing → ready/error) is the
/// only state the page renders.
struct RecordWorkspaceView: View {
    @ObservedObject var store: RecordingsStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Namespace private var glass

    private var engine: RecordingEngine { store.engine }
    private var phase: RecordingFlowPhase { engine.flowPhase }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                GlassEffectContainer(spacing: 12) {
                    hero
                        .frame(maxWidth: 560)
                }
                .padding(.top, 28)

                if let reply = engine.conversationReply {
                    replyCard(reply)
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
        .animation(reduceMotion ? nil : .smooth(duration: 0.28), value: phase)
        .onChange(of: engine.isTranscribing) { wasTranscribing, isTranscribing in
            // When transcription finishes the CLI has persisted the recording — refresh the
            // library. Fires for every intent route and on success or failure.
            if wasTranscribing && !isTranscribing { store.loadLibrary() }
        }
    }

    // MARK: - Hero (single morphing glass surface)

    @ViewBuilder
    private var hero: some View {
        // The hidden template is the tallest phase layout (listening, with the full
        // six-line live-text reservation). Every phase renders inside that fixed envelope,
        // so streaming live text and phase transitions can never shift the content below
        // the hero. The template scales with Dynamic Type because it uses the real fonts.
        let content = ZStack {
            heroSizingTemplate
                .hidden()
                .accessibilityHidden(true)
            VStack(spacing: 14) { heroContent }
        }
        .frame(maxWidth: .infinity, minHeight: 208)
        .padding(26)
        switch ChromeSurface.forReducedTransparency(reduceTransparency) {
        case .opaque:
            // Reduce Transparency: a fully opaque system background — never a material,
            // which still composites the desktop through the window.
            content
                .background(
                    Color(NSColor.windowBackgroundColor),
                    in: .rect(cornerRadius: Theme.cornerLarge)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.cornerLarge, style: .continuous)
                        .strokeBorder(.separator, lineWidth: 1)
                )
        case .liquidGlass:
            content
                .glassEffect(heroGlass, in: .rect(cornerRadius: Theme.cornerLarge))
                .glassEffectID("record-hero", in: glass)
        }
    }

    private var heroGlass: Glass {
        switch phase {
        case .idle: return .regular.interactive()
        case .listening: return .regular.tint(Theme.recordRed.opacity(0.18))
        case .finalizing, .processing: return .regular.tint(.orange.opacity(0.12))
        case .ready: return .regular.tint(.green.opacity(0.10))
        case .failed: return .regular.tint(.orange.opacity(0.16))
        }
    }

    @ViewBuilder
    private var heroContent: some View {
        switch phase {
        case .idle:
            idleContent
        case .listening:
            listeningContent
        case .finalizing:
            busyContent(label: "Finishing up…", detail: "Capturing the last words", showsLiveText: true)
        case .processing(let label):
            busyContent(
                label: label,
                detail: nil,
                showsLiveText: false,
                showsCancel: engine.canCancelIntentDelivery
            )
        case .ready(let summary):
            readyContent(summary: summary)
        case .failed(let message):
            failedContent(message: message)
        }
    }

    /// Invisible layout twin of the listening phase; see `hero`. Uses the same controls and
    /// fonts so its height tracks the real layout at every Dynamic Type size.
    private var heroSizingTemplate: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "waveform").font(.largeTitle)
                Text("0:00:00")
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
            }
            liveTextReservation
            HStack(spacing: 12) {
                Button {} label: { Label("Discard", systemImage: "xmark") }
                    .buttonStyle(.glass)
                Button {} label: { Label("Stop & Transcribe", systemImage: "stop.fill") }
                    .buttonStyle(.glassProminent)
            }
            .controlSize(.large)
            .disabled(true)
        }
    }

    /// Reserves exactly six lines at the live-text font so the region cannot grow as words
    /// stream in.
    private var liveTextReservation: some View {
        Text(String(repeating: "M\n", count: 5) + "M")
            .font(.system(.title3, design: .rounded))
            .lineLimit(6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Idle

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
            .keyboardShortcut(.defaultAction)
            .accessibilityLabel("Start recording")

            Text("Speak — Recordings types what you say, answers questions, and edits selected text.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)

            if engine.statusMessage != "Ready" {
                Text(engine.statusMessage)
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                    .multilineTextAlignment(.center)
            }
        }
        .tint(Theme.accent)
    }

    private var idleHint: String {
        if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
            return "Click, or hold \(shortcut.description)"
        }
        return "Click to start"
    }

    // MARK: Listening

    private var listeningContent: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
                    .foregroundStyle(Theme.recordRed).font(.largeTitle)
                    .accessibilityHidden(true)
                Text(fmt(engine.recordingDuration))
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                    .contentTransition(reduceMotion ? .identity : .numericText())
                    .accessibilityLabel("Recording, \(fmt(engine.recordingDuration))")
            }
            liveText(placeholder: "Listening…")
            HStack(spacing: 12) {
                Button(role: .cancel) { engine.cancelRecording() } label: {
                    Label("Discard", systemImage: "xmark")
                }
                .buttonStyle(.glass)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Discard recording")
                Button { engine.stopAndTranscribe() } label: {
                    Label("Stop & Transcribe", systemImage: "stop.fill")
                }
                .buttonStyle(.glassProminent).tint(Theme.recordRed)
                .keyboardShortcut(.defaultAction)
                .accessibilityLabel("Stop and transcribe")
            }
            .controlSize(.large)
        }
    }

    // MARK: Finalizing / Processing

    private func busyContent(
        label: String,
        detail: String?,
        showsLiveText: Bool,
        showsCancel: Bool = false
    ) -> some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.large)
                Text(label).font(.system(.title2, design: .rounded)).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            if let detail {
                Text(detail).font(.caption).foregroundStyle(.tertiary)
            }
            if showsLiveText {
                liveText(placeholder: "Finishing up…")
            }
            if showsCancel {
                Button(role: .cancel) {
                    engine.cancelIntentProcessing()
                } label: {
                    Label("Cancel", systemImage: "xmark")
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .keyboardShortcut(.cancelAction)
                .help("Stop waiting — the transcript stays in Recent")
                .accessibilityLabel("Cancel and keep the transcript")
            }
        }
    }

    // MARK: Ready

    private func readyContent(summary: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            Text(summary)
                .font(.system(.title3, design: .rounded))
                .multilineTextAlignment(.center)
            Button {
                engine.startRecording()
            } label: {
                Label("Record Again", systemImage: "mic.fill")
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .accessibilityLabel("Start a new recording")
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Error

    private func failedContent(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36, weight: .semibold))
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text(message)
                .font(.system(.title3, design: .rounded))
                .multilineTextAlignment(.center)
            Button {
                engine.startRecording()
            } label: {
                Label("Try Again", systemImage: "mic.fill")
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .accessibilityLabel("Try recording again")
        }
        .accessibilityElement(children: .contain)
    }

    /// Live text renders inside a fixed six-line reservation: the region's size never
    /// depends on how much has been transcribed, so nothing below it can shift.
    private func liveText(placeholder: String) -> some View {
        ZStack(alignment: .topLeading) {
            liveTextReservation
                .hidden()
                .accessibilityHidden(true)
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
    }

    // MARK: - Conversation reply

    /// Content surface, deliberately not glass: answers must stay highly readable.
    private func replyCard(_ reply: ConversationReply) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("You asked", systemImage: "questionmark.bubble")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    engine.copyToClipboard(reply.answer)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy the answer")
                .accessibilityLabel("Copy answer")
            }
            Text(reply.question)
                .font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Divider().opacity(0.4)
            Text(reply.answer)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: Theme.cornerMedium))
        .frame(maxWidth: 560)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Answer: \(reply.answer)")
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
        let items = Array(engine.recentTranscriptions.prefix(3))
        return VStack(alignment: .leading, spacing: 6) {
            Text("JUST NOW").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.alignleft").font(.caption).foregroundStyle(.tertiary).padding(.top, 2)
                    Text(item.displayText).font(.callout).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        engine.pasteIntoFrontApp(item.displayText)
                    } label: { Image(systemName: "arrow.up.right.square") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Paste into front app")
                    .accessibilityLabel("Paste transcript into front app")
                }
                .padding(.vertical, 4)
                if i < items.count - 1 { Divider().opacity(0.3) }
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
