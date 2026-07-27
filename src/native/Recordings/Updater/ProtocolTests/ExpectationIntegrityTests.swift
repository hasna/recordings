import Testing

/// Positive and negative controls for the test framework itself.
///
/// Package.swift pins swift-testing to a revision that does not match the compiler, because the
/// matching 6.3.x line hard-links a toolchain library that is not on SwiftPM's search path. The
/// rule that pin was standing in for — "the shim must track the compiler" — exists because a
/// mismatched shim once corrupted `#expect` Bool-comparison evaluation and passed false
/// assertions. A silently-passing `#expect` makes every other test in this package meaningless,
/// and no green run can reveal it.
///
/// These assert the property directly. The negative controls matter more than the positive ones:
/// `withKnownIssue` fails when its body records *no* issue, so if `#expect` ever stops evaluating
/// a false comparison, this suite goes red instead of the whole suite going quietly green.
struct ExpectationIntegrityTests {
    @Test("#expect admits true Bool comparisons")
    func admitsTrueComparisons() {
        #expect(true == true)
        #expect(false == false)
        #expect(true != false)
        #expect((1 == 1) == true)
        #expect((1 == 2) == false)
    }

    @Test("#expect records an issue for a false Bool comparison")
    func recordsIssueForFalseEquality() {
        withKnownIssue("a false Bool comparison must be recorded, not passed") {
            #expect(false == true)
        }
    }

    @Test("#expect records an issue for a false Bool inequality")
    func recordsIssueForFalseInequality() {
        withKnownIssue("an untrue inequality must be recorded, not passed") {
            #expect(true != true)
        }
    }

    @Test("#expect records an issue for a false comparison behind a variable")
    func recordsIssueForFalseComparisonThroughVariables() {
        // The reported corruption involved comparison *evaluation*, so route the operands
        // through variables rather than literals the optimiser can fold away.
        let left = Int.random(in: 1...1)
        let right = left + 1
        #expect(left != right)
        withKnownIssue("a false comparison between variables must be recorded") {
            #expect(left == right)
        }
    }

    @Test("#require unwraps a present optional")
    func requireUnwrapsPresentOptional() throws {
        // Only the positive direction is asserted here. The negative direction — `#require(nil)`
        // — throws by design, and wrapping it in `withKnownIssue` additionally records an
        // "API was misused" issue, so it adds noise rather than coverage. The Bool-comparison
        // controls above are what the reported corruption was actually about.
        let present: Int? = 7
        #expect(try #require(present) == 7)
    }
}
