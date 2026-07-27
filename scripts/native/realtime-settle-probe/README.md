# Realtime settle-latency probe

The standalone probe that produced the settle-latency tables in PR #30. It paces
real 24 kHz/16-bit/mono PCM through `RealtimeTranscriptionClient` exactly like the
capture pipeline (4,800-byte chunks every 100 ms, a periodic commit every 900 ms),
then measures the true post-release settle wait with a deliberately oversized finish
budget so the observed wait is the session's own settle latency, not a budget cutoff.

The in-tree `RecordingsTests/RealtimeSettleBenchmark.swift` measures the same thing
through the test harness; this probe exists so the numbers can be reproduced on a
machine where running the package test suite is not safe or not possible (it links
only the client and its logging dependency — no test host, no RecordingEngine, no
production paths; client logs go to an isolated temporary home).

## Build (macOS)

    cd scripts/native/realtime-settle-probe
    swiftc -O -parse-as-library \
      ../../../src/native/Recordings/RecordingsLib/RealtimeTranscriptionClient.swift \
      ../../../src/native/Recordings/RecordingsLib/NativeAppDiagnostics.swift \
      main.swift -o settleprobe

## Run

    RECORDINGS_BENCH_WAVS="s5.wav:s30.wav:s120.wav" \
    RECORDINGS_BENCH_RUNS=5 \
    RECORDINGS_BENCH_KEY_FILE="$HOME/.hasna/recordings/config.json" \
    ./settleprobe

- `RECORDINGS_BENCH_WAVS` (required): colon-separated 24 kHz/16-bit/mono WAV paths.
- `RECORDINGS_BENCH_RUNS`: runs per WAV (default 5). Run 1 of the session is cold.
- `RECORDINGS_BENCH_FINISH_BUDGET_MS`: finish budget (default 10000).
- `RECORDINGS_BENCH_KEY_FILE` (required): JSON file with `openai_api_key`. The key is
  read in-process and never exported into any environment.

One `BENCH_RESULT` line per run on stdout:

    BENCH_RESULT wav=... run=1 cold=true audio_seconds=4.6 pcm_bytes=218834 \
      budget_ms=10000 stream_start_ms=700 finish_wait_ms=777 settled=true chars=85 error=
