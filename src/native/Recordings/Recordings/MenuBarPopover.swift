import SwiftUI
import KeyboardShortcuts

struct MenuBarPopover: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts
    @State private var copiedIndex: Int?

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            Divider()
            recordingArea
                .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            recentList
                .frame(maxHeight: 200)
            Divider()
            footer
                .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Image(systemName: "mic.fill")
                .font(.title3)
                .foregroundStyle(.tint)
            Text("Hasna Recordings")
                .font(.headline)
            Spacer()
            if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
                Text(shortcut.description)
                    .font(.system(.caption, design: .monospaced))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .glassEffect(.regular)
            }
        }
    }

    // MARK: - Recording Area

    private var recordingArea: some View {
        Group {
            if engine.isRecording {
                HStack(spacing: 10) {
                    Circle().fill(.red).frame(width: 8, height: 8)
                    Text(fmt(engine.recordingDuration))
                        .font(.system(.body, design: .monospaced))
                        .monospacedDigit()
                    Spacer()
                    Button("Stop") { engine.stopAndTranscribe() }
                        .buttonStyle(.borderedProminent)
                        .tint(.red)
                        .controlSize(.small)
                }
                .padding(10)
                .glassEffect(.regular.tint(.red.opacity(0.3)))
            } else if engine.isTranscribing {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Transcribing...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(10)
                .glassEffect(.regular)
            } else {
                VStack(spacing: 8) {
                    Button { engine.startRecording() } label: {
                        Label("Record", systemImage: "mic.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)

                    if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
                        Text("or hold \(shortcut.description)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(10)
                .glassEffect(.regular)
            }
        }
    }

    // MARK: - Recent

    private var recentList: some View {
        Group {
            if engine.recentTranscriptions.isEmpty {
                VStack {
                    Spacer()
                    Text("No transcriptions yet")
                        .font(.caption)
                        .foregroundStyle(.quaternary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(engine.recentTranscriptions.indices, id: \.self) { i in
                            TranscriptionRow(
                                item: engine.recentTranscriptions[i],
                                isCopied: copiedIndex == i
                            ) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(
                                    engine.recentTranscriptions[i].displayText,
                                    forType: .string
                                )
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    copiedIndex = i
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                    withAnimation { if copiedIndex == i { copiedIndex = nil } }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 6)
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            SettingsLink {
                Image(systemName: "gear")
            }
            .buttonStyle(.borderless)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
        }
    }

    private func fmt(_ t: TimeInterval) -> String {
        String(format: "%d:%02d", Int(t) / 60, Int(t) % 60)
    }
}

struct TranscriptionRow: View {
    let item: TranscriptionResult
    let isCopied: Bool
    let onCopy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(item.displayText)
                .font(.caption)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isCopied {
                Image(systemName: "checkmark")
                    .font(.caption2)
                    .foregroundStyle(.green)
                    .transition(.scale.combined(with: .opacity))
            } else {
                Text(relativeTime(item.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .onTapGesture { onCopy() }
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let s = Date().timeIntervalSince(date)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        return "\(Int(s / 3600))h"
    }
}
