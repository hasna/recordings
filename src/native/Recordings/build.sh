#!/usr/bin/env bash
# Build Recordings.app for macOS 26
# Usage: ./build.sh [debug|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building Recordings.app ($MODE)..."
swift build -c "$MODE" --product App

# Create .app bundle
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

# Copy SwiftPM resource bundles used by Bundle.module.
for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$MODE"/*.resources .build/*/"$MODE"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

# Copy entitlements (for codesigning)
if [ -f RecordingsLib/Recordings.entitlements ]; then
    codesign --force --sign - --entitlements RecordingsLib/Recordings.entitlements "$APP_DIR" 2>/dev/null || true
fi

echo "✓ Built $APP_DIR"
echo ""
echo "To install to ~/.hasna/recordings/:"
echo "  cp -r $APP_DIR ~/.hasna/recordings/Recordings.app"
echo ""
echo "To run:"
echo "  open $APP_DIR"
