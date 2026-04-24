// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Recordings",
    platforms: [
        .macOS(.v26)
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "2.0.0"),
        .package(url: "https://github.com/apple/swift-testing.git", .upToNextMinor(from: "0.99.0")),
    ],
    targets: [
        .target(
            name: "RecordingsLib",
            dependencies: ["KeyboardShortcuts"],
            path: "RecordingsLib",
            exclude: ["Info.plist", "Recordings.entitlements"]
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
