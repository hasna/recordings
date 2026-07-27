import Foundation
import Testing
@testable import RecordingsLib

// MARK: - Realtime settlement benchmark (opt-in, network-bound)

/// Measures how long real OpenAI realtime sessions take to settle after release —
/// the number the settlement budget in `RecordingEngine` is calibrated against.
///
/// This is a live-network benchmark, not a unit test: it opens real realtime
/// transcription sessions with the machine's configured API key and paces real PCM
/// through them exactly like the capture pipeline does (4,800-byte chunks every
/// 100 ms, a periodic commit every 900 ms). It never writes to the production
/// recordings home — client logs go to a temporary directory.
///
/// Disabled unless RECORDINGS_BENCH_REALTIME=1. Configuration:
///   RECORDINGS_BENCH_WAVS             colon-separated 24 kHz/16-bit/mono WAV paths (required)
///   RECORDINGS_BENCH_RUNS             runs per WAV (default 5)
///   RECORDINGS_BENCH_FINISH_BUDGET_MS finish budget passed to the client (default 10000,
///                                     deliberately far above production budgets so the
///                                     observed wait is the true settle latency)
///   RECORDINGS_BENCH_HOME             home the API key is read from (default ~/.hasna/recordings)
///
/// Results are emitted as BENCH_RESULT lines on stdout, one per run.
struct RealtimeSettleBenchmark {
    private static var enabled: Bool {
        ProcessInfo.processInfo.environment["RECORDINGS_BENCH_REALTIME"] == "1"
    }

    @Test("realtime settle latency", .enabled(if: RealtimeSettleBenchmark.enabled))
    @MainActor
    func settleLatency() async throws {
        let environment = ProcessInfo.processInfo.environment
        let wavPaths = (environment["RECORDINGS_BENCH_WAVS"] ?? "")
            .split(separator: ":").map(String.init)
        try #require(!wavPaths.isEmpty, "RECORDINGS_BENCH_WAVS is required")
        let runsPerWav = Int(environment["RECORDINGS_BENCH_RUNS"] ?? "") ?? 5
        let finishBudget = UInt64(environment["RECORDINGS_BENCH_FINISH_BUDGET_MS"] ?? "") ?? 10_000
        let keyHome = environment["RECORDINGS_BENCH_HOME"]
            ?? "\(NSHomeDirectory())/.hasna/recordings"

        let apiKey = OpenAIAPIKeyStore.load(homePath: keyHome)
        try #require(!apiKey.isEmpty, "no API key available from \(keyHome)")
        let language = OpenAIAPIKeyStore.apiLanguageHint(
            for: OpenAIAPIKeyStore.loadLanguage(homePath: keyHome)
        )

        // Client logs must never land in the production Recordings.log.
        let benchHome = NSTemporaryDirectory() + "recordings-settle-bench-" + UUID().uuidString
        try FileManager.default.createDirectory(
            atPath: benchHome, withIntermediateDirectories: true
        )
        print("BENCH_HOME \(benchHome)")

        var coldRun = true
        for wavPath in wavPaths {
            let pcm = try Self.pcmData(fromWavAtPath: wavPath)
            let audioSeconds = Double(pcm.count) / 48_000.0
            for run in 1...runsPerWav {
                let result = await Self.streamOnce(
                    pcm: pcm,
                    apiKey: apiKey,
                    language: language,
                    homePath: benchHome,
                    finishBudgetMilliseconds: finishBudget
                )
                let errorField = result.error?
                    .replacingOccurrences(of: " ", with: "_") ?? ""
                print(
                    "BENCH_RESULT wav=\(wavPath) run=\(run) cold=\(coldRun) "
                        + "audio_seconds=\(String(format: "%.1f", audioSeconds)) "
                        + "pcm_bytes=\(pcm.count) budget_ms=\(finishBudget) "
                        + "stream_start_ms=\(result.streamStartMilliseconds) "
                        + "finish_wait_ms=\(result.finishWaitMilliseconds) "
                        + "settled=\(result.settled) chars=\(result.textCount) "
                        + "error=\(errorField)"
                )
                coldRun = false
            }
        }
    }

    private struct RunResult {
        let streamStartMilliseconds: UInt64
        let finishWaitMilliseconds: UInt64
        let settled: Bool
        let textCount: Int
        let error: String?
    }

    /// Streams one WAV through a fresh client at capture pace and measures the
    /// finish/settle wait. A fresh client per run mirrors production: every
    /// recording builds a new WebSocket session.
    @MainActor
    private static func streamOnce(
        pcm: Data,
        apiKey: String,
        language: String,
        homePath: String,
        finishBudgetMilliseconds: UInt64
    ) async -> RunResult {
        let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: homePath)

        let startBegan = monotonicMilliseconds()
        await client.startStreaming(language: language)
        let streamStart = monotonicMilliseconds() - startBegan
        guard client.isStreaming else {
            let text = client.stop()
            return RunResult(
                streamStartMilliseconds: streamStart,
                finishWaitMilliseconds: 0,
                settled: false,
                textCount: text.count,
                error: client.error ?? "failed to start streaming"
            )
        }

        // Capture pacing: 4,800 bytes per 100 ms tick (24 kHz * 2 bytes / 10),
        // periodic commit every 900 ms — the same cadence RecordingEngine uses.
        let chunkSize = 4_800
        var offset = 0
        var lastCommitAt = monotonicMilliseconds()
        while offset < pcm.count {
            let end = min(offset + chunkSize, pcm.count)
            client.sendAudio(pcm.subdata(in: offset..<end))
            offset = end
            try? await Task.sleep(for: .milliseconds(100))
            let now = monotonicMilliseconds()
            if now - lastCommitAt >= 900 {
                if await client.commitInput(reason: "periodic") {
                    lastCommitAt = now
                }
            }
        }

        let finishBegan = monotonicMilliseconds()
        let finishResult = await client.finish(
            timeoutMilliseconds: finishBudgetMilliseconds,
            pipelineID: UUID().uuidString,
            pipelineStartedUptimeMilliseconds: finishBegan
        )
        let finishWait = monotonicMilliseconds() - finishBegan
        return RunResult(
            streamStartMilliseconds: streamStart,
            finishWaitMilliseconds: finishWait,
            settled: finishResult.settled,
            textCount: finishResult.text.count,
            error: finishResult.error
        )
    }

    /// Extracts raw PCM from a canonical RIFF/WAVE file, asserting the capture
    /// pipeline's format (PCM, mono, 24 kHz, 16-bit) so a mispacked fixture cannot
    /// silently skew the measurement.
    private static func pcmData(fromWavAtPath path: String) throws -> Data {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        try #require(data.count > 44, "WAV too small: \(path)")
        try #require(
            String(data: data[0..<4], encoding: .ascii) == "RIFF"
                && String(data: data[8..<12], encoding: .ascii) == "WAVE",
            "not a RIFF/WAVE file: \(path)"
        )

        var index = 12
        var pcm: Data?
        while index + 8 <= data.count {
            let chunkID = String(data: data[index..<index + 4], encoding: .ascii) ?? ""
            let chunkSize = Int(
                UInt32(data[index + 4]) | UInt32(data[index + 5]) << 8
                    | UInt32(data[index + 6]) << 16 | UInt32(data[index + 7]) << 24
            )
            let body = index + 8
            guard body + chunkSize <= data.count else { break }
            if chunkID == "fmt ", chunkSize >= 16 {
                let format = UInt16(data[body]) | UInt16(data[body + 1]) << 8
                let channels = UInt16(data[body + 2]) | UInt16(data[body + 3]) << 8
                let sampleRate = UInt32(data[body + 4]) | UInt32(data[body + 5]) << 8
                    | UInt32(data[body + 6]) << 16 | UInt32(data[body + 7]) << 24
                let bits = UInt16(data[body + 14]) | UInt16(data[body + 15]) << 8
                try #require(
                    format == 1 && channels == 1 && sampleRate == 24_000 && bits == 16,
                    "bench WAV must be PCM/mono/24kHz/16-bit: \(path)"
                )
            } else if chunkID == "data" {
                pcm = data.subdata(in: body..<body + chunkSize)
            }
            // Chunks are word-aligned: odd sizes carry one padding byte.
            index = body + chunkSize + (chunkSize % 2)
        }
        let payload = try #require(pcm, "no data chunk in \(path)")
        return payload
    }

    private static func monotonicMilliseconds() -> UInt64 {
        UInt64(ProcessInfo.processInfo.systemUptime * 1_000)
    }
}
