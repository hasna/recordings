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
    expect(engine).toContain("typealias PastePoster = @MainActor @Sendable () -> PasteAttempt");

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
    expect(engine).toContain('"Copied — paste blocked by secure input"');
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
