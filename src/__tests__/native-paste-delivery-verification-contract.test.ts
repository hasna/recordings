import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/// `CGEvent.post` returns `Void` and macOS reports no delivery. Until this contract existed
/// the paste path treated "two CGEvents were constructed" as success: `postPaste()` returned
/// true after construction, the coordinator answered `completion(transaction, .pasted)`
/// unconditionally, and the log printed a paste that may never have reached any app. These
/// assertions fail on that shape.
const ENGINE_PATH = "src/native/Recordings/RecordingsLib/RecordingEngine.swift";
const VERIFICATION_PATH = "src/native/Recordings/RecordingsLib/PasteDeliveryVerification.swift";

function engineSource(): string {
  return readFileSync(ENGINE_PATH, "utf8");
}

function verificationSource(): string {
  return readFileSync(VERIFICATION_PATH, "utf8");
}

/// The coordinator body, so "the coordinator never invents a delivery" can be asserted about
/// the state machine itself rather than about the whole file.
function pasteCoordinatorBody(engine: string): string {
  const start = engine.indexOf("final class PasteTransactionCoordinator {");
  const end = engine.indexOf("struct PipelineDeliveryGate", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return engine.slice(start, end);
}

describe("native paste delivery verification contract", () => {
  test("posting a keystroke is not an outcome the coordinator can call pasted", () => {
    const engine = engineSource();
    const coordinator = pasteCoordinatorBody(engine);

    // The two literal shapes of the defect.
    expect(engine).not.toContain("completion(transaction, .pasted)");
    expect(engine).not.toContain("settlement(transaction, .pasted)");
    expect(engine).not.toContain("typealias PastePoster = @MainActor @Sendable () -> Bool");
    expect(engine).toContain(
      "typealias PastePoster = @MainActor @Sendable () -> PasteKeystrokeAttempt",
    );

    // The coordinator cannot name `.pasted` at all: the outcome arrives from the evidence
    // mapping, so there is no branch where a posted event becomes a delivery.
    expect(coordinator).not.toContain(".pasted");
    expect(coordinator).toContain("case .posted:");
    expect(coordinator).toContain(".forDeliveryEvidence(evidence)");
    expect(engine).not.toContain("return .pasted");
  });

  test("the only route to a pasted outcome is confirming read-back evidence", () => {
    const engine = engineSource();
    const mapping = engine.slice(
      engine.indexOf("static func forDeliveryEvidence("),
      engine.indexOf("struct PasteboardWriteResult"),
    );

    expect(mapping).toContain("case .confirmedByFocusedValue, .confirmedBySelectedText: .pasted");
    expect(mapping).toContain("case .notObservedFocusedValueUnchanged: .deliveryNotObserved");
    expect(mapping).toContain("case .unverified(let reason): .deliveredUnverified(reason)");
  });

  test("the paste path reads the target app back and never trusts a single inline read", () => {
    const engine = engineSource();
    const verification = verificationSource();

    // Production wires a real read-back with a non-zero wait: verifying on the posting turn
    // would report "unchanged" for a paste still in flight.
    expect(engine).toContain("PasteDeliveryVerifier.classify(");
    expect(engine).toContain("verificationDelay: Self.pasteReadBackInterval");
    expect(engine).toContain("verificationAttempts: Self.pasteReadBackAttempts");
    expect(engine).toMatch(/nonisolated static let pasteReadBackInterval: TimeInterval = 0\.\d+/);
    expect(engine).toMatch(/nonisolated static let pasteReadBackAttempts = [2-9]/);

    // The read-back is an Accessibility read of the focused element, compared against a
    // baseline captured before the keystroke, and it refuses to compare across a focus move.
    expect(verification).toContain("kAXFocusedUIElementAttribute as CFString");
    expect(verification).toContain("kAXValueAttribute as CFString");
    expect(verification).toContain("kAXSelectedTextAttribute as CFString");
    expect(verification).toContain("guard CFEqual(current, focusedElement) else");
    expect(engine).toContain("deliveryProbe = FocusedTextProbe.capture(pid: app.processIdentifier)");
  });

  test("confirmation requires the field to gain the pasted text, not merely contain it", () => {
    const verification = verificationSource();

    // Containment alone confirms a paste that never happened whenever the field already held
    // the same transcript, so the rule counts occurrences and requires a gain.
    expect(verification).toContain("if occurrencesAfter > occurrencesBefore { return .confirmedByFocusedValue }");
    expect(verification).not.toMatch(/if\s+after\.value\.contains\(pastedText\)/);
    expect(verification).toContain("case notObservedFocusedValueUnchanged");
  });

  test("an unreadable surface degrades to a labelled unverified state, never to pasted", () => {
    const verification = verificationSource();

    expect(verification).toContain("case baselineUnreadable(FocusedTextReadFailure)");
    expect(verification).toContain("case readBackUnreadable(FocusedTextReadFailure)");
    expect(verification).toContain('case valueUnreadable = "focused_value_unreadable"');
    // Every unverified reason prints itself, so the log says which surface refused to answer.
    expect(verification).toMatch(/case \.unverified\(let reason\): "unverified:\\\(reason\.logToken\)"/);
  });

  test("secure input is probed before any event is constructed and refuses the post", () => {
    const engine = engineSource();
    const verification = verificationSource();

    expect(verification).toContain('static let secureInputPIDKey = "kCGSSessionSecureInputPID"');
    expect(verification).toContain("CGSessionCopyCurrentDictionary()");
    // Not knowing is its own state: an unreadable session must never read as "safe to post".
    expect(verification).toContain("case unknown");

    const probeIndex = engine.indexOf("SecureInputProbe.current()");
    const refusalIndex = engine.indexOf("return .refusedSecureInput(holder)");
    const constructionIndex = engine.indexOf("CGEvent(keyboardEventSource: source");
    expect(probeIndex).toBeGreaterThan(-1);
    expect(refusalIndex).toBeGreaterThan(probeIndex);
    expect(constructionIndex).toBeGreaterThan(refusalIndex);
    expect(engine).toContain("case .refusedSecureInput(let holder):");
    expect(engine).toContain("failNow(with: .secureInputActive(holder))");
  });

  test("the delivery log line reports clipboard, keystroke, secure input, and delivery apart", () => {
    const engine = engineSource();
    const verification = verificationSource();

    expect(verification).toContain('"paste_delivery target=');
    for (const field of [
      " chars=",
      " clipboard=",
      " clipboard_change_count=",
      " events=",
      " secure_input=",
      " delivery=",
      " read_back_attempts=",
    ]) {
      expect(verification).toContain(field);
    }
    // Emitted on every completion, including the ones that never reached the keystroke.
    expect(engine).toContain("self.log(PasteDeliveryReport(");
    expect(engine).toContain("attempt: .forOutcome(outcome)");
    expect(engine).toContain("evidence: deliveryEvidence");
  });

  test("the UI reports unverified delivery as its own state instead of success", () => {
    const engine = engineSource();
    const statusKind = engine.slice(
      engine.indexOf("nonisolated static func deliveryStatusKind("),
      engine.indexOf("nonisolated static func pasteTraceStage("),
    );

    expect(engine).not.toContain("kind: posted ? .success : .failure");
    expect(engine).toContain("kind: Self.deliveryStatusKind(for: outcome)");
    expect(statusKind).toContain("case .pasted: .success");
    expect(statusKind).toContain("case .deliveredUnverified: .unverified");
    expect(statusKind).toMatch(/case \.deliveryNotObserved,[\s\S]*?\.eventPostFailed: \.failure/);
    // A recording whose paste is unconfirmed still finished, so the phase stays ready while
    // the message says the delivery is unproven — but it is never folded into `.success`.
    expect(engine).toContain("case .success, .unverified: .ready(message)");
    expect(engine).toContain('"Paste sent, delivery unconfirmed');
    expect(engine).toContain('"Paste did not reach the target app');
    // Both secure-input messages must promise the clipboard, because the clipboard is kept
    // either way — `shouldRestore` returns `false` for this outcome even when `restoreClipboard`
    // was requested. A message that did not say "press Cmd-V" would leave the owner with a
    // clipboard they were never told about; one that said it while restoring would be a lie.
    expect(engine).toContain('"This field blocks typing (secure input) — transcript copied, press Cmd-V"');
    expect(engine).toContain("transcript kept on the clipboard ");
    expect(engine).not.toContain('"Copied — paste blocked by secure input"');
  });

  // The capability this PR adds is that the app reads the FULL text value of whatever field is
  // focused in the target app. That is acceptable only while the read stays in memory. A review
  // established by grep that no added `log(` call interpolates the field value — a grep is not a
  // guard, so these two tests are the guard. They fail the moment a log line, a report field or
  // an evidence token starts carrying user text.
  describe("the focused-field read is not allowed to escape into the log", () => {
    /// Identifiers that hold the user's text rather than a count or a token. `text.count` and
    /// `characterCount` are fine and deliberately not listed.
    const TEXT_BEARING = [
      "pastedText",
      "selectedText",
      "snapshot.value",
      "baseline.value",
      "readBack.value",
      "before.value",
      "after.value",
      "focusedValue",
    ];

    /// Region from `open` at `start` to its matching close. Logging expressions in this codebase
    /// span several lines — `logLine` is a `+`-chain of six string segments — so a per-line scan
    /// misses exactly the case that matters: a segment carrying the text on a continuation line.
    function balancedRegion(source: string, start: number, open: string, close: string): string {
      const from = source.indexOf(open, start);
      if (from === -1) return "";
      let depth = 0;
      for (let index = from; index < source.length; index += 1) {
        const character = source[index];
        if (character === open) depth += 1;
        else if (character === close) {
          depth -= 1;
          if (depth === 0) return source.slice(from, index + 1);
        }
      }
      return source.slice(from);
    }

    /// Every expression whose value reaches the log: `log(...)` calls and the bodies of the
    /// `logLine` / `logToken` computed properties that those calls print.
    function loggingRegions(source: string): string[] {
      const regions: string[] = [];
      for (const match of source.matchAll(/\blog\(/g)) {
        regions.push(balancedRegion(source, match.index ?? 0, "(", ")"));
      }
      for (const match of source.matchAll(/var (?:logLine|logToken)\s*:\s*String\s*\{/g)) {
        regions.push(balancedRegion(source, match.index ?? 0, "{", "}"));
      }
      return regions.filter((region) => region.length > 0);
    }

    function interpolationsIn(region: string): string[] {
      return [...region.matchAll(/\\\(([^)]*)\)/g)].map((match) => match[1] ?? "");
    }

    test("no logging expression interpolates the focused field's text", () => {
      const sources = [
        [ENGINE_PATH, engineSource()],
        [VERIFICATION_PATH, verificationSource()],
      ] as const;

      let inspected = 0;
      for (const [path, source] of sources) {
        for (const region of loggingRegions(source)) {
          inspected += 1;
          for (const interpolation of interpolationsIn(region)) {
            for (const identifier of TEXT_BEARING) {
              expect(
                interpolation.includes(identifier),
                `${path}: a logging expression interpolates ${identifier}: ${region.slice(0, 200)}`,
              ).toBe(false);
            }
          }
        }
      }

      // Guard the guard: if the log lines are ever renamed out from under this, it must fail
      // loudly rather than pass by inspecting nothing.
      expect(inspected).toBeGreaterThan(10);
    });

    test("the delivery report carries counts and tokens, never the text", () => {
      const verification = verificationSource();
      const start = verification.indexOf("struct PasteDeliveryReport");
      const end = verification.indexOf("\n}", start);
      expect(start).toBeGreaterThan(-1);
      const report = verification.slice(start, end);

      // Every stored property, so a new `let pastedText: String` cannot slip in unnoticed.
      const properties = [...report.matchAll(/^\s{4}let (\w+): ([^\n=]+)$/gm)].map((match) => ({
        name: match[1] ?? "",
        type: (match[2] ?? "").trim(),
      }));
      expect(properties.length).toBeGreaterThan(4);
      for (const property of properties) {
        if (property.type !== "String" && property.type !== "String?") continue;
        // The one permitted String is the target's bundle identifier, which is not user text.
        expect(property.name).toBe("targetBundleIdentifier");
      }
    });

    test("the user-facing disclosure exists, because no new permission prompt announces it", () => {
      const readme = readFileSync("README.md", "utf8");

      expect(readme).toContain("What the app reads to confirm a paste");
      expect(readme).toContain("never logged and never persisted");
      // The two limits a reader has to know: the cap, and that no extra permission is asked.
      expect(readme).toContain("20,000 characters");
      expect(readme).toMatch(/No additional permission is requested/);
    });
  });

  test("the Swift regression tests that pin the defect are part of the test target", () => {
    const tests = readFileSync(
      "src/native/Recordings/RecordingsTests/PasteDeliveryVerificationTests.swift",
      "utf8",
    );

    expect(tests).toContain("func postedWithoutEvidenceIsNotPasted()");
    expect(tests).toContain("outcomes == [.deliveredUnverified(.readBackNotAttempted)]");
    expect(tests).toContain("func secureInputRefusesAndReportsItself()");
    expect(tests).toContain("func preexistingTextIsNotEvidence()");
  });
});
