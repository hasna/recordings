import Testing
@testable import RecordingsUpdateBroker

struct CanonicalReleaseOrderTests {
    @Test("canonical material uses unsigned UTF-8 byte ordering")
    func unsignedUTF8Ordering() {
        let astral = "\u{10000}"
        let privateUse = "\u{e000}"
        let decomposed = "e\u{301}"
        let precomposed = "\u{e9}"
        let values = [astral, precomposed, privateUse, "z", decomposed, "a"]
        let expected = ["a", decomposed, "z", precomposed, privateUse, astral]

        #expect(CanonicalReleaseOrder.sorted(values) == expected)
        // Swift String equality is normalization-aware. Canonical release
        // ordering intentionally compares the preserved UTF-8 bytes instead.
        #expect(decomposed == precomposed)
        #expect(CanonicalReleaseOrder.unsignedUTF8Precedes(decomposed, precomposed))
        #expect(!CanonicalReleaseOrder.unsignedUTF8Precedes(precomposed, decomposed))
    }
}
