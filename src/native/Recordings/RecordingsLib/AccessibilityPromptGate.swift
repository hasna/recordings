import Foundation
@preconcurrency import ApplicationServices

public struct AccessibilityTrustResult: Sendable, Equatable {
    public let trusted: Bool
    public let didPrompt: Bool
}

/// Limits automatic Accessibility prompting to one attempt for the lifetime of a process.
/// Explicit user actions may request again, while ordinary trust checks never prompt.
public final class AccessibilityPromptGate: @unchecked Sendable {
    public static let processShared = AccessibilityPromptGate()

    private let lock = NSLock()
    private var automaticPromptAttempted = false
    private var promptRequests = 0

    public init() {}

    public var promptRequestCount: Int {
        lock.withLock { promptRequests }
    }

    public func trustForProtectedOperation() -> AccessibilityTrustResult {
        trustForProtectedOperation(
            isTrusted: { AXIsProcessTrusted() },
            requestPrompt: { AccessibilityPromptGate.requestSystemPrompt() }
        )
    }

    public func trustForProtectedOperation(
        isTrusted: () -> Bool,
        requestPrompt: () -> Bool
    ) -> AccessibilityTrustResult {
        if isTrusted() {
            return AccessibilityTrustResult(trusted: true, didPrompt: false)
        }

        let shouldPrompt = lock.withLock {
            guard !automaticPromptAttempted else { return false }
            automaticPromptAttempted = true
            promptRequests += 1
            return true
        }
        guard shouldPrompt else {
            return AccessibilityTrustResult(trusted: false, didPrompt: false)
        }
        return AccessibilityTrustResult(trusted: requestPrompt(), didPrompt: true)
    }

    public func requestExplicitly() -> AccessibilityTrustResult {
        requestExplicitly { AccessibilityPromptGate.requestSystemPrompt() }
    }

    public func requestExplicitly(_ requestPrompt: () -> Bool) -> AccessibilityTrustResult {
        lock.withLock {
            automaticPromptAttempted = true
            promptRequests += 1
        }
        return AccessibilityTrustResult(trusted: requestPrompt(), didPrompt: true)
    }

    private static func requestSystemPrompt() -> Bool {
        AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
    }
}
