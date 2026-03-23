import SwiftUI
import KeyboardShortcuts

struct MenuBarPopover: View {
    @ObservedObject var engine: RecordingEngine
    @ObservedObject var shortcuts: VoiceShortcuts

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            Divider()
            modeSelector.padding(.horizontal, 16).padding(.vertical, 10)
            shortcutRow.padding(.horizontal, 16).padding(.bottom, 8)
            Divider()
            recordingArea.padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            recentList.frame(maxHeight: 180)
            Divider()
            footer.padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Image(systemName: "mic.fill").font(.title3).foregroundStyle(.tint)
            Text("Recordings").font(.headline)
            Spacer()
            Toggle(isOn: $engine.isWhisperMode) {
                Label("Whisper", systemImage: "speaker.wave.1.fill").font(.caption)
            }
            .toggleStyle(.button).buttonStyle(.bordered).controlSize(.small)
        }
    }

    // MARK: - Mode Selector

    private var modeSelector: some View {
        HStack(spacing: 8) {
            modeBtn(.pushToTalk)
            modeBtn(.dictation)
            modeBtn(.command)
        }
    }

    @ViewBuilder
    private func modeBtn(_ m: RecordingMode) -> some View {
        if engine.mode == m {
            Button { engine.mode = m } label: {
                Label(m.rawValue, systemImage: m.icon).font(.caption)
                    .foregroundStyle(.white).frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.small)
        } else {
            Button { engine.mode = m } label: {
                Label(m.rawValue, systemImage: m.icon).font(.caption)
                    .frame(maxWidth: .infinity)
            }.buttonStyle(.bordered).controlSize(.small)
        }
    }

    // MARK: - Shortcut Row

    private var shortcutRow: some View {
        VStack(spacing: 6) {
            // fn key toggle
            HStack {
                Toggle(isOn: $engine.useFnKey) {
                    HStack(spacing: 4) {
                        Text("fn").font(.system(.caption, design: .monospaced)).bold()
                        Text("Globe key").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch).controlSize(.small)
            }

            // Custom shortcut
            HStack(spacing: 8) {
                Text("Custom").font(.caption).foregroundStyle(.secondary)
                Spacer()
                let current = KeyboardShortcuts.getShortcut(for: .toggleRecording)
                Text(current?.description ?? "None")
                    .font(.system(.caption, design: .monospaced))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 5))

                SettingsLink {
                    Text("Set").font(.caption2)
                }.buttonStyle(.bordered).controlSize(.mini)
            }
        }
    }

    // MARK: - Recording Area

    private var recordingArea: some View {
        VStack(spacing: 8) {
            if engine.isRecording {
                HStack(spacing: 12) {
                    Circle().fill(.red).frame(width: 10, height: 10)
                    Text(fmt(engine.recordingDuration))
                        .font(.system(.title2, design: .monospaced))
                    Spacer()
                    Button("Stop") { engine.stopAndTranscribe() }
                        .buttonStyle(.borderedProminent).tint(.red).controlSize(.small)
                }
                .padding(12).glassEffect(.regular.tint(.red))
            } else if engine.isTranscribing {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Transcribing...").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(12).glassEffect(.regular)
            } else {
                VStack(spacing: 10) {
                    Button { engine.startRecording() } label: {
                        Label("Record", systemImage: "mic.circle.fill").font(.title3)
                    }.buttonStyle(.borderedProminent).controlSize(.large)

                    Text(engine.mode.hint)
                        .font(.callout).foregroundStyle(.primary.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity).padding(14).glassEffect(.clear)
            }

            Text(engine.statusMessage)
                .font(.caption2).foregroundStyle(.secondary)
                .lineLimit(2).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Recent

    private var recentList: some View {
        Group {
            if engine.recentTranscriptions.isEmpty {
                VStack { Spacer()
                    Text("No recent transcriptions").font(.caption).foregroundStyle(.quaternary)
                    Spacer()
                }.frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(engine.recentTranscriptions.indices, id: \.self) { i in
                            TranscriptionRow(item: engine.recentTranscriptions[i])
                        }
                    }.padding(.horizontal, 16).padding(.vertical, 6)
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            SettingsLink { Image(systemName: "gear") }.buttonStyle(.borderless)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.borderless).foregroundStyle(.secondary)
        }
    }

    private func fmt(_ t: TimeInterval) -> String {
        String(format: "%d:%02d", Int(t) / 60, Int(t) % 60)
    }
}

struct TranscriptionRow: View {
    let item: TranscriptionResult
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(item.displayText).font(.caption).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text({ let s = Date().timeIntervalSince(item.timestamp)
                return s < 60 ? "now" : s < 3600 ? "\(Int(s/60))m" : "\(Int(s/3600))h"
            }()).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4).contentShape(Rectangle())
        .onTapGesture {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(item.displayText, forType: .string)
        }
    }
}
