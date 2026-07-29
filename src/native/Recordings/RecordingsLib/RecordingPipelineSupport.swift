import AVFoundation
@preconcurrency import ApplicationServices
import Carbon.HIToolbox
import Darwin
import SwiftUI
@preconcurrency import KeyboardShortcuts

struct RecordingPipelineTrace: Sendable {
    let id = UUID().uuidString
    let startedUptimeMilliseconds = UInt64(ProcessInfo.processInfo.systemUptime * 1_000)

    func message(stage: String, detail: String = "") -> String {
        let nowMilliseconds = UInt64(ProcessInfo.processInfo.systemUptime * 1_000)
        let elapsedMilliseconds = nowMilliseconds >= startedUptimeMilliseconds
            ? nowMilliseconds - startedUptimeMilliseconds
            : 0
        let suffix = detail.isEmpty ? "" : " \(detail)"
        return "pipeline_timing pipeline_id=\(id) stage=\(stage) elapsed_ms=\(elapsedMilliseconds)\(suffix)"
    }
}

public enum RecordingTrigger: Equatable, Sendable {
    case manual
    case fnKey
    case keyboardShortcut
}

struct MicrophonePermissionStartGate {
    private(set) var activeRequestID: UUID?

    var isAwaitingResponse: Bool {
        activeRequestID != nil
    }

    mutating func reserve(requestID: UUID = UUID()) -> UUID? {
        guard activeRequestID == nil else { return nil }
        activeRequestID = requestID
        return requestID
    }

    mutating func consumeResponse(for requestID: UUID) -> Bool {
        guard activeRequestID == requestID else { return false }
        activeRequestID = nil
        return true
    }

    mutating func cancel() {
        activeRequestID = nil
    }
}

struct PasteTargetCandidate: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String?
    let isRegularApp: Bool
    let launchDate: Date?

    init(
        pid: pid_t,
        bundleIdentifier: String?,
        isRegularApp: Bool,
        launchDate: Date? = nil
    ) {
        self.pid = pid
        self.bundleIdentifier = bundleIdentifier
        self.isRegularApp = isRegularApp
        self.launchDate = launchDate
    }
}

struct PasteTargetProcessIdentity: Equatable, Sendable {
    let pid: pid_t
    let bundleIdentifier: String
    let launchDate: Date

    func matches(_ candidate: PasteTargetCandidate) -> Bool {
        candidate.pid == pid
            && candidate.bundleIdentifier == bundleIdentifier
            && candidate.launchDate == launchDate
    }
}

enum PasteDeliveryKind: Equatable, Sendable {
    case ordinaryDictation
    case commandRewrite
    case manualPaste
}

final class PCMStreamPipe: @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private let processor: Task<Data, Never>

    init(chunkSize: Int, client: RealtimeTranscriptionClient?) {
        var streamContinuation: AsyncStream<Data>.Continuation!
        let stream = AsyncStream<Data>(bufferingPolicy: .unbounded) { continuation in
            streamContinuation = continuation
        }
        continuation = streamContinuation
        processor = Task {
            var recordedPCM = Data()
            var pendingChunk = Data()

            for await data in stream {
                guard !data.isEmpty else { continue }
                recordedPCM.append(data)
                pendingChunk.append(data)

                while pendingChunk.count >= chunkSize {
                    await client?.sendAudio(pendingChunk.prefixData(count: chunkSize))
                    pendingChunk.removeFirst(chunkSize)
                }
            }

            if !pendingChunk.isEmpty {
                await client?.sendAudio(pendingChunk)
            }
            return recordedPCM
        }
    }

    func append(_ data: Data) {
        continuation.yield(data)
    }

    func finish() async -> Data {
        continuation.finish()
        return await processor.value
    }

    func cancel() {
        continuation.finish()
        processor.cancel()
    }
}

private extension Data {
    func prefixData(count: Int) -> Data {
        Data(prefix(count))
    }
}

// MARK: - Recording Engine

