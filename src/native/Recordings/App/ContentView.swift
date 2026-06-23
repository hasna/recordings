import SwiftUI
import RecordingsLib

/// Root layout: a narrow violet Liquid-Glass sidebar on the left, and ONE continuous canvas
/// on the right — a compact header line, then either the Record workspace (default) or the
/// recordings library (list | detail), separated only by hairline dividers. No boxed panels.
struct ContentView: View {
    @ObservedObject var store: RecordingsStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 0) {
            SidebarView(store: store)
                .frame(width: Theme.sidebarWidth)
                .background(Theme.sidebarGradient(colorScheme).ignoresSafeArea())

            VStack(spacing: 0) {
                HeaderBar(store: store)
                Divider().opacity(0.5)

                switch store.pane {
                case .record:
                    RecordWorkspaceView(store: store)
                case .library:
                    HSplitView {
                        RecordingsListView(store: store)
                            .frame(minWidth: 280, idealWidth: 340)
                        RecordingDetailView(store: store)
                            .frame(minWidth: 420)
                    }
                }
            }
            .background(Theme.canvas(colorScheme))
        }
        .frame(minWidth: 940, minHeight: 620)
        .ignoresSafeArea(.container, edges: .top)
        .onAppear { store.loadLibrary() }
    }
}

/// Compact header line: "12 recordings · Updated 3m ago" + storage/sync status + actions.
private struct HeaderBar: View {
    @ObservedObject var store: RecordingsStore

    var body: some View {
        HStack(spacing: 6) {
            Text("\(store.library.count) recording\(store.library.count == 1 ? "" : "s")")
            if let updated = store.lastUpdated {
                Text("·")
                Text("Updated \(updated.relativeDescription)")
            }
            Spacer()

            switch store.syncState {
            case .syncing:
                ProgressView().controlSize(.small)
            case .synced:
                Label("Synced", systemImage: "checkmark.icloud").labelStyle(.titleAndIcon)
            case .failed:
                Label("Sync failed", systemImage: "exclamationmark.icloud").foregroundStyle(.orange)
            case .idle:
                EmptyView()
            }

            Button { store.loadLibrary() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Refresh library")

            Button {
                store.pane = .record
            } label: {
                Image(systemName: "mic.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.accent)
            .help("New recording")
        }
        .font(.system(.subheadline, design: .rounded))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 18)
        .padding(.top, 20)
        .padding(.bottom, 10)
    }
}
