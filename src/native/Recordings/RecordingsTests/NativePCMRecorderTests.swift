@preconcurrency import AVFoundation
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

    @Test("stop waits for an admitted callback, rejects later callbacks, then emits converter tail")
    func stopDrainsAdmittedCallbackAndConverterTail() throws {
        let inputFormat = try #require(AVAudioFormat(
            standardFormatWithSampleRate: 48_000,
            channels: 1
        ))
        let outputFormat = try #require(NativePCMRecorder.realtimeOutputFormat())
        let converter = try #require(AVAudioConverter(from: inputFormat, to: outputFormat))
        converter.primeMethod = .normal
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 480))
        buffer.frameLength = 480
        let samples = try #require(buffer.floatChannelData?[0])
        for index in 0..<Int(buffer.frameLength) {
            samples[index] = Float(index % 32) / 32
        }
        let bufferBox = NativeRecorderAudioBufferBox(buffer)

        let probe = NativeRecorderLifecycleProbe()
        let tail = Data([0x54, 0x41, 0x49, 0x4c])
        let recorder = NativePCMRecorder(
            testingInputFormat: inputFormat,
            outputFormat: outputFormat,
            converter: converter,
            stopCapture: { probe.captureStopped.signal() },
            onCallbackAdmitted: { probe.callbackAdmitted() },
            finalizeConverter: { _, _ in
                probe.finalizerRan()
                return [tail]
            },
            onPCM: { probe.emit($0) }
        )

        DispatchQueue.global(qos: .userInitiated).async {
            recorder.processInputBufferForTesting(bufferBox.value)
            probe.callbackReturned.signal()
        }
        #expect(probe.firstCallbackEntered.wait(timeout: .now() + 1) == .success)

        DispatchQueue.global(qos: .userInitiated).async {
            recorder.stop()
            probe.stopReturned.signal()
        }
        #expect(probe.captureStopped.wait(timeout: .now() + 1) == .success)

        recorder.processInputBufferForTesting(bufferBox.value)
        #expect(probe.admissionCount == 1)
        #expect(probe.finalizationCount == 0)

        probe.releaseFirstCallback.signal()
        #expect(probe.callbackReturned.wait(timeout: .now() + 1) == .success)
        #expect(probe.stopReturned.wait(timeout: .now() + 1) == .success)
        #expect(probe.finalizationCount == 1)
        #expect(probe.emissions.last == tail)
    }

    @Test("stop executes AVAudioConverter end-of-stream finalization")
    func stopFinalizesActualConverter() throws {
        let inputFormat = try #require(AVAudioFormat(
            standardFormatWithSampleRate: 44_100,
            channels: 1
        ))
        let outputFormat = try #require(NativePCMRecorder.realtimeOutputFormat())
        let converter = try #require(AVAudioConverter(from: inputFormat, to: outputFormat))
        converter.primeMethod = .normal
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 441))
        buffer.frameLength = 441
        let samples = try #require(buffer.floatChannelData?[0])
        for index in 0..<Int(buffer.frameLength) {
            samples[index] = Float(index % 16) / 16
        }

        let probe = NativeRecorderLifecycleProbe()
        let recorder = NativePCMRecorder(
            testingInputFormat: inputFormat,
            outputFormat: outputFormat,
            converter: converter,
            stopCapture: {},
            onCallbackAdmitted: {},
            finalizeConverter: { converter, format in
                probe.finalizerRan()
                return NativePCMRecorder.finalizeConverterTail(converter, outputFormat: format)
            },
            onPCM: { probe.emit($0) }
        )

        recorder.processInputBufferForTesting(buffer)
        let bytesBeforeStop = probe.emittedByteCount
        recorder.stop()

        #expect(probe.finalizationCount == 1)
        #expect(probe.emittedByteCount > bytesBeforeStop)
    }
}

private final class NativeRecorderAudioBufferBox: @unchecked Sendable {
    let value: AVAudioPCMBuffer

    init(_ value: AVAudioPCMBuffer) {
        self.value = value
    }
}

private final class NativeRecorderLifecycleProbe: @unchecked Sendable {
    let firstCallbackEntered = DispatchSemaphore(value: 0)
    let releaseFirstCallback = DispatchSemaphore(value: 0)
    let callbackReturned = DispatchSemaphore(value: 0)
    let captureStopped = DispatchSemaphore(value: 0)
    let stopReturned = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    private var admissions = 0
    private var finalizations = 0
    private var emitted: [Data] = []

    var admissionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return admissions
    }

    var finalizationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return finalizations
    }

    var emissions: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return emitted
    }

    var emittedByteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return emitted.reduce(0) { $0 + $1.count }
    }

    func callbackAdmitted() {
        lock.lock()
        admissions += 1
        let shouldBlock = admissions == 1
        lock.unlock()
        if shouldBlock {
            firstCallbackEntered.signal()
            releaseFirstCallback.wait()
        }
    }

    func finalizerRan() {
        lock.lock()
        finalizations += 1
        lock.unlock()
    }

    func emit(_ data: Data) {
        lock.lock()
        emitted.append(data)
        lock.unlock()
    }
}
