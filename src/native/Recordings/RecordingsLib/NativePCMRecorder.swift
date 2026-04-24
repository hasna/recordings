@preconcurrency import AVFoundation
import Foundation

enum NativePCMRecorderError: LocalizedError {
    case noInputDevice
    case unsupportedInputFormat
    case failedToCreateConverter
    case failedToStart(String)

    var errorDescription: String? {
        switch self {
        case .noInputDevice:
            return "No microphone input device is available"
        case .unsupportedInputFormat:
            return "The selected microphone format is not supported"
        case .failedToCreateConverter:
            return "Could not prepare microphone audio conversion"
        case .failedToStart(let message):
            return "Could not start microphone capture: \(message)"
        }
    }
}

final class NativePCMRecorder: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let onPCM: @Sendable (Data) -> Void
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    private var started = false

    init(onPCM: @escaping @Sendable (Data) -> Void) {
        self.onPCM = onPCM
    }

    func start() throws {
        guard !started else { return }

        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)
        guard inputFormat.channelCount > 0 else {
            throw NativePCMRecorderError.noInputDevice
        }
        guard inputFormat.sampleRate > 0 else {
            throw NativePCMRecorderError.unsupportedInputFormat
        }
        guard let outputFormat = Self.realtimeOutputFormat() else {
            throw NativePCMRecorderError.unsupportedInputFormat
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw NativePCMRecorderError.failedToCreateConverter
        }

        self.converter = converter
        self.inputFormat = inputFormat
        self.outputFormat = outputFormat

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
            self?.convertAndEmit(buffer)
        }

        do {
            engine.prepare()
            try engine.start()
            started = true
        } catch {
            inputNode.removeTap(onBus: 0)
            self.converter = nil
            self.inputFormat = nil
            self.outputFormat = nil
            throw NativePCMRecorderError.failedToStart(error.localizedDescription)
        }
    }

    func stop() {
        guard started else {
            converter = nil
            inputFormat = nil
            outputFormat = nil
            return
        }

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        inputFormat = nil
        outputFormat = nil
        started = false
    }

    deinit {
        stop()
    }

    private func convertAndEmit(_ inputBuffer: AVAudioPCMBuffer) {
        guard let converter, let inputFormat, let outputFormat else { return }

        let sampleRateRatio = outputFormat.sampleRate / inputFormat.sampleRate
        let estimatedFrames = AVAudioFrameCount(Double(inputBuffer.frameLength) * sampleRateRatio) + 512
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: max(estimatedFrames, 1)
        ) else {
            return
        }

        let inputSource = AudioConverterInputSource(buffer: inputBuffer)
        var conversionError: NSError?
        converter.convert(to: outputBuffer, error: &conversionError) { _, status in
            inputSource.next(status: status)
        }

        guard conversionError == nil else { return }
        let data = Self.extractPCM16Data(from: outputBuffer)
        if !data.isEmpty {
            onPCM(data)
        }
    }

    static func realtimeOutputFormat() -> AVAudioFormat? {
        AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: true
        )
    }

    static func extractPCM16Data(from buffer: AVAudioPCMBuffer) -> Data {
        var data = Data()
        for audioBuffer in UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList) {
            guard let bytes = audioBuffer.mData?.assumingMemoryBound(to: UInt8.self),
                  audioBuffer.mDataByteSize > 0 else {
                continue
            }
            data.append(bytes, count: Int(audioBuffer.mDataByteSize))
        }
        return data
    }
}

private final class AudioConverterInputSource: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private let lock = NSLock()
    private var consumed = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func next(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        lock.lock()
        defer { lock.unlock() }

        if consumed {
            status.pointee = .noDataNow
            return nil
        }

        consumed = true
        status.pointee = .haveData
        return buffer
    }
}
