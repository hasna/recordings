import Foundation

// MARK: - Speech Intent

/// What the user wanted a recording to do. Replaces the exposed Talk/Dictate/Command
/// selector: every recording is captured the same way and the intent is decided from the
/// final transcript.
public enum SpeechIntent: String, CaseIterable, Sendable {
    case dictate
    case conversation
    case command
}

/// One typed classifier outcome. `confidence` is clamped to 0...1; `reason` is a short
/// human-readable justification surfaced in logs and the Record page. When
/// `literalTranscript` is set the raw transcript must be pasted verbatim, bypassing any
/// post-processed variant — used for injection-vetoed speech.
public struct IntentDecision: Equatable, Sendable {
    public let intent: SpeechIntent
    public let confidence: Double
    public let reason: String
    public let literalTranscript: Bool

    public init(intent: SpeechIntent, confidence: Double, reason: String, literalTranscript: Bool = false) {
        self.intent = intent
        self.confidence = confidence.isFinite ? min(max(confidence, 0), 1) : 0
        self.reason = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        self.literalTranscript = literalTranscript
    }
}

/// Where a decision came from, for logging and the stale-result guard.
public enum IntentDecisionOrigin: String, Sendable {
    case localScreen
    case classifier
}

// MARK: - Local screen

/// Deterministic local pre-classifier. Returns a definitive decision when the transcript is
/// clearly plain dictation (or must be treated as such), and `nil` when the remote classifier
/// should be consulted. Clear dictation therefore never waits on a network call.
public enum IntentScreen {
    /// Transcripts longer than this are treated as long-form dictation outright.
    public static let longFormWordCount = 60

    public static func screen(text: String, hasSelection: Bool) -> IntentDecision? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return IntentDecision(intent: .dictate, confidence: 1, reason: "Empty transcript")
        }
        let lowered = trimmed.lowercased()

        if containsInjectionMarker(lowered) {
            // Instruction-injection-shaped speech is never routed to the classifier: it is
            // pasted literally so hostile transcripts cannot influence the decision model.
            return IntentDecision(
                intent: .dictate,
                confidence: 1,
                reason: "Suspected instruction injection — dictating literally",
                literalTranscript: true
            )
        }

        let words = lowered.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        if words.count > longFormWordCount {
            return IntentDecision(intent: .dictate, confidence: 1, reason: "Long-form dictation")
        }

        let commandShaped = containsCommandMarker(lowered)
        let conversationShaped = containsConversationMarker(lowered)
        // Two independent signals agreeing (interrogative opener AND a terminal question
        // mark, or an edit opener AND an explicit selection reference) are decided locally
        // with deterministic high confidence: no serial classifier call for the clear
        // shapes. Anything with mixed or single-signal shape stays fail-closed behind the
        // classifier.
        if !commandShaped, isClearQuestion(lowered) {
            return IntentDecision(intent: .conversation, confidence: clearShapeConfidence, reason: "Clear question")
        }
        if !conversationShaped, commandShaped, isClearSelectionCommand(lowered) {
            if hasSelection {
                return IntentDecision(
                    intent: .command,
                    confidence: clearShapeConfidence,
                    reason: "Clear edit instruction for the selection"
                )
            }
            // The clear-edit shape without a selection is a fail-closed result: the raw
            // words must be pasted verbatim so an enhancer can never "execute" the
            // instruction by rewriting it.
            return IntentDecision(
                intent: .dictate,
                confidence: 1,
                reason: "Edit instruction without a selection — dictating literally",
                literalTranscript: true
            )
        }
        if conversationShaped || (commandShaped && hasSelection) {
            return nil
        }
        if commandShaped {
            // Command-shaped speech with nothing selected can never become a command, so it
            // pastes immediately instead of waiting on the classifier — and it pastes the
            // raw words verbatim: an enhancer must never get to "execute" an instruction
            // like "make the release tomorrow" by rewriting it.
            return IntentDecision(
                intent: .dictate,
                confidence: 1,
                reason: "No selection for an edit — dictating literally",
                literalTranscript: true
            )
        }
        return IntentDecision(intent: .dictate, confidence: 1, reason: "No command or question markers")
    }

    /// Confidence assigned to locally-decided clear question/command shapes; kept above the
    /// router threshold and below 1 so logs distinguish them from certain decisions.
    public static let clearShapeConfidence = 0.9

    /// Phrases that read as attempts to steer the classifier or reach system surfaces the app
    /// does not have. Matching transcripts are dictated literally without consulting the model.
    static let injectionMarkers: [String] = [
        "ignore previous instructions",
        "ignore all previous instructions",
        "ignore your instructions",
        "disregard your instructions",
        "disregard previous instructions",
        "disregard everything above",
        "disregard the above",
        "override your instructions",
        "new instructions:",
        "you are now",
        "you're now",
        "system prompt",
        "developer message",
        "rm -rf",
        "sudo",
        "run the command",
        "run command",
        "execute the command",
        "run a shell",
        "open the terminal and",
        "shell command",
        "delete all files",
        "format the disk",
        "shut down the computer",
    ]

    static func containsInjectionMarker(_ lowered: String) -> Bool {
        injectionMarkers.contains { lowered.contains($0) }
    }

    /// Leading fillers stripped before checking how an utterance starts.
    private static let leadingFillers: Set<String> = [
        "ok", "okay", "so", "hey", "um", "uh", "please", "now", "alright", "and", "then",
    ]

    /// Openers that suggest an instruction about existing text.
    private static let commandOpeners: [String] = [
        "rewrite", "reword", "rephrase", "translate", "summarize", "summarise", "shorten",
        "expand", "simplify", "capitalize", "capitalise", "lowercase", "uppercase", "bold",
        "fix", "correct", "improve", "polish", "clean", "format", "convert", "turn",
        "make", "change", "replace", "edit", "delete", "remove", "insert", "add",
    ]

    /// Substrings anywhere in the transcript that refer to acting on selected text.
    private static let commandPhrases: [String] = [
        "this text", "the selected", "selected text", "the selection", "this paragraph",
        "this sentence", "make it ", "make this ", "say it better", "more professional",
        "more formal", "more casual", "bullet points", "in spanish", "in french",
        "in german", "in english",
    ]

    static func containsCommandMarker(_ lowered: String) -> Bool {
        let words = meaningfulWords(lowered)
        if let first = words.first, commandOpeners.contains(first) {
            return true
        }
        return commandPhrases.contains { lowered.contains($0) }
    }

    /// Question openers and forms that suggest the user is asking the assistant something.
    private static let conversationOpeners: [String] = [
        "what", "whats", "what's", "why", "how", "when", "where", "who", "whos", "who's",
        "which", "can", "could", "would", "should", "do", "does", "did", "is", "are",
        "tell", "explain", "give", "help", "remind",
    ]

    static func containsConversationMarker(_ lowered: String) -> Bool {
        if lowered.hasSuffix("?") { return true }
        guard let first = meaningfulWords(lowered).first else { return false }
        return conversationOpeners.contains(first)
    }

    /// Interrogative openers that mark an unambiguous question when the utterance also ends
    /// with a question mark. Deliberately narrower than `conversationOpeners`: auxiliary
    /// openers like "can"/"do"/"is" are common in dictated messages and stay ambiguous.
    private static let clearQuestionOpeners: Set<String> = [
        "what", "whats", "what's", "why", "how", "when", "where", "who", "whos", "who's",
        "which",
    ]

    static func isClearQuestion(_ lowered: String) -> Bool {
        guard lowered.hasSuffix("?") else { return false }
        guard let first = meaningfulWords(lowered).first else { return false }
        return clearQuestionOpeners.contains(first)
    }

    /// A clear selection edit requires both an edit opener as the first meaningful word and
    /// an explicit reference to the selected text elsewhere in the utterance.
    static func isClearSelectionCommand(_ lowered: String) -> Bool {
        guard let first = meaningfulWords(lowered).first, commandOpeners.contains(first) else {
            return false
        }
        return commandPhrases.contains { lowered.contains($0) }
    }

    private static func meaningfulWords(_ lowered: String) -> [String] {
        let words = lowered
            .split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .map { $0.trimmingCharacters(in: .punctuationCharacters) }
            .filter { !$0.isEmpty }
        return Array(words.drop(while: { leadingFillers.contains($0) }))
    }
}

// MARK: - Routing

/// Everything the router may consult besides the decision itself. All values are frozen from
/// the recording that produced the transcript, never read from live state.
public struct IntentRoutingContext: Equatable, Sendable {
    public let detectionEnabled: Bool
    public let hasSelection: Bool
    public let accessibilityTrusted: Bool

    public init(detectionEnabled: Bool, hasSelection: Bool, accessibilityTrusted: Bool) {
        self.detectionEnabled = detectionEnabled
        self.hasSelection = hasSelection
        self.accessibilityTrusted = accessibilityTrusted
    }
}

/// The complete, closed set of things a recording may do. There is deliberately no case that
/// reaches the shell, the file system, or any app surface beyond pasting text, rewriting the
/// frozen Accessibility selection, or answering in the Recordings UI.
/// `literalRawTranscript` marks fail-closed pastes: the raw transcript must be delivered
/// verbatim, never a post-processed variant.
public enum RoutedSpeechAction: Equatable, Sendable {
    case paste(reason: String, literalRawTranscript: Bool)
    case answerConversation(reason: String)
    case rewriteSelection(reason: String)
}

/// Pure fail-closed routing: every uncertain, unavailable, low-confidence, or
/// precondition-violating outcome degrades to pasting the literal raw transcript. Only a
/// positive dictation decision (or intent detection being switched off) may paste the
/// post-processed text, because there the enhancement pipeline is the product feature the
/// user asked for — not a misroute.
public enum IntentRouter {
    /// A classifier decision must meet this confidence to leave the dictation path.
    public static let minimumActionableConfidence = 0.8

    public static func route(decision: IntentDecision?, context: IntentRoutingContext) -> RoutedSpeechAction {
        guard context.detectionEnabled else {
            return .paste(reason: "Intent detection disabled", literalRawTranscript: false)
        }
        guard let decision else {
            return .paste(reason: "Intent unavailable — dictated literally", literalRawTranscript: true)
        }
        guard decision.confidence >= minimumActionableConfidence else {
            return .paste(
                reason: "Low confidence (\(formatted(decision.confidence))) — dictated literally",
                literalRawTranscript: true
            )
        }
        switch decision.intent {
        case .dictate:
            return .paste(reason: decision.reason, literalRawTranscript: decision.literalTranscript)
        case .conversation:
            return .answerConversation(reason: decision.reason)
        case .command:
            guard context.accessibilityTrusted else {
                return .paste(reason: "Accessibility unavailable — dictated literally", literalRawTranscript: true)
            }
            guard context.hasSelection else {
                return .paste(reason: "No selected text — dictated literally", literalRawTranscript: true)
            }
            return .rewriteSelection(reason: decision.reason)
        }
    }

    private static func formatted(_ confidence: Double) -> String {
        String(format: "%.2f", confidence)
    }
}

// MARK: - Flow phase

/// Typed Record-page state. The engine owns transitions; views render from this instead of
/// sniffing status strings, so idle/listening/finalizing/processing/ready/error are explicit.
public enum RecordingFlowPhase: Equatable, Sendable {
    case idle
    case listening
    case finalizing
    case processing(String)
    case ready(String)
    case failed(String)

    public var isBusy: Bool {
        switch self {
        case .listening, .finalizing, .processing: return true
        case .idle, .ready, .failed: return false
        }
    }
}

/// A completed conversational answer, bound to the recording generation that produced it so
/// stale replies can never attach to a later recording.
public struct ConversationReply: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let question: String
    public let answer: String
    public let timestamp: Date

    public init(question: String, answer: String, timestamp: Date = Date()) {
        self.id = UUID()
        self.question = question
        self.answer = answer
        self.timestamp = timestamp
    }
}
