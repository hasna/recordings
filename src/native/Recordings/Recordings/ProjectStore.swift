import Foundation
import Darwin

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

    static func detectProjectStatic(bundleId: String?, pid: pid_t?, projects: [RecProject]) -> RecProject? {
        if let bundleId {
            if let match = projects.first(where: { $0.appBundleIds?.contains(bundleId) == true }) {
                return match
            }
        }

        if let bundleId, isTerminalStatic(bundleId) {
            if let title = frontWindowTitleStatic(bundleId: bundleId) {
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
        }

        if let pid, let bundleId, isTerminalStatic(bundleId) {
            if let cwd = cwdViaProc(pid) ?? findShellChildCwd(of: pid), cwd != "/" {
                for project in projects {
                    guard let projectPath = project.path else { continue }
                    if cwd.hasPrefix(projectPath) { return project }
                }
            }
        }

        return nil
    }

    private static func frontWindowTitleStatic(bundleId: String) -> String? {
        let appName = bundleId.components(separatedBy: ".").last ?? ""
        let script = "tell application \"\(appName)\" to get name of front window"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if proc.isRunning { proc.terminate() }
            }
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private static func isTerminalStatic(_ bundleId: String) -> Bool {
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

    private static func findShellChildCwd(of parentPid: pid_t, depth: Int = 0) -> String? {
        guard depth < 4 else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        proc.arguments = ["-P", "\(parentPid)"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            let pids = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: "\n")
                .compactMap { pid_t($0) } ?? []
            for child in pids {
                if let cwd = cwdViaProc(child), cwd != "/" { return cwd }
                if let cwd = findShellChildCwd(of: child, depth: depth + 1) { return cwd }
            }
        } catch {}
        return nil
    }

    private static func cwdViaProc(_ pid: pid_t) -> String? {
        var vnodeInfo = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        let result = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnodeInfo, size)
        guard result > 0 else { return nil }
        return withUnsafePointer(to: vnodeInfo.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) {
                let s = String(cString: $0)
                return s.isEmpty ? nil : s
            }
        }
    }
}
