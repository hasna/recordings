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
            Section("Shortcut — fn Key") {
                Toggle("Use fn (Globe) key", isOn: $engine.useFnKey)

                if engine.useFnKey {
                    Text("Hold fn to record, release to stop and paste.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("Required: System Settings → Keyboard → set \"Press 🌐 key to: Do Nothing\"")
                            .font(.caption)
                    }
                    Button("Open Keyboard Settings") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!)
                    }.controlSize(.small)
                }
            }

            Section("Shortcut — Custom Key") {
                HStack {
                    Text("Toggle Recording")
                    Spacer()
                    KeyboardShortcuts.Recorder(for: .toggleRecording) { _ in
                        engine.updateStatus()
                    }
                }
                Text("Click the field and press any key combo (e.g. ⌥D, ⌃R, F5).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Recording") {
                Picker("Mode", selection: $engine.mode) {
                    ForEach(RecordingMode.allCases) { m in
                        Label(m.rawValue, systemImage: m.icon).tag(m)
                    }
                }
                Toggle("Whisper Mode", isOn: $engine.isWhisperMode)
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
