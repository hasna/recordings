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
    public let id: String
    public var name: String
    var path: String?
    var systemPrompt: String?
    var appBundleIds: [String]?

    public init(name: String, path: String? = nil, systemPrompt: String? = nil, appBundleIds: [String]? = nil) {
        self.id = UUID().uuidString
        self.name = name
        self.path = path
        self.systemPrompt = systemPrompt
        self.appBundleIds = appBundleIds
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

    public init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        filePath = "\(home)/.hasna/recordings/projects.json"
        load()
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

    func save() {
        do {
            let data = try JSONEncoder().encode(settings)
            let dir = (filePath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: filePath))
        } catch {
            fputs("[ProjectStore] Failed to save: \(error)\n", stderr)
        }
    }

    public func addProject(name: String, path: String? = nil, systemPrompt: String? = nil) {
        let project = RecProject(name: name, path: path, systemPrompt: systemPrompt)
        settings.projects.append(project)
        save()
    }

    public func updateProject(_ project: RecProject) {
        guard let idx = settings.projects.firstIndex(where: { $0.id == project.id }) else { return }
        settings.projects[idx] = project
        save()
    }

    public func removeProject(id: String) {
        settings.projects.removeAll { $0.id == id }
        if settings.activeProjectId == id { settings.activeProjectId = nil }
        save()
    }

    public func setActive(_ id: String?) {
        settings.activeProjectId = id
        save()
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
