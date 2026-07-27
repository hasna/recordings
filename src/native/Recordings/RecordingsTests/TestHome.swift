import Foundation

/// A throwaway home directory for tests that construct production types which persist under
/// `~/.hasna/recordings`.
///
/// Every such type takes its home by injection rather than reading the environment, because
/// `FileManager.default.homeDirectoryForCurrentUser` resolves through the password database
/// (`getpwuid`) instead of `$HOME`. Running the suite with an overridden `HOME` therefore does
/// *not* redirect these writes — on 2026-07-27 a suite run appended 132 lines, including a
/// false permission-regression line, to the live user's `Recordings.log`. Injecting the home is
/// the only reliable containment.
func makeTestHome(_ label: String = "recordings-tests") -> String {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("\(label)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url.path
}

/// The live user's recordings directory — the one no test may write to. Only the containment
/// guard in `HomeContainmentTests` should reference this.
func liveRecordingsDirectory() -> String {
    "\(FileManager.default.homeDirectoryForCurrentUser.path)/.hasna/recordings"
}
