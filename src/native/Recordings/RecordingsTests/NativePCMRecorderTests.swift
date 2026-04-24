import AVFoundation
import Testing
@testable import RecordingsLib

struct NativePCMRecorderTests {
    @Test("Realtime output format is OpenAI-compatible 24 kHz mono PCM16")
    func realtimeOutputFormat() throws {
        let format = try #require(NativePCMRecorder.realtimeOutputFormat())

        #expect(format.commonFormat == .pcmFormatInt16)
        #expect(format.sampleRate == 24_000)
        #expect(format.channelCount == 1)
        #expect(format.isInterleaved)
    }

    @Test("Extracts PCM16 bytes from audio buffer")
    func extractPCM16Data() throws {
        let format = try #require(NativePCMRecorder.realtimeOutputFormat())
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4

        let samples = try #require(buffer.int16ChannelData?[0])
        samples[0] = 1
        samples[1] = -2
        samples[2] = 3
        samples[3] = -4

        let data = NativePCMRecorder.extractPCM16Data(from: buffer)

        #expect(data.count == 8)
        #expect(data.withUnsafeBytes { $0.load(as: Int16.self) } == 1)
    }
}
