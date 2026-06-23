import Testing
import Foundation
@testable import RecordingsLib

struct TranscriptionResultIdentityTests {
    @Test("Each transcription has a unique id even with identical content and timestamp")
    func uniqueIdentity() {
        let now = Date()
        let a = TranscriptionResult(rawText: "hello", processedText: nil, timestamp: now, projectId: nil, projectName: nil)
        let b = TranscriptionResult(rawText: "hello", processedText: nil, timestamp: now, projectId: nil, projectName: nil)
        // Same content and exact same timestamp must not collide — identity drives
        // SwiftUI ForEach rows and the "copied" indicator.
        #expect(a.id != b.id)
    }

    @Test("displayText prefers processed text over raw")
    func displayTextPrefersProcessed() {
        let r = TranscriptionResult(rawText: "raw", processedText: "processed", timestamp: Date(), projectId: nil, projectName: nil)
        #expect(r.displayText == "processed")
    }
}
