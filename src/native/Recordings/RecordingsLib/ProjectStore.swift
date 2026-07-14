import Foundation

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

public struct RecProject: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    var path: String?
    var systemPrompt: String?
    var appBundleIds: [String]?
    var canonicalPath: String?

    public init(
        id: String = UUID().uuidString,
        name: String,
        path: String? = nil,
        systemPrompt: String? = nil,
        appBundleIds: [String]? = nil,
        canonicalPath: String? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.systemPrompt = systemPrompt
        self.appBundleIds = appBundleIds
        self.canonicalPath = canonicalPath
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
    @Published public var settings = ProjectSettings()
    @Published public private(set) var isReadyForRecording = false
    @Published public private(set) var persistenceError: String?

    private let filePath: String

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

    public init(filePath: String? = nil) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.filePath = filePath ?? "\(home)/.hasna/recordings/projects.json"
        load()
        isReadyForRecording = settings.projects.isEmpty
    }

    func load() {
        guard FileManager.default.fileExists(atPath: filePath),
              let data = FileManager.default.contents(atPath: filePath) else { return }
        do {
            settings = try JSONDecoder().decode(ProjectSettings.self, from: data)
        } catch {
            fputs("[ProjectStore] Failed to load: \(error)\n", stderr)
        }
    }

    public func save() throws {
        do {
            let data = try JSONEncoder().encode(settings)
            let dir = (filePath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
            persistenceError = nil
        } catch {
            persistenceError = "Failed to save projects: \(error.localizedDescription)"
            throw error
        }
    }

    public func clearPersistenceError() {
        persistenceError = nil
    }

    public func reconcileWithCanonicalStore(home: String = RecordingsCLI.defaultHome) async throws {
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
        let canonicalByLocalID = Dictionary(uniqueKeysWithValues: registrations)
        var migrated = original
        migrated.projects = original.projects.map { project in
            guard let canonical = canonicalByLocalID[project.id] else { return project }
            return RecProject(
                id: canonical.id,
                name: project.name,
                path: project.path,
                systemPrompt: project.systemPrompt,
                appBundleIds: project.appBundleIds,
                canonicalPath: canonical.path
            )
        }
        if let active = original.activeProjectId {
            migrated.activeProjectId = canonicalByLocalID[active]?.id
        }
        settings = migrated
        do {
            try save()
            isReadyForRecording = true
        } catch {
            settings = original
            throw error
        }
    }

    public func addProject(name: String, path: String? = nil, systemPrompt: String? = nil, home: String = RecordingsCLI.defaultHome) async throws {
        let local = RecProject(name: name, path: path, systemPrompt: systemPrompt)
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
            canonicalPath: canonical.path
        )
        let original = settings
        settings.projects.append(project)
        do { try save() } catch { settings = original; throw error }
        isReadyForRecording = true
    }

    public func updateProject(_ project: RecProject) throws {
        guard let idx = settings.projects.firstIndex(where: { $0.id == project.id }) else { return }
        let original = settings
        settings.projects[idx] = project
        do { try save() } catch { settings = original; throw error }
    }

    public func removeProject(id: String) throws {
        let original = settings
        settings.projects.removeAll { $0.id == id }
        if settings.activeProjectId == id { settings.activeProjectId = nil }
        do { try save() } catch { settings = original; throw error }
    }

    public func setActive(_ id: String?) throws {
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
