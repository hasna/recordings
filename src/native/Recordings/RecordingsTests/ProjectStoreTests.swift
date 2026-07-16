import Foundation
import Testing
@testable import RecordingsLib

struct ProjectStoreTests {
    private struct SyntheticReadError: LocalizedError {
        var errorDescription: String? { "synthetic read failure" }
    }

    @Test("legacy project color survives settings decode and encode")
    func legacyProjectColorRoundTrip() throws {
        let input = Data(##"{"globalSystemPrompt":"Global","postProcessingMode":"always","activeProjectId":"legacy-id","projects":[{"id":"legacy-id","name":"Legacy","path":"/tmp/legacy","systemPrompt":"Keep bullets","appBundleIds":["com.example.app"],"canonicalPath":"recordings-app://projects/legacy-id","color":"#12AB34"}]}"##.utf8)

        let settings = try JSONDecoder().decode(ProjectSettings.self, from: input)
        let encoded = try JSONEncoder().encode(settings)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let projects = try #require(object["projects"] as? [[String: Any]])
        let project = try #require(projects.first)

        #expect(project["color"] as? String == "#12AB34")
        #expect(project["path"] as? String == "/tmp/legacy")
        #expect(project["systemPrompt"] as? String == "Keep bullets")
        #expect((project["appBundleIds"] as? [String]) == ["com.example.app"])
        #expect(object["postProcessingMode"] as? String == "always")
    }

    @Test("legacy app projects migrate to canonical Store ids without losing metadata")
    @MainActor
    func migratesProjectsToCanonicalStore() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        let script = """
        #!/bin/sh
        printf '%s' '{"id":"canonical-id","name":"Legacy","path":"recordings-app://projects/legacy-id"}'
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let store = ProjectStore(filePath: root.appendingPathComponent("projects.json").path)
        store.settings.projects = [
            RecProject(
                id: "legacy-id",
                name: "Legacy",
                path: nil,
                systemPrompt: "Keep bullets",
                appBundleIds: ["com.example.app"],
                color: "#12AB34"
            )
        ]
        store.settings.activeProjectId = "legacy-id"
        try store.save()

        try await store.reconcileWithCanonicalStore(home: root.path)

        let migrated = try #require(store.settings.projects.first)
        #expect(migrated.id == "canonical-id")
        #expect(migrated.name == "Legacy")
        #expect(migrated.path == nil)
        #expect(migrated.systemPrompt == "Keep bullets")
        #expect(migrated.appBundleIds == ["com.example.app"])
        #expect(migrated.canonicalPath == "recordings-app://projects/legacy-id")
        #expect(migrated.color == "#12AB34")
        #expect(store.settings.activeProjectId == "canonical-id")
        #expect(store.isReadyForRecording)

        var edited = migrated
        edited.name = "Edited Legacy"
        try store.updateProject(edited)
        let persisted = try JSONDecoder().decode(
            ProjectSettings.self,
            from: Data(contentsOf: root.appendingPathComponent("projects.json"))
        )
        #expect(persisted.projects.first?.name == "Edited Legacy")
        #expect(persisted.projects.first?.color == "#12AB34")
    }

    @Test("duplicate legacy project ids reconcile without crashing or duplicating canonical rows")
    @MainActor
    func duplicateProjectIDsAreDeduplicated() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        let script = """
        #!/bin/sh
        printf '%s' '{"id":"canonical-id","name":"Legacy","path":"recordings-app://projects/duplicate-id"}'
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let store = ProjectStore(filePath: root.appendingPathComponent("projects.json").path)
        store.settings.projects = [
            RecProject(id: "duplicate-id", name: "First"),
            RecProject(id: "duplicate-id", name: "Second"),
        ]
        store.settings.activeProjectId = "duplicate-id"
        try store.save()

        try await store.reconcileWithCanonicalStore(home: root.path)

        #expect(store.settings.projects.count == 1)
        #expect(store.settings.projects.first?.id == "canonical-id")
        #expect(store.settings.activeProjectId == "canonical-id")
    }

    @Test("failed canonical registration preserves recording metadata and can be retried")
    @MainActor
    func failedRegistrationDoesNotDisableCaptureForAppLifetime() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        let failureScript = """
        #!/bin/sh
        echo 'ERROR: synthetic registration failure' >&2
        exit 1
        """
        try failureScript.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let store = ProjectStore(filePath: root.appendingPathComponent("projects.json").path)
        store.settings.projects = [
            RecProject(id: "local-id", name: "Active Local", systemPrompt: "Keep this context")
        ]
        store.settings.activeProjectId = "local-id"
        try store.save()

        await #expect(throws: (any Error).self) {
            try await store.reconcileWithCanonicalStore(home: root.path)
        }
        #expect(!store.isReadyForRecording)
        #expect(store.synchronizationError?.contains("synthetic registration failure") == true)
        #expect(store.persistenceError?.contains("synthetic registration failure") == true)
        #expect(store.activeProject?.id == "local-id")
        #expect(store.activeCanonicalProjectIdForRecording == nil)
        #expect(store.effectiveSystemPrompt == "Keep this context")
        #expect(RecordingEngine.canBeginRecording(isRecording: false, isTranscribing: false))

        let successScript = """
        #!/bin/sh
        printf '%s' '{"id":"canonical-id","name":"Active Local","path":"recordings-app://projects/local-id"}'
        """
        try successScript.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        try await store.reconcileWithCanonicalStore(home: root.path)
        #expect(store.isReadyForRecording)
        #expect(store.synchronizationError == nil)
        #expect(store.persistenceError == nil)
        #expect(store.activeProject?.id == "canonical-id")
        #expect(store.activeCanonicalProjectIdForRecording == "canonical-id")
        #expect(store.effectiveSystemPrompt == "Keep this context")
    }

    @Test("persisted canonical project remains safe during startup reconciliation")
    @MainActor
    func canonicalProjectIdSurvivesStartupDegradedState() throws {
        var settings = ProjectSettings()
        settings.projects = [
            RecProject(
                id: "canonical-id",
                name: "Canonical",
                canonicalPath: "recordings-app://projects/local-id",
                canonicalStoreId: "canonical-id"
            )
        ]
        settings.activeProjectId = "canonical-id"
        let data = try JSONEncoder().encode(settings)
        let store = ProjectStore(filePath: "/tmp/projects.json") { _ in data }

        #expect(!store.isReadyForRecording)
        #expect(store.activeCanonicalProjectIdForRecording == "canonical-id")
    }

    @Test("adding a project preserves color in canonical local metadata")
    @MainActor
    func addProjectPreservesColor() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        let script = """
        #!/bin/sh
        printf '%s' '{"id":"canonical-added","name":"Added","path":"recordings-app://projects/added"}'
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let file = root.appendingPathComponent("projects.json")
        let store = ProjectStore(filePath: file.path)
        try await store.addProject(name: "Added", color: "#AABBCC", home: root.path)

        #expect(store.settings.projects.first?.id == "canonical-added")
        #expect(store.settings.projects.first?.color == "#AABBCC")
        let persisted = try JSONDecoder().decode(ProjectSettings.self, from: Data(contentsOf: file))
        #expect(persisted.projects.first?.color == "#AABBCC")
    }

    @Test("project persistence failures remain visible to the UI")
    @MainActor
    func reportsPersistenceFailure() throws {
        // An unwritable path fails at load, so the surfaced message is the load failure —
        // what matters to the UI contract is that a failed save leaves a visible error.
        let store = ProjectStore(filePath: "/dev/null/projects.json")
        store.settings.projects = [RecProject(name: "Cannot Save")]

        #expect(throws: (any Error).self) {
            try store.save()
        }
        let persistenceError = try #require(store.persistenceError)
        #expect(persistenceError.contains("projects"))
    }

    @Test("project mutations are rejected while canonical reconciliation is in flight")
    @MainActor
    func serializesReconciliationAndMutations() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent(".bun/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let executable = bin.appendingPathComponent("recordings")
        let script = """
        #!/bin/sh
        root="$(cd "$(dirname "$0")/../.." && pwd)"
        touch "$root/started"
        while [ ! -f "$root/release" ]; do sleep 0.01; done
        printf '%s' '{"id":"canonical-id","name":"Legacy","path":"recordings-app://projects/legacy-id"}'
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let store = ProjectStore(filePath: root.appendingPathComponent("projects.json").path)
        store.settings.projects = [RecProject(id: "legacy-id", name: "Legacy")]
        try store.save()
        let reconciliation = Task { try await store.reconcileWithCanonicalStore(home: root.path) }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: root.appendingPathComponent("started").path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.isSynchronizingProjects)
        var edited = try #require(store.settings.projects.first)
        edited.name = "Must Not Be Lost"
        #expect(throws: ProjectStoreError.self) {
            try store.updateProject(edited)
        }
        try Data().write(to: root.appendingPathComponent("release"))
        try await reconciliation.value
        #expect(store.settings.projects.first?.name == "Legacy")
        #expect(!store.isSynchronizingProjects)
    }

    @Test("project decode failures are visible and prevent readiness")
    @MainActor
    func reportsLoadFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("projects.json")
        try Data("not-json".utf8).write(to: file)

        let store = ProjectStore(filePath: file.path)

        #expect(store.persistenceError?.contains("Failed to load projects") == true)
        #expect(!store.isReadyForRecording)
        #expect(!store.canMutateProjects)
        #expect(throws: ProjectStoreError.self) {
            try store.save()
        }
        await #expect(throws: ProjectStoreError.self) {
            try await store.reconcileWithCanonicalStore(home: root.path)
        }
        #expect(try Data(contentsOf: file) == Data("not-json".utf8))
    }

    @Test("unreadable project data blocks every mutation without overwriting the file")
    @MainActor
    func unreadableDataBlocksMutations() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("projects.json")
        let sentinel = Data("existing-project-data".utf8)
        try sentinel.write(to: file)

        let store = ProjectStore(filePath: file.path) { _ in
            throw SyntheticReadError()
        }
        store.settings.projects = [RecProject(id: "existing", name: "Existing")]

        #expect(store.persistenceError?.contains("synthetic read failure") == true)
        #expect(!store.isReadyForRecording)
        #expect(!store.canMutateProjects)
        #expect(throws: ProjectStoreError.self) { try store.save() }
        #expect(throws: ProjectStoreError.self) {
            try store.updateProject(RecProject(id: "existing", name: "Changed"))
        }
        #expect(throws: ProjectStoreError.self) { try store.removeProject(id: "existing") }
        #expect(throws: ProjectStoreError.self) { try store.setActive("existing") }
        await #expect(throws: ProjectStoreError.self) {
            try await store.addProject(name: "Added", home: root.path)
        }
        #expect(try Data(contentsOf: file) == sentinel)
    }

    @Test("a project file that becomes unreadable after launch is never overwritten")
    @MainActor
    func postLaunchReadFailureBlocksMutations() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("projects.json")
        let initial = try JSONEncoder().encode(ProjectSettings())
        try initial.write(to: file)
        var readError: SyntheticReadError?
        let store = ProjectStore(filePath: file.path) { path in
            if let readError { throw readError }
            return try Data(contentsOf: URL(fileURLWithPath: path))
        }

        readError = SyntheticReadError()
        store.settings.globalSystemPrompt = "Must not be persisted"

        #expect(throws: ProjectStoreError.self) { try store.save() }
        #expect(!store.canMutateProjects)
        #expect(store.persistenceError?.contains("synthetic read failure") == true)
        #expect(try Data(contentsOf: file) == initial)
    }

    @Test("external project file changes are never replaced by stale in-memory settings")
    @MainActor
    func externalChangeBlocksMutations() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("projects.json")
        try JSONEncoder().encode(ProjectSettings()).write(to: file)
        let store = ProjectStore(filePath: file.path)
        let external = Data("externally-replaced-data".utf8)
        try external.write(to: file)

        store.settings.globalSystemPrompt = "Must not replace external data"

        #expect(throws: ProjectStoreError.self) { try store.save() }
        #expect(!store.canMutateProjects)
        #expect(store.persistenceError?.contains("changed on disk") == true)
        #expect(try Data(contentsOf: file) == external)
    }

    @Test("a stale app instance cannot overwrite a newer project save")
    @MainActor
    func staleStoreCannotOverwriteNewerSave() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("projects.json")
        try JSONEncoder().encode(ProjectSettings()).write(to: file)
        let first = ProjectStore(filePath: file.path)
        let stale = ProjectStore(filePath: file.path)

        first.settings.globalSystemPrompt = "newer value"
        try first.save()
        let newerData = try Data(contentsOf: file)
        stale.settings.globalSystemPrompt = "stale value"

        #expect(throws: ProjectStoreError.self) { try stale.save() }
        #expect(!stale.canMutateProjects)
        #expect(try Data(contentsOf: file) == newerData)
        let persisted = try JSONDecoder().decode(ProjectSettings.self, from: newerData)
        #expect(persisted.globalSystemPrompt == "newer value")
    }

    @Test("absent project data remains a writable empty store")
    @MainActor
    func absentDataIsWritable() {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("projects.json")
        let store = ProjectStore(filePath: file.path) { _ in nil }

        #expect(store.persistenceError == nil)
        #expect(store.isReadyForRecording)
        #expect(store.canMutateProjects)
    }

    @Test("matchProject by bundle ID")
    func matchByBundleId() {
        let projects = [
            RecProject(name: "MyApp", appBundleIds: ["com.example.myapp"]),
            RecProject(name: "Other", appBundleIds: ["com.example.other"]),
        ]
        let result = ProjectStore.matchProject(windowTitle: nil, bundleId: "com.example.myapp", projects: projects)
        #expect(result?.name == "MyApp")
    }

    @Test("matchProject by window title containing project name")
    func matchByWindowTitle() {
        let projects = [
            RecProject(name: "Hasna", path: nil),
            RecProject(name: "Other", path: nil),
        ]
        let result = ProjectStore.matchProject(windowTitle: "Hasna — Takumi", bundleId: nil, projects: projects)
        #expect(result?.name == "Hasna")
    }

    @Test("matchProject by path component in window title")
    func matchByPathComponent() {
        let projects = [
            RecProject(name: "Backend API", path: "/projects/backend-api"),
            RecProject(name: "Other", path: nil),
        ]
        let result = ProjectStore.matchProject(windowTitle: "backend-api — VSCode", bundleId: nil, projects: projects)
        #expect(result?.name == "Backend API")
    }

    @Test("matchProject returns nil when no match")
    func noMatch() {
        let projects = [
            RecProject(name: "ProjectA", appBundleIds: ["com.a"]),
        ]
        let result = ProjectStore.matchProject(windowTitle: "ProjectB", bundleId: "com.b", projects: projects)
        #expect(result == nil)
    }

    @Test("matchProject returns nil for empty projects")
    func emptyProjects() {
        let result = ProjectStore.matchProject(windowTitle: "Anything", bundleId: "com.any", projects: [])
        #expect(result == nil)
    }

    @Test("matchProject is case-insensitive")
    func caseInsensitive() {
        let projects = [
            RecProject(name: "myapp", path: nil),
        ]
        let result = ProjectStore.matchProject(windowTitle: "MyApp - Editor", bundleId: nil, projects: projects)
        #expect(result?.name == "myapp")
    }
}
