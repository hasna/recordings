import Foundation
import Testing
@testable import RecordingsLib

struct ProjectStoreTests {
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
                appBundleIds: ["com.example.app"]
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
        #expect(store.settings.activeProjectId == "canonical-id")
        #expect(store.isReadyForRecording)
    }

    @Test("project persistence failures remain visible to the UI")
    @MainActor
    func reportsPersistenceFailure() {
        let store = ProjectStore(filePath: "/dev/null/projects.json")
        store.settings.projects = [RecProject(name: "Cannot Save")]

        #expect(throws: (any Error).self) {
            try store.save()
        }
        #expect(store.persistenceError?.contains("Failed to save projects") == true)
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
