// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Recordings",
    platforms: [
        .macOS(.v26)
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "2.0.0")
    ],
    targets: [
        .executableTarget(
            name: "Recordings",
            dependencies: ["KeyboardShortcuts"],
            path: "Recordings",
            exclude: ["Info.plist", "Recordings.entitlements"]
        )
    ]
)
