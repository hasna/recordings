import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install_macos_app.sh");
const BUILD_SH = join(REPO_ROOT, "src", "native", "Recordings", "build.sh");

describe("install_macos_app.sh source contract", () => {
  const installer = readFileSync(INSTALLER, "utf8");
  const buildScript = readFileSync(BUILD_SH, "utf8");

  test("never touches TCC permission state", () => {
    expect(installer).not.toContain("tccutil");
    expect(installer).not.toContain("TCC.db");
  });

  test("preserves a certificate-signed app unless a rebuild is forced", () => {
    expect(installer).toContain("app_signature_is_stable");
    expect(installer).toContain("RECORDINGS_FORCE_APP_REINSTALL");
    expect(installer).toContain("Signature=adhoc");
  });

  test("build script honors a stable signing identity", () => {
    expect(buildScript).toContain("RECORDINGS_CODESIGN_IDENTITY");
    // An explicit identity must not silently fall back to ad-hoc on failure.
    expect(buildScript).toMatch(
      /codesign --force --sign "\$CODESIGN_IDENTITY" --entitlements [^|]*$/m,
    );
  });
});

describe("install_macos_app.sh behavior (stubbed macOS)", () => {
  let fixture: string;
  let stubBin: string;
  let home: string;
  let markers: string;
  let appDest: string;

  function writeStub(name: string, body: string): void {
    const path = join(stubBin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function runInstaller(extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", [join(fixture, "scripts", "install_macos_app.sh"), "--postinstall"], {
      encoding: "utf8",
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        HOME: home,
        MARKERS: markers,
        ...extraEnv,
      },
    });
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "recordings-install-test-"));
    stubBin = join(fixture, "stub-bin");
    home = join(fixture, "home");
    markers = join(fixture, "markers");
    mkdirSync(stubBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(markers, { recursive: true });

    // Fixture package layout: the script derives PACKAGE_ROOT from its own path.
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    cpSync(INSTALLER, join(fixture, "scripts", "install_macos_app.sh"));
    const nativeDir = join(fixture, "src", "native", "Recordings");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      join(nativeDir, "build.sh"),
      [
        "#!/bin/bash",
        'touch "$MARKERS/build-invoked"',
        'mkdir -p .build/release/Recordings.app/Contents/MacOS',
        'echo binary > .build/release/Recordings.app/Contents/MacOS/Recordings',
      ].join("\n"),
    );
    chmodSync(join(nativeDir, "build.sh"), 0o755);

    appDest = join(home, ".hasna", "recordings", "Recordings.app");

    writeStub("uname", 'echo Darwin');
    writeStub("swift", "exit 0");
    writeStub("tccutil", 'touch "$MARKERS/tccutil-invoked"; exit 0');
    writeStub("pgrep", "exit 1");
    writeStub("pkill", "exit 0");
    writeStub("open", "exit 0");
    // codesign stub: reports the signature state recorded in the app bundle.
    writeStub(
      "codesign",
      [
        'app="${@: -1}"',
        'state="$app/Contents/signature-state"',
        'if [ "$1" = "--verify" ]; then exit 0; fi',
        'if [ -f "$state" ]; then cat "$state" >&2; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  function installApp(signatureState: string): void {
    mkdirSync(join(appDest, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(appDest, "Contents", "MacOS", "Recordings"), "old binary");
    writeFileSync(join(appDest, "Contents", "signature-state"), signatureState);
  }

  test("skips the rebuild when the installed app has a stable certificate identity", () => {
    installApp("Identifier=com.hasna.recordings\nSignature size=5800\n");
    const result = runInstaller();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping rebuild");
    expect(existsSync(join(markers, "build-invoked"))).toBeFalse();
    // The stably signed app was not replaced.
    expect(readFileSync(join(appDest, "Contents", "MacOS", "Recordings"), "utf8")).toBe("old binary");
  });

  test("rebuilds when the installed app is ad-hoc signed", () => {
    installApp("Identifier=com.hasna.recordings\nSignature=adhoc\n");
    const result = runInstaller();
    expect(result.status).toBe(0);
    expect(existsSync(join(markers, "build-invoked"))).toBeTrue();
    expect(readFileSync(join(appDest, "Contents", "MacOS", "Recordings"), "utf8").trim()).toBe("binary");
  });

  test("RECORDINGS_FORCE_APP_REINSTALL=1 overrides the stable-identity guard", () => {
    installApp("Identifier=com.hasna.recordings\nSignature size=5800\n");
    const result = runInstaller({ RECORDINGS_FORCE_APP_REINSTALL: "1" });
    expect(result.status).toBe(0);
    expect(existsSync(join(markers, "build-invoked"))).toBeTrue();
  });

  test("never invokes tccutil in any path", () => {
    installApp("Identifier=com.hasna.recordings\nSignature=adhoc\n");
    const result = runInstaller();
    expect(result.status).toBe(0);
    expect(existsSync(join(markers, "tccutil-invoked"))).toBeFalse();
  });
});
