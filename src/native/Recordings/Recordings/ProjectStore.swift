import Foundation

struct RecProject: Codable, Identifiable, Sendable {
    let id: String
    var name: String
    var path: String?
    var systemPrompt: String?
    var appBundleIds: [String]?

    init(name: String, path: String? = nil, systemPrompt: String? = nil, appBundleIds: [String]? = nil) {
        self.id = UUID().uuidString
        self.name = name
        self.path = path
        self.systemPrompt = systemPrompt
        self.appBundleIds = appBundleIds
    }
}

struct ProjectSettings: Codable, Sendable {
    var globalSystemPrompt: String
    var projects: [RecProject]
    var activeProjectId: String?

    init() {
        globalSystemPrompt = ""
        projects = []
        activeProjectId = nil
    }
}

@MainActor
final class ProjectStore: ObservableObject {
    @Published var settings = ProjectSettings()

    private let filePath: String

    var activeProject: RecProject? {
        settings.projects.first { $0.id == settings.activeProjectId }
    }

    var effectiveSystemPrompt: String {
        let global = settings.globalSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let project = activeProject?.systemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if global.isEmpty && project.isEmpty { return "" }
        if global.isEmpty { return project }
        if project.isEmpty { return global }
        return "\(global)\n\n\(project)"
    }

    init() {
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

    func addProject(name: String, path: String? = nil, systemPrompt: String? = nil) {
        let project = RecProject(name: name, path: path, systemPrompt: systemPrompt)
        settings.projects.append(project)
        save()
    }

    func updateProject(_ project: RecProject) {
        guard let idx = settings.projects.firstIndex(where: { $0.id == project.id }) else { return }
        settings.projects[idx] = project
        save()
    }

    func removeProject(id: String) {
        settings.projects.removeAll { $0.id == id }
        if settings.activeProjectId == id { settings.activeProjectId = nil }
        save()
    }

    func setActive(_ id: String?) {
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
