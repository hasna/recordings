// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Recordings",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(name: "App", targets: ["App"]),
        .library(name: "RecordingsUpdateProtocol", targets: ["RecordingsUpdateProtocol"]),
        .executable(name: "recordings-update-broker", targets: ["RecordingsUpdateBroker"]),
        .executable(name: "recordings-update-client", targets: ["RecordingsUpdateClient"]),
        .executable(name: "recordings-envelope-signer", targets: ["RecordingsEnvelopeSigner"]),
        .executable(
            name: "recordings-bootstrap-preflight",
            targets: ["RecordingsBootstrapPreflight"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", exact: "1.12.0"),
        // Swift Testing. The stations build with CommandLineTools (no bundled Testing
        // module), so the package is required. The original rule here was "the pin must
        // track the compiler", because an archived 0.99 shim under the 6.2 compiler once
        // silently corrupted `#expect` Bool-comparison evaluation, passing false assertions.
        //
        // Measured on station06 (Apple Swift 6.3.2, swiftlang-6.3.2.1.108): the 6.3.x line
        // CANNOT be used here. From swift-6.3-RELEASE onward swift-testing's own manifest adds
        // `.linkedLibrary("_TestingInterop")` under `#if compiler(>=6.3)`. That library ships
        // in the toolchain at `$(xcode-select -p)/Library/Developer/usr/lib`, which is not on
        // SwiftPM's default search path, so `swift build --build-tests` fails with
        // `ld: library '_TestingInterop' not found`. It links only if every invocation adds
        // `-Xlinker -L$(xcode-select -p)/Library/Developer/usr/lib`, which nothing in this repo
        // supplies. Repinning to 6.3.2 would therefore break `swift test` for every caller.
        //
        // So the pin stays on the 6.2 line, and the rule it was standing in for is now
        // enforced directly instead of by version matching: ExpectationIntegrityTests asserts
        // that `#expect` both admits true Bool comparisons and *records issues* for false ones.
        // That turns the silent failure mode into a red test, which a version pin never could.
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
        .target(
            name: "RecordingsUpdateProtocol",
            path: "Updater/Protocol"
        ),
        .executableTarget(
            name: "RecordingsUpdateBroker",
            dependencies: ["RecordingsUpdateProtocol", "RecordingsVerifierLauncher"],
            path: "Updater/Broker",
            // PeerIdentity resolves the XPC peer's audit token into a PID and EUID with
            // audit_token_to_pid/_euid, which live in libbsm. Without this the broker
            // compiles and then fails at link, which `swift build --target` does not
            // surface because it stops short of linking the executable product.
            linkerSettings: [.linkedLibrary("bsm")]
        ),
        .target(
            name: "RecordingsVerifierLauncher",
            path: "Updater/VerifierLauncher",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "RecordingsUpdateClient",
            dependencies: ["RecordingsUpdateProtocol"],
            path: "Updater/Client"
        ),
        .executableTarget(
            name: "RecordingsEnvelopeSigner",
            dependencies: ["RecordingsUpdateProtocol"],
            path: "Updater/Signer"
        ),
        .executableTarget(
            name: "RecordingsBootstrapPreflight",
            dependencies: ["RecordingsUpdateProtocol"],
            path: "Updater/BootstrapPreflight"
        ),
        .testTarget(
            name: "RecordingsTests",
            dependencies: ["RecordingsLib", .product(name: "Testing", package: "swift-testing")],
            path: "RecordingsTests"
        ),
        .testTarget(
            name: "RecordingsUpdateProtocolTests",
            dependencies: [
                "RecordingsUpdateProtocol",
                .product(name: "Testing", package: "swift-testing"),
            ],
            path: "Updater/ProtocolTests"
        ),
        .testTarget(
            name: "RecordingsUpdateBrokerTests",
            dependencies: [
                "RecordingsUpdateBroker",
                .product(name: "Testing", package: "swift-testing"),
            ],
            path: "Updater/BrokerTests"
        ),
    ]
)
