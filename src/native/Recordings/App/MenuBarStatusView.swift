@preconcurrency import Cocoa
import SwiftUI
import RecordingsLib

struct MenuBarStatusLabel: View {
    @ObservedObject var store: RecordingsStore

    var body: some View {
        Image(systemName: presentation.iconName)
            .accessibilityLabel(presentation.accessibilityLabel)
    }

    private var presentation: MenuBarPresentation {
        MenuBarPresentation(
            isRecording: store.engine.isRecording,
            canStartRecording: store.engine.canStartRecording,
            statusMessage: store.engine.statusMessage
        )
    }
}

struct MenuBarStatusView: View {
    @ObservedObject var store: RecordingsStore
    let openRecordings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: presentation.iconName)
                    .foregroundStyle(statusColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recordings")
                        .font(.headline)
                    Text(presentation.statusText)
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
            .disabled(!presentation.primaryActionEnabled)

            Divider()

            Button(action: openRecordings) {
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

    private var statusColor: Color {
        store.engine.isRecording ? .red : .accentColor
    }

    private var presentation: MenuBarPresentation {
        MenuBarPresentation(
            isRecording: store.engine.isRecording,
            canStartRecording: store.engine.canStartRecording,
            statusMessage: store.engine.statusMessage
        )
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
