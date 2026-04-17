import SwiftUI
import KeyboardShortcuts

struct SettingsView: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts
    @State private var newTrigger = ""
    @State private var newContent = ""

    var body: some View {
        TabView {
            generalTab.tabItem { Label("General", systemImage: "gear") }
            shortcutsTab.tabItem { Label("Voice Shortcuts", systemImage: "text.badge.star") }
        }
        .frame(width: 480, height: 400)
    }

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
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped).padding()
    }

    private var shortcutsTab: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("Trigger phrase", text: $newTrigger).textFieldStyle(.roundedBorder)
                TextField("Text to insert", text: $newContent).textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !newTrigger.isEmpty, !newContent.isEmpty else { return }
                    shortcuts.add(trigger: newTrigger, content: newContent)
                    newTrigger = ""; newContent = ""
                }.buttonStyle(.borderedProminent).disabled(newTrigger.isEmpty || newContent.isEmpty)
            }.padding()
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
                            Text(s.trigger).font(.body.bold())
                            Text(s.content).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }.onDelete(perform: shortcuts.remove)
                }
            }
        }
    }
}
