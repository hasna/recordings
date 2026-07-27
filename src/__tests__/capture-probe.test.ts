import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import {
  probeMicrophoneCapture,
  captureProbeSubject,
  microphoneGrantInstruction,
  readWavPeak,
  DEFAULT_PROBE_SECONDS,
  RECORDINGS_BUNDLE_IDENTIFIER,
} from "../lib/capture-probe.js";
import type { RecordingsConfig } from "../types/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.RECORDINGS_TEST_RECORD_EXECUTABLE;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recordings-capture-probe-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Build a minimal 16-bit mono PCM WAV from the given samples. */
function buildWav(samples: number[], options: { extraChunk?: boolean } = {}): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22); // bits per sample

  // sox emits a LIST/INFO chunk ahead of `data` for some outputs. A reader that
  // assumes a fixed 44-byte header silently reads metadata as audio.
  const chunks: Buffer[] = [fmt];
  if (options.extraChunk) {
    const listBody = Buffer.from("INFOhello!", "ascii"); // odd length -> needs pad
    const list = Buffer.alloc(8 + listBody.length + (listBody.length % 2));
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(listBody.length, 4);
    listBody.copy(list, 8);
    chunks.push(list);
  }

  const dataChunk = Buffer.alloc(8 + data.length);
  dataChunk.write("data", 0, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);
  data.copy(dataChunk, 8);
  chunks.push(dataChunk);

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Stand in for `rec`. Writes `wav` to the output path (8th argument) and exits
 * 0 — mirroring macOS, which does NOT fail a mic-denied capture.
 */
function makeRecorderStub(dir: string, wav: Buffer | null): string {
  const wavPath = join(dir, "canned.wav");
  if (wav) writeFileSync(wavPath, wav);
  const stub = join(dir, "rec-stub.sh");
  writeFileSync(
    stub,
    wav
      ? `#!/usr/bin/env bash\ncp ${JSON.stringify(wavPath)} "$8"\nexit 0\n`
      : `#!/usr/bin/env bash\nexit 0\n`
  );
  chmodSync(stub, 0o755);
  return stub;
}

function makeConfig(): RecordingsConfig {
  return { sample_rate: 16000 } as unknown as RecordingsConfig;
}

describe("readWavPeak", () => {
  test("reports zero peak for digital silence", () => {
    const dir = makeTempDir();
    const file = join(dir, "silence.wav");
    writeFileSync(file, buildWav(new Array(512).fill(0)));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(512);
    expect(peak.peak).toBe(0);
  });

  test("reports a non-zero peak when signal is present", () => {
    const dir = makeTempDir();
    const file = join(dir, "signal.wav");
    writeFileSync(file, buildWav([0, 1000, -16384, 200]));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(4);
    expect(peak.peak).toBeCloseTo(0.5, 5);
  });

  test("finds the data chunk past a LIST chunk instead of assuming a 44-byte header", () => {
    const dir = makeTempDir();
    const file = join(dir, "with-list.wav");
    writeFileSync(file, buildWav([0, 0, 8192, 0], { extraChunk: true }));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(4);
    expect(peak.peak).toBeCloseTo(0.25, 5);
  });

  test("rejects a non-RIFF file rather than reporting a peak", () => {
    const dir = makeTempDir();
    const file = join(dir, "not-a-wav.bin");
    writeFileSync(file, Buffer.from("this is not audio at all", "ascii"));

    expect(() => readWavPeak(file)).toThrow(/not a RIFF/);
  });
});

describe("probeMicrophoneCapture", () => {
  // This is the regression this whole module exists for. On station03 with
  // Microphone = not_determined, `rec` exited 0 and wrote a 64080-byte WAV whose
  // maximum amplitude was exactly 0.000000. Anything that keys off exit status
  // or file size calls that a success.
  test("FAILS on a zero-filled capture even though the recorder exits 0", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = makeRecorderStub(
      dir,
      buildWav(new Array(16000).fill(0))
    );

    const result = probeMicrophoneCapture(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.silent).toBe(true);
    expect(result.peak).toBe(0);
    expect(result.samples).toBe(16000);
    expect(result.message).toContain("digital silence");
  });

  test("succeeds and reports the peak when real signal is captured", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = makeRecorderStub(
      dir,
      buildWav([0, 4096, -8192, 128])
    );

    const result = probeMicrophoneCapture(makeConfig());

    expect(result.ok).toBe(true);
    expect(result.silent).toBe(false);
    expect(result.peak).toBeCloseTo(0.25, 5);
    expect(result.seconds).toBe(DEFAULT_PROBE_SECONDS);
    expect(result.message).toContain("peak amplitude");
  });

  test("fails when the recorder writes no file despite exiting 0", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = makeRecorderStub(dir, null);

    const result = probeMicrophoneCapture(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("wrote no audio file");
  });

  test("fails cleanly when the recorder executable does not exist", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = join(dir, "definitely-missing");

    const result = probeMicrophoneCapture(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not run/);
  });

  test("names the responsible process, not Recordings.app, when a capture is silent", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = makeRecorderStub(
      dir,
      buildWav(new Array(64).fill(0))
    );

    const result = probeMicrophoneCapture(makeConfig());

    expect(result.ok).toBe(false);
    // A CLI probe exercises the terminal's (or sshd's) grant. Telling the reader
    // to fix Recordings.app on the strength of this sends them to a pane that
    // will not change the outcome.
    expect(result.message).toContain(captureProbeSubject().subject);
  });

  test("leaves no probe artifacts behind in the temp dir", () => {
    const dir = makeTempDir();
    process.env.RECORDINGS_TEST_RECORD_EXECUTABLE = makeRecorderStub(
      dir,
      buildWav([0, 4096])
    );

    const result = probeMicrophoneCapture(makeConfig());
    expect(result.ok).toBe(true);

    const leftovers = readdirSync(tmpdir()).filter((entry) =>
      /^recordings-capture-probe-\d+-\d+\.wav$/.test(entry)
    );
    expect(leftovers).toEqual([]);
  });
});

describe("captureProbeSubject", () => {
  test("marks an SSH session as unable to be prompted", () => {
    const subject = captureProbeSubject({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" });

    if (process.platform === "darwin") {
      expect(subject.headless).toBe(true);
      expect(subject.subject).toContain("sshd");
      // The point of the flag: over SSH a silent capture is INCONCLUSIVE about
      // the app, because macOS cannot show a consent sheet to a GUI-less session.
      expect(subject.note).toContain("NOTHING");
    } else {
      expect(subject.headless).toBe(false);
    }
  });

  test("attributes a local terminal run to the terminal, never to the app", () => {
    const subject = captureProbeSubject({ TERM_PROGRAM: "ghostty" });

    expect(subject.headless).toBe(false);
    if (process.platform === "darwin") {
      expect(subject.subject).toContain("ghostty");
      expect(subject.subject).toContain("not Recordings.app");
    }
  });
});

describe("microphoneGrantInstruction", () => {
  /** A bundle skeleton — the instruction resolves paths that exist on disk. */
  function makeBundle(dir: string, name = "Recordings.app"): string {
    const bundle = join(dir, name);
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    return bundle;
  }

  test("names the pane, the section, the bundle and the binary", () => {
    const bundle = makeBundle(makeTempDir());

    const instruction = microphoneGrantInstruction({ installedAppPath: bundle });

    expect(instruction.bundle_path).toBe(bundle);
    expect(instruction.bundle_identifier).toBe(RECORDINGS_BUNDLE_IDENTIFIER);
    const text = instruction.steps.join(" ");
    // "Grant Microphone" is not actionable. Pane, section, control and binary are.
    expect(text).toContain("System Settings → Privacy & Security → Microphone");
    expect(text).toContain(bundle);
    expect(text).toContain(join(bundle, "Contents", "MacOS", "Recordings"));
  });

  test("says the Settings row does not exist yet when the app has never asked", () => {
    const bundle = makeBundle(makeTempDir());

    const instruction = microphoneGrantInstruction({
      installedAppPath: bundle,
      everRequested: false,
    });

    // Sending someone to a toggle that is not in the list is how this loops.
    expect(instruction.steps.join(" ")).toContain("will NOT contain");
  });

  test("warns when several bundles could receive the grant", () => {
    const dir = makeTempDir();
    const canonical = makeBundle(dir);
    const legacy = makeBundle(dir, "Recordings.app.legacy");

    const instruction = microphoneGrantInstruction({
      installedAppPath: canonical,
      otherAppPaths: [legacy],
    });

    expect(instruction.candidate_bundle_paths).toEqual([canonical, legacy]);
    expect(instruction.steps[0]).toContain("AMBIGUOUS");
  });

  test("ignores bundle paths that do not exist on disk", () => {
    const dir = makeTempDir();
    const bundle = makeBundle(dir);

    const instruction = microphoneGrantInstruction({
      installedAppPath: join(dir, "Applications", "Recordings.app"),
      otherAppPaths: [bundle],
    });

    expect(instruction.candidate_bundle_paths).toEqual([bundle]);
    expect(instruction.bundle_path).toBe(bundle);
  });

  test("says there is nothing to grant when no bundle is installed", () => {
    const dir = makeTempDir();

    const instruction = microphoneGrantInstruction({
      installedAppPath: join(dir, "Recordings.app"),
    });

    expect(instruction.bundle_path).toBeNull();
    expect(instruction.steps.join(" ")).toContain("Install the app first");
  });
});
