import Foundation
import SwiftUI
import Combine
import RecordingsLib

/// Which main pane the canvas shows.
enum Pane: Equatable {
    case record       // the recording workspace (default / first screen)
    case library      // browse past recordings
}

/// Sidebar filter selection for the library.
enum LibraryFilter: Hashable {
    case all
    case project(String)     // project id
    case noProject
    case mode(String)        // "raw" | "enhanced"
    case thisMachine
    case machine(String)
}

/// Cloud sync activity surfaced to the UI.
enum CloudSyncState: Equatable {
    case idle
    case syncing
    case synced(Date)
    case failed(String)
}

/// Observable application state for the full macOS app. Bridges the live `RecordingEngine`,
/// the `ProjectStore` / `VoiceShortcuts`, and the `recordings` CLI library/storage.
@MainActor
final class RecordingsStore: ObservableObject {
    let engine: RecordingEngine
    let projectStore: ProjectStore
    let voiceShortcuts: VoiceShortcuts

    @Published var pane: Pane = .record
    @Published var library: [Recording] = []
    @Published var selection: String?
    @Published var filter: LibraryFilter = .all
    @Published var searchText: String = ""
    @Published var isLoadingLibrary = false
    @Published var loadError: String?
    @Published var operationError: String?

    @Published var stats: RecordingStats?
    @Published var storage: StorageStatus?
    @Published var syncState: CloudSyncState = .idle

    let localMachineID: String
    private let home: String
    private var cancellables = Set<AnyCancellable>()

    init(engine: RecordingEngine = RecordingEngine(),
         projectStore: ProjectStore = ProjectStore(),
         voiceShortcuts: VoiceShortcuts = VoiceShortcuts()) {
        self.engine = engine
        self.projectStore = projectStore
        self.voiceShortcuts = voiceShortcuts
        self.home = FileManager.default.homeDirectoryForCurrentUser.path
        self.localMachineID = (Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
        engine.projectStore = projectStore
        engine.voiceShortcuts = voiceShortcuts

        // Re-publish the wrapped ObservableObjects so views that observe only this store
        // refresh on live recording changes (timer, live text) and project edits.
        engine.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)
        projectStore.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)
        voiceShortcuts.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    // MARK: - Derived collections

    var projects: [RecProject] { projectStore.settings.projects }

    var machines: [String] {
        Set(library.compactMap { $0.machineId }.filter { !$0.isEmpty })
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    var lastUpdated: Date? { library.compactMap(\.createdDate).max() }

    var visibleRecordings: [Recording] {
        library.filter { matchesFilter($0) && matchesSearch($0) }
    }

    private func matchesFilter(_ r: Recording) -> Bool {
        switch filter {
        case .all: return true
        case .project(let id): return r.projectId == id
        case .noProject: return r.projectId == nil
        case .mode(let m): return r.processingMode == m
        case .thisMachine: return r.machineId == localMachineID
        case .machine(let m): return r.machineId == m
        }
    }

    private func matchesSearch(_ r: Recording) -> Bool {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return true }
        if r.displayText.localizedCaseInsensitiveContains(q) { return true }
        if r.tags.contains(where: { $0.localizedCaseInsensitiveContains(q) }) { return true }
        return false
    }

    func count(for filter: LibraryFilter) -> Int {
        library.filter {
            switch filter {
            case .all: return true
            case .project(let id): return $0.projectId == id
            case .noProject: return $0.projectId == nil
            case .mode(let m): return $0.processingMode == m
            case .thisMachine: return $0.machineId == localMachineID
            case .machine(let m): return $0.machineId == m
            }
        }.count
    }

    var selectedRecording: Recording? {
        guard let id = selection else { return nil }
        return library.first { $0.id == id }
    }

    func projectName(_ id: String?) -> String? {
        guard let id else { return nil }
        return projects.first { $0.id == id }?.name
    }

    // MARK: - Library loading

    private var reloadRequestedDuringLoad = false

    func loadLibrary() {
        guard !isLoadingLibrary else { reloadRequestedDuringLoad = true; return }
        isLoadingLibrary = true
        let home = home
        Task.detached(priority: .userInitiated) {
            let result: Result<([Recording], RecordingStats?, StorageStatus?), Error>
            do {
                let recs = try RecordingsCLI.listAll(home: home)
                let stats = try? RecordingsCLI.stats(home: home)
                let storage = try? RecordingsCLI.storageStatus(home: home)
                result = .success((recs, stats, storage))
            } catch {
                result = .failure(error)
            }
            await MainActor.run {
                self.isLoadingLibrary = false
                switch result {
                case .success(let (recs, stats, storage)):
                    self.library = recs
                    self.stats = stats
                    self.storage = storage
                    self.loadError = nil
                    if self.selection == nil || !recs.contains(where: { $0.id == self.selection }) {
                        self.selection = self.visibleRecordings.first?.id
                    }
                case .failure(let error):
                    self.loadError = (error as? RecordingsCLI.Failure)?.message ?? error.localizedDescription
                }
                if self.reloadRequestedDuringLoad {
                    self.reloadRequestedDuringLoad = false
                    self.loadLibrary()
                }
            }
        }
    }

    func delete(id: String) {
        let home = home
        Task.detached(priority: .userInitiated) {
            let result: Result<Void, Error>
            do {
                try RecordingsCLI.delete(id: id, home: home)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await MainActor.run {
                switch result {
                case .success:
                    self.library.removeAll { $0.id == id }
                    if self.selection == id { self.selection = self.visibleRecordings.first?.id }
                case .failure(let error):
                    self.operationError = (error as? RecordingsCLI.Failure)?.message ?? error.localizedDescription
                }
            }
        }
    }

    // MARK: - Cloud sync

    func syncCloud() {
        guard syncState != .syncing else { return }
        syncState = .syncing
        let home = home
        Task.detached(priority: .utility) {
            let outcome: CloudSyncState
            do {
                _ = try RecordingsCLI.storageSync(home: home)
                outcome = .synced(Date())
            } catch {
                let msg = (error as? RecordingsCLI.Failure)?.message ?? error.localizedDescription
                outcome = .failed(msg)
            }
            await MainActor.run {
                self.syncState = outcome
                if case .synced = outcome { self.loadLibrary() }
            }
        }
    }
}
