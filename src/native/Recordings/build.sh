#!/usr/bin/env bash
# Build, sign, notarize, and finalize a Recordings.app artifact.
# Usage: ./build.sh [debug|local|release]

set -euo pipefail

MODE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$SCRIPT_DIR"

case "$MODE" in
    debug|local|release) ;;
    *)
        echo "Mode must be debug, local, or release" >&2
        exit 2
        ;;
esac

CODESIGN_IDENTITY="${RECORDINGS_CODESIGN_IDENTITY:-}"
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
NOTARY_PROFILE="${RECORDINGS_NOTARY_KEYCHAIN_PROFILE:-}"
LOCAL_APPROVED_TARGET="${RECORDINGS_LOCAL_APPROVED_TARGET:-}"
LOCAL_APPROVED_TARGET_IDENTITY_SHA256="${RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256:-}"
PLIST_BUDDY="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
PLUTIL="${PLUTIL:-/usr/bin/plutil}"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-$(command -v bun)}"

BUILD_CONFIGURATION="release"
ARTIFACT_POLICY="release"
APPROVED_TARGET="fleet"
APPROVED_TARGET_IDENTITY_SHA256="none"
BUILDER_IDENTITY_SHA256="none"
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
elif [ "$MODE" = "local" ]; then
    if [ "$LOCAL_APPROVED_TARGET" != "station06" ]; then
        echo "Local-only builds currently require RECORDINGS_LOCAL_APPROVED_TARGET=station06." >&2
        exit 1
    fi
    if ! [[ "$LOCAL_APPROVED_TARGET_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
        echo "Local-only builds require RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256 from the approved machine registry." >&2
        exit 1
    fi
    BUILD_HOST="$(hostname -s)"
    if [ "$BUILD_HOST" = "$LOCAL_APPROVED_TARGET" ]; then
        echo "Local-only artifacts must be built on a non-target Mac." >&2
        exit 1
    fi
    BUILDER_PLATFORM_ID="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {print $(NF-1); exit}' | tr '[:upper:]' '[:lower:]')"
    if [ -z "$BUILDER_PLATFORM_ID" ]; then
        echo "Could not read the build Mac platform identity." >&2
        exit 1
    fi
    BUILDER_IDENTITY_SHA256="$(printf '%s' "$BUILDER_PLATFORM_ID" | shasum -a 256 | awk '{print $1}')"
    unset BUILDER_PLATFORM_ID
    if [ "$BUILDER_IDENTITY_SHA256" = "$LOCAL_APPROVED_TARGET_IDENTITY_SHA256" ]; then
        echo "Local-only artifacts must be built on a non-target Mac identity." >&2
        exit 1
    fi
    CODESIGN_IDENTITY="-"
    EXPECTED_TEAM_ID="ADHOC"
    ARTIFACT_POLICY="local_only"
    APPROVED_TARGET="$LOCAL_APPROVED_TARGET"
    APPROVED_TARGET_IDENTITY_SHA256="$LOCAL_APPROVED_TARGET_IDENTITY_SHA256"
    echo "WARNING: local-only artifacts are ad-hoc signed, non-notarized, and restricted to ${APPROVED_TARGET}." >&2
    echo "WARNING: installing can change code identity and require Microphone or Accessibility reauthorization." >&2
else
    BUILD_CONFIGURATION="debug"
    CODESIGN_IDENTITY="-"
    EXPECTED_TEAM_ID="ADHOC"
    ARTIFACT_POLICY="local_only"
    APPROVED_TARGET="debug-only"
    echo "WARNING: debug builds are ad-hoc signed and non-distributable; never install or upload this output." >&2
fi

echo "Building Recordings.app ($MODE)..."
swift build -c "$BUILD_CONFIGURATION" --product App

BUILD_DIR=".build/$BUILD_CONFIGURATION"
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

for bundle in "$BUILD_DIR"/*.resources "$BUILD_DIR"/*.bundle .build/*/"$BUILD_CONFIGURATION"/*.resources .build/*/"$BUILD_CONFIGURATION"/*.bundle; do
    [ -e "$bundle" ] || continue
    rm -rf "$RESOURCES/$(basename "$bundle")"
    ditto "$bundle" "$RESOURCES/$(basename "$bundle")"
done

APP_SIGN_ARGUMENTS=(--force --sign "$CODESIGN_IDENTITY")
HELPER_SIGN_ARGUMENTS=(--force --sign "$CODESIGN_IDENTITY" --options runtime)
if [ "$MODE" != "debug" ]; then
    APP_SIGN_ARGUMENTS+=(--options runtime)
fi
if [ "$MODE" = "release" ]; then
    APP_SIGN_ARGUMENTS+=(--timestamp)
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
if [ "$MODE" != "debug" ]; then
    bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" provenance \
        --app "$APP_DIR" \
        --team-id "$EXPECTED_TEAM_ID" \
        --package-root "$PACKAGE_ROOT" \
        --artifact-policy "$ARTIFACT_POLICY" \
        --approved-target "$APPROVED_TARGET" \
        --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256" \
        --builder-identity-sha256 "$BUILDER_IDENTITY_SHA256"
fi
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

if [ "$MODE" = "local" ]; then
    ARTIFACT_BASENAME="Recordings-${VERSION}-macos-${APPROVED_TARGET}-local-only"
    FINAL_ARCHIVE="$BUILD_DIR/${ARTIFACT_BASENAME}.zip"
    FINAL_MANIFEST="$BUILD_DIR/${ARTIFACT_BASENAME}.manifest.json"
    rm -f "$FINAL_ARCHIVE" "$FINAL_MANIFEST"
    codesign --verify --deep --strict --all-architectures --verbose=2 "$APP_DIR"
    ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$FINAL_ARCHIVE"
    bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" finalize-local \
        --app "$APP_DIR" \
        --archive "$FINAL_ARCHIVE" \
        --manifest "$FINAL_MANIFEST" \
        --approved-target "$APPROVED_TARGET" \
        --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
    echo "Built immutable local-only app artifact: $FINAL_ARCHIVE"
    echo "Built local-only artifact manifest: $FINAL_MANIFEST"
    echo "This artifact is not notarized and is approved only for ${APPROVED_TARGET}."
    exit 0
fi

verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
ARTIFACT_BASENAME="Recordings-${VERSION}-macos"
NOTARY_ARCHIVE="$BUILD_DIR/${ARTIFACT_BASENAME}-notarization.zip"
FINAL_ARCHIVE="$BUILD_DIR/${ARTIFACT_BASENAME}.zip"
FINAL_MANIFEST="$BUILD_DIR/${ARTIFACT_BASENAME}.manifest.json"
NOTARY_SUBMISSION="$BUILD_DIR/${ARTIFACT_BASENAME}.notary-submit.json"
NOTARY_LOG="$BUILD_DIR/${ARTIFACT_BASENAME}.notary-log.json"

rm -f "$NOTARY_ARCHIVE" "$FINAL_ARCHIVE" "$FINAL_MANIFEST" "$NOTARY_SUBMISSION" "$NOTARY_LOG"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$NOTARY_ARCHIVE"
NOTARY_ARCHIVE_SHA256="$(shasum -a 256 "$NOTARY_ARCHIVE" | awk '{print $1}')"
xcrun notarytool submit "$NOTARY_ARCHIVE" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait --output-format json >"$NOTARY_SUBMISSION"
NOTARY_ID="$(NOTARY_SUBMISSION_JSON="$(cat "$NOTARY_SUBMISSION")" "$BUN_EXECUTABLE" -e '
    const value = JSON.parse(process.env.NOTARY_SUBMISSION_JSON ?? "null");
    if (value?.status !== "Accepted" || typeof value?.id !== "string" || !value.id) process.exit(1);
    process.stdout.write(value.id);
')" || {
    echo "Notarization submission was not accepted or omitted its submission ID." >&2
    exit 1
}
xcrun notarytool log "$NOTARY_ID" \
    --keychain-profile "$NOTARY_PROFILE" >"$NOTARY_LOG"
NOTARY_LOG_JSON="$(cat "$NOTARY_LOG")" "$BUN_EXECUTABLE" -e '
    const value = JSON.parse(process.env.NOTARY_LOG_JSON ?? "null");
    if (value?.status !== "Accepted") process.exit(1);
    if (Array.isArray(value?.issues) && value.issues.length > 0) process.exit(1);
' || {
    echo "Accepted notarization log contains a rejected status or reported issues." >&2
    exit 1
}
rm -f "$NOTARY_ARCHIVE"
xcrun stapler staple "$APP_DIR"
xcrun stapler validate "$APP_DIR"
spctl --assess --type execute --verbose=2 "$APP_DIR"
syspolicy_check distribution "$APP_DIR"
verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$FINAL_ARCHIVE"
bun "$PACKAGE_ROOT/scripts/macos_artifact.ts" finalize \
    --app "$APP_DIR" \
    --archive "$FINAL_ARCHIVE" \
    --manifest "$FINAL_MANIFEST" \
    --team-id "$EXPECTED_TEAM_ID" \
    --notary-log "$NOTARY_LOG" \
    --notary-submission-id "$NOTARY_ID" \
    --submitted-archive-sha256 "$NOTARY_ARCHIVE_SHA256"

echo "Built immutable app artifact: $FINAL_ARCHIVE"
echo "Built artifact manifest: $FINAL_MANIFEST"
echo "Captured accepted notarization log: $NOTARY_LOG"
