// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Recordings",
    platforms: [
        .macOS(.v26)
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", exact: "1.12.0"),
        // Swift Testing pinned to the toolchain-matched release. The stations build with
        // CommandLineTools (no bundled Testing module), so the package is required — but it
        // must track the compiler: the archived 0.99 shim under the 6.2 compiler silently
        // corrupted `#expect` Bool-comparison evaluation, passing false assertions.
        .package(url: "https://github.com/apple/swift-testing.git", revision: "swift-6.2-RELEASE"),
    ],
    targets: [
        .target(
            name: "RecordingsLib",
            dependencies: ["KeyboardShortcuts"],
            path: "RecordingsLib",
            exclude: ["Info.plist", "Recordings.entitlements", "RecordingsCLI.entitlements"],
            resources: [.process("Resources")]
        ),
        .executableTarget(
            name: "App",
            dependencies: ["RecordingsLib"],
            path: "App"
        ),
        .testTarget(
            name: "RecordingsTests",
            dependencies: ["RecordingsLib", .product(name: "Testing", package: "swift-testing")],
            path: "RecordingsTests"
        ),
    ]
)
