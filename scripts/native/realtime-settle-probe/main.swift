import Foundation

// Standalone settle-latency probe: paces real PCM through RealtimeTranscriptionClient
// exactly like the capture pipeline (4,800-byte chunks / 100 ms, periodic commit /
// 900 ms), then measures the finish/settle wait. Compiled with swiftc against
// RealtimeTranscriptionClient.swift + NativeAppDiagnostics.swift only — no test
// harness, no RecordingEngine, no production paths: client logs go to a temp dir.

func pcmData(fromWavAtPath path: String) throws -> Data {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    precondition(data.count > 44, "WAV too small: \(path)")
    precondition(
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
            precondition(
                format == 1 && channels == 1 && sampleRate == 24_000 && bits == 16,
                "probe WAV must be PCM/mono/24kHz/16-bit: \(path)"
            )
        } else if chunkID == "data" {
            pcm = data.subdata(in: body..<body + chunkSize)
        }
        index = body + chunkSize + (chunkSize % 2)
    }
    guard let payload = pcm else { fatalError("no data chunk in \(path)") }
    return payload
}

func monotonicMilliseconds() -> UInt64 {
    UInt64(ProcessInfo.processInfo.systemUptime * 1_000)
}

@main
struct SettleProbe {
    static func main() async {
        let environment = ProcessInfo.processInfo.environment
        let wavPaths = (environment["RECORDINGS_BENCH_WAVS"] ?? "").split(separator: ":").map(String.init)
        precondition(!wavPaths.isEmpty, "RECORDINGS_BENCH_WAVS is required")
        let runsPerWav = Int(environment["RECORDINGS_BENCH_RUNS"] ?? "") ?? 5
        let finishBudget = UInt64(environment["RECORDINGS_BENCH_FINISH_BUDGET_MS"] ?? "") ?? 10_000
        // The key is read in-process from the app's own config file and lives only in
        // this process's memory — never exported into a shell environment, never
        // printed. RECORDINGS_BENCH_KEY_FILE points at the config; no default writes.
        let keyFile = environment["RECORDINGS_BENCH_KEY_FILE"] ?? ""
        precondition(!keyFile.isEmpty, "RECORDINGS_BENCH_KEY_FILE is required")
        let apiKey: String = {
            guard let data = FileManager.default.contents(atPath: keyFile),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let key = json["openai_api_key"] as? String
            else { return "" }
            return key
        }()
        precondition(!apiKey.isEmpty, "no openai_api_key in \(keyFile)")

        let benchHome = NSTemporaryDirectory() + "recordings-settle-probe-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: benchHome, withIntermediateDirectories: true)
        print("BENCH_HOME \(benchHome)")

        var coldRun = true
        for wavPath in wavPaths {
            guard let pcm = try? pcmData(fromWavAtPath: wavPath) else {
                print("BENCH_ERROR wav=\(wavPath) reason=unreadable")
                continue
            }
            let audioSeconds = Double(pcm.count) / 48_000.0
            for run in 1...runsPerWav {
                let client = RealtimeTranscriptionClient(apiKey: apiKey, homePath: benchHome)
                let startBegan = monotonicMilliseconds()
                await client.startStreaming(language: "en")
                let streamStart = monotonicMilliseconds() - startBegan
                guard client.isStreaming else {
                    let text = client.stop()
                    print(
                        "BENCH_RESULT wav=\(wavPath) run=\(run) cold=\(coldRun) "
                            + "audio_seconds=\(String(format: "%.1f", audioSeconds)) "
                            + "stream_start_ms=\(streamStart) finish_wait_ms=0 settled=false "
                            + "chars=\(text.count) error=\((client.error ?? "start_failed").replacingOccurrences(of: " ", with: "_"))"
                    )
                    coldRun = false
                    continue
                }

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
                let result = await client.finish(
                    timeoutMilliseconds: finishBudget,
                    pipelineID: UUID().uuidString,
                    pipelineStartedUptimeMilliseconds: finishBegan
                )
                let finishWait = monotonicMilliseconds() - finishBegan
                print(
                    "BENCH_RESULT wav=\(wavPath) run=\(run) cold=\(coldRun) "
                        + "audio_seconds=\(String(format: "%.1f", audioSeconds)) "
                        + "pcm_bytes=\(pcm.count) budget_ms=\(finishBudget) "
                        + "stream_start_ms=\(streamStart) finish_wait_ms=\(finishWait) "
                        + "settled=\(result.settled) chars=\(result.text.count) "
                        + "error=\((result.error ?? "").replacingOccurrences(of: " ", with: "_"))"
                )
                coldRun = false
            }
        }
    }
}
