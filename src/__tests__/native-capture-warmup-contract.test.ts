import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Guards the fix for a silently-swallowed short press.
 *
 * `AVAudioEngine.start()` returns roughly 100 ms before the input tap delivers its first
 * sample (measured cold: `native recorder started` at +541 ms, first PCM chunk at +644 ms).
 * The engine used to flip `isRecording` on `start()` returning, so a trigger released in that
 * window skipped the "cancelling pending start" branch that exists for exactly this case and
 * ran the whole transcription pipeline over an empty buffer — no text, no visible error.
 *
 * The Swift test suite covers the behaviour; these assertions are the structural half, because
 * they are checkable on a machine with no Swift toolchain. They are deliberately scoped to the
 * two things that cannot regress without reintroducing the bug: where `isRecording` is set, and
 * whether the visible surface is actually wired to the new state.
 */
const root = "src/native/Recordings";

function read(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

/** Slice of `source` from the first occurrence of `start` up to the next `end` after it. */
function region(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing terminator after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** Body of a Swift method declared at four-space indentation. */
function methodBody(source: string, declaration: string): string {
  return region(source, declaration, "\n    }\n");
}

describe("native capture warm-up contract", () => {
  test("isRecording is set by the first PCM chunk, never by recorder.start() returning", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");

    const startBlock = region(engine, "try recorder.start()", "} catch {");
    expect(startBlock).toContain("isWarmingUpCapture = true");
    expect(
      startBlock,
      "recorder.start() returning is warm-up, not captured audio",
    ).not.toContain("isRecording = true");

    const callback = region(
      engine,
      "let confirmCapture: @MainActor @Sendable (UInt64) -> Void",
      "try recorder.start()",
    );
    expect(callback).toContain("let recorder = recorderFactory");
    expect(callback).toContain("received first PCM chunk");
    expect(callback).toContain("Task { @MainActor in confirmCapture(captureGeneration) }");
    expect(callback).toContain("self?.confirmCaptureIsLive(generation: generation)");

    const confirm = methodBody(
      engine,
      "private func confirmCaptureIsLive(generation: UInt64) {",
    );
    expect(confirm).toContain("isRecording = true");
    // Generation-bound: a buffer already in the recorder's delivery queue must not revive an
    // attempt that a key-up has already torn down.
    expect(confirm).toContain("guard generation == recordingGeneration");
    expect(confirm).toContain("isWarmingUpCapture");
  });

  test("a release with no audio yet cancels, and the cancel actually tears the capture down", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");

    const release = methodBody(engine, "func handleTriggerRelease(_ trigger: RecordingTrigger) {");
    expect(release).toContain("guard isRecording else {");
    expect(release).toContain("cancelPendingStart()");

    const cancelPending = methodBody(engine, "private func cancelPendingStart() {");
    expect(cancelPending).toContain("isWarmingUpCapture");
    expect(cancelPending).toContain("abandonWarmingCapture(");

    // The old cancel branch only reset intent, because it could only be reached before
    // anything had started. It is now reachable with an open microphone and a realtime
    // session mid-handshake, so it has to close both.
    const abandon = methodBody(
      engine,
      "private func abandonWarmingCapture(reason: String, alert: RecordingAttemptAlert?) {",
    );
    for (const teardown of [
      "recordingGeneration &+= 1",
      "recordingTimer?.invalidate()",
      "recorder?.stop()",
      "realtimeClient?.stop()",
      "streamingTask?.cancel()",
      "pcmStreamPipe?.cancel()",
      "activeCaptureConfiguration = nil",
      "resetRecordingIntent()",
      // Without this the engine wedges: the start gate refuses every later press and no
      // teardown path runs again. Asserted explicitly — a reviewer deleted this line and the
      // rest of this suite stayed green.
      "isWarmingUpCapture = false",
      "isRecording = false",
    ]) {
      expect(abandon, `abandon path must include: ${teardown}`).toContain(teardown);
    }
    expect(abandon, "an empty buffer must never enter the pipeline").not.toContain(
      "stopAndTranscribe()",
    );

    // `recorder?.stop()` being present is not enough: capturing `nativeRecorder` *after*
    // nil-ing it makes the call a silent no-op and leaves the microphone open with the macOS
    // in-use indicator lit. The capture must precede the clear.
    const captured = abandon.indexOf("let recorder = nativeRecorder");
    const cleared = abandon.indexOf("nativeRecorder = nil");
    const stopped = abandon.indexOf("recorder?.stop()");
    expect(captured, "abandon must capture nativeRecorder before clearing it").toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(captured);
    expect(stopped).toBeGreaterThan(cleared);
    // Bumping the generation before stopping the recorder is what makes the
    // `finalizeConverterTail` chunk harmless: it arrives stale and fails the guard in
    // `confirmCaptureIsLive`. Order is load-bearing, not incidental.
    expect(abandon.indexOf("recordingGeneration &+= 1")).toBeLessThan(stopped);

    // M2: ordering is not enough — the stop must also be REACHABLE. `guard isWarmingUpCapture`
    // plus `confirmCaptureIsLive` make `isRecording` always false in this body, so wrapping the
    // stop in `if isRecording { }` preserves every string and every index above while leaving
    // the microphone open and the macOS in-use indicator lit. Nothing may guard it.
    const stopLine = abandon.slice(abandon.lastIndexOf("\n", stopped) + 1, abandon.indexOf("\n", stopped));
    expect(stopLine.trim(), "recorder?.stop() must stand alone, not trail a condition").toBe(
      "recorder?.stop()",
    );
    // A7: `defer { recorder?.stop() }` on its own line satisfies the trim check above and
    // contains none of the tokens below, so `defer` is named explicitly.
    const beforeStop = abandon.slice(captured, stopped);
    for (const conditional of ["if ", "guard ", "switch ", "defer"]) {
      expect(
        beforeStop,
        `recorder?.stop() must not be conditional (found "${conditional}" between capture and stop)`,
      ).not.toContain(conditional);
    }

    // A6: scanning only from the capture line leaves the space ABOVE it unchecked, and an early
    // return there is worse than a guarded stop — `guard isWarmingUpCapture else { return }`
    // makes the flag true for the whole body, so `if isWarmingUpCapture { return }` inserted
    // before the capture is an UNCONDITIONAL bail: no teardown, no disclosure, microphone left
    // open, engine wedged. Every string, index and ordering assertion still passes. So scan the
    // whole body up to the stop, starting just past the opening guard, which owns the only
    // legitimate `return`.
    const openingGuard = "guard isWarmingUpCapture else { return }";
    const guardEnds = abandon.indexOf(openingGuard);
    expect(guardEnds, `abandon must open with: ${openingGuard}`).toBeGreaterThan(-1);
    const bodyBeforeStop = abandon.slice(guardEnds + openingGuard.length, stopped);
    expect(
      bodyBeforeStop,
      "nothing may return between the opening guard and the microphone being released",
    ).not.toMatch(/\breturn\b/);
    for (const conditional of ["if ", "guard ", "switch ", "defer"]) {
      expect(
        bodyBeforeStop,
        `no branch may precede the microphone release (found "${conditional}")`,
      ).not.toContain(conditional);
    }

    // M3: the disclosure calls `updateStatus()`, which early-returns while `captureIsActive`.
    // Disclosing before the flags are cleared leaves the Record pane showing a live recording
    // that already ended.
    const disclosed = abandon.indexOf("discloseEmptyAttempt(");
    expect(disclosed, "abandon must disclose the outcome").toBeGreaterThan(-1);
    expect(
      abandon.indexOf("isWarmingUpCapture = false"),
      "the warm-up flag must be cleared before the disclosure, or updateStatus() no-ops",
    ).toBeLessThan(disclosed);
    expect(abandon.indexOf("isRecording = false")).toBeLessThan(disclosed);

    // A recorder that throws must not leave the warming flag set either.
    const catchBlock = region(engine, 'log("native recorder failed error=', "\n        }\n");
    expect(catchBlock, "the failed-start path must clear the warming flag").toContain(
      "isWarmingUpCapture = false",
    );

    // Stop and Discard are live during warm-up, so neither may fall through the
    // `guard isRecording` that used to make them no-ops.
    const stop = region(
      engine,
      "public func stopAndTranscribe() {",
      "let pipelineTrace = RecordingPipelineTrace()",
    );
    expect(stop).toContain("if isWarmingUpCapture {");
    expect(stop).toContain("abandonWarmingCapture(");

    const cancel = region(engine, "public func cancelRecording() {", 'log("cancelRecording")');
    expect(cancel).toContain("if isWarmingUpCapture {");
    expect(cancel).toContain("abandonWarmingCapture(");
  });

  test("warm-up closes the start gate so a second start cannot open a second recorder", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");

    const gate = methodBody(engine, "nonisolated static func canBeginRecording(");
    expect(gate).toContain("!isWarmingUpCapture");
    // No default. `false` is the permissive value for a safety input, so a caller that forgot
    // it would compile and read as startable mid-warm-up.
    expect(gate).toContain("isWarmingUpCapture: Bool,");
    expect(gate, "a defaulted safety input silently reopens the hole").not.toContain(
      "isWarmingUpCapture: Bool = false",
    );

    // Every caller of the gate has to pass it, or the gate is decorative.
    const callSites = engine.match(/canBeginRecording\(/g) ?? [];
    const passedSites = engine.match(/isWarmingUpCapture: (self\.)?isWarmingUpCapture/g) ?? [];
    expect(passedSites.length, "every canBeginRecording call must pass warm-up").toBe(
      callSites.length - 1, // the declaration itself
    );

    // A press refused *because of* warm-up must say so. `logIgnoredTrigger` exists to end
    // exactly this silence, and omitting the field prints every reason as false.
    const ignored = methodBody(engine, "private func logIgnoredTrigger(_ trigger: RecordingTrigger) {");
    expect(ignored, "the refusal log must name the warm-up state").toContain(
      "isWarmingUpCapture=",
    );
  });

  test("the outcome is visible on the menu-bar glyph, not only in a status line behind a click", () => {
    const alert = read("RecordingsLib/RecordingAttemptAlert.swift");
    const presentation = read("RecordingsLib/MenuBarPresentation.swift");
    const view = read("App/MenuBarStatusView.swift");
    const engine = read("RecordingsLib/RecordingEngine.swift");

    // One published field, one writer. `blockedReason` already exists for "the app cannot do
    // the thing you asked", already reaches the always-visible glyph with its own icon and
    // VoiceOver label, and is already cleared by the next start. A second published field for
    // the same idea would undo the collapse that field exists to be — so the empty-attempt
    // messages are routed through it rather than carrying a surface of their own.
    expect(engine, "no parallel disclosure field").not.toContain("var attemptAlert");
    const writes = engine.match(/^\s*blockedReason = /gm) ?? [];
    expect(writes.length, "blockedReason must keep exactly one writer").toBe(1);
    const disclose = methodBody(
      engine,
      "private func discloseEmptyAttempt(_ alert: RecordingAttemptAlert) {",
    );
    expect(disclose).toContain("setBlockedReason(alert.message, for: .pressConsumed)");
    expect(disclose).toContain("updateStatus()");
    // The pre-existing completed-but-empty recording was equally invisible and gets the same
    // disclosure — and it must be the SAME message. `MenuBarPresentation` renders the blocked
    // state as `statusText = blockedReason`, so disclosing the generic constant while `finish`
    // holds a specific `failureStatus` silently replaces the specific diagnosis with
    // "No audio captured" in every surface that reads the presentation.
    const noAudio = region(engine, 'log("no audio captured")', "\n                }\n");
    expect(noAudio).toContain(
      "let failure = resolved.failureStatus ?? RecordingAttemptAlert.noAudioCaptured.message",
    );
    expect(noAudio).toContain("self.finish(failure)");
    expect(noAudio).toContain("self.setBlockedReason(failure, for: .pressConsumed)");
    expect(
      noAudio,
      "the disclosure must reuse finish()'s message, not substitute the generic one",
    ).not.toContain("setBlockedReason(\n");
    // No timer: a badge that expires on a surface the user had no reason to watch is not a
    // disclosure. This one survives until the next recording.
    expect(alert, "the message vocabulary must not own a lifetime").not.toContain(
      "visibleDuration",
    );
    expect(engine).not.toContain("attemptAlertTask");

    expect(presentation).toContain("if isRecording || isWarmingUpCapture {");
    // No default on the warm-up argument: `false` is the invisible value, so a surface that
    // forgot it would compile and drop the glyph to busy mid-hold.
    expect(presentation).not.toContain("isWarmingUpCapture: Bool = false");
    expect(presentation).toContain("isWarmingUpCapture: Bool,");

    // Every construction in the app and its tests must state it, including the runtime smoke
    // probe, which omitted it entirely while a default existed.
    for (const file of [
      "App/MenuBarStatusView.swift",
      "App/RuntimeSmoke.swift",
      "RecordingsTests/MenuBarPresentationTests.swift",
      "RecordingsTests/RecordingEngineDeliveryTests.swift",
    ]) {
      const source = read(file);
      const sites = source.match(/MenuBarPresentation\(\n(?:.*\n)*?\s*\)/g) ?? [];
      expect(sites.length, `no MenuBarPresentation call sites found in ${file}`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(site, `${file}: call site omits isWarmingUpCapture`).toContain("isWarmingUpCapture:");
      }
    }

    // Both menu-bar surfaces — the always-on label and the popover — must forward warm-up, or
    // the engine tracks it and nothing on screen changes.
    expect(view.match(/isWarmingUpCapture: store\.engine\.isWarmingUpCapture/g)?.length).toBe(2);
    expect(view.match(/blockedReason: store\.engine\.blockedReason/g)?.length).toBe(2);
    // Every affordance must read the combined state; during warm-up the button has to already
    // be Stop, or clicking it would silently start nothing.
    expect(view).not.toMatch(/store\.engine\.isRecording \? "stop\.fill"/);
    expect(view).toContain('store.engine.captureIsActive ? "stop.fill"');

    // Each affordance is pinned SEPARATELY, and this is the reason: the single
    // `toContain("if store.engine.captureIsActive {")` that used to stand here is satisfied by
    // either `statusColor` or `toggleRecording`, so reverting one of them to `isRecording` was
    // invisible. Measured on this file: 4 of the 5 reads reverted with the suite still green at
    // exit 0, and only `recordButtonIcon` was caught -- by the `not.toMatch`/`toContain` pair
    // above, which is the shape the rest of these now copy. The consequence differs per member,
    // so each carries its own failure message.
    //
    // And each is pinned by its FULL EXPRESSION, not by the presence of the identifier. That
    // distinction is this PR's second adversarial finding, measured: `toContain("captureIsActive")`
    // is a presence test, and three of the four members below survived a mutation at EXIT 0 while
    // keeping the read. `captureIsActive && !isWarmingUpCapture` masks warm-up straight back out
    // (`statusColor`, `toggleRecording` — the latter restoring verbatim the click that silently does
    // nothing), and swapping the title's two branches leaves the read untouched. Neither the count
    // below nor the stray-`isRecording` sweep can see any of them: the read is still there and no
    // `isRecording` was added. Only the expression can.
    const warmUpAwareMembers: ReadonlyArray<readonly [string, RegExp, string]> = [
      [
        "private var statusColor: Color",
        /^\s*if store\.engine\.captureIsActive \{ return \.red \}$/m,
        "the popover glyph stays idle-coloured through the whole warm-up window",
      ],
      [
        "private var recordButtonTitle: String",
        /^\s*store\.engine\.captureIsActive \? "Stop and Transcribe" : "Start Recording"$/m,
        "the button reads Start Recording while it already acts as Stop",
      ],
      [
        "private var recordButtonIcon: String",
        /^\s*store\.engine\.captureIsActive \? "stop\.fill" : "mic\.fill"$/m,
        "the button shows mic.fill while it already acts as Stop",
      ],
      [
        "private func toggleRecording()",
        // Branch bodies included, so swapping them is caught as well as masking the condition.
        /if store\.engine\.captureIsActive \{\s*store\.engine\.stopAndTranscribe\(\)\s*\} else \{\s*store\.engine\.startRecording\(\)/,
        "Stop pressed during warm-up calls startRecording(), the gate refuses it, and the click " +
          "silently does nothing -- verbatim the failure this suite exists to prevent",
      ],
    ];
    for (const [declaration, expression, consequence] of warmUpAwareMembers) {
      const body = methodBody(view, declaration);
      // Presence first, so a DELETED read fails as a missing read rather than as a shape change.
      expect(body, `${declaration}: ${consequence}`).toContain("store.engine.captureIsActive");
      expect(
        body,
        `${declaration} no longer reads warm-up as its whole condition: ${consequence}`,
      ).toMatch(expression);
    }

    // The button's tint lives inline in `body` rather than in a member, so it needs its own
    // anchor; it is the fifth read.
    expect(view, "the record button's tint must follow warm-up too").toContain(
      ".tint(store.engine.captureIsActive ? .red : .accentColor)",
    );

    // A count as well, so a NEW affordance added without warm-up awareness is caught rather than
    // silently joining the four above.
    expect(
      view.match(/store\.engine\.captureIsActive/g)?.length,
      "every warm-up-aware read in MenuBarStatusView",
    ).toBe(5);

    // The converse, and the assertion that actually makes all five independent: `isRecording` is
    // legitimate in exactly one shape in this file -- the argument handed to MenuBarPresentation,
    // which receives both flags and decides between them itself. Any other read is a surface that
    // ignores warm-up, so reverting any one of the five leaves a line here.
    const strayIsRecording = view
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("store.engine.isRecording"))
      .filter((line) => line !== "isRecording: store.engine.isRecording,");
    expect(
      strayIsRecording,
      "MenuBarStatusView reads isRecording outside MenuBarPresentation's argument",
    ).toEqual([]);
  });

  /**
   * M4 was the worst mutation this suite missed: a single `.filter { $0.key != .pressConsumed }`
   * in the compositor writes the disclosure into `blockedReasons` and never publishes it.
   * `blockedReason` stays nil, the glyph never changes, and the entire visibility feature becomes
   * a silent no-op — with every other assertion still green.
   */
  test("the compositor publishes every source it was given", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");
    const compositor = methodBody(
      engine,
      // Anchored to the declaration's OPENING, not its full single-line spelling: `main` gave this
      // method a third parameter (`generation: UInt64? = nil`) and broke the signature across four
      // lines, so the one-line form no longer exists and `region` threw "missing anchor". The
      // sibling suite already anchors this way (macos-shortcut-contract.test.ts:277, :700).
      "private func setBlockedReason(",
    );
    expect(compositor, "a filtered source is a source that never reaches the glyph").not.toContain(
      ".filter",
    );
    // The composed value must be built from the whole dictionary and then published.
    expect(compositor).toMatch(/blockedReasons\s*\n\s*\.sorted/);
    expect(compositor).toContain("blockedReason = composed.isEmpty ? nil : composed");

    // A8: banning `.filter` pins the syntax, not the class. Excluding a source at the WRITE
    // reaches the identical effect with no filter anywhere — nothing is removed from the
    // composition because nothing was ever put in:
    //
    //     if let reason, !reason.isEmpty, source != .pressConsumed {
    //
    // `blockedReason` stays nil, the glyph never changes, the whole disclosure is a no-op, and
    // every assertion above survives. So pin the write as unconditional, and forbid `source`
    // being compared at all: in this function it is a dictionary key, never a predicate.
    // A8 reconciled with `main` rather than dropped, and this is the one place where merging this
    // branch had to WEAKEN a landed assertion, so it is spelled out.
    //
    // The original form required the write to be textually adjacent to the reason check and forbade
    // `source` being compared AT ALL. `main` now compares it deliberately three times: an early
    // `return` refusing a reason that belongs to a superseded recording — the pre-render gate whose
    // absence let "press Cmd-V" outlive its clipboard — plus two `source == .delivery` stamps of
    // `deliveryBlockedReasonGeneration`. A blanket ban on `source ==` would delete that fix, and a
    // blanket allowance would restore A8. So enumerate instead: exactly what may stand between the
    // reason check and the dictionary write, and exactly which comparisons may exist.
    //
    // Still kills A8's own mutation: adding `source != .pressConsumed` to the write's condition
    // changes the first gate's text, and adding a fresh `if source != … { return }` adds a third.
    const beforeWrite = region(
      compositor,
      "if let reason, !reason.isEmpty {",
      "blockedReasons[source] = reason",
    )
      // Line comments stripped: this function's prose mentions `return` and reads as code to a
      // regex, and an assertion a comment can satisfy is not an assertion.
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    const gates = [...beforeWrite.matchAll(/^\s*if (.+?) \{$/gm)].map((match) => match[1]);
    expect(
      gates,
      "only the superseded-delivery gate may stand between the reason check and the write",
    ).toEqual([
      "let reason, !reason.isEmpty",
      "source == .delivery, let generation, generation != recordingGeneration",
    ]);
    // The write's OWN condition carries no source predicate — that is A8's exact shape.
    expect(
      compositor,
      "`source` is a key at the write, never a predicate; comparing it there drops a whole cause",
    ).not.toMatch(/if let reason,[^\n]*source/);
    // And every comparison of `source` anywhere in the compositor is a `.delivery` scope check.
    // Exact list, so a `!= .pressConsumed` anywhere in this method fails rather than blends in.
    expect(
      compositor.match(/source\s*[!=]=\s*\.\w+/g) ?? [],
      "the only `source` comparisons here are the three .delivery scope checks",
    ).toEqual(["source == .delivery", "source == .delivery", "source == .delivery"]);
    // Both the reads of `source` that may exist, and nothing else. Was 3 before `main`'s generation
    // gate: the parameter, the dictionary write and the removal; now also the three comparisons.
    const sourceUses = compositor.match(/\bsource\b/g) ?? [];
    expect(sourceUses.length, "unexpected extra use of `source` in the compositor").toBe(7);
    // Both slots this branch writes must be reachable through it.
    for (const source of [".pressConsumed", ".delivery"]) {
      expect(engine, `no writer for ${source}`).toContain(`for: ${source}`);
    }
  });

  /**
   * M1: the two transient clears exist so a stale "press Cmd-V" cannot outlive its clipboard.
   * Hoisted above the start gate they fire on a press the gate REFUSES, destroying a still-true
   * instruction while no recording begins — the exact failure the comment beside them describes.
   * The existing contract test only checked that the clears are present.
   */
  test("the transient reasons are cleared only once the start gate has passed", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");
    const startRecording = region(
      engine,
      "public func startRecording(trigger: RecordingTrigger = .manual) {",
      "let myPID = ProcessInfo.processInfo.processIdentifier",
    );
    // Reached only when the gate passed, so it is the boundary the clears must sit behind.
    const gatePassed = startRecording.indexOf('log("startRecording trigger=');
    expect(gatePassed).toBeGreaterThan(-1);
    // And the gate's own refusal path must precede that.
    expect(startRecording.indexOf("guard Self.canBeginRecording(")).toBeLessThan(gatePassed);
    for (const clear of [
      "setBlockedReason(nil, for: .pressConsumed)",
      "setBlockedReason(nil, for: .delivery)",
    ]) {
      const at = startRecording.indexOf(clear);
      expect(at, `missing clear: ${clear}`).toBeGreaterThan(-1);
      expect(at, `${clear} must not run on a press the gate refuses`).toBeGreaterThan(gatePassed);
    }
  });

  test("the realtime session is not negotiated for a recorder that never started", () => {
    const engine = read("RecordingsLib/RecordingEngine.swift");

    const startNative = region(
      engine,
      "private func startNativeRecording(",
      "try recorder.start()",
    );
    // The client is constructed up front (the stream pipe needs it), but the WebSocket
    // handshake must not be kicked off before the recorder is known to have started.
    expect(startNative).toContain("RealtimeTranscriptionClient(apiKey: apiKey, homePath: home)");
    expect(startNative).not.toContain("beginRealtimeStreaming(");

    const startBlock = region(engine, "try recorder.start()", "} catch {");
    expect(startBlock).toContain("beginRealtimeStreaming(client: client");
  });
});
