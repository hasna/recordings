import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import {
  probeMicrophoneCapture,
  captureProbeSubject,
  microphoneGrantInstruction,
  classifyPermissionState,
  readWavPeak,
  DEFAULT_PROBE_SECONDS,
  MAX_PROBE_SECONDS,
  SILENCE_PEAK_THRESHOLD,
  RECORDINGS_BUNDLE_IDENTIFIER,
  TCC_UNREADABLE_STATE,
} from "../lib/capture-probe.js";
import type { RecordingsConfig } from "../types/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recordings-capture-probe-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Build a minimal 16-bit mono PCM WAV from the given samples. */
interface BuildWavOptions {
  extraChunk?: boolean;
  /** Declared bit depth, so the 16-bit guard can be exercised. */
  bitsPerSample?: number;
  /** wFormatTag; 1 is uncompressed PCM, 3 is IEEE float. */
  formatTag?: number;
  /** Emit `data` before `fmt ` — legal RIFF, and it used to defeat the scan. */
  dataFirst?: boolean;
  /** Leave the fmt chunk out entirely. */
  omitFmt?: boolean;
  /** Declare a fmt chunk shorter than the 16 bytes the spec requires. */
  fmtChunkSize?: number;
  /** Emit WAVE_FORMAT_EXTENSIBLE with this SubFormat tag in its GUID. */
  extensibleSubFormat?: number;
  /** Emit the fmt chunk twice, with this tag on the second one. */
  duplicateFmtTag?: number;
  /** Emit a second data chunk after the first. */
  duplicateData?: boolean;
}

function buildWav(samples: number[], options: BuildWavOptions = {}): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));

  const extensible = options.extensibleSubFormat !== undefined;
  // EXTENSIBLE needs cbSize (2) + 22 bytes of extension; SubFormat starts at +8.
  const declaredFmtSize = options.fmtChunkSize ?? (extensible ? 40 : 16);
  const fmt = Buffer.alloc(8 + declaredFmtSize);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(declaredFmtSize, 4);
  if (declaredFmtSize >= 16) {
    fmt.writeUInt16LE(extensible ? 0xfffe : options.formatTag ?? 1, 8); // wFormatTag
    fmt.writeUInt16LE(1, 10); // mono
    fmt.writeUInt32LE(16000, 12);
    fmt.writeUInt32LE(32000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(options.bitsPerSample ?? 16, 22); // bits per sample
  }
  if (extensible && declaredFmtSize >= 40) {
    fmt.writeUInt16LE(22, 24); // cbSize
    fmt.writeUInt16LE(options.bitsPerSample ?? 16, 26); // wValidBitsPerSample
    fmt.writeUInt32LE(0x4, 28); // dwChannelMask
    fmt.writeUInt16LE(options.extensibleSubFormat!, 32); // SubFormat GUID head
  }

  // sox emits a LIST/INFO chunk ahead of `data` for some outputs. A reader that
  // assumes a fixed 44-byte header silently reads metadata as audio.
  const chunks: Buffer[] = options.omitFmt ? [] : [fmt];
  if (options.duplicateFmtTag !== undefined) {
    const second = Buffer.from(fmt);
    second.writeUInt16LE(options.duplicateFmtTag, 8);
    chunks.push(second);
  }
  if (options.extraChunk) {
    // ODD length, so the chunk really is followed by a pad byte. The fixture read
    // `Buffer.from("INFOhello!")` with the comment "odd length -> needs pad", but that string is
    // 10 bytes — even — so the pad path was never exercised and dropping `+ (chunkSize % 2)` from
    // readWavPeak's chunk walk survived as a mutation. "INFOhello" is 9.
    const listBody = Buffer.from("INFOhello", "ascii"); // odd length (9) -> needs pad
    // Guard the fixture itself: the previous comment asserted a property the bytes did not have.
    if (listBody.length % 2 !== 1) throw new Error("LIST fixture must be odd-length");
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
  if (options.dataFirst) chunks.unshift(dataChunk);
  else chunks.push(dataChunk);
  if (options.duplicateData) chunks.push(Buffer.from(dataChunk));

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

  // These four are the guards that survived mutation testing unnoticed: deleting
  // the bit-depth check, or letting the loop stop at `data`, left the suite green
  // while the function silently reinterpreted other formats as 16-bit PCM.
  test("rejects a 32-bit sample format instead of reinterpreting it as 16-bit", () => {
    const dir = makeTempDir();
    const file = join(dir, "float32.wav");
    writeFileSync(file, buildWav([0, 4096], { bitsPerSample: 32 }));

    expect(() => readWavPeak(file)).toThrow(/expected 16-bit PCM, got 32-bit/);
  });

  test("rejects a non-PCM format tag even at 16 bits", () => {
    const dir = makeTempDir();
    const file = join(dir, "ieee-float.wav");
    writeFileSync(file, buildWav([0, 4096], { formatTag: 3 }));

    expect(() => readWavPeak(file)).toThrow(/uncompressed PCM/);
  });

  // RIFF does not mandate chunk order. Breaking out of the scan at `data` left
  // bitsPerSample at its 16 default, so a 32-bit file reported a plausible,
  // wrong peak instead of raising.
  test("still reads fmt when the data chunk comes first", () => {
    const dir = makeTempDir();
    const file = join(dir, "data-first.wav");
    writeFileSync(file, buildWav([0, 4096], { bitsPerSample: 32, dataFirst: true }));

    expect(() => readWavPeak(file)).toThrow(/expected 16-bit PCM, got 32-bit/);
  });

  test("refuses a WAV with no fmt chunk rather than assuming 16-bit", () => {
    const dir = makeTempDir();
    const file = join(dir, "no-fmt.wav");
    writeFileSync(file, buildWav([0, 4096], { omitFmt: true }));

    expect(() => readWavPeak(file)).toThrow(/no fmt chunk/);
  });

  test("rejects a truncated fmt chunk instead of reading the next header as bit depth", () => {
    const dir = makeTempDir();
    const file = join(dir, "short-fmt.wav");
    writeFileSync(file, buildWav([0, 4096], { fmtChunkSize: 8 }));

    expect(() => readWavPeak(file)).toThrow(/truncated fmt chunk/);
  });

  // WAVE_FORMAT_EXTENSIBLE is legitimate uncompressed PCM; CoreAudio writers emit
  // it. Requiring tag 1 outright would turn a real capture into a read failure.
  test("accepts WAVE_FORMAT_EXTENSIBLE whose SubFormat is PCM", () => {
    const dir = makeTempDir();
    const file = join(dir, "extensible-pcm.wav");
    writeFileSync(file, buildWav([0, 8192, -4096], { extensibleSubFormat: 1 }));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(3);
    expect(peak.peak).toBeCloseTo(0.25, 5);
  });

  test("rejects WAVE_FORMAT_EXTENSIBLE whose SubFormat is float", () => {
    const dir = makeTempDir();
    const file = join(dir, "extensible-float.wav");
    writeFileSync(file, buildWav([0, 8192], { extensibleSubFormat: 3 }));

    expect(() => readWavPeak(file)).toThrow(/uncompressed PCM/);
  });

  test("rejects WAVE_FORMAT_EXTENSIBLE with no readable SubFormat GUID", () => {
    const dir = makeTempDir();
    const file = join(dir, "extensible-truncated.wav");
    writeFileSync(file, buildWav([0, 8192], { extensibleSubFormat: 1, fmtChunkSize: 16 }));

    expect(() => readWavPeak(file)).toThrow(/SubFormat GUID/);
  });

  // A trailing bogus fmt chunk must not override the real one.
  test("uses the FIRST fmt chunk when a file carries two", () => {
    const dir = makeTempDir();
    const file = join(dir, "two-fmt.wav");
    writeFileSync(file, buildWav([0, 8192], { duplicateFmtTag: 3 }));

    const peak = readWavPeak(file);
    expect(peak.peak).toBeCloseTo(0.25, 5);
  });

  test("uses the FIRST data chunk when a file carries two", () => {
    const dir = makeTempDir();
    const file = join(dir, "two-data.wav");
    writeFileSync(file, buildWav([0, 8192], { duplicateData: true }));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(2);
  });

  test("treats a zero-length data chunk as no samples, not as a crash", () => {
    const dir = makeTempDir();
    const file = join(dir, "empty-data.wav");
    writeFileSync(file, buildWav([]));

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(0);
    expect(peak.peak).toBe(0);
  });

  test("rejects a non-RIFF file rather than reporting a peak", () => {
    const dir = makeTempDir();
    const file = join(dir, "not-a-wav.bin");
    writeFileSync(file, Buffer.from("this is not audio at all", "ascii"));

    expect(() => readWavPeak(file)).toThrow(/not a RIFF/);
  });
});

/**
 * The one real capture measured on station03 (recording-20260727-135932-380.wav):
 * peak_int16 1326 of 32768. Quiet dictation, and the number the silence threshold
 * has to stay clear of.
 */
const MEASURED_REAL_DICTATION_PEAK = 1326 / 32768;

describe("SILENCE_PEAK_THRESHOLD", () => {
  // Imported by this file but asserted nowhere, so mutating 0.001 -> 0.06 survived the suite. That
  // matters: 0.06 sits ABOVE the ~0.0405 peak of a real quiet dictation, so that mutant makes
  // genuine speech report "no usable signal" while every test stays green. The threshold was
  // configured, not proven.
  test("sits above one LSB and below a real quiet dictation peak", () => {
    const ONE_LSB = 1 / 32768;

    expect(MEASURED_REAL_DICTATION_PEAK).toBeCloseTo(0.040466, 5);
    expect(SILENCE_PEAK_THRESHOLD).toBeGreaterThan(ONE_LSB);
    expect(SILENCE_PEAK_THRESHOLD).toBeLessThan(MEASURED_REAL_DICTATION_PEAK);
    // A full order of magnitude of headroom, not merely "below".
    expect(SILENCE_PEAK_THRESHOLD).toBeLessThan(MEASURED_REAL_DICTATION_PEAK / 10);
    // The documented margins, so a future edit cannot quietly restate them wrongly: ~33 LSB of
    // headroom over dither, and ~40x below real speech.
    expect(SILENCE_PEAK_THRESHOLD / ONE_LSB).toBeCloseTo(32.77, 1);
    expect(MEASURED_REAL_DICTATION_PEAK / SILENCE_PEAK_THRESHOLD).toBeCloseTo(40.5, 1);
  });

  test("classifies at the boundary: 32 int16 is silence, 34 is signal", () => {
    const dir = makeTempDir();

    const belowThreshold = probeMicrophoneCapture(makeConfig(), {
      executable: makeRecorderStub(dir, buildWav(new Array(64).fill(32))),
    });
    expect(belowThreshold.ok).toBe(false);
    expect(belowThreshold.silent).toBe(true);

    const dir2 = makeTempDir();
    const aboveThreshold = probeMicrophoneCapture(makeConfig(), {
      executable: makeRecorderStub(dir2, buildWav(new Array(64).fill(34))),
    });
    expect(aboveThreshold.ok).toBe(true);
    expect(aboveThreshold.silent).toBe(false);
  });

  test("a capture at the real dictation peak is NOT classified as silence", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(dir, buildWav([0, 1326, -1200]));

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(true);
    expect(result.silent).toBe(false);
  });

  test("a capture just at the threshold IS classified as silence", () => {
    const dir = makeTempDir();
    const atThreshold = Math.floor(SILENCE_PEAK_THRESHOLD * 32768);
    const executable = makeRecorderStub(dir, buildWav([0, atThreshold]));

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(false);
    expect(result.silent).toBe(true);
  });
});

describe("probeMicrophoneCapture", () => {
  // This is the regression this whole module exists for. On station03 with
  // Microphone = not_determined, `rec` exited 0 and wrote a 64080-byte WAV whose
  // maximum amplitude was exactly 0.000000. Anything that keys off exit status
  // or file size calls that a success.
  test("FAILS on a zero-filled capture even though the recorder exits 0", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(
      dir,
      buildWav(new Array(16000).fill(0))
    );

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(false);
    expect(result.silent).toBe(true);
    expect(result.peak).toBe(0);
    expect(result.samples).toBe(16000);
    expect(result.message).toContain("no usable signal");
  });

  test("succeeds and reports the peak when real signal is captured", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(
      dir,
      buildWav([0, 4096, -8192, 128])
    );

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(true);
    expect(result.silent).toBe(false);
    expect(result.peak).toBeCloseTo(0.25, 5);
    expect(result.seconds).toBe(DEFAULT_PROBE_SECONDS);
    expect(result.message).toContain("peak amplitude");
  });

  test("fails when the recorder writes no file despite exiting 0", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(dir, null);

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("wrote no audio file");
  });

  // F7: `silent` used to default to `true` on the shared base object, so every early return
  // inherited it. A missing binary reported `silent=true samples=0 peak=0`, and a `--json`
  // consumer reading `capture_probe.silent` concluded the microphone had delivered digital
  // silence when no capture was ever attempted — the same "could not measure" vs "measured a bad
  // value" conflation this module exists to remove. Only the amplitude branch may state a verdict.
  test("reports silent as null when no amplitude was measured at all", () => {
    const missingBinaryDir = makeTempDir();
    const spawnFailed = probeMicrophoneCapture(makeConfig(), {
      executable: join(missingBinaryDir, "definitely-missing"),
    });
    expect(spawnFailed.ok).toBe(false);
    expect(spawnFailed.samples).toBe(0);
    expect(spawnFailed.silent).toBeNull();

    const noFileDir = makeTempDir();
    const wroteNothing = probeMicrophoneCapture(makeConfig(), {
      executable: makeRecorderStub(noFileDir, null),
    });
    expect(wroteNothing.ok).toBe(false);
    expect(wroteNothing.silent).toBeNull();
  });

  // F6: a `data` chunk that declares size 0 while carrying real samples used to yield
  // `Math.min(0, N) = 0` -> "capture produced no samples", a FALSE FAILURE on audio that is
  // present. Zero means "size not filled in", not "no audio".
  test("reads a data chunk that declares size 0 but carries samples", () => {
    const dir = makeTempDir();
    const file = join(dir, "zero-declared.wav");
    const wav = buildWav([0, 4096, -8192, 128]);
    // Zero out the data chunk's declared size, leaving the payload intact.
    const dataIndex = wav.indexOf(Buffer.from("data", "ascii"));
    expect(dataIndex).toBeGreaterThan(0);
    wav.writeUInt32LE(0, dataIndex + 4);
    writeFileSync(file, wav);

    const peak = readWavPeak(file);
    expect(peak.samples).toBe(4);
    expect(peak.peak).toBeCloseTo(0.25, 5);
  });

  // F9's timeout branch survived being made to report ok:true, so it had no test.
  test("FAILS when the recorder is killed by the timeout, even if it wrote a WAV", () => {
    const dir = makeTempDir();
    // Writes a perfectly good non-silent WAV, then hangs so the timeout fires.
    const wavPath = join(dir, "canned.wav");
    writeFileSync(wavPath, buildWav([0, 8192, -8192]));
    const stub = join(dir, "slow-rec.sh");
    writeFileSync(stub, `#!/usr/bin/env bash\ncp ${JSON.stringify(wavPath)} "$8"\nsleep 30\n`);
    chmodSync(stub, 0o755);

    const result = probeMicrophoneCapture(makeConfig(), {
      executable: stub,
      timeoutMs: 700,
    });

    // A partial or abandoned capture must not be laundered into a pass by the
    // file happening to look valid.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not finish");
  });

  test("clamps an absurd probe duration instead of blocking on it", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(dir, buildWav([0, 4096]));

    const result = probeMicrophoneCapture(makeConfig(), { executable, seconds: 999_999 });

    expect(result.seconds).toBe(MAX_PROBE_SECONDS);
  });

  test("fails cleanly when the recorder executable does not exist", () => {
    const dir = makeTempDir();
    const executable = join(dir, "definitely-missing");

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not run/);
  });

  test("names the responsible process, not Recordings.app, when a capture is silent", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(
      dir,
      buildWav(new Array(64).fill(0))
    );

    const result = probeMicrophoneCapture(makeConfig(), { executable });

    expect(result.ok).toBe(false);
    // A CLI probe exercises the terminal's (or sshd's) grant. Telling the reader
    // to fix Recordings.app on the strength of this sends them to a pane that
    // will not change the outcome. Asserted against a literal, not against
    // captureProbeSubject() — comparing production output to production output
    // passes no matter what either one says.
    expect(result.message).toContain("attributed to");
    expect(result.message).not.toContain("Grant Microphone to Recordings.app");
  });

  test("leaves no probe artifacts behind in the temp dir", () => {
    const dir = makeTempDir();
    const executable = makeRecorderStub(
      dir,
      buildWav([0, 4096])
    );

    const result = probeMicrophoneCapture(makeConfig(), { executable });
    expect(result.ok).toBe(true);

    const leftovers = readdirSync(tmpdir()).filter((entry) =>
      /^recordings-capture-probe-\d+-\d+\.wav$/.test(entry)
    );
    expect(leftovers).toEqual([]);
  });
});

describe("captureProbeSubject", () => {
  // platform is injected so the darwin logic — the module's central claim — is
  // asserted on Linux CI too. Gating these behind `if (platform === "darwin")`
  // meant inverting the entire darwin branch left the suite fully green.
  const darwin = { platform: "darwin" as const };

  test("names sshd, not the app, and marks an SSH session unpromptable", () => {
    const subject = captureProbeSubject(
      { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
      { ...darwin, hasTty: true }
    );

    expect(subject.headless).toBe(true);
    expect(subject.subject_known).toBe(true);
    expect(subject.subject).toContain("sshd");
    expect(subject.subject).toContain("not Recordings.app");
    expect(subject.note).toContain("NOTHING");
  });

  // The regression that made the old detector wrong in the environment this org
  // actually uses: tmux snapshots env at pane creation, so a remote pane has
  // neither SSH_CONNECTION nor TERM_PROGRAM.
  test("attributes a tmux pane to the tmux server and calls it inconclusive", () => {
    const subject = captureProbeSubject({ TMUX: "/tmp/tmux-501/default,123,0" }, darwin);

    expect(subject.subject).toContain("tmux server");
    expect(subject.subject).toContain("not Recordings.app");
    expect(subject.note).toContain("inconclusive");
    // Must NOT claim a terminal application it cannot see.
    expect(subject.subject).not.toContain("terminal application");
  });

  test("refuses to guess when there is no SSH var, no TERM_PROGRAM and no tty", () => {
    const subject = captureProbeSubject({}, { ...darwin, hasTty: false });

    expect(subject.subject_known).toBe(false);
    expect(subject.headless).toBe(true);
    expect(subject.note).toContain("could not be identified");
    expect(subject.note).toContain("Inconclusive");
  });

  test("attributes a local terminal run to the terminal, never to the app", () => {
    const subject = captureProbeSubject({ TERM_PROGRAM: "ghostty" }, { ...darwin, hasTty: true });

    expect(subject.headless).toBe(false);
    expect(subject.subject_known).toBe(true);
    expect(subject.subject).toContain("ghostty");
    expect(subject.subject).toContain("not Recordings.app");
    expect(subject.note).toContain("does not");
  });

  test("says TCC does not gate the microphone off darwin", () => {
    const subject = captureProbeSubject({}, { platform: "linux", hasTty: true });

    expect(subject.subject).toBe("this process");
    expect(subject.subject_known).toBe(true);
    expect(subject.note).toContain("not gated by TCC");
  });
});

describe("classifyPermissionState", () => {
  // The F1 regression: a refused database read was reported as "never asked",
  // so the CLI asserted "no TCC entry exists" on a machine that had a row.
  test("an unreadable TCC database is unknown, NOT never_requested", () => {
    expect(classifyPermissionState(TCC_UNREADABLE_STATE)).toBe("unknown");
  });

  test("only a literal not_determined means the app never asked", () => {
    expect(classifyPermissionState("not_determined")).toBe("never_requested");
  });

  // Retargeted during the #24 x #25 rebase. These cases used to assert the suffixed vocabulary
  // this branch's own reader emitted (`denied_identity_unverified`, ...). #24's `resolveTccGrant()`
  // is now the only producer and it emits bare labels, so asserting the suffixed forms alone would
  // have tested a code path nothing can reach. The live vocabulary is asserted here; the retired
  // forms move to the legacy-tolerance case below.
  test("a definite decision means the app has asked", () => {
    expect(classifyPermissionState("allowed")).toBe("requested");
    expect(classifyPermissionState("denied")).toBe("requested");
    expect(classifyPermissionState("limited")).toBe("requested");
    expect(classifyPermissionState("allowed_identity_unverified")).toBe("requested");
  });

  // TCC auth_value 1 is "unknown" but the ROW EXISTS, so the app has asked and
  // the Settings list will contain a Recordings entry.
  test("TCC auth_value 1 counts as requested because a row exists", () => {
    expect(classifyPermissionState("unknown")).toBe("requested");
    expect(classifyPermissionState("unknown(7)")).toBe("requested");
  });

  // An allowed row whose stored code requirement could not be bound to the installed bundle is
  // still a row. #24 names these so they cannot be skimmed as a pass, which also means they do not
  // match any `startsWith("allowed")` test — the reason they needed explicit cases.
  test("an allowed row that could not be bound to the bundle still counts as requested", () => {
    expect(classifyPermissionState("stale_allowed_for_previous_app_build")).toBe("requested");
    expect(classifyPermissionState("unverified_no_installed_bundle")).toBe("requested");
  });

  // Retired vocabulary: emitted by no current code path, tolerated because captured
  // `recordings check --json` output from an older build is re-read later.
  test("the retired _identity_unverified suffix is still read as a row that exists", () => {
    expect(classifyPermissionState("denied_identity_unverified")).toBe("requested");
    expect(classifyPermissionState("limited_identity_unverified")).toBe("requested");
    expect(classifyPermissionState("unknown_identity_unverified")).toBe("requested");
    expect(classifyPermissionState("unknown(7)_identity_unverified")).toBe("requested");
  });

  test("an ambiguous multi-install report is unknown, not an answer about the app", () => {
    expect(classifyPermissionState("ambiguous_multiple_installations")).toBe("unknown");
    expect(classifyPermissionState("unsupported")).toBe("unknown");
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
      requestState: "never_requested",
    });

    // Sending someone to a toggle that is not in the list is how this loops.
    expect(instruction.steps.join(" ")).toContain("will NOT contain");
  });

  // F1: a refused TCC read must never be narrated as "the app never asked".
  test("does not claim the row is absent when the permission state is unknown", () => {
    const bundle = makeBundle(makeTempDir());

    const instruction = microphoneGrantInstruction({
      installedAppPath: bundle,
      requestState: "unknown",
    });

    const text = instruction.steps.join(" ");
    expect(text).not.toContain("will NOT contain");
    expect(text).not.toContain("has never requested");
    expect(text).toContain("could NOT be determined");
    expect(text).toContain("Full Disk Access");
  });

  test("stays silent about the row when the app has already asked", () => {
    const bundle = makeBundle(makeTempDir());

    const instruction = microphoneGrantInstruction({
      installedAppPath: bundle,
      requestState: "requested",
    });

    const text = instruction.steps.join(" ");
    expect(text).not.toContain("will NOT contain");
    expect(text).not.toContain("could NOT be determined");
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
