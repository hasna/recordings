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

    func detectProject(bundleId: String?, pid: pid_t?) -> RecProject? {
        if let bundleId {
            if let match = settings.projects.first(where: { $0.appBundleIds?.contains(bundleId) == true }) {
                return match
            }
        }

        if let pid, let cwd = workingDirectory(for: pid, bundleId: bundleId) {
            for project in settings.projects {
                guard let projectPath = project.path else { continue }
                if cwd.hasPrefix(projectPath) { return project }
            }
        }

        return nil
    }

    private func workingDirectory(for pid: pid_t, bundleId: String?) -> String? {
        guard let bundleId, isTerminal(bundleId) else { return nil }
        let childPid = frontmostChildPid(of: pid) ?? pid
        return cwdOfProcess(childPid)
    }

    private func isTerminal(_ bundleId: String) -> Bool {
        let terminals: Set<String> = [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.mitchellh.ghostty",
            "dev.warp.Warp-Stable",
            "co.zeit.hyper",
            "com.github.wez.wezterm",
            "io.alacritty",
            "net.kovidgoyal.kitty",
        ]
        return terminals.contains(bundleId)
    }

    private func frontmostChildPid(of parentPid: pid_t) -> pid_t? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", "pgrep -P \(parentPid) | tail -1"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let str = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return pid_t(str)
        } catch {
            return nil
        }
    }

    private func cwdOfProcess(_ pid: pid_t) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-p", "\(pid)", "-Fn", "-d", "cwd"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            for line in output.components(separatedBy: "\n") where line.hasPrefix("n/") {
                return String(line.dropFirst())
            }
        } catch {}
        return nil
    }
}
