import Testing
@testable import RecordingsLib

struct ProjectStoreTests {
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
