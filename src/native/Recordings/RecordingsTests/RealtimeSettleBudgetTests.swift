import Foundation
import Testing
@testable import RecordingsLib

// MARK: - Realtime settlement budget

struct RealtimeSettleBudgetTests {
    /// Capture byte rate the budget converts from: 24 kHz, 16-bit, mono.
    private let bytesPerSecond = 48_000

    @Test("empty and pathological captures get the floor budget")
    func floorBudget() {
        #expect(RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: 0) == 1_500)
        #expect(RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: -1) == 1_500)
        #expect(RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: 1) == 1_500)
    }

    @Test("the budget grows with recording length because the fallback cost does")
    func scalesWithAudioSeconds() {
        // A ~5 s dictation: the old fixed 700 ms budget was routinely missed by real
        // settle times (0.6-1.6 s measured); the scaled budget stays comfortably above.
        #expect(
            RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: 5 * bytesPerSecond)
                == 1_500 + 5 * 25
        )
        // A one-minute recording is worth a 3 s settlement wait: its fallback pass
        // costs ~19 s (measured).
        #expect(
            RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: 60 * bytesPerSecond)
                == 3_000
        )
    }

    @Test("very long recordings cap at the ceiling instead of stalling the user")
    func ceilingBudget() {
        // The 4m07s dictation from the field report: uncapped scaling would ask for
        // 1_500 + 247*25 = 7_675 ms; the ceiling keeps the wait bounded.
        #expect(
            RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: 247 * bytesPerSecond)
                == 5_000
        )
        #expect(
            RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: Int.max) == 5_000
        )
    }

    @Test("partial seconds are rounded down, never up past the ceiling")
    func partialSeconds() {
        // 1.9 s of audio counts as 1 whole second of budget scaling.
        let bytes = Int(Double(bytesPerSecond) * 1.9)
        #expect(
            RecordingEngine.realtimeSettleBudgetMilliseconds(pcmByteCount: bytes) == 1_525
        )
    }
}

// MARK: - Realtime outbound send deadlines

struct RealtimeSendDeadlineTests {
    @Test("the configure send absorbs a cold connection handshake")
    func configureDeadlineCoversColdHandshake() {
        // Cold DNS + TCP + TLS + WebSocket upgrade measured 0.77-1.0 s against the
        // live endpoint from a fresh process; the configure deadline must clear it
        // with margin or a cold connection poisons the whole session.
        #expect(RealtimeTranscriptionClient.configureSendTimeoutMilliseconds >= 2_000)
    }

    @Test("post-configure sends stay tight so mid-session stalls surface quickly")
    func steadyStateDeadlineStaysTight() {
        #expect(
            RealtimeTranscriptionClient.outboundSendTimeoutMilliseconds
                < RealtimeTranscriptionClient.configureSendTimeoutMilliseconds
        )
        #expect(RealtimeTranscriptionClient.outboundSendTimeoutMilliseconds <= 1_000)
    }
}
