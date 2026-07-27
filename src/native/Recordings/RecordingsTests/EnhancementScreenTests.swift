import Foundation
import Testing
@testable import RecordingsLib

// MARK: - Cross-language enhancement fixtures

/// Fixture table shared verbatim with `src/__tests__/enhancer.test.ts`
/// ("cross-language fixtures pinned to EnhancementScreenTests.swift"). The CLI's
/// `needsEnhancement` and the app's `EnhancementScreen` must agree on every row;
/// change either implementation and both suites must be updated together.
enum EnhancementFixtures {
    /// The default trigger list from `src/lib/config.ts`, frozen the same way the
    /// engine forwards it to the helper (`--enhance-triggers-json`).
    static let defaultTriggersJSON = """
    ["say it better","rewrite this","make it sound","clean this up","fix this",\
    "rephrase","write it properly","make it professional","improve this","polish this"]
    """

    /// Rows the CLI enhances in `auto` mode: one per built-in instruction pattern,
    /// plus an explicit configured trigger.
    static let mayEnhance: [String] = [
        "this is my draft say it better",
        "write an email to the team about the outage",
        "give them full instructions for the deploy",
        "tell them to restart the ingest service",
        "make this sound more professional",
        "okay so write that we are postponing the launch",
        "i need the agent to build a dashboard for the metrics",
    ]

    /// Rows the CLI passes through untouched, including near-misses of the
    /// instruction patterns ("draft beer", "asked them").
    static let plainDictation: [String] = [
        "meet me at noon by the north entrance",
        "the deploy finished and the metrics look stable",
        "draft beer is better than bottled in my opinion",
        "she asked them about the schedule yesterday",
    ]
}

struct EnhancementScreenTests {
    @Test("every enhancement-eligible fixture is screened as may-enhance")
    func detectsEligibleRows() {
        for text in EnhancementFixtures.mayEnhance {
            #expect(
                EnhancementScreen.mayRequireEnhancement(
                    text: text,
                    enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
                ),
                "expected may-enhance: \(text)"
            )
        }
    }

    @Test("plain dictation fixtures are provably not enhanceable")
    func passesPlainDictation() {
        for text in EnhancementFixtures.plainDictation {
            #expect(
                !EnhancementScreen.mayRequireEnhancement(
                    text: text,
                    enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
                ),
                "expected plain dictation: \(text)"
            )
        }
    }

    @Test("trigger matching is case-insensitive, like the CLI's")
    func caseInsensitiveTriggers() {
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "REWRITE THIS whole paragraph",
            enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
        ))
    }

    @Test("an empty trigger payload still applies the built-in instruction patterns")
    func emptyTriggersKeepPatterns() {
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "write an email to the team about the outage",
            enhanceTriggersJSON: ""
        ))
        #expect(!EnhancementScreen.mayRequireEnhancement(
            text: "meet me at noon by the north entrance",
            enhanceTriggersJSON: ""
        ))
    }

    @Test("an empty trigger STRING inside the payload fails closed to may-enhance")
    func emptyTriggerRowFailsClosed() {
        // The CLI's `lower.includes("")` is true for every transcript, so one empty row in the
        // configured list means the helper rewrites everything. The mirror special-cases the row
        // instead of testing it, because Swift's answer for an empty needle depends on which
        // `contains` overload resolves and nothing executes this suite (see EnhancementScreen).
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "meet me at noon by the north entrance",
            enhanceTriggersJSON: #"[""]"#
        ))
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "meet me at noon by the north entrance",
            enhanceTriggersJSON: #"["rewrite this",""]"#
        ))
    }

    @Test("undecodable trigger payloads fail closed to may-enhance")
    func malformedTriggersFailClosed() {
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "meet me at noon by the north entrance",
            enhanceTriggersJSON: "not json"
        ))
        #expect(EnhancementScreen.mayRequireEnhancement(
            text: "meet me at noon by the north entrance",
            enhanceTriggersJSON: #"{"triggers":[]}"#
        ))
    }
}

// MARK: - Paste-before-persistence in auto mode

struct AutoModePasteBeforePersistenceTests {
    @Test("auto mode pastes plain dictation ahead of persistence")
    func autoDictationPastesFirst() {
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.auto.rawValue,
            transcript: "meet me at noon by the north entrance",
            hasSelection: false,
            intentDetectionEnabled: true,
            enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
        ))
    }

    @Test("auto mode persists first whenever the helper could rewrite the transcript")
    func autoEnhanceableSpeechPersistsFirst() {
        for text in EnhancementFixtures.mayEnhance {
            #expect(
                !RecordingEngine.shouldPasteBeforePersistence(
                    postProcessingMode: PostProcessingMode.auto.rawValue,
                    transcript: text,
                    hasSelection: false,
                    intentDetectionEnabled: true,
                    enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
                ),
                "expected persist-first: \(text)"
            )
        }
    }

    @Test("auto mode still defers to the intent screens for non-dictation shapes")
    func autoNonDictationPersistsFirst() {
        // Question-shaped speech may become a conversation — persist first.
        #expect(!RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.auto.rawValue,
            transcript: "what's the capital of France?",
            hasSelection: false,
            intentDetectionEnabled: true,
            enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
        ))
    }

    @Test("auto mode fails closed to persist-first on a malformed trigger payload")
    func autoMalformedTriggersPersistFirst() {
        #expect(!RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.auto.rawValue,
            transcript: "meet me at noon by the north entrance",
            hasSelection: false,
            intentDetectionEnabled: true,
            enhanceTriggersJSON: "not json"
        ))
    }

    @Test("always mode keeps persisting first even for plain dictation")
    func alwaysModePersistsFirst() {
        #expect(!RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.always.rawValue,
            transcript: "meet me at noon by the north entrance",
            hasSelection: false,
            intentDetectionEnabled: true,
            enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
        ))
    }

    @Test("off mode is unchanged by the trigger payload")
    func offModeUnchanged() {
        #expect(RecordingEngine.shouldPasteBeforePersistence(
            postProcessingMode: PostProcessingMode.off.rawValue,
            transcript: "this is my draft say it better",
            hasSelection: false,
            intentDetectionEnabled: true,
            enhanceTriggersJSON: EnhancementFixtures.defaultTriggersJSON
        ))
    }
}
