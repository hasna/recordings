@preconcurrency import Cocoa
import SwiftUI
import RecordingsLib

struct MenuBarPresentation: Equatable {
    let iconName: String
    let accessibilityLabel: String
    let statusText: String

    init(isRecording: Bool, isTranscribing: Bool, idleStatus: String = "Ready") {
        if isRecording {
            iconName = "waveform"
            accessibilityLabel = "Recordings, recording"
            statusText = "Recording"
        } else if isTranscribing {
            iconName = "ellipsis.circle"
            accessibilityLabel = "Recordings, transcribing"
            statusText = "Transcribing"
        } else {
            iconName = "mic.fill"
            accessibilityLabel = "Recordings"
            statusText = idleStatus
        }
    }
}

struct MenuBarStatusLabel: View {
    @ObservedObject var store: RecordingsStore

    var body: some View {
        Image(systemName: presentation.iconName)
            .accessibilityLabel(presentation.accessibilityLabel)
    }

    private var presentation: MenuBarPresentation {
        MenuBarPresentation(
            isRecording: store.engine.isRecording,
            isTranscribing: store.engine.isTranscribing,
            idleStatus: store.engine.statusMessage
        )
    }
}

struct MenuBarStatusView: View {
    @ObservedObject var store: RecordingsStore
    let openRecordings: () -> Void

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

    private var statusIcon: String {
        presentation.iconName
    }

    private var statusColor: Color {
        store.engine.isRecording ? .red : .accentColor
    }

    private var statusText: String {
        presentation.statusText
    }

    private var presentation: MenuBarPresentation {
        MenuBarPresentation(
            isRecording: store.engine.isRecording,
            isTranscribing: store.engine.isTranscribing,
            idleStatus: store.engine.statusMessage
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
