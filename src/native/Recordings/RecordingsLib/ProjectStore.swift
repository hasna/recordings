import Foundation
import Darwin

public enum PostProcessingMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case off
    case auto
    case always

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .off: return "Raw"
        case .auto: return "Auto"
        case .always: return "Always"
        }
    }
}

public enum ProjectStoreError: Error, LocalizedError {
    case synchronizationInProgress
    case persistenceFailure(String)

    public var errorDescription: String? {
        switch self {
        case .synchronizationInProgress: return "Project synchronization is in progress"
        case .persistenceFailure(let message): return message
        }
    }
}

public struct RecProject: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    var path: String?
    var systemPrompt: String?
    var appBundleIds: [String]?
    var canonicalPath: String?
    var color: String?

    public init(
        id: String = UUID().uuidString,
        name: String,
        path: String? = nil,
        systemPrompt: String? = nil,
        appBundleIds: [String]? = nil,
        canonicalPath: String? = nil,
        color: String? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.systemPrompt = systemPrompt
        self.appBundleIds = appBundleIds
        self.canonicalPath = canonicalPath
        self.color = color
    }

    var registrationPath: String {
        let stored = canonicalPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !stored.isEmpty { return stored }
        let configured = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !configured.isEmpty { return configured }
        return "recordings-app://projects/\(id)"
    }
}

public struct ProjectSettings: Codable, Sendable {
    public var globalSystemPrompt: String
    public var postProcessingMode: String
    public var projects: [RecProject]
    public var activeProjectId: String?

    public init() {
        globalSystemPrompt = ""
        postProcessingMode = PostProcessingMode.auto.rawValue
        projects = []
        activeProjectId = nil
    }

    enum CodingKeys: String, CodingKey {
        case globalSystemPrompt
        case postProcessingMode
        case projects
        case activeProjectId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        globalSystemPrompt = try container.decodeIfPresent(String.self, forKey: .globalSystemPrompt) ?? ""
        postProcessingMode = try container.decodeIfPresent(String.self, forKey: .postProcessingMode) ?? PostProcessingMode.auto.rawValue
        projects = try container.decodeIfPresent([RecProject].self, forKey: .projects) ?? []
        activeProjectId = try container.decodeIfPresent(String.self, forKey: .activeProjectId)
    }
}

@MainActor
public final class ProjectStore: ObservableObject {
    typealias SettingsDataLoader = (String) throws -> Data?

    @Published public var settings = ProjectSettings()
    @Published public private(set) var isReadyForRecording = false
    @Published public private(set) var isSynchronizingProjects = false
    @Published public private(set) var persistenceError: String?

    private let filePath: String
    private let dataLoader: SettingsDataLoader
    private var loadSucceeded = true
    private var loadFailureMessage: String?
    private var persistedData: Data?

    public var canMutateProjects: Bool {
        loadSucceeded && !isSynchronizingProjects
    }

    public var activeProject: RecProject? {
        settings.projects.first { $0.id == settings.activeProjectId }
    }

    public var effectiveSystemPrompt: String {
        let global = settings.globalSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let project = activeProject?.systemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if global.isEmpty && project.isEmpty { return "" }
        if global.isEmpty { return project }
        if project.isEmpty { return global }
        return "\(global)\n\n\(project)"
    }

    public var effectivePostProcessingMode: String {
        let mode = PostProcessingMode(rawValue: settings.postProcessingMode) ?? .auto
        return mode.rawValue
    }

    public convenience init(filePath: String? = nil) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.init(
            filePath: filePath ?? "\(home)/.hasna/recordings/projects.json",
            dataLoader: Self.readSettingsData
        )
    }

    init(filePath: String, dataLoader: @escaping SettingsDataLoader) {
        self.filePath = filePath
        self.dataLoader = dataLoader
        let loaded = load()
        loadSucceeded = loaded
        isReadyForRecording = loaded && settings.projects.isEmpty
    }

    nonisolated private static func readSettingsData(atPath path: String) throws -> Data? {
        do {
            return try Data(contentsOf: URL(fileURLWithPath: path))
        } catch {
            let cocoaError = error as NSError
            if cocoaError.domain == NSCocoaErrorDomain,
               cocoaError.code == NSFileReadNoSuchFileError || cocoaError.code == NSFileNoSuchFileError {
                return nil
            }
            throw error
        }
    }

    @discardableResult
    func load() -> Bool {
        do {
            guard let data = try dataLoader(filePath) else {
                persistedData = nil
                loadFailureMessage = nil
                persistenceError = nil
                return true
            }
            settings = try JSONDecoder().decode(ProjectSettings.self, from: data)
            persistedData = data
            loadFailureMessage = nil
            persistenceError = nil
            return true
        } catch {
            let message = "Failed to load projects: \(error.localizedDescription)"
            blockMutations(message: message)
            return false
        }
    }

    public func save() throws {
        try requireWritableState()
        try persistSettings()
    }

    private func requireWritableState() throws {
        guard loadSucceeded else {
            throw ProjectStoreError.persistenceFailure(loadFailureMessage ?? "Failed to load projects")
        }
        guard !isSynchronizingProjects else { throw ProjectStoreError.synchronizationInProgress }
        try validatePersistedData()
    }

    private func validatePersistedData() throws {
        guard loadSucceeded else {
            throw ProjectStoreError.persistenceFailure(loadFailureMessage ?? "Failed to load projects")
        }
        do {
            guard try dataLoader(filePath) == persistedData else {
                let message = "Project settings changed on disk. Restart Recordings before making changes."
                blockMutations(message: message)
                throw ProjectStoreError.persistenceFailure(message)
            }
        } catch let error as ProjectStoreError {
            throw error
        } catch {
            let message = "Failed to read projects before saving: \(error.localizedDescription)"
            blockMutations(message: message)
            throw ProjectStoreError.persistenceFailure(message)
        }
    }

    private func blockMutations(message: String) {
        loadSucceeded = false
        isReadyForRecording = false
        loadFailureMessage = message
        persistenceError = message
    }

    private func persistSettings() throws {
        do {
            let data = try JSONEncoder().encode(settings)
            let dir = (filePath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try withExclusivePersistenceLock {
                try validatePersistedData()
                try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
                persistedData = data
            }
            persistenceError = nil
        } catch {
            if error is ProjectStoreError { throw error }
            persistenceError = "Failed to save projects: \(error.localizedDescription)"
            throw error
        }
    }

    private func withExclusivePersistenceLock<T>(_ operation: () throws -> T) throws -> T {
        let lockPath = "\(filePath).lock"
        let descriptor = Darwin.open(lockPath, O_CREAT | O_RDWR, mode_t(S_IRUSR | S_IWUSR))
        guard descriptor >= 0 else { throw posixError() }
        defer { Darwin.close(descriptor) }
        guard Darwin.lockf(descriptor, F_LOCK, 0) == 0 else { throw posixError() }
        defer { Darwin.lockf(descriptor, F_ULOCK, 0) }
        return try operation()
    }

    private func posixError() -> NSError {
        let code = errno
        return NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(code),
            userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(code))]
        )
    }

    public func clearPersistenceError() {
        persistenceError = nil
    }

    public func reconcileWithCanonicalStore(home: String = RecordingsCLI.defaultHome) async throws {
        try requireWritableState()
        isSynchronizingProjects = true
        defer { isSynchronizingProjects = false }
        let original = settings
        guard !original.projects.isEmpty else {
            isReadyForRecording = true
            return
        }
        isReadyForRecording = false
        let registrations: [(String, RecordingsCLI.CanonicalProject)]
        do {
            registrations = try await Task.detached(priority: .utility) {
                try original.projects.map { project in
                    let canonical = try RecordingsCLI.registerProject(
                        name: project.name,
                        path: project.registrationPath,
                        home: home
                    )
                    return (project.id, canonical)
                }
            }.value
        } catch {
            persistenceError = "Failed to register projects: \((error as? RecordingsCLI.Failure)?.message ?? error.localizedDescription)"
            throw error
        }
        var migrated = original
        var canonicalIDByLocalID: [String: String] = [:]
        var seenCanonicalIDs = Set<String>()
        migrated.projects = zip(original.projects, registrations).compactMap { pair -> RecProject? in
            let (project, registration) = pair
            let canonical = registration.1
            if canonicalIDByLocalID[project.id] == nil {
                canonicalIDByLocalID[project.id] = canonical.id
            }
            guard seenCanonicalIDs.insert(canonical.id).inserted else { return nil }
            return RecProject(
                id: canonical.id,
                name: project.name,
                path: project.path,
                systemPrompt: project.systemPrompt,
                appBundleIds: project.appBundleIds,
                canonicalPath: canonical.path,
                color: project.color
            )
        }
        if let active = original.activeProjectId {
            migrated.activeProjectId = canonicalIDByLocalID[active]
        }
        settings = migrated
        do {
            try persistSettings()
            isReadyForRecording = true
        } catch {
            settings = original
            throw error
        }
    }

    public func addProject(name: String, path: String? = nil, systemPrompt: String? = nil, color: String? = nil, home: String = RecordingsCLI.defaultHome) async throws {
        try requireWritableState()
        isSynchronizingProjects = true
        defer { isSynchronizingProjects = false }
        let local = RecProject(name: name, path: path, systemPrompt: systemPrompt, color: color)
        let canonical: RecordingsCLI.CanonicalProject
        do {
            canonical = try await Task.detached(priority: .userInitiated) {
                try RecordingsCLI.registerProject(name: local.name, path: local.registrationPath, home: home)
            }.value
        } catch {
            persistenceError = "Failed to register project: \((error as? RecordingsCLI.Failure)?.message ?? error.localizedDescription)"
            throw error
        }
        let project = RecProject(
            id: canonical.id,
            name: local.name,
            path: local.path,
            systemPrompt: local.systemPrompt,
            appBundleIds: local.appBundleIds,
            canonicalPath: canonical.path,
            color: local.color
        )
        let original = settings
        settings.projects.append(project)
        do { try persistSettings() } catch { settings = original; throw error }
        isReadyForRecording = true
    }

    public func updateProject(_ project: RecProject) throws {
        try requireWritableState()
        guard let idx = settings.projects.firstIndex(where: { $0.id == project.id }) else { return }
        let original = settings
        settings.projects[idx] = project
        do { try save() } catch { settings = original; throw error }
    }

    public func removeProject(id: String) throws {
        try requireWritableState()
        let original = settings
        settings.projects.removeAll { $0.id == id }
        if settings.activeProjectId == id { settings.activeProjectId = nil }
        do { try save() } catch { settings = original; throw error }
    }

    public func setActive(_ id: String?) throws {
        try requireWritableState()
        let original = settings
        settings.activeProjectId = id
        do { try save() } catch { settings = original; throw error }
    }

    // MARK: - Auto-detection

    nonisolated static func matchProject(windowTitle: String?, bundleId: String?, projects: [RecProject]) -> RecProject? {
        if let bundleId {
            if let match = projects.first(where: { $0.appBundleIds?.contains(bundleId) == true }) {
                return match
            }
        }

        if let title = windowTitle {
            let lower = title.lowercased()
            for project in projects {
                let name = project.name.lowercased()
                if lower.contains(name) { return project }
                let slug = name.replacingOccurrences(of: " ", with: "-")
                if lower.contains(slug) { return project }
                if let path = project.path {
                    let dirName = (path as NSString).lastPathComponent.lowercased()
                    if lower.contains(dirName) { return project }
                }
            }
        }

        return nil
    }

}
