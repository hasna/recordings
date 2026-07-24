#!/usr/bin/env bash
# Build Recordings.app for macOS 26
# Usage: ./build.sh [debug|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# A STABLE certificate identity keeps the app's TCC designated requirement
# constant across rebuilds so macOS permission grants (Microphone /
# Accessibility) persist. Ad-hoc ("-") pins the identity to this exact binary's
# CDHash and forces re-authorization after every build, so we NEVER default to
# it. When no explicit identity is provided we create (once) and reuse a
# per-machine self-signed code-signing certificate held in a DEDICATED signing
# keychain, so the default postinstall path is self-contained AND works over a
# headless SSH session — no out-of-band env and no unlocked login keychain
# required.
SIGNING_CN="Hasna Recordings Signing"
SIGNING_DIR="${HOME}/.hasna/recordings/signing"
# Dedicated code-signing keychain. We NEVER touch the login keychain: over SSH
# the login keychain is locked and codesign would block on an interactive
# unlock/allow prompt. A dedicated keychain with a KNOWN password (stored in the
# vault) can be created, unlocked, and key-partition-listed non-interactively.
SIGNING_KEYCHAIN="${SIGNING_DIR}/recordings-signing.keychain-db"

# Resolve the macOS keychain/codesign tools by ABSOLUTE path when present, so a
# same-named shim earlier on PATH (e.g. the Hasna `security` CLI installed in
# ~/.bun/bin) cannot shadow the real /usr/bin/security. On hosts without those
# absolute paths (e.g. the Linux unit-test sandbox) we fall back to PATH so the
# tests can stub them.
SECURITY="/usr/bin/security"; [ -x "$SECURITY" ] || SECURITY="security"
CODESIGN="/usr/bin/codesign"; [ -x "$CODESIGN" ] || CODESIGN="codesign"
# SHA-1 hash of the signing identity, resolved by ensure_local_signing_identity.
SIGNING_IDENTITY=""

# Vault keys are host-scoped so each machine owns its own signing material.
signing_host() {
    hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown
}
vault_prefix() {
    printf 'hasna/machine/%s/recordings/signing' "$(signing_host)"
}

# Append the dedicated keychain to the USER search list (never replacing it) so
# codesign / find-identity can see the identity while leaving login and other
# keychains intact.
add_signing_keychain_to_search_list() {
    local target="$SIGNING_KEYCHAIN"
    local -a current=()
    local line trimmed
    while IFS= read -r line; do
        # `security list-keychains` prints each path indented and quoted.
        trimmed="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
        trimmed="${trimmed%\"}"; trimmed="${trimmed#\"}"
        [ -n "$trimmed" ] || continue
        [ "$trimmed" = "$target" ] && return 0        # already in the list
        current+=("$trimmed")
    done < <("$SECURITY" list-keychains -d user 2>/dev/null)
    "$SECURITY" list-keychains -d user -s "$target" ${current[@]+"${current[@]}"} >/dev/null 2>&1 \
        || echo "WARN: could not add $target to the keychain search list" >&2
}

# Create/reuse the "Hasna Recordings Signing" identity inside the DEDICATED
# signing keychain, unlocking it non-interactively with the known vault-stored
# password so codesign can sign over SSH without any prompt. Reusing the same
# certificate is what makes the designated requirement (certificate-based)
# stable across rebuilds so TCC grants survive. Returns 0 when usable.
ensure_local_signing_identity() {
    command -v "$SECURITY" >/dev/null 2>&1 || { echo "ERROR: 'security' not found" >&2; return 1; }
    command -v openssl  >/dev/null 2>&1 || { echo "ERROR: 'openssl' not found" >&2; return 1; }
    # The dedicated keychain's password lives in the vault; without the vault CLI
    # we cannot manage it non-interactively, so fail closed rather than fall back
    # to the (headless-hostile) login keychain.
    command -v secrets  >/dev/null 2>&1 || { echo "ERROR: 'secrets' vault CLI not found; cannot manage the dedicated signing keychain password" >&2; return 1; }

    local prefix pw_key cert_key key_key
    prefix="$(vault_prefix)"
    pw_key="${prefix}/keychain_password"
    cert_key="${prefix}/certificate_pem_b64"
    key_key="${prefix}/private_key_pem_b64"

    mkdir -p "$SIGNING_DIR" && chmod 700 "$SIGNING_DIR" 2>/dev/null || true

    # 1. Known keychain password: generate once, persist in the vault, reuse.
    local kc_pw
    kc_pw="$(secrets get "$pw_key" 2>/dev/null || true)"
    if [ -z "$kc_pw" ]; then
        kc_pw="$(openssl rand -base64 24 | tr -d '\n')"
        if ! secrets set "$pw_key" "$kc_pw" --type password \
                --label "Recordings signing keychain password ($(signing_host))" >/dev/null 2>&1; then
            echo "ERROR: failed to store signing keychain password in the vault ($pw_key)" >&2
            return 1
        fi
        echo "Generated dedicated signing keychain password (stored in vault: $pw_key)."
    fi

    # 2. Create the dedicated keychain if missing; ALWAYS unlock it with the
    #    known password. Disable auto-lock so the key stays reachable headless.
    if [ ! -f "$SIGNING_KEYCHAIN" ]; then
        echo "Creating dedicated code-signing keychain: $SIGNING_KEYCHAIN"
        if ! "$SECURITY" create-keychain -p "$kc_pw" "$SIGNING_KEYCHAIN" >/dev/null 2>&1; then
            echo "ERROR: failed to create dedicated signing keychain" >&2; return 1
        fi
    fi
    if ! "$SECURITY" unlock-keychain -p "$kc_pw" "$SIGNING_KEYCHAIN" >/dev/null 2>&1; then
        echo "ERROR: failed to unlock dedicated signing keychain (stale vault password?)" >&2; return 1
    fi
    # No timeout / no lock-on-sleep: keep it usable across a headless build.
    "$SECURITY" set-keychain-settings "$SIGNING_KEYCHAIN" >/dev/null 2>&1 || true

    # 3. Make the dedicated keychain discoverable to codesign/find-identity.
    add_signing_keychain_to_search_list

    # 4. Reuse the identity if it is already present in the dedicated keychain.
    #    NOTE: no -v (valid-only) filter. A self-signed identity is untrusted
    #    (CSSMERR_TP_NOT_TRUSTED) — and marking it trusted needs GUI auth that is
    #    unavailable over SSH — so it is invisible to `find-identity -v`. codesign
    #    can nonetheless sign with it, so we locate it by its SHA-1 HASH (which is
    #    also what we pass to `codesign --sign`, decoupling signing from the
    #    certificate's common name).
    SIGNING_IDENTITY="$("$SECURITY" find-identity -p codesigning "$SIGNING_KEYCHAIN" 2>/dev/null | grep -oE '[0-9A-F]{40}' | head -1)"
    if [ -n "$SIGNING_IDENTITY" ]; then
        # Re-assert non-interactive key access with the KNOWN password.
        "$SECURITY" set-key-partition-list -S apple-tool:,apple: -k "$kc_pw" "$SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
        return 0
    fi

    # 5. Materialize cert+key: reuse the vault copy if present (keeps the DR — and
    #    the TCC grants bound to it — stable even if the keychain is recreated),
    #    otherwise mint a new self-signed identity and persist it to the vault.
    local work key crt p12 vault_cert_b64 vault_key_b64
    work="$(mktemp -d)" || return 1
    key="$work/key.pem"; crt="$work/cert.pem"; p12="$work/identity.p12"

    vault_cert_b64="$(secrets get "$cert_key" 2>/dev/null || true)"
    vault_key_b64="$(secrets get "$key_key" 2>/dev/null || true)"
    if [ -n "$vault_cert_b64" ] && [ -n "$vault_key_b64" ]; then
        printf '%s' "$vault_cert_b64" | openssl base64 -d -A > "$crt" 2>/dev/null || true
        printf '%s' "$vault_key_b64"  | openssl base64 -d -A > "$key" 2>/dev/null || true
        [ -s "$crt" ] && [ -s "$key" ] && echo "Reusing signing certificate from vault ($cert_key)."
    fi
    if [ ! -s "$crt" ] || [ ! -s "$key" ]; then
        echo "Minting new self-signed code-signing certificate \"$SIGNING_CN\" (one-time)..."
        cat > "$work/req.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[ dn ]
CN = $SIGNING_CN
[ ext ]
basicConstraints   = critical,CA:false
keyUsage           = critical,digitalSignature
extendedKeyUsage   = critical,codeSigning
EOF
        if ! openssl req -x509 -newkey rsa:2048 -nodes -keyout "$key" -out "$crt" \
                -days 3650 -config "$work/req.cnf" >/dev/null 2>&1; then
            rm -rf "$work"; echo "ERROR: failed to generate self-signed signing certificate" >&2; return 1
        fi
        # Persist so future rebuilds — even after keychain re-creation or machine
        # re-provisioning — reuse the SAME identity and keep the DR stable.
        secrets set "$cert_key" "$(openssl base64 -A -in "$crt")" --type certificate \
            --label "Recordings signing cert ($(signing_host))" >/dev/null 2>&1 \
            || echo "WARN: could not persist signing certificate to vault ($cert_key)" >&2
        secrets set "$key_key" "$(openssl base64 -A -in "$key")" --type private_key \
            --label "Recordings signing key ($(signing_host))" >/dev/null 2>&1 \
            || echo "WARN: could not persist signing key to vault ($key_key)" >&2
    fi

    # Package as PKCS#12 for `security import`. macOS's Security framework cannot
    # read the PBKDF2/AES encoding OpenSSL 3 emits by default, so prefer -legacy
    # (RC2/3DES + SHA1 MAC) and fall back for OpenSSL builds without it. Use a
    # non-empty transport passphrase (the keychain password): an empty p12
    # password trips "MAC verification failed" on macOS import.
    if ! openssl pkcs12 -export -legacy -inkey "$key" -in "$crt" -name "$SIGNING_CN" \
            -out "$p12" -passout pass:"$kc_pw" >/dev/null 2>&1; then
        if ! openssl pkcs12 -export -inkey "$key" -in "$crt" -name "$SIGNING_CN" \
                -out "$p12" -passout pass:"$kc_pw" >/dev/null 2>&1; then
            rm -rf "$work"; echo "ERROR: failed to package signing identity as PKCS#12" >&2; return 1
        fi
    fi
    # Import into the DEDICATED keychain (never the login keychain), allowlisting
    # codesign so it may use the private key.
    if ! "$SECURITY" import "$p12" -k "$SIGNING_KEYCHAIN" -P "$kc_pw" -T /usr/bin/codesign >/dev/null 2>&1; then
        rm -rf "$work"; echo "ERROR: failed to import signing identity into $SIGNING_KEYCHAIN" >&2; return 1
    fi
    # Trust the self-signed root for code signing so `codesign --verify` passes.
    "$SECURITY" add-trusted-cert -r trustRoot -p codeSign -k "$SIGNING_KEYCHAIN" "$crt" >/dev/null 2>&1 || true
    # THE headless fix: grant codesign non-interactive access to the imported key
    # using the KNOWN keychain password (never an empty password, never the login
    # keychain), so signing works over SSH with no interactive allow prompt.
    if ! "$SECURITY" set-key-partition-list -S apple-tool:,apple: -k "$kc_pw" "$SIGNING_KEYCHAIN" >/dev/null 2>&1; then
        echo "WARN: set-key-partition-list did not complete; codesign may prompt for key access" >&2
    fi
    rm -rf "$work"

    # Locate the freshly imported identity by hash (again, no -v: it is an
    # untrusted self-signed cert). codesign signs by this hash.
    SIGNING_IDENTITY="$("$SECURITY" find-identity -p codesigning "$SIGNING_KEYCHAIN" 2>/dev/null | grep -oE '[0-9A-F]{40}' | head -1)"
    [ -n "$SIGNING_IDENTITY" ]
}

echo "Building Recordings.app ($MODE)..."
swift build -c "$MODE" --product App

# Create .app bundle
BUILD_DIR=".build/$MODE"
APP_DIR="$BUILD_DIR/Recordings.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"

# Copy binary
cp "$BUILD_DIR/App" "$MACOS/Recordings"

# Copy Info.plist
cp RecordingsLib/Info.plist "$CONTENTS/Info.plist"

# Copy SwiftPM resource bundles used by Bundle.module.
for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$MODE"/*.resources .build/*/"$MODE"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

# FAIL CLOSED on missing entitlements. Without the entitlements file the app
# would be signed with no Microphone/Accessibility entitlements (or skipped and
# left effectively unsigned) — a silent, safety-critical regression. Refuse to
# build instead.
if [ ! -f RecordingsLib/Recordings.entitlements ]; then
    echo "ERROR: RecordingsLib/Recordings.entitlements is missing." >&2
    echo "Refusing to build: the app must be signed with its entitlements;" >&2
    echo "skipping signing would ship an unsigned/unentitled Recordings.app." >&2
    exit 1
fi

# Sign with entitlements using a STABLE identity. A signing failure must fail
# the build: silently falling back to ad-hoc would reintroduce identity churn
# and invalidate existing TCC grants.
#
# Precedence:
#   1. RECORDINGS_CODESIGN_IDENTITY — explicit identity (Developer ID, station
#      signing cert, or "-" for an intentional ad-hoc build). An explicit
#      identity that fails to sign fails the build.
#   2. The per-machine "Hasna Recordings Signing" self-signed certificate in the
#      DEDICATED signing keychain, created once and reused, so the default build
#      is stably signed non-interactively (works over SSH) with no out-of-band
#      configuration. We never fall back to ad-hoc by default.
if [ -n "${RECORDINGS_CODESIGN_IDENTITY:-}" ]; then
    "$CODESIGN" --force --sign "$RECORDINGS_CODESIGN_IDENTITY" --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR"
elif ensure_local_signing_identity; then
    "$CODESIGN" --force --keychain "$SIGNING_KEYCHAIN" --sign "$SIGNING_IDENTITY" --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR"
else
    echo "ERROR: no stable code-signing identity is available and refusing to" >&2
    echo "ad-hoc sign: ad-hoc signatures change the app's designated requirement" >&2
    echo "on every build and break macOS Microphone/Accessibility grants." >&2
    echo "Set RECORDINGS_CODESIGN_IDENTITY to a valid signing identity and retry." >&2
    exit 1
fi

echo "✓ Built $APP_DIR"
echo ""
echo "To install to ~/.hasna/recordings/:"
echo "  cp -r $APP_DIR ~/.hasna/recordings/Recordings.app"
echo ""
echo "To run:"
echo "  open $APP_DIR"
