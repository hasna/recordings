import Foundation

/// Deterministic local pre-screen for the CLI's enhancement decision.
///
/// The helper CLI owns the real decision (`needsEnhancement` in `src/lib/enhancer.ts`):
/// in `auto` post-processing mode it rewrites transcripts that carry an explicit
/// configured trigger phrase or an instruction-shaped opening. Delivery may only run
/// ahead of persistence when that rewrite provably cannot happen — the user asked for
/// the rewritten text, so an eligible transcript must keep pasting the helper's output.
///
/// This screen therefore mirrors the CLI's detection *conservatively*: it answers
/// "may the helper enhance this?" and fails closed (true) whenever it cannot decide.
/// The trigger list is config-owned and arrives as the same frozen JSON array the
/// engine already forwards to the helper via `--enhance-triggers-json`, so both sides
/// read one source of truth for the configurable half. The instruction patterns mirror
/// the CLI's built-in regexes; `EnhancementScreenTests` and the `enhancer.test.ts`
/// "cross-language fixture" suite pin both implementations to one shared fixture table
/// so they cannot drift apart silently.
public enum EnhancementScreen {
    /// Built-in instruction shapes, mirrored from `instructionPatterns` in
    /// `src/lib/enhancer.ts`. Order and wording must match the CLI; the shared fixture
    /// tests fail when either side changes alone.
    static let instructionPatternSources: [String] = [
        #"(?:write|draft|compose|create)\s+(?:an?\s+)?(?:email|message|response|reply|letter|note|text|slack|dm)"#,
        #"(?:give|provide|send)\s+(?:them|him|her|it|the\s+agent|the\s+team)\s+(?:full\s+)?instructions"#,
        #"(?:tell|ask)\s+(?:them|him|her|it|the\s+agent)\s+(?:to|that)"#,
        #"(?:make\s+it|make\s+this)\s+(?:sound|look|read)\s+(?:more\s+)?(?:professional|formal|casual|friendly|better)"#,
        #"(?:ok\s+so|okay\s+so|alright\s+so)\s+(?:say|write|tell|put)"#,
        #"(?:i\s+need|i\s+want)\s+(?:the\s+agent|it|them|you)\s+to\s+(?:build|create|implement|design|make)"#,
    ]

    private static let instructionPatterns: [NSRegularExpression]? = {
        var patterns: [NSRegularExpression] = []
        for source in instructionPatternSources {
            guard let pattern = try? NSRegularExpression(
                pattern: source,
                options: [.caseInsensitive]
            ) else { return nil }
            patterns.append(pattern)
        }
        return patterns
    }()

    /// True when the helper CLI could rewrite `text` in `auto` mode — or when this
    /// screen cannot prove it will not (malformed trigger JSON, an unbuildable
    /// pattern): enhancement-eligible speech must never be pasted raw ahead of the
    /// helper, so every unprovable case persists first.
    public static func mayRequireEnhancement(text: String, enhanceTriggersJSON: String) -> Bool {
        guard let triggers = decodeTriggers(enhanceTriggersJSON) else { return true }
        let lowered = text.lowercased()
        for trigger in triggers {
            let loweredTrigger = trigger.lowercased()
            // An EMPTY configured trigger matches EVERYTHING in the CLI:
            // `needsEnhancement` tests `lower.includes(trigger.toLowerCase())` and
            // JavaScript's `includes("")` is true for every string, so one empty row
            // makes the helper rewrite every transcript (MEASURED on the CLI:
            // needs=true, reason `Explicit trigger: ""`). This screen must answer
            // may-enhance for the same input or it admits that speech to
            // paste-before-persistence and pastes raw text where the user asked for
            // the rewrite.
            //
            // Special-cased rather than left to `contains`, because Swift's answer for
            // an empty needle depends on which overload resolves — Foundation's
            // `range(of:)`-based one answers false, the stdlib `Collection` one answers
            // true — and NO machine has ever executed this file, so neither answer may
            // be assumed. That overload claim is an UNVERIFIED INFERENCE from the
            // language, not a measurement; `return true` is the fail-closed answer
            // under either.
            guard !loweredTrigger.isEmpty else { return true }
            if lowered.contains(loweredTrigger) { return true }
        }

        guard let instructionPatterns else { return true }
        let range = NSRange(text.startIndex..., in: text)
        return instructionPatterns.contains { pattern in
            pattern.firstMatch(in: text, range: range) != nil
        }
    }

    /// Decodes the frozen trigger array the engine forwards to the helper. An empty
    /// string means "no configured triggers" (the built-in patterns still apply);
    /// anything else must parse as a JSON string array or the screen fails closed.
    private static func decodeTriggers(_ json: String) -> [String]? {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        guard let data = trimmed.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data)
        else { return nil }
        return decoded
    }
}
