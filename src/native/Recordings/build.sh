#!/usr/bin/env bash
# Build, sign, notarize, and finalize a Recordings.app artifact.
# Usage: ./build.sh [debug|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$SCRIPT_DIR"

case "$MODE" in
    debug|release) ;;
    *)
        echo "Mode must be debug or release" >&2
        exit 2
        ;;
esac

CODESIGN_IDENTITY="${RECORDINGS_CODESIGN_IDENTITY:-}"
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
NOTARY_PROFILE="${RECORDINGS_NOTARY_KEYCHAIN_PROFILE:-}"
PLIST_BUDDY="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"

if [ "$MODE" = "release" ]; then
    if [ -z "$CODESIGN_IDENTITY" ] || [ "$CODESIGN_IDENTITY" = "-" ]; then
        echo "Release builds require RECORDINGS_CODESIGN_IDENTITY for a Developer ID Application identity." >&2
        exit 1
    fi
    if [ -z "$EXPECTED_TEAM_ID" ]; then
        echo "Release builds require RECORDINGS_EXPECTED_TEAM_IDENTIFIER to pin the Developer ID team." >&2
        exit 1
    fi
    if [ -z "$NOTARY_PROFILE" ]; then
        echo "Release builds require RECORDINGS_NOTARY_KEYCHAIN_PROFILE for notarization." >&2
        exit 1
    fi
else
    CODESIGN_IDENTITY="-"
    EXPECTED_TEAM_ID="ADHOC"
    echo "WARNING: debug builds are ad-hoc signed and non-distributable; never install or upload this output." >&2
fi

echo "Building Recordings.app ($MODE)..."
swift build -c "$MODE" --product App

BUILD_DIR=".build/$MODE"
APP_DIR="$BUILD_DIR/Recordings.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
HELPERS="$CONTENTS/Helpers"

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES" "$HELPERS"
cp "$BUILD_DIR/App" "$MACOS/Recordings"
"$PACKAGE_ROOT/scripts/build_companion_cli.sh" "$HELPERS/recordings"
cp RecordingsLib/Info.plist "$CONTENTS/Info.plist"

for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$MODE"/*.resources .build/*/"$MODE"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

SIGN_ARGUMENTS=(--force --sign "$CODESIGN_IDENTITY")
if [ "$MODE" = "release" ]; then
    SIGN_ARGUMENTS+=(--options runtime --timestamp)
fi
codesign "${SIGN_ARGUMENTS[@]}" "$HELPERS/recordings"
bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" provenance \
    --app "$APP_DIR" \
    --team-id "$EXPECTED_TEAM_ID" \
    --package-root "$PACKAGE_ROOT"
codesign "${SIGN_ARGUMENTS[@]}" \
    --entitlements RecordingsLib/Recordings.entitlements \
    "$APP_DIR"

verify_signed_code() {
    local code_path="$1"
    local label="$2"
    local details
    local authority
    local team_id
    local timestamp
    codesign --verify --strict --verbose=2 "$code_path"
    details="$(codesign -d --verbose=4 "$code_path" 2>&1)"
    authority="$(printf '%s\n' "$details" | awk -F= '/^Authority=/ { print $2; exit }')"
    team_id="$(printf '%s\n' "$details" | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
    timestamp="$(printf '%s\n' "$details" | awk -F= '/^Timestamp=/ { print $2; exit }')"
    if [[ "$authority" != "Developer ID Application:"* ]]; then
        echo "$label is not signed by a Developer ID Application authority." >&2
        exit 1
    fi
    if [ "$team_id" != "$EXPECTED_TEAM_ID" ]; then
        echo "$label TeamIdentifier ${team_id:-missing} does not match ${EXPECTED_TEAM_ID}." >&2
        exit 1
    fi
    if [[ "$details" != *"(runtime)"* ]]; then
        echo "$label is missing hardened runtime signing." >&2
        exit 1
    fi
    case "$timestamp" in
        ''|none|None|NONE)
            echo "$label is missing a trusted signing timestamp." >&2
            exit 1
            ;;
    esac
}

codesign --verify --deep --strict --verbose=2 "$APP_DIR"

VERSION="$("$PLIST_BUDDY" -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist")"
if [ "$MODE" = "debug" ]; then
    echo "Built non-distributable debug app: $APP_DIR"
    exit 0
fi

verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
ARTIFACT_BASENAME="Recordings-${VERSION}-macos"
NOTARY_ARCHIVE="$BUILD_DIR/${ARTIFACT_BASENAME}-notarization.zip"
FINAL_ARCHIVE="$BUILD_DIR/${ARTIFACT_BASENAME}.zip"
FINAL_MANIFEST="$BUILD_DIR/${ARTIFACT_BASENAME}.manifest.json"

rm -f "$NOTARY_ARCHIVE" "$FINAL_ARCHIVE" "$FINAL_MANIFEST"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$NOTARY_ARCHIVE"
xcrun notarytool submit "$NOTARY_ARCHIVE" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait
rm -f "$NOTARY_ARCHIVE"
xcrun stapler staple "$APP_DIR"
xcrun stapler validate "$APP_DIR"
spctl --assess --type execute --verbose=2 "$APP_DIR"
verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$FINAL_ARCHIVE"
bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" finalize \
    --app "$APP_DIR" \
    --archive "$FINAL_ARCHIVE" \
    --manifest "$FINAL_MANIFEST" \
    --team-id "$EXPECTED_TEAM_ID"

echo "Built immutable app artifact: $FINAL_ARCHIVE"
echo "Built artifact manifest: $FINAL_MANIFEST"
