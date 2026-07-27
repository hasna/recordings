import Foundation

/// A throwaway `~` for one `RecordingEngine` under test.
///
/// `RecordingEngine` roots everything it owns at `<home>/.hasna/recordings`: the audio spool,
/// `config.json` (which holds the operator's live API keys), and `Recordings.log`. Its
/// `homePath` default is the real home, so before that seam existed every engine a test built
/// wrote there — on 2026-07-27 a suite run appended 11 fixture lines
/// (`target=com.example.editor pid=99999`, `accessibility=false`) to the log of a machine the
/// owner dictates on, corrupting the only record the recording investigations read, and
/// rewrote that machine's real `config.json`.
///
/// Same shape as `NativeAppDiagnosticsTests.makeHome()`, the existing precedent for a temp
/// home behind a `homePath:` parameter: a fresh `$TMPDIR` directory per call. It is left for
/// the OS to reap rather than torn down, because the callers are engine factories that hand
/// back only the engine and so have no scope to remove it from; `CLIRunnerTests` instead
/// passes the temp home it already creates and already deletes.
func makeIsolatedTestHome(_ label: String) -> String {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("recordings-\(label)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url.path
}
