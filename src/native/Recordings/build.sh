#!/usr/bin/env bash
# Build, sign, and optionally notarize Recordings.app.
# Usage: ./build.sh [debug|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

case "$MODE" in
    debug|release) ;;
    *)
        echo "Mode must be debug or release" >&2
        exit 2
        ;;
esac

CODESIGN_IDENTITY="${RECORDINGS_CODESIGN_IDENTITY:-}"
NOTARY_PROFILE="${RECORDINGS_NOTARY_KEYCHAIN_PROFILE:-}"

if [ "$MODE" = "release" ]; then
    if [ -z "$CODESIGN_IDENTITY" ] || [ "$CODESIGN_IDENTITY" = "-" ]; then
        echo "Release builds require RECORDINGS_CODESIGN_IDENTITY for a stable Developer ID Application identity." >&2
        exit 1
    fi
    if [ -z "$NOTARY_PROFILE" ]; then
        echo "Release builds require RECORDINGS_NOTARY_KEYCHAIN_PROFILE for notarization." >&2
        exit 1
    fi
else
    CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
fi

echo "Building Recordings.app ($MODE)..."
swift build -c "$MODE" --product App

BUILD_DIR=".build/$MODE"
APP_DIR="$BUILD_DIR/Recordings.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
HELPERS="$CONTENTS/Helpers"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES" "$HELPERS"

# Copy binary
cp "$BUILD_DIR/App" "$MACOS/Recordings"

# Embed an immutable, same-source CLI so the app cannot accidentally run an older
# global `recordings` installation with a different command surface.
"$PACKAGE_ROOT/scripts/build_companion_cli.sh" "$HELPERS/recordings"

# Copy Info.plist
cp RecordingsLib/Info.plist "$CONTENTS/Info.plist"

for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$MODE"/*.resources .build/*/"$MODE"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

SIGN_ARGUMENTS=(
    --force
    --sign "$CODESIGN_IDENTITY"
)
if [ "$MODE" = "release" ]; then
    SIGN_ARGUMENTS+=(--options runtime --timestamp)
fi

codesign "${SIGN_ARGUMENTS[@]}" "$HELPERS/recordings"
codesign "${SIGN_ARGUMENTS[@]}" \
    --entitlements RecordingsLib/Recordings.entitlements \
    "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

if [ "$MODE" = "release" ]; then
    NOTARY_ARCHIVE="$BUILD_DIR/Recordings-notarization.zip"
    rm -f "$NOTARY_ARCHIVE"
    ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$NOTARY_ARCHIVE"
    xcrun notarytool submit "$NOTARY_ARCHIVE" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait
    rm -f "$NOTARY_ARCHIVE"
    xcrun stapler staple "$APP_DIR"
    xcrun stapler validate "$APP_DIR"
    spctl --assess --type execute --verbose=2 "$APP_DIR"
fi

echo "Built $APP_DIR"
if [ "$MODE" = "debug" ] && [ "$CODESIGN_IDENTITY" = "-" ]; then
    echo "Debug build uses an ad-hoc signature; macOS permissions may not survive replacement."
fi
