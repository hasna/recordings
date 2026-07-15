@preconcurrency import Cocoa
import SwiftUI
import RecordingsLib

struct MenuBarStatusLabel: View {
    @ObservedObject var store: RecordingsStore

    var body: some View {
        Image(systemName: iconName)
            .accessibilityLabel(statusLabel)
    }

    private var iconName: String {
        if store.engine.isRecording { return "waveform" }
        if store.engine.isTranscribing { return "ellipsis.circle" }
        return "mic.fill"
    }

    private var statusLabel: String {
        if store.engine.isRecording { return "Recordings, recording" }
        if store.engine.isTranscribing { return "Recordings, transcribing" }
        return "Recordings"
    }
}

struct MenuBarStatusView: View {
    @ObservedObject var store: RecordingsStore
    let showMainWindow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: statusIcon)
                    .foregroundStyle(statusColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recordings")
                        .font(.headline)
                    Text(statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Button(action: toggleRecording) {
                Label(recordButtonTitle, systemImage: recordButtonIcon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(store.engine.isRecording ? .red : .accentColor)
            .disabled(store.engine.isTranscribing)

            Divider()

            Button(action: showMainWindow) {
                Label("Open Recordings", systemImage: "macwindow")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            SettingsLink {
                Label("Settings", systemImage: "gearshape")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quit Recordings", systemImage: "power")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .frame(width: 260)
    }

    private var statusIcon: String {
        if store.engine.isRecording { return "waveform" }
        if store.engine.isTranscribing { return "ellipsis.circle" }
        return "mic.fill"
    }

    private var statusColor: Color {
        store.engine.isRecording ? .red : .accentColor
    }

    private var statusText: String {
        if store.engine.isRecording { return "Recording" }
        if store.engine.isTranscribing { return "Transcribing" }
        return store.engine.statusMessage
    }

    private var recordButtonTitle: String {
        store.engine.isRecording ? "Stop and Transcribe" : "Start Recording"
    }

    private var recordButtonIcon: String {
        store.engine.isRecording ? "stop.fill" : "mic.fill"
    }

    private func toggleRecording() {
        if store.engine.isRecording {
            store.engine.stopAndTranscribe()
        } else {
            store.engine.startRecording()
        }
    }
}
