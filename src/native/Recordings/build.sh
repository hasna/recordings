#!/usr/bin/env bash
# Build Recordings.app for macOS 26
# Usage: ./build.sh [debug|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# A stable certificate identity (e.g. a station signing certificate or a
# Developer ID) keeps the app's TCC designated requirement constant across
# rebuilds so macOS permission grants persist. Ad-hoc ("-") pins the identity
# to this exact binary's CDHash and forces re-authorization after every build.
CODESIGN_IDENTITY="${RECORDINGS_CODESIGN_IDENTITY:--}"

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

# Sign with entitlements. When an explicit certificate identity is requested,
# a signing failure must fail the build: silently falling back to ad-hoc would
# reintroduce identity churn and invalidate existing TCC grants.
if [ -f RecordingsLib/Recordings.entitlements ]; then
    if [ "$CODESIGN_IDENTITY" = "-" ]; then
        codesign --force --sign - --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR" 2>/dev/null || true
    else
        codesign --force --sign "$CODESIGN_IDENTITY" --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR"
    fi
fi

echo "✓ Built $APP_DIR"
echo ""
echo "To install to ~/.hasna/recordings/:"
echo "  cp -r $APP_DIR ~/.hasna/recordings/Recordings.app"
echo ""
echo "To run:"
echo "  open $APP_DIR"
