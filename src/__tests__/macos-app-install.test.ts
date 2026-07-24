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
      /"\$CODESIGN" --force --sign "\$RECORDINGS_CODESIGN_IDENTITY" --entitlements [^|]*$/m,
    );
    // The default path signs against the DEDICATED keychain, by the identity's
    // resolved SHA-1 hash (decoupled from the certificate common name).
    expect(buildScript).toMatch(
      /"\$CODESIGN" --force --keychain "\$SIGNING_KEYCHAIN" --sign "\$SIGNING_IDENTITY" --entitlements [^|]*$/m,
    );
  });

  test("p12 import is macOS-compatible and non-interactive", () => {
    // OpenSSL 3's default p12 encoding fails macOS `security import`; use -legacy
    // and a non-empty transport passphrase (never -P "").
    expect(buildScript).toContain("openssl pkcs12 -export -legacy");
    expect(buildScript).not.toContain('-P ""');
    expect(buildScript).toContain('-P "$kc_pw"');
  });

  test("signing identity is located by hash without the valid-only filter", () => {
    // A self-signed identity is untrusted (CSSMERR_TP_NOT_TRUSTED) and invisible
    // to `find-identity -v`; marking it trusted needs GUI auth unavailable over
    // SSH. So we must NOT use -v, and locate the identity by its SHA-1 hash.
    expect(buildScript).not.toContain("find-identity -v -p");
    expect(buildScript).toContain("find-identity -p codesigning");
    expect(buildScript).toMatch(/grep -oE '\[0-9A-F\]\{40\}'/);
  });

  test("keychain tools are invoked by absolute path (shim-proof)", () => {
    // A same-named `security` shim earlier on PATH must not shadow the real
    // macOS keychain tool, so build.sh resolves /usr/bin/security by absolute
    // path (falling back to PATH only where the absolute path is absent).
    expect(buildScript).toContain('SECURITY="/usr/bin/security"');
    expect(buildScript).toContain('CODESIGN="/usr/bin/codesign"');
    // The keychain commands go through the resolved binary, not bare `security`.
    expect(buildScript).toMatch(/"\$SECURITY" (create-keychain|unlock-keychain|find-identity|import|set-key-partition-list)/);
  });

  test("headless keychain auth: dedicated keychain, known password, never -k \"\"", () => {
    // THE blocker regression guard: codesign key access over SSH must never be
    // granted with an empty keychain password, and must never rely on the login
    // keychain being unlocked.
    expect(buildScript).not.toContain('-k ""');
    expect(buildScript).not.toContain("login.keychain");
    // A dedicated signing keychain under the recordings data dir is used.
    expect(buildScript).toContain("recordings-signing.keychain-db");
    expect(buildScript).toContain('"$SECURITY" create-keychain');
    expect(buildScript).toContain('"$SECURITY" unlock-keychain');
    // Non-interactive key access uses the KNOWN keychain password variable.
    expect(buildScript).toContain(
      'set-key-partition-list -S apple-tool:,apple: -k "$kc_pw"',
    );
    // The dedicated keychain is added to the search list for signing.
    expect(buildScript).toContain("add_signing_keychain_to_search_list");
    expect(buildScript).toContain('"$SECURITY" list-keychains');
  });

  test("keychain password is sourced from the vault by host-scoped name", () => {
    // Password (a secret) is never inlined; it is read/written via the vault
    // under a host-scoped key. Never a literal secret value in the script.
    expect(buildScript).toContain("hasna/machine/");
    expect(buildScript).toContain("recordings/signing");
    expect(buildScript).toContain("keychain_password");
    expect(buildScript).toContain("secrets get");
    expect(buildScript).toContain("secrets set");
  });

  test("build FAILS CLOSED when the entitlements file is absent", () => {
    // Missing entitlements must abort the build, not skip signing (which would
    // ship an unsigned/unentitled app).
    expect(buildScript).toMatch(
      /if \[ ! -f RecordingsLib\/Recordings\.entitlements \]; then/,
    );
    // The old "sign only if entitlements exist, else silently skip" shape is gone.
    expect(buildScript).not.toMatch(
      /if \[ -f RecordingsLib\/Recordings\.entitlements \]; then/,
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
  let vault: string;
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
        VAULT: vault,
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
    vault = join(fixture, "vault");
    mkdirSync(stubBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(markers, { recursive: true });
    mkdirSync(vault, { recursive: true });

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

    // secrets stub: models the local vault. `get` prints the stored value (exit
    // 1 when absent); `set` persists it. Keys are host-scoped in build.sh; the
    // password and cert/key material are keyed by name only — never inlined.
    writeStub(
      "secrets",
      [
        'cmd="$1"; shift || true',
        'key="$1"; shift || true',
        `safe="$(printf '%s' "$key" | tr '/ ' '__')"`,
        'f="$VAULT/$safe"',
        'case "$cmd" in',
        "  get)",
        '    if [ -f "$f" ]; then cat "$f"; exit 0; else echo "Not found: $key" >&2; exit 1; fi ;;',
        "  set)",
        '    val="$1"',
        '    mkdir -p "$VAULT"',
        `    printf '%s' "$val" > "$f"; exit 0 ;;`,
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
    );

    // security stub: models a DEDICATED signing keychain. `create-keychain`
    // makes the keychain file; `import` records the identity + a stable serial
    // taken from the (vault-persisted) certificate; `find-identity` reports the
    // identity when present in the given keychain. Unlock/settings/search-list/
    // partition-list are no-ops that succeed non-interactively.
    writeStub(
      "security",
      [
        'cmd="$1"; shift || true',
        'case "$cmd" in',
        "  create-keychain)",
        '    kc="${@: -1}"; : > "$kc"; echo x >> "$MARKERS/keychain-created"; exit 0 ;;',
        "  unlock-keychain|set-keychain-settings|list-keychains|add-trusted-cert)",
        "    exit 0 ;;",
        "  set-key-partition-list)",
        '    printf "%s\\n" "$*" >> "$MARKERS/set-key-partition-list"; exit 0 ;;',
        "  find-identity)",
        '    kc="${@: -1}"',
        '    if [ -f "$kc" ] && grep -q "^CN=Hasna Recordings Signing" "$kc" 2>/dev/null; then',
        // The identity's 40-hex SHA-1 is derived from the reused serial, so it is
        // stable across rebuilds (mirroring a real certificate identity). No -v:
        // the stub lists the (untrusted) identity regardless of validity.
        `      serial="$(grep '^SERIAL=' "$kc" 2>/dev/null | head -1 | cut -d= -f2)"`,
        `      h="$(printf '%s' "$serial" | shasum | awk '{print $1}' | tr 'a-f' 'A-F' | cut -c1-40)"`,
        '      echo "  1) $h \\"Hasna Recordings Signing\\""',
        "    fi",
        "    exit 0 ;;",
        "  import)",
        '    p12="$1"; shift',
        '    kc=""; prev=""',
        '    for a in "$@"; do case "$prev" in -k) kc="$a" ;; esac; prev="$a"; done',
        `    serial="$(grep -o 'SERIAL=[^ ]*' "$p12" 2>/dev/null | head -1 | cut -d= -f2)"`,
        `    printf 'CN=Hasna Recordings Signing\\nSERIAL=%s\\n' "$serial" > "$kc"`,
        '    echo x >> "$MARKERS/cert-created"',
        "    exit 0 ;;",
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
    );

    // openssl stub: `req` mints a cert/key pair sharing a stable serial; `pkcs12`
    // carries that serial into the p12; `base64` is an identity passthrough (so
    // vault round-tripping preserves the serial); `rand` yields a password.
    writeStub(
      "openssl",
      [
        'cmd="$1"; shift || true',
        'case "$cmd" in',
        "  req)",
        '    key=""; crt=""; prev=""',
        '    for a in "$@"; do case "$prev" in -keyout) key="$a" ;; -out) crt="$a" ;; esac; prev="$a"; done',
        '    serial="$$-$RANDOM-$RANDOM"',
        `    [ -n "$key" ] && printf 'KEY SERIAL=%s\\n' "$serial" > "$key"`,
        `    [ -n "$crt" ] && printf 'CERT SERIAL=%s\\n' "$serial" > "$crt"`,
        "    exit 0 ;;",
        "  pkcs12)",
        '    in=""; out=""; prev=""',
        '    for a in "$@"; do case "$prev" in -in) in="$a" ;; -out) out="$a" ;; esac; prev="$a"; done',
        '    [ -n "$out" ] && cat "$in" > "$out" 2>/dev/null || true',
        "    exit 0 ;;",
        "  base64)",
        '    infile=""; prev=""',
        '    for a in "$@"; do case "$prev" in -in) infile="$a" ;; esac; prev="$a"; done',
        '    if [ -n "$infile" ]; then cat "$infile"; else cat; fi',
        "    exit 0 ;;",
        "  rand)",
        '    echo "stubkcpw$$-$RANDOM"; exit 0 ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
    );

    // codesign stub: --sign <cert> --keychain <kc> writes a certificate-based DR
    // derived from the keychain's reused serial (stable across rebuilds);
    // --sign - writes a cdhash DR (changes with the binary). Records the identity.
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
        'id=""; app=""; kc=""',
        'while [ "$#" -gt 0 ]; do',
        "  case \"$1\" in",
        '    --sign) id="$2"; shift 2 ;;',
        '    --keychain) kc="$2"; shift 2 ;;',
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
        // Signed by the identity's hash; the Authority (cert CN) and the
        // certificate-based DR are read from the keychain's reused serial, so
        // they are stable across rebuilds.
        `  serial="$(grep '^SERIAL=' "$kc" 2>/dev/null | head -1 | cut -d= -f2)"`,
        `  cn="$(grep '^CN=' "$kc" 2>/dev/null | head -1 | cut -d= -f2-)"`,
        '  dr="$(printf "%s" "$serial" | shasum | awk "{print \\$1}")"',
        `  printf 'Identifier=com.hasna.recordings\\nAuthority=%s\\ndesignated => identifier "com.hasna.recordings" and certificate leaf = H"%s"\\n' "$cn" "$dr" > "$app/Contents/signature-state"`,
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
    // codesign is invoked with the identity's SHA-1 hash, not a name.
    expect(lastSignIdentity()).toMatch(/^[0-9A-F]{40}$/);

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
    expect(lastSignIdentity()).toMatch(/^[0-9A-F]{40}$/);
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
