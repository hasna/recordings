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

    const iconName = alert.match(/public var iconName: String \{ "([^"]+)" \}/)?.[1];
    expect(iconName).toBeTruthy();
    // Must be distinguishable from the three glyphs already in the vocabulary, or the change
    // is invisible — the whole point of the alert.
    expect(["mic.fill", "waveform", "ellipsis.circle"]).not.toContain(iconName);

    expect(presentation).toContain("if isRecording || isWarmingUpCapture {");
    expect(presentation).toContain("iconName = attemptAlert.iconName");
    // Neither new argument may be defaulted: `false` and `nil` are the invisible values, so a
    // surface that forgot them would compile and render warm-up as busy and a failure as idle.
    expect(presentation).not.toContain("isWarmingUpCapture: Bool = false");
    expect(presentation).not.toContain("attemptAlert: RecordingAttemptAlert? = nil");
    expect(presentation).toContain("isWarmingUpCapture: Bool,");
    expect(presentation).toContain("attemptAlert: RecordingAttemptAlert?\n    ) {");

    // And every construction in the app and its tests must state both, including the runtime
    // smoke probe, which omitted them entirely while the defaults existed.
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
        expect(site, `${file}: call site omits attemptAlert`).toContain("attemptAlert:");
      }
    }

    // Both menu-bar surfaces (the always-on label and the popover) must forward the new state,
    // or the engine tracks it and nothing on screen changes.
    expect(view.match(/isWarmingUpCapture: store\.engine\.isWarmingUpCapture/g)?.length).toBe(2);
    expect(view.match(/attemptAlert: store\.engine\.attemptAlert/g)?.length).toBe(2);
    // The popover's primary button must read the combined state; during warm-up it has to
    // already be Stop, or clicking it would start nothing.
    expect(view).not.toMatch(/store\.engine\.isRecording \? "stop\.fill"/);
    expect(view).toContain('store.engine.captureIsActive ? "stop.fill"');

    // The pre-existing no-audio failure raises the same glyph: it was equally invisible.
    expect(engine).toContain("self.raiseAttemptAlertGlyph(.noAudioCaptured)");
    expect(engine).toContain("private func raiseAttemptAlertGlyph(_ alert: RecordingAttemptAlert)");
    expect(alert).toContain("public static let visibleDuration: TimeInterval");
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
