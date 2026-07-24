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
# per-machine self-signed code-signing certificate in the login keychain, so the
# default postinstall path is self-contained — no out-of-band env is required.
SIGNING_CN="Hasna Recordings Signing"

# Create the per-machine "Hasna Recordings Signing" identity if it does not yet
# exist, and reuse it on every subsequent build. Reusing the same certificate is
# what makes the designated requirement (certificate-based) stable across
# rebuilds so grants survive. Returns 0 when the identity is present/usable.
ensure_local_signing_identity() {
    command -v security >/dev/null 2>&1 || return 1
    command -v openssl  >/dev/null 2>&1 || return 1

    if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGNING_CN"; then
        return 0
    fi

    echo "Creating per-machine code-signing certificate \"$SIGNING_CN\" (one-time)..."
    local keychain work key crt p12
    keychain="${HOME}/Library/Keychains/login.keychain-db"
    [ -f "$keychain" ] || keychain="login.keychain"
    work="$(mktemp -d)" || return 1
    key="$work/key.pem"; crt="$work/cert.pem"; p12="$work/identity.p12"

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
        rm -rf "$work"; return 1
    fi
    if ! openssl pkcs12 -export -inkey "$key" -in "$crt" -name "$SIGNING_CN" \
            -out "$p12" -passout pass: >/dev/null 2>&1; then
        rm -rf "$work"; return 1
    fi
    # Import the identity and allow codesign to use its key without prompting.
    if ! security import "$p12" -k "$keychain" -P "" -T /usr/bin/codesign >/dev/null 2>&1; then
        rm -rf "$work"; return 1
    fi
    # Trust the self-signed root for code signing so `codesign --verify` passes.
    security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$crt" >/dev/null 2>&1 || true
    # Best-effort: unlock the key ACL for non-interactive signing. Harmless if it
    # fails (needs the keychain password on some setups); -T already allowlists
    # codesign.
    security set-key-partition-list -S apple-tool:,apple: -k "" "$keychain" >/dev/null 2>&1 || true
    rm -rf "$work"

    security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGNING_CN"
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

# Sign with entitlements using a STABLE identity. A signing failure must fail
# the build: silently falling back to ad-hoc would reintroduce identity churn
# and invalidate existing TCC grants.
#
# Precedence:
#   1. RECORDINGS_CODESIGN_IDENTITY — explicit identity (Developer ID, station
#      signing cert, or "-" for an intentional ad-hoc build). An explicit
#      identity that fails to sign fails the build.
#   2. The per-machine "Hasna Recordings Signing" self-signed certificate,
#      created once and reused, so the default build is stably signed with no
#      out-of-band configuration. We never fall back to ad-hoc by default.
if [ -f RecordingsLib/Recordings.entitlements ]; then
    if [ -n "${RECORDINGS_CODESIGN_IDENTITY:-}" ]; then
        codesign --force --sign "$RECORDINGS_CODESIGN_IDENTITY" --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR"
    elif ensure_local_signing_identity; then
        codesign --force --sign "$SIGNING_CN" --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR"
    else
        echo "ERROR: no stable code-signing identity is available and refusing to" >&2
        echo "ad-hoc sign: ad-hoc signatures change the app's designated requirement" >&2
        echo "on every build and break macOS Microphone/Accessibility grants." >&2
        echo "Set RECORDINGS_CODESIGN_IDENTITY to a valid signing identity and retry." >&2
        exit 1
    fi
fi

echo "✓ Built $APP_DIR"
echo ""
echo "To install to ~/.hasna/recordings/:"
echo "  cp -r $APP_DIR ~/.hasna/recordings/Recordings.app"
echo ""
echo "To run:"
echo "  open $APP_DIR"
