import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install_macos_app.sh");
const BUILD_SH = join(REPO_ROOT, "src", "native", "Recordings", "build.sh");

describe("install_macos_app.sh / build.sh source contract", () => {
  const installer = readFileSync(INSTALLER, "utf8");
  const buildScript = readFileSync(BUILD_SH, "utf8");

  test("installer never touches TCC permission state", () => {
    expect(installer).not.toContain("tccutil");
    expect(installer).not.toContain("TCC.db");
  });

  test("installer skips rebuild on source freshness, not signature", () => {
    // The deterministic, version-aware guard replaced the signature-based one.
    expect(installer).toContain("compute_source_hash");
    expect(installer).toContain(".recordings-source-hash");
    expect(installer).toContain("RECORDINGS_FORCE_APP_REINSTALL");
    expect(installer).not.toContain("app_signature_is_stable");
    // The decision must not read the app signature at all.
    expect(installer).not.toContain("codesign");
    expect(installer).not.toContain("adhoc");
  });

  test("build script signs with a stable identity by default (never ad-hoc)", () => {
    expect(buildScript).toContain("ensure_local_signing_identity");
    expect(buildScript).toContain("Hasna Recordings Signing");
    // Must never default to ad-hoc signing.
    expect(buildScript).not.toContain("--sign -");
    // An explicit identity must not silently fall back to ad-hoc on failure.
    expect(buildScript).toMatch(
      /codesign --force --sign "\$RECORDINGS_CODESIGN_IDENTITY" --entitlements [^|]*$/m,
    );
    expect(buildScript).toMatch(
      /codesign --force --sign "\$SIGNING_CN" --entitlements [^|]*$/m,
    );
  });
});

// End-to-end behavior with a fully stubbed macOS toolchain. The real installer
// and the real build.sh run; only the platform tools (swift/codesign/security/
// openssl/…) are stubbed. The stubs model a self-signed certificate whose
// designated requirement (DR) is derived from a per-machine serial that is
// created once and reused — mirroring how a real certificate keeps the DR
// stable across rebuilds. Ad-hoc signing (never used by default) is modelled as
// a cdhash DR that changes with the binary.
describe("install_macos_app.sh behavior (stubbed macOS toolchain)", () => {
  let fixture: string;
  let stubBin: string;
  let home: string;
  let markers: string;
  let keychain: string;
  let nativeDir: string;
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
        KEYCHAIN: keychain,
        ...extraEnv,
      },
    });
  }

  function markerCount(name: string): number {
    const p = join(markers, name);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0).length;
  }

  function lastSignIdentity(): string {
    const p = join(markers, "codesign-identity");
    if (!existsSync(p)) return "";
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
    return lines[lines.length - 1] ?? "";
  }

  function installedSignatureState(): string {
    const p = join(appDest, "Contents", "signature-state");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "recordings-install-test-"));
    stubBin = join(fixture, "stub-bin");
    home = join(fixture, "home");
    markers = join(fixture, "markers");
    keychain = join(fixture, "keychain-state");
    mkdirSync(stubBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(markers, { recursive: true });

    // Fixture package layout. The installer derives PACKAGE_ROOT from its path.
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    cpSync(INSTALLER, join(fixture, "scripts", "install_macos_app.sh"));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "@hasna/recordings", version: "0.2.11" }));

    // Real build.sh drives the signing path; only the native sources are faked.
    nativeDir = join(fixture, "src", "native", "Recordings");
    mkdirSync(join(nativeDir, "RecordingsLib"), { recursive: true });
    cpSync(BUILD_SH, join(nativeDir, "build.sh"));
    chmodSync(join(nativeDir, "build.sh"), 0o755);
    writeFileSync(join(nativeDir, "RecordingsLib", "Info.plist"), "<plist>original</plist>\n");
    writeFileSync(join(nativeDir, "RecordingsLib", "Recordings.entitlements"), "<entitlements/>\n");

    appDest = join(home, ".hasna", "recordings", "Recordings.app");

    writeStub("uname", "echo Darwin");
    writeStub("pgrep", "exit 1");
    writeStub("pkill", "exit 0");
    writeStub("open", "exit 0");
    writeStub("ditto", 'cp -R "$1" "$2"');
    writeStub("tccutil", 'touch "$MARKERS/tccutil-invoked"; exit 0');

    // swift build stub: produces the product binary build.sh expects, and
    // records each invocation so tests can assert rebuild vs skip.
    writeStub(
      "swift",
      [
        "mode=release",
        'prev=""',
        'for a in "$@"; do if [ "$prev" = "-c" ]; then mode="$a"; fi; prev="$a"; done',
        'mkdir -p ".build/$mode"',
        'echo binary > ".build/$mode/App"',
        'echo run >> "$MARKERS/swift-count"',
        "exit 0",
      ].join("\n"),
    );

    // security stub: models a login-keychain code-signing identity that is
    // created once (recording a stable per-machine serial) and reused.
    writeStub(
      "security",
      [
        'cmd="$1"; shift || true',
        'case "$cmd" in',
        "  find-identity)",
        '    if [ -f "$KEYCHAIN" ]; then echo "  1) ABCDEF1234 \\"Hasna Recordings Signing\\""; fi',
        "    exit 0 ;;",
        "  import)",
        '    if [ ! -f "$KEYCHAIN" ]; then',
        `      printf 'CN=Hasna Recordings Signing\\nSERIAL=%s\\n' "$$-$RANDOM-$RANDOM" > "$KEYCHAIN"`,
        '      echo x >> "$MARKERS/cert-created"',
        "    fi",
        "    exit 0 ;;",
        "  add-trusted-cert|set-key-partition-list) exit 0 ;;",
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
    );

    // openssl stub: satisfies build.sh by creating the requested output files.
    writeStub(
      "openssl",
      [
        'prev=""',
        'for a in "$@"; do',
        '  case "$prev" in -out|-keyout) : > "$a" 2>/dev/null || true ;; esac',
        '  prev="$a"',
        "done",
        "exit 0",
      ].join("\n"),
    );

    // codesign stub: --sign <cert> writes a certificate-based DR derived from
    // the reused serial (stable across rebuilds); --sign - writes a cdhash DR
    // (changes with the binary). Records the identity used.
    writeStub(
      "codesign",
      [
        'op="$1"',
        'if [ "$op" = "--verify" ]; then exit 0; fi',
        'if [ "$op" = "-d" ]; then',
        '  app="${@: -1}"',
        '  [ -f "$app/Contents/signature-state" ] && cat "$app/Contents/signature-state" >&2',
        "  exit 0",
        "fi",
        'id=""; app=""',
        'while [ "$#" -gt 0 ]; do',
        "  case \"$1\" in",
        '    --sign) id="$2"; shift 2 ;;',
        "    --entitlements) shift 2 ;;",
        "    --force) shift ;;",
        '    *) app="$1"; shift ;;',
        "  esac",
        "done",
        'echo "$id" >> "$MARKERS/codesign-identity"',
        'mkdir -p "$app/Contents"',
        'if [ "$id" = "-" ]; then',
        '  cdh="$(shasum "$app/Contents/MacOS/Recordings" 2>/dev/null | awk "{print \\$1}")"',
        `  printf 'Identifier=com.hasna.recordings\\nSignature=adhoc\\ndesignated => cdhash H"%s"\\n' "$cdh" > "$app/Contents/signature-state"`,
        "else",
        `  serial="$(grep '^SERIAL=' "$KEYCHAIN" 2>/dev/null | head -1 | cut -d= -f2)"`,
        '  dr="$(printf "%s" "$serial" | shasum | awk "{print \\$1}")"',
        `  printf 'Identifier=com.hasna.recordings\\nAuthority=%s\\ndesignated => identifier "com.hasna.recordings" and certificate leaf = H"%s"\\n' "$id" "$dr" > "$app/Contents/signature-state"`,
        "fi",
        "exit 0",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  test("default postinstall (no env) yields a certificate-based DR, not ad-hoc", () => {
    const result = runInstaller();
    expect(result.status).toBe(0);
    // A per-machine signing certificate was created once and used to sign.
    expect(markerCount("cert-created")).toBe(1);
    expect(lastSignIdentity()).toBe("Hasna Recordings Signing");

    const state = installedSignatureState();
    expect(state).toContain("certificate leaf");
    expect(state).toContain("Authority=Hasna Recordings Signing");
    // The DR is NOT an ad-hoc cdhash.
    expect(state).not.toContain("Signature=adhoc");
    expect(state).not.toContain("cdhash");
  });

  test("unchanged source -> no rebuild, grant untouched", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    expect(markerCount("swift-count")).toBe(1);
    const drBefore = installedSignatureState();
    const binBefore = readFileSync(join(appDest, "Contents", "MacOS", "Recordings"), "utf8");

    const second = runInstaller();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("skipping rebuild");
    // No rebuild happened: swift was not invoked a second time.
    expect(markerCount("swift-count")).toBe(1);
    // The installed (already-granted) app is byte-for-byte untouched.
    expect(readFileSync(join(appDest, "Contents", "MacOS", "Recordings"), "utf8")).toBe(binBefore);
    expect(installedSignatureState()).toBe(drBefore);
  });

  test("changed source -> rebuild + re-sign with the SAME cert -> DR persists", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    expect(markerCount("swift-count")).toBe(1);
    expect(markerCount("cert-created")).toBe(1);
    const drBefore = installedSignatureState();
    expect(drBefore).toContain("certificate leaf");

    // A genuine app update: change a native source file so the hash changes.
    writeFileSync(join(nativeDir, "RecordingsLib", "Info.plist"), "<plist>updated build</plist>\n");

    const second = runInstaller();
    expect(second.status).toBe(0);
    // The changed source forced a rebuild...
    expect(markerCount("swift-count")).toBe(2);
    // ...that reused the SAME certificate (not created again)...
    expect(markerCount("cert-created")).toBe(1);
    expect(lastSignIdentity()).toBe("Hasna Recordings Signing");
    // ...so the certificate-based DR is identical -> the TCC grant persists.
    const drAfter = installedSignatureState();
    expect(drAfter).toContain("certificate leaf");
    expect(drAfter).toBe(drBefore);
  });

  test("skip is source-based: an ad-hoc-signed app with matching source is still skipped", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    expect(markerCount("swift-count")).toBe(1);

    // Corrupt the installed signature to ad-hoc WITHOUT changing the sources.
    // A signature-based guard would rebuild here; the source-based guard skips.
    writeFileSync(
      join(appDest, "Contents", "signature-state"),
      'Identifier=com.hasna.recordings\nSignature=adhoc\ndesignated => cdhash H"deadbeef"\n',
    );

    const second = runInstaller();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("skipping rebuild");
    expect(markerCount("swift-count")).toBe(1);
  });

  test("skip is source-based: a stably-signed app with a stale stamp is rebuilt", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    expect(markerCount("swift-count")).toBe(1);
    // App is stably (certificate) signed...
    expect(installedSignatureState()).toContain("certificate leaf");

    // ...but the recorded source hash is stale (as if sources moved on).
    writeFileSync(join(home, ".hasna", "recordings", ".recordings-source-hash"), "staleplaceholderhash\n");

    const second = runInstaller();
    expect(second.status).toBe(0);
    // Rebuilt despite the stable signature, because the source hash mismatched.
    expect(markerCount("swift-count")).toBe(2);
  });

  test("RECORDINGS_FORCE_APP_REINSTALL=1 overrides the source-freshness guard", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    expect(markerCount("swift-count")).toBe(1);

    const second = runInstaller({ RECORDINGS_FORCE_APP_REINSTALL: "1" });
    expect(second.status).toBe(0);
    expect(markerCount("swift-count")).toBe(2);
  });

  test("never invokes tccutil in any path", () => {
    // Rebuild path.
    runInstaller();
    expect(existsSync(join(markers, "tccutil-invoked"))).toBeFalse();
    // Skip path.
    runInstaller();
    expect(existsSync(join(markers, "tccutil-invoked"))).toBeFalse();
  });

  test("refreshes the ~/Applications copy on the skip path too", () => {
    const first = runInstaller();
    expect(first.status).toBe(0);
    // Seed a stale ~/Applications launch point.
    const altCopy = join(home, "Applications", "Recordings.app", "Contents", "MacOS");
    mkdirSync(altCopy, { recursive: true });
    writeFileSync(join(altCopy, "Recordings"), "stale");

    const second = runInstaller();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("skipping rebuild");
    // The launch point was refreshed from the current app even though we skipped.
    expect(second.stdout).toContain("Updated stale copy");
    expect(readFileSync(join(altCopy, "Recordings"), "utf8").trim()).toBe("binary");
  });
});
