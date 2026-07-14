import SwiftUI
import AVFoundation
import RecordingsLib

/// Detail pane for a selected recording: the full transcript on the white canvas, a slim
/// action toolbar (copy / paste / play / delete), and a metadata strip. No boxed panels.
struct RecordingDetailView: View {
    @ObservedObject var store: RecordingsStore
    @State private var player: AVAudioPlayer?
    @State private var isPlaying = false
    @State private var copied = false

    var body: some View {
        if let rec = store.selectedRecording {
            detail(rec)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "waveform.and.mic").font(.system(size: 40)).foregroundStyle(.quaternary)
                Text("Select a recording").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func detail(_ rec: Recording) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(rec.createdDate.map { dateLabel($0) } ?? "Recording")
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                Spacer()
                toolbar(rec)
            }
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
            Divider().opacity(0.4)

            ScrollView {
                Text(rec.displayText.isEmpty ? "No transcript" : rec.displayText)
                    .font(.system(.title3, design: .rounded))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.top, 14)

                if rec.isEnhanced, !rec.rawText.isEmpty, rec.rawText != rec.displayText {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("RAW TRANSCRIPT").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Text(rec.rawText).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 18).padding(.top, 18)
                }
            }

            Divider().opacity(0.4)
            metadata(rec).padding(.horizontal, 18).padding(.vertical, 10)
        }
        .onChange(of: store.selection) { _, _ in stopPlayback() }
        .onDisappear { stopPlayback() }
    }

    private func toolbar(_ rec: Recording) -> some View {
        HStack(spacing: 4) {
            if hasAudio(rec) {
                iconButton(isPlaying ? "stop.circle" : "play.circle", help: isPlaying ? "Stop" : "Play audio") {
                    togglePlayback(rec)
                }
            }
            iconButton(copied ? "checkmark" : "doc.on.doc", help: "Copy transcript") {
                let pb = NSPasteboard.general
                pb.clearContents(); pb.setString(rec.displayText, forType: .string)
                withAnimation { copied = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { withAnimation { copied = false } }
            }
            iconButton("arrow.up.right.square", help: "Paste into front app") {
                store.engine.pasteIntoFrontApp(rec.displayText)
            }
            iconButton("trash", help: "Delete") { store.delete(id: rec.id) }
        }
        .foregroundStyle(.secondary)
    }

    private func iconButton(_ name: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: name).frame(width: 24, height: 24) }
            .buttonStyle(.plain).help(help)
    }

    private func metadata(_ rec: Recording) -> some View {
        HStack(spacing: 14) {
            if rec.durationMs > 0 { metaItem("clock", rec.durationLabel) }
            if let model = rec.modelUsed { metaItem("cpu", model) }
            if let lang = rec.language, !lang.isEmpty { metaItem("globe", lang) }
            if let name = store.projectName(rec.projectId) { metaItem("folder", name) }
            if let machine = rec.machineId, !machine.isEmpty { metaItem("desktopcomputer", machine) }
            if !rec.tags.isEmpty { metaItem("number", rec.tags.joined(separator: ", ")) }
            Spacer()
        }
        .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
    }

    private func metaItem(_ icon: String, _ text: String) -> some View {
        Label(text, systemImage: icon).labelStyle(.titleAndIcon)
    }

    private func dateLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .medium; f.timeStyle = .short
        return f.string(from: date)
    }

    // MARK: - Audio playback

    private func hasAudio(_ rec: Recording) -> Bool {
        guard let path = rec.audioPath, !path.isEmpty else { return false }
        return FileManager.default.fileExists(atPath: path)
    }

    private func togglePlayback(_ rec: Recording) {
        if isPlaying { stopPlayback(); return }
        guard let path = rec.audioPath else { return }
        do {
            let p = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
            p.play()
            player = p
            isPlaying = true
            // Reset the button when playback ends.
            DispatchQueue.main.asyncAfter(deadline: .now() + p.duration + 0.1) {
                if player === p { stopPlayback() }
            }
        } catch {
            isPlaying = false
        }
    }

    private func stopPlayback() {
        player?.stop()
        player = nil
        isPlaying = false
    }
}
