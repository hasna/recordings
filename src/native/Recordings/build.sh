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

rm -rf "$APP_DIR"
mkdir -p "$MACOS"

# Copy binary
cp "$BUILD_DIR/App" "$MACOS/Recordings"

# Copy Info.plist
cp RecordingsLib/Info.plist "$CONTENTS/Info.plist"

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
