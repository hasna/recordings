import Foundation

extension Foundation.Bundle {
    static let module: Bundle = {
        let mainPath = Bundle.main.bundleURL.appendingPathComponent("Recordings_Recordings.bundle").path
        let buildPath = "/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-recordings/src/native/Recordings/.build/index-build/arm64-apple-macosx/debug/Recordings_Recordings.bundle"

        let preferredBundle = Bundle(path: mainPath)

        guard let bundle = preferredBundle ?? Bundle(path: buildPath) else {
            // Users can write a function called fatalError themselves, we should be resilient against that.
            Swift.fatalError("could not load resource bundle: from \(mainPath) or \(buildPath)")
        }

        return bundle
    }()
}