import Foundation

// MARK: - OpenAI Realtime Transcription Client

/// Streams PCM audio to OpenAI's Realtime Transcription API via WebSocket.
/// Receives transcription deltas in real time.
@MainActor
final class RealtimeTranscriptionClient: ObservableObject {
    /// Latest stable transcription model.
    static let modelID = "gpt-4o-transcribe"

    @Published var accumulatedText = ""
    @Published var isStreaming = false
    @Published var error: String?

    private var ws: URLSessionWebSocketTask?
    private var audioStreamContinuation: AsyncStream<Data>.Continuation?
    private var receiveTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?

    private let apiKey: String
    private let homePath: String

    init(apiKey: String, homePath: String) {
        self.apiKey = apiKey
        self.homePath = homePath
    }

    // MARK: - Public API

    /// Start a streaming transcription session.
    /// - Parameters:
    ///   - systemPrompt: Optional system prompt for the transcription
    ///   - audioFormat: Audio format. Defaults to pcm16 at 24kHz (OpenAI's preferred format).
    /// - Returns: The client is now streaming. Call `sendAudio(_:)` to send chunks.
    func startStreaming(systemPrompt: String = "") async {
        guard !apiKey.isEmpty else {
            self.error = "OpenAI API key not configured"
            return
        }
        guard !isStreaming else { return }

        isStreaming = true
        accumulatedText = ""
        error = nil

        // Step 1: Create a client session to get an ephemeral WebSocket URL
        guard let wsURL = await createSessionURL(systemPrompt: systemPrompt) else {
            isStreaming = false
            error = "Failed to create transcription session"
            return
        }

        // Step 2: Connect WebSocket
        var request = URLRequest(url: wsURL)
        request.timeoutInterval = 10
        ws = URLSession.shared.webSocketTask(with: request)
        ws?.resume()

        // Step 3: Send session configuration
        let sessionConfig: [String: Any] = [
            "type": "session.update",
            "session": [
                "modalities": ["text"],
                "turn_detection": [
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 400,
                    "create_response": false,
                ],
            ],
        ]
        do {
            try await ws?.send(.string(encodeJSON(sessionConfig)))
        } catch {
            self.error = "Failed to configure session: \(error.localizedDescription)"
            isStreaming = false
            return
        }

        // Step 4: Set instructions if provided
        if !systemPrompt.isEmpty {
            let instrConfig: [String: Any] = [
                "type": "session.update",
                "session": ["instructions": systemPrompt],
            ]
            do {
                try await ws?.send(.string(encodeJSON(instrConfig)))
            } catch {
                // Non-fatal — transcription will still work
            }
        }

        // Step 5: Start receiving transcription deltas
        receiveTask = Task {
            await receiveLoop()
        }
    }

    /// Send a chunk of PCM audio data to the transcription session.
    func sendAudio(_ data: Data) {
        guard let ws, isStreaming else { return }
        let base64 = data.base64EncodedString()
        let msg: [String: Any] = [
            "type": "input_audio_buffer.append",
            "audio": base64,
        ]
        Task {
            try? await ws.send(.string(encodeJSON(msg)))
        }
    }

    /// Signal end of input — triggers final transcription completion.
    func commitInput() {
        guard let ws, isStreaming else { return }
        let msg: [String: Any] = [
            "type": "input_audio_buffer.commit",
        ]
        Task {
            try? await ws.send(.string(encodeJSON(msg)))
        }
    }

    /// Stop the streaming session and clean up.
    /// Returns the final accumulated transcription text.
    func stop() -> String {
        isStreaming = false
        receiveTask?.cancel()
        streamTask?.cancel()
        ws?.cancel(with: .normalClosure, reason: nil)
        ws = nil
        receiveTask = nil
        streamTask = nil
        let text = accumulatedText
        return text
    }

    // MARK: - Session Creation

    private func createSessionURL(systemPrompt: String) async -> URL? {
        let url = URL(string: "https://api.openai.com/v1/realtime/transcription_sessions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("2025-04-15.preview", forHTTPHeaderField: "OpenAI-Beta")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "model": Self.modelID,
            "modalities": ["text"],
            "turn_detection": [
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 400,
                "create_response": false,
            ],
        ]
        if !systemPrompt.isEmpty {
            body["instructions"] = systemPrompt
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let wsURLString = json["url"] as? String,
                  let wsURL = URL(string: wsURLString)
            else {
                // Check for error response
                if let http = response as? HTTPURLResponse, http.statusCode >= 400,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let err = json["error"] as? [String: Any],
                   let msg = err["message"] as? String {
                    fputs("[RealtimeClient] Session error: \(msg)\n", stderr)
                    self.error = msg
                }
                return nil
            }
            fputs("[RealtimeClient] Session URL created\n", stderr)
            return wsURL
        } catch {
            fputs("[RealtimeClient] Failed to create session: \(error)\n", stderr)
            self.error = "Failed to create transcription session: \(error.localizedDescription)"
            return nil
        }
    }

    // MARK: - Receive Loop

    private func receiveLoop() async {
        guard let ws else { return }
        do {
            while true {
                try Task.checkCancellation()
                let message = try await ws.receive()
                switch message {
                case .string(let text):
                    handleEvent(text)
                case .data:
                    break
                @unknown default:
                    break
                }
            }
        } catch {
            // Connection closed
            fputs("[RealtimeClient] Receive loop ended: \(error.localizedDescription)\n", stderr)
        }
    }

    // MARK: - Event Parsing

    private func handleEvent(_ text: String) {
        guard let json = parseJSON(text),
              let type = json["type"] as? String
        else { return }

        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = json["delta"] as? String {
                accumulatedText += delta
            }

        case "conversation.item.input_audio_transcription.completed":
            // The server may send the complete transcript here
            if let text = json["transcript"] as? String, !text.isEmpty {
                accumulatedText = text
            }

        case "error":
            if let detail = json["error"] as? [String: Any],
               let msg = detail["message"] as? String {
                fputs("[RealtimeClient] Error: \(msg)\n", stderr)
                self.error = msg
            }

        default:
            break
        }
    }

    private func parseJSON(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json
    }

    private func encodeJSON(_ obj: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8)
        else { return "{}" }
        return s
    }
}

// MARK: - Test Helpers (expose private parsing for unit testing)

extension RealtimeTranscriptionClient {
    static func parseDeltaTestHelper(_ text: String) -> String? {
        let client = RealtimeTranscriptionClient(apiKey: "test", homePath: "/tmp")
        return client.parseJSONForTest(text).flatMap { json -> String? in
            guard let type = json["type"] as? String else { return nil }
            switch type {
            case "conversation.item.input_audio_transcription.delta":
                return json["delta"] as? String
            case "conversation.item.input_audio_transcription.completed":
                return json["transcript"] as? String
            default:
                return nil
            }
        }
    }

    static func isSessionErrorTestHelper(_ text: String) -> Bool {
        let client = RealtimeTranscriptionClient(apiKey: "test", homePath: "/tmp")
        guard let json = client.parseJSONForTest(text),
              let type = json["type"] as? String
        else { return false }
        return type == "error"
    }

    static func parseErrorTestHelper(_ text: String) -> String? {
        let client = RealtimeTranscriptionClient(apiKey: "test", homePath: "/tmp")
        guard let json = client.parseJSONForTest(text),
              let error = json["error"] as? [String: Any]
        else { return nil }
        return error["message"] as? String
    }

    private func parseJSONForTest(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json
    }
}
