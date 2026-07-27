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

    /**
     * Names that hold the user's text, closed over assignment.
     *
     * A fixed denylist of eight identifier substrings is not a leak guard, it is a spelling test:
     * `let fieldContents = observed.value` followed by `log("field=\(fieldContents)")` writes the
     * target app's focused-field text — password fields included — into
     * `~/.hasna/recordings/Recordings.log` in plaintext, and every assertion stayed green because
     * `fieldContents` is not on the list. One `let` breaks the chain.
     *
     * So the taint is propagated instead: seeded from the denylist plus any `.value` read (the AX
     * accessor that returns the text) and any `.read(let x)` / `.readBack()` binding, then closed
     * transitively over `let`/`var`/`guard let`/`if let`/`case let` bindings and over
     * `_ = <tainted>` reassignment until it stops growing.
     */
    function taintedIdentifiers(source: string): Set<string> {
      const tainted = new Set<string>(TEXT_BEARING);
      /// A snapshot binding carries the text even before `.value` is read off it, so interpolating
      /// the binding itself would print the struct — text and all.
      for (const match of source.matchAll(/case\s+\.read\((?:let|var)\s+(\w+)\)/g)) {
        tainted.add(match[1] ?? "");
      }

      /// Propagation is through ACCESS, not through calls. `let x = observed.value` is the text;
      /// `let ok = writeClipboardAttempt(text, …)` is a Bool that merely touched some. Taking the
      /// leading access chain — everything up to the first `(` — keeps
      /// `snapshot.value.trimmingCharacters(…)` tainted while leaving a function whose ARGUMENT is
      /// tainted alone, which is what a whole-expression match got wrong.
      const isTainted = (expression: string): boolean => {
        const chain = (expression.split("(")[0] ?? "").trim();
        if (!chain) return false;
        if (/(?:^|[^.\w])(?:\w+\.)*(?:value|readBack)\b/.test(chain)) return true;
        return [...tainted].some((identifier) => {
          const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // A count derived from the text is not the text.
          if (new RegExp(`${escaped}\\s*\\.\\s*count\\b`).test(chain)) return false;
          return new RegExp(`(?:^|[^.\\w])${escaped}\\b`).test(chain);
        });
      };

      const bindings = [
        ...source.matchAll(/(?:let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^\n]+)/g),
        ...source.matchAll(/(?:if|guard)\s+(?:let|var)\s+(\w+)\s*=\s*([^\n,{]+)/g),
      ];
      // Fixed point: `a = snapshot.value; b = a; c = b` must all be tainted, and source order
      // cannot be relied on.
      for (let pass = 0; pass < 8; pass += 1) {
        const before = tainted.size;
        for (const binding of bindings) {
          const name = binding[1] ?? "";
          if (!name || tainted.has(name)) continue;
          if (isTainted(binding[2] ?? "")) tainted.add(name);
        }
        if (tainted.size === before) break;
      }
      return tainted;
    }

    test("no logging expression interpolates the focused field's text", () => {
      const sources = [
        [ENGINE_PATH, engineSource()],
        [VERIFICATION_PATH, verificationSource()],
      ] as const;

      let inspected = 0;
      let checked = 0;
      for (const [path, source] of sources) {
        const tainted = taintedIdentifiers(source);
        for (const region of loggingRegions(source)) {
          inspected += 1;
          for (const interpolation of interpolationsIn(region)) {
            for (const identifier of tainted) {
              checked += 1;
              expect(
                new RegExp(`(?:^|[^.\\w])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
                  interpolation,
                ) && !new RegExp(`${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*count\\b`).test(interpolation),
                `${path}: a logging expression interpolates text-bearing ${identifier}: ${region.slice(0, 200)}`,
              ).toBe(false);
            }
          }
        }
      }

      // Guard the guard: if the log lines are ever renamed out from under this, it must fail
      // loudly rather than pass by inspecting nothing. `checked` proves the taint set was
      // non-empty too — an empty set would make every interpolation trivially clean.
      expect(inspected).toBeGreaterThan(10);
      expect(checked).toBeGreaterThan(10);
    });

    /**
     * Defence in depth, and the structurally cheaper half: the `prepare:` and `verify:` closures
     * are the only places holding a `FocusedTextSnapshot`, so nothing inside them needs to log at
     * all. Forbidding the sink outright means a future leak has to first move the code somewhere
     * the taint analysis above is watching.
     */
    test("the closures that hold the focused-field read do not log at all", () => {
      const engine = engineSource();
      for (const closure of ["prepare: {", "verify: {"]) {
        const start = engine.indexOf(closure);
        expect(start, `closure not found: ${closure}`).toBeGreaterThan(-1);
        const region = balancedRegion(engine, start + closure.length - 1, "{", "}");
        expect(region.length).toBeGreaterThan(0);
        expect(region, `${closure} must not reach the log`).not.toMatch(/\blog\(/);
      }
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

  /**
   * The read-back is a superset of the old detector for "did the text land" and a strict SUBSET for
   * "why not". `#29`'s original commit probed secure input twice — once before constructing the
   * events and once after posting them — and the consolidation kept only the first.
   *
   * The case that loses: a password field takes secure input AFTER the pre-post probe and while the
   * events are posted. The window server drops the keystroke, the coordinator answers `.posted`, and
   * the read-back — two AX reads of the focused field — has no vocabulary for secure input at all,
   * topping out at `.notObservedFocusedValueUnchanged` / `.unverified(.readBackUnreadable)`. So the
   * outcome is `.deliveryNotObserved` or `.deliveredUnverified`, neither of which is an
   * `isSecureInputOutcome`, and nothing is persisted: no warning icon, no VoiceOver "blocked" label,
   * and no "press Cmd-V" — the only thing telling the owner the transcript is recoverable.
   *
   * Worse than silent: `lastPasteSecureInputProbe` still held the PRE-post reading, so the delivery
   * log recorded `secureInput=inactive` for a paste secure input had actually eaten. It did not omit
   * the cause, it asserted the opposite.
   */
  test("secure input is probed again after the keystroke is posted, and the log follows the later reading", () => {
    const engine = engineSource();
    const poster = engine.slice(
      engine.indexOf("postPaste: { [weak self] in"),
      engine.indexOf("return .posted"),
    );
    expect(poster.length).toBeGreaterThan(0);

    // Two probes, and the second one after both posts.
    const probes = [...poster.matchAll(/SecureInputProbe\.current\(\)/g)];
    expect(probes.length).toBe(2);
    const secondProbe = poster.lastIndexOf("SecureInputProbe.current()");
    for (const post of ["down.post(tap: .cgSessionEventTap)", "up.post(tap: .cgSessionEventTap)"]) {
      const at = poster.indexOf(post);
      expect(at, `missing post call: ${post}`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(secondProbe);
    }

    // The later reading refuses the delivery AND becomes what the log reports, or the report still
    // says `secureInput=inactive` for the paste it just lost.
    const afterPost = poster.slice(secondProbe);
    expect(afterPost).toMatch(/if case \.active\(let holder\) = secureInputAfterPost/);
    expect(afterPost).toContain("lastPasteSecureInputProbe = secureInputAfterPost");
    expect(afterPost).toContain("return .refusedSecureInput(holder)");

    // And `.refusedSecureInput` is still the route to the outcome that persists a reason, so the
    // recheck actually reaches a surface rather than only the log.
    expect(engine).toContain(".secureInputActive(holder)");
    expect(engine).toContain("Self.isSecureInputOutcome(outcome) ? message : nil");
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
