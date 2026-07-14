@preconcurrency import AVFoundation
import Foundation

enum NativePCMRecorderError: LocalizedError {
    case alreadyActive
    case noInputDevice
    case unsupportedInputFormat
    case failedToCreateConverter
    case failedToStart(String)

    var errorDescription: String? {
        switch self {
        case .alreadyActive:
            return "Microphone capture is already starting, running, or stopping"
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
    private enum LifecycleState: Equatable {
        case idle
        case starting
        case running
        case stopping
    }

    private let engine = AVAudioEngine()
    private let onPCM: @Sendable (Data) -> Void
    private let lifecycle = NSCondition()
    private let conversionLock = NSLock()
    private let deliveryQueue = DispatchQueue(label: "com.hasna.recordings.native-pcm-delivery")
    private let deliveryQueueKey = DispatchSpecificKey<UInt8>()
    private let stopWorkQueue = DispatchQueue(label: "com.hasna.recordings.native-pcm-stop")
    private let stopCaptureForTesting: (@Sendable () -> Void)?
    private let onCallbackAdmittedForTesting: (@Sendable () -> Void)?
    private let finalizeConverter: @Sendable (AVAudioConverter, AVAudioFormat) -> [Data]
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    private var state = LifecycleState.idle
    private var acceptingCallbacks = false
    private var inFlightCallbacks = 0

    init(onPCM: @escaping @Sendable (Data) -> Void) {
        self.onPCM = onPCM
        self.stopCaptureForTesting = nil
        self.onCallbackAdmittedForTesting = nil
        self.finalizeConverter = Self.finalizeConverterTail
        deliveryQueue.setSpecific(key: deliveryQueueKey, value: 1)
    }

    init(
        testingInputFormat: AVAudioFormat,
        outputFormat: AVAudioFormat,
        converter: AVAudioConverter,
        stopCapture: @escaping @Sendable () -> Void,
        onCallbackAdmitted: @escaping @Sendable () -> Void,
        finalizeConverter: @escaping @Sendable (AVAudioConverter, AVAudioFormat) -> [Data],
        startsRunning: Bool = true,
        onPCM: @escaping @Sendable (Data) -> Void
    ) {
        self.onPCM = onPCM
        self.stopCaptureForTesting = stopCapture
        self.onCallbackAdmittedForTesting = onCallbackAdmitted
        self.finalizeConverter = finalizeConverter
        self.converter = converter
        self.inputFormat = testingInputFormat
        self.outputFormat = outputFormat
        self.state = startsRunning ? .running : .idle
        self.acceptingCallbacks = startsRunning
        deliveryQueue.setSpecific(key: deliveryQueueKey, value: 1)
    }

    func start() throws {
        try reserveStart()

        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)
        guard inputFormat.channelCount > 0 else {
            abandonStart()
            throw NativePCMRecorderError.noInputDevice
        }
        guard inputFormat.sampleRate > 0 else {
            abandonStart()
            throw NativePCMRecorderError.unsupportedInputFormat
        }
        guard let outputFormat = Self.realtimeOutputFormat() else {
            abandonStart()
            throw NativePCMRecorderError.unsupportedInputFormat
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            abandonStart()
            throw NativePCMRecorderError.failedToCreateConverter
        }

        lifecycle.lock()
        self.converter = converter
        self.inputFormat = inputFormat
        self.outputFormat = outputFormat
        lifecycle.unlock()

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
            self?.processInputBuffer(buffer)
        }

        do {
            engine.prepare()
            try engine.start()
            lifecycle.lock()
            acceptingCallbacks = true
            state = .running
            lifecycle.broadcast()
            lifecycle.unlock()
        } catch {
            inputNode.removeTap(onBus: 0)
            lifecycle.lock()
            self.converter = nil
            self.inputFormat = nil
            self.outputFormat = nil
            state = .idle
            acceptingCallbacks = false
            lifecycle.broadcast()
            lifecycle.unlock()
            throw NativePCMRecorderError.failedToStart(error.localizedDescription)
        }
    }

    private func reserveStart() throws {
        lifecycle.lock()
        guard state == .idle else {
            lifecycle.unlock()
            throw NativePCMRecorderError.alreadyActive
        }
        state = .starting
        lifecycle.unlock()
    }

    func stop() {
        let isReentrantDelivery = DispatchQueue.getSpecific(key: deliveryQueueKey) != nil
        lifecycle.lock()
        while state == .starting || (state == .stopping && !isReentrantDelivery) {
            lifecycle.wait()
        }
        guard state == .running else {
            lifecycle.unlock()
            return
        }
        acceptingCallbacks = false
        state = .stopping
        lifecycle.unlock()

        if isReentrantDelivery {
            stopWorkQueue.async { [self] in
                stopCaptureAndFinish()
            }
        } else {
            stopCaptureAndFinish()
        }
    }

    private func stopCaptureAndFinish() {
        if let stopCaptureForTesting {
            stopCaptureForTesting()
        } else {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }

        lifecycle.lock()
        while inFlightCallbacks > 0 {
            lifecycle.wait()
        }
        let converter = converter
        let outputFormat = outputFormat
        lifecycle.unlock()

        if let converter, let outputFormat {
            conversionLock.lock()
            let tailChunks = finalizeConverter(converter, outputFormat)
            conversionLock.unlock()
            for data in tailChunks where !data.isEmpty {
                deliverPCM(data)
            }
        }

        lifecycle.lock()
        self.converter = nil
        inputFormat = nil
        self.outputFormat = nil
        state = .idle
        lifecycle.broadcast()
        lifecycle.unlock()
    }

    deinit {
        stop()
    }

    private func abandonStart() {
        lifecycle.lock()
        state = .idle
        acceptingCallbacks = false
        lifecycle.broadcast()
        lifecycle.unlock()
    }

    func processInputBufferForTesting(_ inputBuffer: AVAudioPCMBuffer) {
        processInputBuffer(inputBuffer)
    }

    func deliverPCMForTesting(_ data: Data) {
        lifecycle.lock()
        guard acceptingCallbacks else {
            lifecycle.unlock()
            return
        }
        inFlightCallbacks += 1
        lifecycle.unlock()

        defer { finishCallback() }
        deliverPCM(data)
    }

    func reserveStartForTesting() throws {
        try reserveStart()
    }

    func abandonStartForTesting() {
        abandonStart()
    }

    var isIdleForTesting: Bool {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        return state == .idle
    }

    private func processInputBuffer(_ inputBuffer: AVAudioPCMBuffer) {
        lifecycle.lock()
        guard acceptingCallbacks,
              let converter,
              let inputFormat,
              let outputFormat else {
            lifecycle.unlock()
            return
        }
        inFlightCallbacks += 1
        lifecycle.unlock()

        onCallbackAdmittedForTesting?()

        defer { finishCallback() }

        conversionLock.lock()
        let data = convert(
            inputBuffer,
            converter: converter,
            inputFormat: inputFormat,
            outputFormat: outputFormat
        )
        conversionLock.unlock()
        if !data.isEmpty {
            deliverPCM(data)
        }
    }

    private func deliverPCM(_ data: Data) {
        if DispatchQueue.getSpecific(key: deliveryQueueKey) != nil {
            onPCM(data)
        } else {
            deliveryQueue.sync {
                onPCM(data)
            }
        }
    }

    private func finishCallback() {
        lifecycle.lock()
        inFlightCallbacks -= 1
        if inFlightCallbacks == 0 {
            lifecycle.broadcast()
        }
        lifecycle.unlock()
    }

    private func convert(
        _ inputBuffer: AVAudioPCMBuffer,
        converter: AVAudioConverter,
        inputFormat: AVAudioFormat,
        outputFormat: AVAudioFormat
    ) -> Data {
        let sampleRateRatio = outputFormat.sampleRate / inputFormat.sampleRate
        let estimatedFrames = AVAudioFrameCount(Double(inputBuffer.frameLength) * sampleRateRatio) + 512
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: max(estimatedFrames, 1)
        ) else {
            return Data()
        }

        let inputSource = AudioConverterInputSource(buffer: inputBuffer)
        var conversionError: NSError?
        converter.convert(to: outputBuffer, error: &conversionError) { _, status in
            inputSource.next(status: status)
        }

        guard conversionError == nil else { return Data() }
        return Self.extractPCM16Data(from: outputBuffer)
    }

    static func finalizeConverterTail(_ converter: AVAudioConverter, outputFormat: AVAudioFormat) -> [Data] {
        var chunks: [Data] = []
        while let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4_096) {
            var conversionError: NSError?
            let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
                inputStatus.pointee = .endOfStream
                return nil
            }
            guard conversionError == nil else { break }
            let data = extractPCM16Data(from: outputBuffer)
            if !data.isEmpty {
                chunks.append(data)
            }
            switch status {
            case .haveData:
                guard !data.isEmpty else { return chunks }
            case .inputRanDry, .endOfStream, .error:
                return chunks
            @unknown default:
                return chunks
            }
        }
        return chunks
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
