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
PLUTIL="${PLUTIL:-/usr/bin/plutil}"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-$(command -v bun)}"

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
VERSION="$("$PLIST_BUDDY" -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist")"

for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$MODE"/*.resources .build/*/"$MODE"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

APP_SIGN_ARGUMENTS=(--force --sign "$CODESIGN_IDENTITY")
HELPER_SIGN_ARGUMENTS=(--force --sign "$CODESIGN_IDENTITY" --options runtime)
if [ "$MODE" = "release" ]; then
    APP_SIGN_ARGUMENTS+=(--options runtime --timestamp)
    HELPER_SIGN_ARGUMENTS+=(--timestamp)
fi
codesign "${HELPER_SIGN_ARGUMENTS[@]}" \
    --entitlements RecordingsLib/RecordingsCLI.entitlements \
    "$HELPERS/recordings"

verify_helper_entitlements() {
    local helper="$1"
    local entitlement_plist
    local entitlement_json
    entitlement_plist="$(mktemp)"
    if ! codesign -d --entitlements :- "$helper" >"$entitlement_plist" 2>/dev/null; then
        rm -f "$entitlement_plist"
        echo "Companion CLI signed entitlements could not be read back." >&2
        return 1
    fi
    entitlement_json="$("$PLUTIL" -convert json -o - "$entitlement_plist" | tr -d '[:space:]')"
    rm -f "$entitlement_plist"
    if ! ENTITLEMENT_JSON="$entitlement_json" "$BUN_EXECUTABLE" -e '
        const actual = JSON.parse(process.env.ENTITLEMENT_JSON ?? "null");
        const expected = [
          "com.apple.security.cs.allow-jit",
          "com.apple.security.cs.allow-unsigned-executable-memory",
        ];
        if (!actual || Array.isArray(actual)) process.exit(1);
        const keys = Object.keys(actual).sort();
        if (JSON.stringify(keys) !== JSON.stringify(expected)) process.exit(1);
        if (!keys.every((key) => actual[key] === true)) process.exit(1);
    '; then
        echo "Companion CLI has unexpected hardened-runtime entitlements: ${entitlement_json:-missing}." >&2
        return 1
    fi
}

has_hardened_runtime_flag() {
    local details="$1"
    local flags
    flags="$(printf '%s\n' "$details" | sed -n 's/^CodeDirectory .*flags=[^(]*(\([^)]*\)).*/\1/p' | head -n 1)"
    case ",$flags," in
        *,runtime,*) return 0 ;;
        *) return 1 ;;
    esac
}

verify_hardened_helper() {
    local details
    codesign --verify --strict --verbose=2 "$HELPERS/recordings"
    details="$(codesign -d --verbose=4 "$HELPERS/recordings" 2>&1)"
    if ! has_hardened_runtime_flag "$details"; then
        echo "Companion CLI is missing hardened runtime signing." >&2
        exit 1
    fi
    verify_helper_entitlements "$HELPERS/recordings"
}

run_signed_helper_contract() {
    local contract_home
    local version
    local project_output
    local recording_output
    local helper_executable
    contract_home="$(mktemp -d)"
    helper_executable="$SCRIPT_DIR/$HELPERS/recordings"
    local -a contract_environment=(
        env -i
        HOME="$contract_home"
        PATH="/usr/bin:/bin:/usr/sbin:/sbin"
        HASNA_RECORDINGS_STORAGE_MODE="local"
        RECORDINGS_STORAGE_MODE="local"
        HASNA_RECORDINGS_DB_PATH="$contract_home/recordings.db"
        RECORDINGS_AUDIO_DIR="$contract_home/audio"
    )
    contract_run() {
        (cd "$contract_home" && "${contract_environment[@]}" "$@")
    }
    if ! version="$(contract_run "$helper_executable" --version)" || \
       [ "$version" != "$VERSION" ] || \
       ! project_output="$(contract_run "$helper_executable" --json project register \
           --name "Signed Helper Contract" \
           --path "recordings-app://build/signed-helper-contract")" || \
       [[ "$project_output" != *"Signed Helper Contract"* ]] || \
       ! recording_output="$(contract_run "$helper_executable" --json save-text \
           "Signed helper contract" \
           --source "native_build_contract" \
           --post-processing off)" || \
       [[ "$recording_output" != *"Signed helper contract"* ]]; then
        rm -rf "$contract_home"
        echo "Post-sign signed companion CLI contract failed." >&2
        exit 1
    fi
    if ! PROJECT_JSON="$project_output" RECORDING_JSON="$recording_output" "$BUN_EXECUTABLE" -e '
        const project = JSON.parse(process.env.PROJECT_JSON ?? "null");
        const recording = JSON.parse(process.env.RECORDING_JSON ?? "null");
        if (project?.name !== "Signed Helper Contract") process.exit(1);
        if (project?.path !== "recordings-app://build/signed-helper-contract") process.exit(1);
        if (recording?.raw_text !== "Signed helper contract") process.exit(1);
    '; then
        rm -rf "$contract_home"
        echo "Post-sign signed companion CLI contract returned invalid JSON." >&2
        exit 1
    fi
    rm -rf "$contract_home"
}

verify_hardened_helper
run_signed_helper_contract
bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" provenance \
    --app "$APP_DIR" \
    --team-id "$EXPECTED_TEAM_ID" \
    --package-root "$PACKAGE_ROOT"
codesign "${APP_SIGN_ARGUMENTS[@]}" \
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
    if ! has_hardened_runtime_flag "$details"; then
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
"$PACKAGE_ROOT/scripts/smoke_macos_app.sh" "$APP_DIR"

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
