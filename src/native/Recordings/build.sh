#!/bin/bash
# Build, sign, notarize, and finalize a Recordings.app artifact.
# Usage: ./build.sh [debug|local] | ./build.sh release <initial-bootstrap|app-update>

set -euo pipefail
umask 077

HOST_UNAME_EXECUTABLE="/usr/bin/uname"
SYSTEM_DIRNAME_EXECUTABLE="/usr/bin/dirname"
SYSTEM_PWD_EXECUTABLE="/bin/pwd"
SANITIZED_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

require_bootstrap_executable() {
    local label="$1"
    local executable="$2"
    case "$executable" in
        /*) ;;
        *)
            echo "$label must be configured as an absolute executable path." >&2
            exit 1
            ;;
    esac
    if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
        echo "$label is missing or is not an executable file: $executable" >&2
        exit 1
    fi
}

require_bootstrap_executable "HOST_UNAME_EXECUTABLE" "$HOST_UNAME_EXECUTABLE"
require_bootstrap_executable "SYSTEM_DIRNAME_EXECUTABLE" "$SYSTEM_DIRNAME_EXECUTABLE"
require_bootstrap_executable "SYSTEM_PWD_EXECUTABLE" "$SYSTEM_PWD_EXECUTABLE"
HOST_PLATFORM="$("$HOST_UNAME_EXECUTABLE" -s)"
readonly HOST_PLATFORM

select_executable() {
    local system_executable="$1"
    local test_override="${2:-}"
    if [ "$HOST_PLATFORM" = "Darwin" ] || [ -z "$test_override" ]; then
        printf '%s\n' "$system_executable"
    else
        printf '%s\n' "$test_override"
    fi
}

DIRNAME_EXECUTABLE="$(select_executable "$SYSTEM_DIRNAME_EXECUTABLE" "${RECORDINGS_TEST_DIRNAME_EXECUTABLE:-}")"
PWD_EXECUTABLE="$(select_executable "$SYSTEM_PWD_EXECUTABLE" "${RECORDINGS_TEST_PWD_EXECUTABLE:-}")"
require_bootstrap_executable "DIRNAME_EXECUTABLE" "$DIRNAME_EXECUTABLE"
require_bootstrap_executable "PWD_EXECUTABLE" "$PWD_EXECUTABLE"

MODE="${1:-release}"
RELEASE_SUBTYPE="${2:-}"
SCRIPT_DIR="$(cd "$("$DIRNAME_EXECUTABLE" "$0")" && "$PWD_EXECUTABLE" -P)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../../.." && "$PWD_EXECUTABLE" -P)"
cd "$SCRIPT_DIR"

case "$MODE" in
    debug|local|release) ;;
    *)
        echo "Mode must be debug, local, or release" >&2
        exit 2
        ;;
esac
if [ "$MODE" = "release" ]; then
    if [ -z "$RELEASE_SUBTYPE" ]; then
        echo "Release builds require an explicit subtype: initial-bootstrap or app-update." >&2
        exit 2
    fi
    case "$RELEASE_SUBTYPE" in
        initial-bootstrap|app-update) ;;
        *)
            echo "Release subtype must be initial-bootstrap or app-update." >&2
            exit 2
            ;;
    esac
    if [ "$#" -ne 2 ]; then
        echo "Release builds accept exactly one subtype argument." >&2
        exit 2
    fi
elif [ "$#" -ne 1 ]; then
    echo "Debug and local builds do not accept a release subtype." >&2
    exit 2
fi
readonly RELEASE_SUBTYPE
RELEASE_ARCHITECTURES=(arm64 x86_64)

CODESIGN_IDENTITY="${RECORDINGS_CODESIGN_IDENTITY:-}"
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
NOTARY_PROFILE="${RECORDINGS_NOTARY_KEYCHAIN_PROFILE:-}"
INSTALLER_IDENTITY="${RECORDINGS_INSTALLER_CODESIGN_IDENTITY:-}"
RELEASE_SEQUENCE="${RECORDINGS_RELEASE_SEQUENCE:-}"
KEY_EPOCH="${RECORDINGS_RELEASE_KEY_EPOCH:-}"
ENVELOPE_EXPIRES_AT_UTC="${RECORDINGS_RELEASE_ENVELOPE_EXPIRES_AT_UTC:-}"
ENVELOPE_PRIVATE_KEY="${RECORDINGS_RELEASE_ENVELOPE_PRIVATE_KEY:-}"
ENVELOPE_PUBLIC_KEY="${RECORDINGS_RELEASE_ENVELOPE_PUBLIC_KEY:-}"
COMPATIBLE_COHORT_MANIFEST="${RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST:-}"
LOCAL_APPROVED_TARGET="${RECORDINGS_LOCAL_APPROVED_TARGET:-}"
LOCAL_APPROVED_TARGET_IDENTITY_KIND="${RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND:-}"
LOCAL_APPROVED_TARGET_IDENTITY_SHA256="${RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256:-}"
PLIST_BUDDY="$(select_executable "/usr/libexec/PlistBuddy" "${RECORDINGS_TEST_PLIST_BUDDY_EXECUTABLE:-${PLIST_BUDDY:-}}")"
PLUTIL="$(select_executable "/usr/bin/plutil" "${RECORDINGS_TEST_PLUTIL_EXECUTABLE:-${PLUTIL:-}}")"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-}"
TAILSCALE_RESOLVER="$PACKAGE_ROOT/scripts/resolve_tailscale_cli.sh"
BASH_EXECUTABLE="$(select_executable "/bin/bash" "${RECORDINGS_TEST_BASH_EXECUTABLE:-}")"
GIT_EXECUTABLE="$(select_executable "/usr/bin/git" "${RECORDINGS_TEST_GIT_EXECUTABLE:-}")"
TAR_EXECUTABLE="$(select_executable "/usr/bin/tar" "${RECORDINGS_TEST_TAR_EXECUTABLE:-}")"
SWIFT_EXECUTABLE="$(select_executable "/usr/bin/swift" "${RECORDINGS_TEST_SWIFT_EXECUTABLE:-}")"
CODESIGN_EXECUTABLE="$(select_executable "/usr/bin/codesign" "${RECORDINGS_TEST_CODESIGN_EXECUTABLE:-}")"
XCRUN_EXECUTABLE="$(select_executable "/usr/bin/xcrun" "${RECORDINGS_TEST_XCRUN_EXECUTABLE:-}")"
SPCTL_EXECUTABLE="$(select_executable "/usr/sbin/spctl" "${RECORDINGS_TEST_SPCTL_EXECUTABLE:-}")"
SYSPOLICY_CHECK_EXECUTABLE="$(select_executable "/usr/bin/syspolicy_check" "${RECORDINGS_TEST_SYSPOLICY_CHECK_EXECUTABLE:-}")"
DITTO_EXECUTABLE="$(select_executable "/usr/bin/ditto" "${RECORDINGS_TEST_DITTO_EXECUTABLE:-}")"
SHASUM_EXECUTABLE="$(select_executable "/usr/bin/shasum" "${RECORDINGS_TEST_SHASUM_EXECUTABLE:-}")"
AWK_EXECUTABLE="$(select_executable "/usr/bin/awk" "${RECORDINGS_TEST_AWK_EXECUTABLE:-}")"
BASENAME_EXECUTABLE="$(select_executable "/usr/bin/basename" "${RECORDINGS_TEST_BASENAME_EXECUTABLE:-}")"
CAT_EXECUTABLE="$(select_executable "/bin/cat" "${RECORDINGS_TEST_CAT_EXECUTABLE:-}")"
CHMOD_EXECUTABLE="$(select_executable "/bin/chmod" "${RECORDINGS_TEST_CHMOD_EXECUTABLE:-}")"
CP_EXECUTABLE="$(select_executable "/bin/cp" "${RECORDINGS_TEST_CP_EXECUTABLE:-}")"
ENV_EXECUTABLE="$(select_executable "/usr/bin/env" "${RECORDINGS_TEST_ENV_EXECUTABLE:-}")"
HEAD_EXECUTABLE="$(select_executable "/usr/bin/head" "${RECORDINGS_TEST_HEAD_EXECUTABLE:-}")"
HOSTNAME_EXECUTABLE="$(select_executable "/bin/hostname" "${RECORDINGS_TEST_HOSTNAME_EXECUTABLE:-}")"
MKDIR_EXECUTABLE="$(select_executable "/bin/mkdir" "${RECORDINGS_TEST_MKDIR_EXECUTABLE:-}")"
MKTEMP_EXECUTABLE="$(select_executable "/usr/bin/mktemp" "${RECORDINGS_TEST_MKTEMP_EXECUTABLE:-}")"
MV_EXECUTABLE="$(select_executable "/bin/mv" "${RECORDINGS_TEST_MV_EXECUTABLE:-}")"
LN_EXECUTABLE="$(select_executable "/bin/ln" "${RECORDINGS_TEST_LN_EXECUTABLE:-}")"
RMDIR_EXECUTABLE="$(select_executable "/bin/rmdir" "${RECORDINGS_TEST_RMDIR_EXECUTABLE:-}")"
RM_EXECUTABLE="$(select_executable "/bin/rm" "${RECORDINGS_TEST_RM_EXECUTABLE:-}")"
SED_EXECUTABLE="$(select_executable "/usr/bin/sed" "${RECORDINGS_TEST_SED_EXECUTABLE:-}")"
TR_EXECUTABLE="$(select_executable "/usr/bin/tr" "${RECORDINGS_TEST_TR_EXECUTABLE:-}")"
GREP_EXECUTABLE="$(select_executable "/usr/bin/grep" "${RECORDINGS_TEST_GREP_EXECUTABLE:-}")"
FIND_EXECUTABLE="$(select_executable "/usr/bin/find" "${RECORDINGS_TEST_FIND_EXECUTABLE:-}")"
LS_EXECUTABLE="$(select_executable "/bin/ls" "${RECORDINGS_TEST_LS_EXECUTABLE:-}")"
ID_EXECUTABLE="$(select_executable "/usr/bin/id" "${RECORDINGS_TEST_ID_EXECUTABLE:-}")"
LIPO_EXECUTABLE="$(select_executable "/usr/bin/lipo" "${RECORDINGS_TEST_LIPO_EXECUTABLE:-}")"
STAT_EXECUTABLE="$(select_executable "/usr/bin/stat" "${RECORDINGS_TEST_STAT_EXECUTABLE:-}")"
TEST_GIT_EXECUTABLE="$(select_executable "" "${RECORDINGS_TEST_GIT_EXECUTABLE:-}")"
TEST_SWIFT_EXECUTABLE="$(select_executable "" "${RECORDINGS_TEST_SWIFT_EXECUTABLE:-}")"

require_executable() {
    local label="$1"
    local executable="$2"
    case "$executable" in
        /*) ;;
        *)
            echo "$label must be configured as an absolute executable path." >&2
            exit 1
            ;;
    esac
    if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
        echo "$label is missing or is not an executable file: $executable" >&2
        exit 1
    fi
}

require_bun_executable() {
    local executable="$1"
    if [ -z "$executable" ]; then
        echo "Release builds require BUN_EXECUTABLE as an explicit absolute Bun executable path." >&2
        exit 1
    fi
    require_executable "BUN_EXECUTABLE" "$executable"
    if ! "$ENV_EXECUTABLE" -i \
        HOME="/tmp" \
        PATH="$SANITIZED_PATH" \
        "$executable" -e '
          import { realpathSync, statSync } from "node:fs";
          const expected = process.argv[1];
          const actual = process.execPath;
          if (!expected || realpathSync(actual) !== realpathSync(expected)) process.exit(66);
          if (!statSync(actual).isFile()) process.exit(66);
          if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(Bun.version)) process.exit(66);
        ' "$executable"; then
        echo "BUN_EXECUTABLE did not identify the Bun executable that actually ran." >&2
        exit 1
    fi
}

run_source_git() {
    "$ENV_EXECUTABLE" -i \
        HOME="/tmp" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="/tmp" \
        GIT_CONFIG_NOSYSTEM="1" \
        GIT_CONFIG_GLOBAL="/dev/null" \
        GIT_NO_REPLACE_OBJECTS="1" \
        GIT_OPTIONAL_LOCKS="0" \
        "$GIT_EXECUTABLE" \
        -c core.fsmonitor=false \
        -c core.hooksPath=/dev/null \
        -C "$PACKAGE_ROOT" \
        "$@"
}

read_source_sha() {
    local source_sha
    if ! source_sha="$(run_source_git rev-parse --verify 'HEAD^{commit}')"; then
        echo "Could not resolve the source git revision." >&2
        return 1
    fi
    if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Resolved git revision is not a full 40-character commit SHA." >&2
        return 1
    fi
    printf '%s\n' "$source_sha"
}

require_clean_source() {
    local status
    status="$(run_source_git status --porcelain=v1 --untracked-files=all)"
    if [ -n "$status" ]; then
        echo "Source worktree must be clean before building." >&2
        return 1
    fi
}

verify_source_unchanged() {
    local current_sha
    current_sha="$(read_source_sha)"
    if [ "$current_sha" != "$SOURCE_SHA" ]; then
        echo "Source revision changed during the build; refusing to emit an artifact." >&2
        return 1
    fi
    require_clean_source
}

require_executable "GIT_EXECUTABLE" "$GIT_EXECUTABLE"
require_executable "TAR_EXECUTABLE" "$TAR_EXECUTABLE"
require_executable "SWIFT_EXECUTABLE" "$SWIFT_EXECUTABLE"
require_executable "CODESIGN_EXECUTABLE" "$CODESIGN_EXECUTABLE"
require_executable "DITTO_EXECUTABLE" "$DITTO_EXECUTABLE"
require_executable "BASH_EXECUTABLE" "$BASH_EXECUTABLE"
require_executable "PLIST_BUDDY" "$PLIST_BUDDY"
require_executable "PLUTIL" "$PLUTIL"
require_executable "AWK_EXECUTABLE" "$AWK_EXECUTABLE"
require_executable "BASENAME_EXECUTABLE" "$BASENAME_EXECUTABLE"
require_executable "CAT_EXECUTABLE" "$CAT_EXECUTABLE"
require_executable "CHMOD_EXECUTABLE" "$CHMOD_EXECUTABLE"
require_executable "CP_EXECUTABLE" "$CP_EXECUTABLE"
require_executable "ENV_EXECUTABLE" "$ENV_EXECUTABLE"
require_executable "HEAD_EXECUTABLE" "$HEAD_EXECUTABLE"
require_executable "HOSTNAME_EXECUTABLE" "$HOSTNAME_EXECUTABLE"
require_executable "MKDIR_EXECUTABLE" "$MKDIR_EXECUTABLE"
require_executable "MKTEMP_EXECUTABLE" "$MKTEMP_EXECUTABLE"
require_executable "MV_EXECUTABLE" "$MV_EXECUTABLE"
require_executable "LN_EXECUTABLE" "$LN_EXECUTABLE"
require_executable "RMDIR_EXECUTABLE" "$RMDIR_EXECUTABLE"
require_executable "RM_EXECUTABLE" "$RM_EXECUTABLE"
require_executable "SED_EXECUTABLE" "$SED_EXECUTABLE"
require_executable "TR_EXECUTABLE" "$TR_EXECUTABLE"
require_executable "GREP_EXECUTABLE" "$GREP_EXECUTABLE"
require_executable "FIND_EXECUTABLE" "$FIND_EXECUTABLE"
require_executable "LS_EXECUTABLE" "$LS_EXECUTABLE"
require_executable "ID_EXECUTABLE" "$ID_EXECUTABLE"
require_executable "STAT_EXECUTABLE" "$STAT_EXECUTABLE"
if [ "$HOST_PLATFORM" = "Darwin" ]; then
    require_executable "LIPO_EXECUTABLE" "$LIPO_EXECUTABLE"
fi
require_bun_executable "$BUN_EXECUTABLE"
if [ "$MODE" = "release" ]; then
    require_executable "XCRUN_EXECUTABLE" "$XCRUN_EXECUTABLE"
    require_executable "SPCTL_EXECUTABLE" "$SPCTL_EXECUTABLE"
    require_executable "SYSPOLICY_CHECK_EXECUTABLE" "$SYSPOLICY_CHECK_EXECUTABLE"
    require_executable "SHASUM_EXECUTABLE" "$SHASUM_EXECUTABLE"
fi

SOURCE_SHA="$(read_source_sha)"
readonly SOURCE_SHA
require_clean_source

OPERATOR_HOME="${HOME:-}"
case "$OPERATOR_HOME" in
    /*) ;;
    *)
        echo "Build requires an absolute HOME path." >&2
        exit 1
        ;;
esac
if [ ! -d "$OPERATOR_HOME" ]; then
    echo "Build HOME is not a directory: $OPERATOR_HOME" >&2
    exit 1
fi

BUILD_ROOT="/tmp"
if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    BUILD_ROOT="/private/var/recordings-build"
    BUILD_ATTESTATION="/Library/Application Support/Hasna/Recordings/BuildTrust/isolated-builder-v1"
    if [ "$($ID_EXECUTABLE -un)" != "_recordingsbuild" ]; then
        echo "Release builds may only run as the isolated _recordingsbuild identity." >&2
        exit 1
    fi
    if [ ! -f "$BUILD_ATTESTATION" ] || [ -L "$BUILD_ATTESTATION" ] || \
       [ "$($STAT_EXECUTABLE -f '%u' "$BUILD_ATTESTATION")" != "0" ]; then
        echo "Managed isolated-builder attestation is missing or unsafe." >&2
        exit 1
    fi
    case "$($STAT_EXECUTABLE -f '%Lp' "$BUILD_ATTESTATION")" in
        400|440|444) ;;
        *) echo "Managed isolated-builder attestation mode is unsafe." >&2; exit 1 ;;
    esac
    if [ "$("$CAT_EXECUTABLE" "$BUILD_ATTESTATION")" != "recordings-isolated-builder-v1" ]; then
        echo "Managed isolated-builder attestation content is invalid." >&2
        exit 1
    fi
    if [ ! -d "$BUILD_ROOT" ] || [ -L "$BUILD_ROOT" ] || \
       [ "$($STAT_EXECUTABLE -f '%u' "$BUILD_ROOT")" != "$($ID_EXECUTABLE -u)" ] || \
       [ "$($STAT_EXECUTABLE -f '%Lp' "$BUILD_ROOT")" != "700" ]; then
        echo "Managed release build root must be owned by _recordingsbuild with mode 0700." >&2
        exit 1
    fi
    BUILD_ROOT_PARENT="$($DIRNAME_EXECUTABLE "$BUILD_ROOT")"
    if [ "$($STAT_EXECUTABLE -f '%u' "$BUILD_ROOT_PARENT")" != "0" ]; then
        echo "Managed release build parent must be root-owned." >&2
        exit 1
    fi
    case "$($STAT_EXECUTABLE -f '%Lp' "$BUILD_ROOT_PARENT")" in
        *[2367][0-9]|*[0-9][2367]) echo "Managed release build parent is group/other writable." >&2; exit 1 ;;
    esac
fi
RELEASE_OUTPUT_ROOT=""
RELEASE_STAGING_DIR=""
RELEASE_FINAL_DIR=""
RELEASE_RESERVATION=""
RELEASE_RESERVATION_OWNED=0
RELEASE_DIRECTORY_PUBLISHED=0
RELEASE_PUBLICATION_IDENTITY_SHA256=""
PACKAGE_PUBLICATION_IDENTITY_SHA256=""
ENVELOPE_PUBLIC_KEY_SNAPSHOT=""
ENVELOPE_PUBLIC_KEY_SHA256=""
COMPATIBLE_COHORT_SHA256=""
BUILD_WORK_DIR="$($MKTEMP_EXECUTABLE -d "$BUILD_ROOT/recordings-native-build.XXXXXX")"
BUILD_HOME="$BUILD_WORK_DIR/home"
SWIFT_SCRATCH_PATH="$BUILD_WORK_DIR/swift"
SOURCE_PACKAGE_ROOT="$BUILD_WORK_DIR/source"
"$MKDIR_EXECUTABLE" -p "$BUILD_HOME" "$SWIFT_SCRATCH_PATH" "$SOURCE_PACKAGE_ROOT"
cleanup_build_work() {
    local status=$?
    trap - EXIT
    "$RM_EXECUTABLE" -rf "$BUILD_WORK_DIR"
    if [ "$RELEASE_DIRECTORY_PUBLISHED" -eq 0 ] && [ -n "$RELEASE_STAGING_DIR" ]; then
        "$RM_EXECUTABLE" -rf "$RELEASE_STAGING_DIR"
    fi
    if [ "$RELEASE_RESERVATION_OWNED" -eq 1 ] && \
       [ ! -e "$RELEASE_FINAL_DIR" ] && [ ! -L "$RELEASE_FINAL_DIR" ]; then
        "$RM_EXECUTABLE" -rf "$RELEASE_RESERVATION"
    fi
    exit "$status"
}
trap cleanup_build_work EXIT

if [ "$HOST_PLATFORM" != "Darwin" ] && [ -n "$TEST_GIT_EXECUTABLE" ]; then
    # Explicit non-Darwin fixtures do not contain an object database. Production Darwin
    # builds never take this branch and always compile the exact archived commit below.
    SOURCE_PACKAGE_ROOT="$PACKAGE_ROOT"
else
    if ! run_source_git archive --format=tar "$SOURCE_SHA" | \
        "$TAR_EXECUTABLE" -x -f - -C "$SOURCE_PACKAGE_ROOT"; then
        echo "Could not materialize the exact source commit for an isolated build." >&2
        exit 1
    fi
fi
SOURCE_NATIVE_DIR="$SOURCE_PACKAGE_ROOT/src/native/Recordings"
RELEASE_LIFECYCLE_HELPER="$SOURCE_PACKAGE_ROOT/packaging/macos/release_lifecycle.ts"
TAILSCALE_RESOLVER="$SOURCE_PACKAGE_ROOT/scripts/resolve_tailscale_cli.sh"
APP_ENTITLEMENTS="$SOURCE_NATIVE_DIR/RecordingsLib/Recordings.entitlements"
HELPER_ENTITLEMENTS="$SOURCE_NATIVE_DIR/RecordingsLib/RecordingsCLI.entitlements"
if [ "$HOST_PLATFORM" != "Darwin" ] && [ "$SOURCE_PACKAGE_ROOT" = "$PACKAGE_ROOT" ]; then
    # Preserve the historical fixture log contract. Production Darwin builds always
    # sign against the absolute entitlements paths in the archived source snapshot.
    APP_ENTITLEMENTS="RecordingsLib/Recordings.entitlements"
    HELPER_ENTITLEMENTS="RecordingsLib/RecordingsCLI.entitlements"
fi
if [ "$SOURCE_PACKAGE_ROOT" != "$PACKAGE_ROOT" ]; then
    for required_snapshot_input in \
        "$SOURCE_NATIVE_DIR/Package.swift" \
        "$SOURCE_NATIVE_DIR/RecordingsLib/Info.plist" \
        "$SOURCE_NATIVE_DIR/RecordingsLib/Recordings.entitlements" \
        "$SOURCE_NATIVE_DIR/RecordingsLib/RecordingsCLI.entitlements" \
        "$SOURCE_PACKAGE_ROOT/scripts/build_companion_cli.sh" \
        "$SOURCE_PACKAGE_ROOT/scripts/smoke_macos_app.sh" \
        "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" \
        "$SOURCE_PACKAGE_ROOT/scripts/native_fs_guard.ts" \
        "$SOURCE_PACKAGE_ROOT/scripts/build_native_fs_guard.sh" \
        "$SOURCE_PACKAGE_ROOT/scripts/native/recordings_fs_guard.c" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/build_release_pkg.sh" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/release_lifecycle.ts" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/Verifier.entitlements" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/Empty.entitlements" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/artifact-verifier.sb" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/Library/LaunchDaemons/com.hasna.recordings.updater.plist" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/scripts/preinstall" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/scripts/postinstall" \
        "$SOURCE_PACKAGE_ROOT/package.json" \
        "$SOURCE_PACKAGE_ROOT/bun.lock" \
        "$SOURCE_PACKAGE_ROOT/bunfig.toml"; do
        if [ ! -f "$required_snapshot_input" ]; then
            echo "Archived source input is missing: $required_snapshot_input" >&2
            exit 1
        fi
    done
fi

generate_and_verify_native_fs_guard() {
    [ "$HOST_PLATFORM" = "Darwin" ] || return 0
    local dependency_root="$BUILD_WORK_DIR/native-guard-dependencies"
    local pack_root="$BUILD_WORK_DIR/native-guard-pack"
    local addon="$SOURCE_PACKAGE_ROOT/scripts/native/prebuilds/darwin-universal/recordings_fs_guard.node"
    "$MKDIR_EXECUTABLE" -p "$dependency_root" "$pack_root"
    "$CP_EXECUTABLE" "$SOURCE_PACKAGE_ROOT/package.json" "$SOURCE_PACKAGE_ROOT/bun.lock" \
        "$SOURCE_PACKAGE_ROOT/bunfig.toml" "$dependency_root/"
    run_bun install \
        --cwd "$dependency_root" \
        --frozen-lockfile \
        --ignore-scripts \
        --minimum-release-age=604800 \
        --no-progress
    "$ENV_EXECUTABLE" -i \
        HOME="$BUILD_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        "$BASH_EXECUTABLE" "$SOURCE_PACKAGE_ROOT/scripts/build_native_fs_guard.sh" \
        "$addon" "$dependency_root/node_modules/node-api-headers/include"
    /usr/bin/lipo -verify_arch arm64 x86_64 "$addon"
    if [ "$MODE" = "release" ]; then
        run_codesign --force --sign "$CODESIGN_IDENTITY" --options runtime --timestamp "$addon"
    else
        run_codesign --force --sign "$CODESIGN_IDENTITY" --options runtime "$addon"
    fi
    run_codesign --verify --strict --all-architectures --verbose=2 "$addon"
    run_bun -e '
      import { createRequire } from "node:module";
      const addon = createRequire(import.meta.url)(process.argv[1]);
      const expected = [
        "chmodHandle", "close", "copyRegularNoReplaceAt", "fsyncHandle",
        "linkNoReplaceAt", "mkdirAt", "openDirAt", "openRegularAt", "openTrustedHome",
        "readDir", "readRegularAt", "removeTreeAt", "removeTreeHandleAt",
        "renameHandleNoReplaceAt", "renameNoReplaceAt", "renameReplaceAt",
        "sameBinding", "sha256Handle", "sha256RegularAt", "statAt", "statHandle",
        "unlinkDirAt", "unlinkFileAt", "unlinkFileHandleAt", "writeFileAt",
      ];
      const actual = Object.getOwnPropertyNames(addon).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`Native filesystem guard exports are incompatible: ${actual.join(", ")}`);
        process.exit(66);
      }
    ' "$addon"
    (
        cd "$SOURCE_PACKAGE_ROOT"
        run_bun pm pack --destination "$pack_root" --ignore-scripts >/dev/null
    )
    local package_archives=("$pack_root"/*.tgz)
    if [ "${#package_archives[@]}" -ne 1 ] || [ ! -f "${package_archives[0]}" ]; then
        echo "Native filesystem guard package staging did not emit exactly one tarball." >&2
        return 1
    fi
    local package_listing
    package_listing="$("$TAR_EXECUTABLE" -tzf "${package_archives[0]}")"
    if ! "$GREP_EXECUTABLE" -Fxq \
        "package/scripts/native/prebuilds/darwin-universal/recordings_fs_guard.node" \
        <<<"$package_listing"; then
        echo "Packed release tarball is missing the generated native filesystem guard." >&2
        return 1
    fi
    if "$GREP_EXECUTABLE" -Eq \
        '(^|/)(\.recordings-fs-guard-build|arm64\.node|x86_64\.node|.*\.(o|obj))($|/)' \
        <<<"$package_listing"; then
        echo "Packed release tarball contains native filesystem guard intermediates." >&2
        return 1
    fi
}

RUN_BUN_TEST_ENVIRONMENT=()
COMPANION_TEST_ENVIRONMENT=()
SMOKE_TEST_ENVIRONMENT=()
XCRUN_TEST_ENVIRONMENT=()
RELEASE_SENSITIVE_TEST_ENVIRONMENT=()
if [ "$HOST_PLATFORM" != "Darwin" ]; then
    if [ -n "${MARKER_DIRECTORY:-}" ]; then
        RUN_BUN_TEST_ENVIRONMENT+=("MARKER_DIRECTORY=$MARKER_DIRECTORY")
        SMOKE_TEST_ENVIRONMENT+=("MARKER_DIRECTORY=$MARKER_DIRECTORY")
    fi
    COMPANION_TEST_ENVIRONMENT+=(
        "BREAK_SIGNED_HELPER=${BREAK_SIGNED_HELPER:-0}"
        "MALFORMED_SIGNED_HELPER_OUTPUT=${MALFORMED_SIGNED_HELPER_OUTPUT:-0}"
    )
    XCRUN_TEST_ENVIRONMENT+=(
        "MARKER_DIRECTORY=${MARKER_DIRECTORY:-}"
        "NOTARY_SUBMIT_REJECTED=${NOTARY_SUBMIT_REJECTED:-0}"
        "NOTARY_LOG_ISSUES=${NOTARY_LOG_ISSUES:-0}"
    )
    RELEASE_SENSITIVE_TEST_ENVIRONMENT+=(
        "MARKER_DIRECTORY=${MARKER_DIRECTORY:-}"
        "EXPECTED_HELPER_ENTITLEMENTS=${EXPECTED_HELPER_ENTITLEMENTS:-}"
        "EXTRA_HELPER_ENTITLEMENT=${EXTRA_HELPER_ENTITLEMENT:-0}"
        "SIGNING_AUTHORITY=${SIGNING_AUTHORITY:-}"
        "SIGNING_TEAM=${SIGNING_TEAM:-}"
        "SIGNING_FLAGS=${SIGNING_FLAGS:-}"
        "MISSING_TIMESTAMP=${MISSING_TIMESTAMP:-0}"
    )
fi

run_bun() {
    "$ENV_EXECUTABLE" -i \
        HOME="$BUILD_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        ${RUN_BUN_TEST_ENVIRONMENT[0]+"${RUN_BUN_TEST_ENVIRONMENT[@]}"} \
        "$BUN_EXECUTABLE" "$@"
}

run_xcrun() {
    "$ENV_EXECUTABLE" -i \
        HOME="$OPERATOR_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        ${XCRUN_TEST_ENVIRONMENT[0]+"${XCRUN_TEST_ENVIRONMENT[@]}"} \
        "$XCRUN_EXECUTABLE" "$@"
}

run_release_sensitive_tool() {
    local executable="$1"
    shift
    "$ENV_EXECUTABLE" -i \
        HOME="$OPERATOR_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        ${RELEASE_SENSITIVE_TEST_ENVIRONMENT[0]+"${RELEASE_SENSITIVE_TEST_ENVIRONMENT[@]}"} \
        "$executable" "$@"
}

run_sensitive_tool() {
    if [ "$MODE" = "release" ]; then
        run_release_sensitive_tool "$@"
    else
        "$@"
    fi
}

run_codesign() {
    if [ "$MODE" = "release" ]; then
        run_release_sensitive_tool "$CODESIGN_EXECUTABLE" "$@"
    else
        "$CODESIGN_EXECUTABLE" "$@"
    fi
}

run_swift() {
    "$ENV_EXECUTABLE" -i \
        HOME="$BUILD_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        "$SWIFT_EXECUTABLE" "$@"
}

run_lipo() {
    if [ "$MODE" = "release" ]; then
        run_release_sensitive_tool "$LIPO_EXECUTABLE" "$@"
    else
        "$LIPO_EXECUTABLE" "$@"
    fi
}

verify_exact_binary_architectures() {
    local binary="$1"
    shift
    local actual_architectures
    local actual_architecture
    local expected_architecture
    local actual_count=0
    local match_count

    if ! actual_architectures="$(run_lipo -archs "$binary")"; then
        echo "Could not read binary architectures: $binary" >&2
        return 1
    fi
    for actual_architecture in $actual_architectures; do
        actual_count=$((actual_count + 1))
        case " $* " in
            *" $actual_architecture "*) ;;
            *)
                echo "Binary contains unsupported architecture $actual_architecture: $binary" >&2
                return 1
                ;;
        esac
    done
    if [ "$actual_count" -ne "$#" ]; then
        echo "Binary architecture count does not match release policy: $binary" >&2
        return 1
    fi
    for expected_architecture in "$@"; do
        match_count=0
        for actual_architecture in $actual_architectures; do
            if [ "$actual_architecture" = "$expected_architecture" ]; then
                match_count=$((match_count + 1))
            fi
        done
        if [ "$match_count" -ne 1 ]; then
            echo "Binary must contain exactly one $expected_architecture slice: $binary" >&2
            return 1
        fi
    done
}

merge_release_swift_product() {
    local product="$1"
    local output="$2"
    local arm64_input="$RELEASE_ARM64_PRODUCT_DIR/$product"
    local x86_64_input="$RELEASE_X86_64_PRODUCT_DIR/$product"
    verify_exact_binary_architectures "$arm64_input" arm64
    verify_exact_binary_architectures "$x86_64_input" x86_64
    run_lipo -create "$arm64_input" "$x86_64_input" -output "$output"
    "$CHMOD_EXECUTABLE" 0755 "$output"
    verify_exact_binary_architectures "$output" arm64 x86_64
}

normalize_unsigned_launch_file_mode() {
    local path="$1"
    local label="$2"
    local hardlinked
    local mode_match

    if [ ! -f "$path" ] || [ -L "$path" ]; then
        echo "$label is missing, linked, or not a regular file: $path" >&2
        return 1
    fi
    if ! hardlinked="$("$FIND_EXECUTABLE" "$path" -xdev -type f -links +1 -print -quit)"; then
        echo "Could not inspect $label link count: $path" >&2
        return 1
    fi
    if [ -n "$hardlinked" ]; then
        echo "$label must not be multiply linked: $path" >&2
        return 1
    fi
    "$CHMOD_EXECUTABLE" 0755 "$path"
    if ! mode_match="$("$FIND_EXECUTABLE" "$path" -xdev -type f -links 1 -perm 0755 -print -quit)"; then
        echo "Could not verify $label mode: $path" >&2
        return 1
    fi
    if [ "$mode_match" != "$path" ]; then
        echo "$label must have exact mode 0755: $path" >&2
        return 1
    fi
}

normalize_unsigned_app_bundle_modes() {
    local app="$1"
    local unexpected
    local hardlinked
    local bad_mode
    local launch_file
    local -a launch_files=(
        "$MACOS/Recordings"
        "$HELPERS/recordings"
    )

    if [ ! -d "$app" ] || [ -L "$app" ]; then
        echo "App bundle root is missing, linked, or not a directory: $app" >&2
        return 1
    fi
    if [ -e "$UPDATE_CLIENT" ] || [ -L "$UPDATE_CLIENT" ]; then
        launch_files+=("$UPDATE_CLIENT")
    fi
    if ! unexpected="$("$FIND_EXECUTABLE" "$app" -xdev ! -type d ! -type f -print -quit)"; then
        echo "Could not inspect the app bundle tree structure." >&2
        return 1
    fi
    if [ -n "$unexpected" ]; then
        echo "App bundle tree contains a symbolic link or special file: $unexpected" >&2
        return 1
    fi
    if ! hardlinked="$("$FIND_EXECUTABLE" "$app" -xdev -type f -links +1 -print -quit)"; then
        echo "Could not inspect app bundle regular-file link counts." >&2
        return 1
    fi
    if [ -n "$hardlinked" ]; then
        echo "App bundle tree contains a multiply-linked regular file: $hardlinked" >&2
        return 1
    fi
    if ! "$FIND_EXECUTABLE" "$app" -xdev -type d -exec "$CHMOD_EXECUTABLE" 0755 {} +; then
        echo "Could not normalize app bundle directory modes." >&2
        return 1
    fi
    if ! "$FIND_EXECUTABLE" "$app" -xdev -type f -exec "$CHMOD_EXECUTABLE" 0644 {} +; then
        echo "Could not normalize app bundle data-file modes." >&2
        return 1
    fi
    for launch_file in "${launch_files[@]}"; do
        normalize_unsigned_launch_file_mode "$launch_file" "App bundle launch file"
    done
    if ! bad_mode="$("$FIND_EXECUTABLE" "$app" -xdev -type d ! -perm 0755 -print -quit)"; then
        echo "Could not verify app bundle directory modes." >&2
        return 1
    fi
    if [ -n "$bad_mode" ]; then
        echo "App bundle directory does not have exact mode 0755: $bad_mode" >&2
        return 1
    fi
    if ! bad_mode="$("$FIND_EXECUTABLE" "$app" -xdev -type f \
        ! -path "$MACOS/Recordings" \
        ! -path "$HELPERS/recordings" \
        ! -path "$UPDATE_CLIENT" \
        ! -perm 0644 -print -quit)"; then
        echo "Could not verify app bundle data-file modes." >&2
        return 1
    fi
    if [ -n "$bad_mode" ]; then
        echo "App bundle data file does not have exact mode 0644: $bad_mode" >&2
        return 1
    fi
}

normalize_unsigned_app_data_file_mode() {
    local path="$1"
    local label="$2"
    local hardlinked
    local mode_match

    if [ ! -f "$path" ] || [ -L "$path" ]; then
        echo "$label is missing, linked, or not a regular file: $path" >&2
        return 1
    fi
    if ! hardlinked="$("$FIND_EXECUTABLE" "$path" -xdev -type f -links +1 -print -quit)"; then
        echo "Could not inspect $label link count: $path" >&2
        return 1
    fi
    if [ -n "$hardlinked" ]; then
        echo "$label must not be multiply linked: $path" >&2
        return 1
    fi
    "$CHMOD_EXECUTABLE" 0644 "$path"
    if ! mode_match="$("$FIND_EXECUTABLE" "$path" -xdev -type f -links 1 -perm 0644 -print -quit)"; then
        echo "Could not verify $label mode: $path" >&2
        return 1
    fi
    if [ "$mode_match" != "$path" ]; then
        echo "$label must have exact mode 0644: $path" >&2
        return 1
    fi
}

verify_app_bundle_modes() {
    local app="$1"
    local unexpected
    local hardlinked
    local bad_mode
    local launch_file
    local mode_match
    local main="$app/Contents/MacOS/Recordings"
    local companion="$app/Contents/Helpers/recordings"
    local client="$app/Contents/Helpers/recordings-update-client"
    local -a launch_files=(
        "$main"
        "$companion"
    )

    if [ ! -d "$app" ] || [ -L "$app" ]; then
        echo "Final unsigned app bundle root is missing, linked, or not a directory: $app" >&2
        return 1
    fi
    if [ -e "$client" ] || [ -L "$client" ]; then
        launch_files+=("$client")
    fi
    if ! unexpected="$("$FIND_EXECUTABLE" "$app" -xdev ! -type d ! -type f -print -quit)"; then
        echo "Could not inspect the final unsigned app bundle tree structure." >&2
        return 1
    fi
    if [ -n "$unexpected" ]; then
        echo "Final unsigned app bundle contains a symbolic link or special file: $unexpected" >&2
        return 1
    fi
    if ! hardlinked="$("$FIND_EXECUTABLE" "$app" -xdev -type f -links +1 -print -quit)"; then
        echo "Could not inspect final unsigned app bundle link counts." >&2
        return 1
    fi
    if [ -n "$hardlinked" ]; then
        echo "Final unsigned app bundle contains a multiply-linked regular file: $hardlinked" >&2
        return 1
    fi
    if ! bad_mode="$("$FIND_EXECUTABLE" "$app" -xdev -type d ! -perm 0755 -print -quit)"; then
        echo "Could not verify final unsigned app bundle directory modes." >&2
        return 1
    fi
    if [ -n "$bad_mode" ]; then
        echo "Final unsigned app bundle directory does not have exact mode 0755: $bad_mode" >&2
        return 1
    fi
    for launch_file in "${launch_files[@]}"; do
        if ! mode_match="$("$FIND_EXECUTABLE" "$launch_file" -xdev -type f -links 1 -perm 0755 -print -quit)"; then
            echo "Could not verify final app launch-file mode: $launch_file" >&2
            return 1
        fi
        if [ "$mode_match" != "$launch_file" ]; then
            echo "Final app launch file must be singly linked with exact mode 0755: $launch_file" >&2
            return 1
        fi
    done
    if ! bad_mode="$("$FIND_EXECUTABLE" "$app" -xdev -type f \
        ! -path "$main" \
        ! -path "$companion" \
        ! -path "$client" \
        ! -perm 0644 -print -quit)"; then
        echo "Could not verify final unsigned app bundle data-file modes." >&2
        return 1
    fi
    if [ -n "$bad_mode" ]; then
        echo "Final unsigned app bundle data file does not have exact mode 0644: $bad_mode" >&2
        return 1
    fi
}

require_path_without_extended_acl() {
    local path="$1"
    local acl_listing
    local acl_status

    acl_listing="$("$LS_EXECUTABLE" -lade "$path")" || {
        echo "Could not inspect app output extended ACLs on: $path" >&2
        return 1
    }
    if printf '%s\n' "$acl_listing" | "$AWK_EXECUTABLE" '
        NR == 1 && length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
        NR > 1 && $1 ~ /^[0-9]+:$/ { found = 1 }
        END { exit found ? 0 : 1 }
    '; then
        echo "App output contains an unexpected extended ACL: $path" >&2
        return 1
    else
        acl_status=$?
        if [ "$acl_status" -ne 1 ]; then
            echo "Could not evaluate app output extended ACLs on: $path" >&2
            return 1
        fi
    fi
}

require_app_tree_without_extended_acl() {
    local tree="$1"
    local acl_listing
    local acl_status

    require_path_without_extended_acl "$tree"
    acl_listing="$("$LS_EXECUTABLE" -laeR "$tree")" || {
        echo "Could not recursively inspect app output extended ACLs on: $tree" >&2
        return 1
    }
    if printf '%s\n' "$acl_listing" | "$AWK_EXECUTABLE" '
        length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
        $1 ~ /^[0-9]+:$/ { found = 1 }
        END { exit found ? 0 : 1 }
    '; then
        echo "App output tree contains an unexpected extended ACL: $tree" >&2
        return 1
    else
        acl_status=$?
        if [ "$acl_status" -ne 1 ]; then
            echo "Could not evaluate recursive app output extended ACLs on: $tree" >&2
            return 1
        fi
    fi
}

require_root_owned_nonwritable_directory() {
    local directory="$1"
    local mode
    [ -d "$directory" ] && [ ! -L "$directory" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$directory")" = "0" ] || {
        echo "Compatible-cohort ancestry is missing, linked, or not root-owned: $directory" >&2
        return 1
    }
    mode="$("$STAT_EXECUTABLE" -f '%Lp' "$directory")"
    [ $((8#$mode & 8#022)) -eq 0 ] || {
        echo "Compatible-cohort ancestry is group/other writable: $directory" >&2
        return 1
    }
    require_path_without_extended_acl "$directory"
}

prepare_compatible_cohort_manifest() {
    local cohort_root="/Library/Application Support/Hasna/Recordings/BuildTrust/compatible-cohorts"
    local relative current component leaf
    [ "$(cd "$cohort_root" && "$PWD_EXECUTABLE" -P)" = "$cohort_root" ] || {
        echo "Compatible-cohort directory is not canonical." >&2
        return 1
    }
    require_root_owned_nonwritable_directory "/"
    relative="${cohort_root#/}"
    current=""
    IFS='/' read -r -a cohort_components <<<"$relative"
    for component in "${cohort_components[@]}"; do
        current="$current/$component"
        require_root_owned_nonwritable_directory "$current"
    done
    leaf="$("$BASENAME_EXECUTABLE" "$COMPATIBLE_COHORT_MANIFEST")"
    [ "$COMPATIBLE_COHORT_MANIFEST" = "$cohort_root/$leaf" ] || {
        echo "Compatible-cohort manifest path must be canonical." >&2
        return 1
    }
    [ -f "$COMPATIBLE_COHORT_MANIFEST" ] && [ ! -L "$COMPATIBLE_COHORT_MANIFEST" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$COMPATIBLE_COHORT_MANIFEST")" = "0" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%Lp' "$COMPATIBLE_COHORT_MANIFEST")" = "444" ] && \
        [ "$("$FIND_EXECUTABLE" "$COMPATIBLE_COHORT_MANIFEST" -xdev -type f -links 1 -perm 0444 -print -quit)" = "$COMPATIBLE_COHORT_MANIFEST" ] || {
        echo "Compatible-cohort manifest must be a singly linked root-owned mode-0444 regular file." >&2
        return 1
    }
    require_path_without_extended_acl "$COMPATIBLE_COHORT_MANIFEST"
    COMPATIBLE_COHORT_SNAPSHOT="$BUILD_WORK_DIR/compatible-cohort.json"
    COMPATIBLE_COHORT_SHA256="$(run_bun \
        "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" snapshot-regular-file \
        --source "$COMPATIBLE_COHORT_MANIFEST" \
        --destination "$COMPATIBLE_COHORT_SNAPSHOT" \
        --maximum-bytes 65536)"
    [ "$leaf" = "${COMPATIBLE_COHORT_SHA256}.json" ] || {
        echo "Compatible-cohort manifest filename must authenticate its snapshotted contents." >&2
        return 1
    }
    run_bun "$RELEASE_LIFECYCLE_HELPER" validate-compatible-cohort \
        --manifest "$COMPATIBLE_COHORT_SNAPSHOT" \
        --public-key "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
        --team-id "$EXPECTED_TEAM_ID" \
        --key-epoch "$KEY_EPOCH"
}

prepare_envelope_public_key() {
    ENVELOPE_PUBLIC_KEY_SNAPSHOT="$BUILD_WORK_DIR/release-envelope-public.raw"
    ENVELOPE_PUBLIC_KEY_SHA256="$(run_bun \
        "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" snapshot-regular-file \
        --source "$ENVELOPE_PUBLIC_KEY" \
        --destination "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
        --maximum-bytes 32 \
        --expected-bytes 32)"
}

BUILD_CONFIGURATION="release"
ARTIFACT_POLICY="release"
APPROVED_TARGET="fleet"
APPROVED_TARGET_IDENTITY_KIND="none"
APPROVED_TARGET_IDENTITY_SHA256="none"
BUILDER_IDENTITY_KIND="none"
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
    if ! [[ "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]] || ! [[ "$KEY_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
        echo "Release builds require positive release sequence and key epoch values." >&2
        exit 1
    fi
    if [ -z "$ENVELOPE_EXPIRES_AT_UTC" ]; then
        echo "Release builds require an explicit release-envelope expiry." >&2
        exit 1
    fi
    for envelope_key in "$ENVELOPE_PRIVATE_KEY" "$ENVELOPE_PUBLIC_KEY"; do
        case "$envelope_key" in /*) ;; *) echo "Release envelope key paths must be absolute." >&2; exit 1 ;; esac
        if [ ! -f "$envelope_key" ] || [ -L "$envelope_key" ]; then
            echo "A release envelope key file is missing or unsafe." >&2
            exit 1
        fi
    done
    prepare_envelope_public_key
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        if [[ "$INSTALLER_IDENTITY" != "Developer ID Installer:"* ]]; then
            echo "Initial-bootstrap releases require RECORDINGS_INSTALLER_CODESIGN_IDENTITY for the Developer ID Installer identity." >&2
            exit 1
        fi
        if [ -n "$COMPATIBLE_COHORT_MANIFEST" ]; then
            echo "Initial-bootstrap releases do not consume RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST." >&2
            exit 1
        fi
    else
        if [ -n "$INSTALLER_IDENTITY" ]; then
            echo "App-update releases do not consume RECORDINGS_INSTALLER_CODESIGN_IDENTITY." >&2
            exit 1
        fi
        if [ "$HOST_PLATFORM" != "Darwin" ] && [ -n "$TEST_GIT_EXECUTABLE" ]; then
            [ -f "$COMPATIBLE_COHORT_MANIFEST" ] && [ ! -L "$COMPATIBLE_COHORT_MANIFEST" ] || {
                echo "App-update test fixture requires one regular compatible-cohort manifest." >&2
                exit 1
            }
        else
            case "$COMPATIBLE_COHORT_MANIFEST" in
                "/Library/Application Support/Hasna/Recordings/BuildTrust/compatible-cohorts/"*.json) ;;
                *) echo "App-update releases require one root-preauthorized RECORDINGS_RELEASE_COMPATIBLE_COHORT_MANIFEST." >&2; exit 1 ;;
            esac
        fi
    fi
elif [ "$MODE" = "local" ]; then
    if [ "$LOCAL_APPROVED_TARGET" != "station06" ]; then
        echo "Local-only builds currently require RECORDINGS_LOCAL_APPROVED_TARGET=station06." >&2
        exit 1
    fi
    if ! [[ "$LOCAL_APPROVED_TARGET_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
        echo "Local-only builds require an authenticated RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_SHA256." >&2
        exit 1
    fi
    if [ "$LOCAL_APPROVED_TARGET_IDENTITY_KIND" != "tailscale_node_id_sha256" ]; then
        echo "New local-only builds require RECORDINGS_LOCAL_APPROVED_TARGET_IDENTITY_KIND=tailscale_node_id_sha256." >&2
        exit 1
    fi
    BUILD_HOST="$("$HOSTNAME_EXECUTABLE" -s)"
    if [ "$BUILD_HOST" = "$LOCAL_APPROVED_TARGET" ]; then
        echo "Local-only artifacts must be built on a non-target Mac." >&2
        exit 1
    fi
    if [ ! -r "$TAILSCALE_RESOLVER" ]; then
        echo "Packaged Tailscale CLI resolver is missing." >&2
        exit 1
    fi
    # shellcheck source=/dev/null
    source "$TAILSCALE_RESOLVER"
    if ! TAILSCALE_CLI="$(recordings_resolve_trusted_tailscale_app_cli "$BUILD_WORK_DIR")"; then
        echo "Tailscale is required to authenticate the non-target build Mac." >&2
        exit 1
    fi
    if ! BUILDER_IDENTITY_SHA256="$(recordings_run_trusted_tailscale_status "$TAILSCALE_CLI" "$BUILD_WORK_DIR" | run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" tailscale-node-id-sha256 --expected-hostname "$BUILD_HOST")"; then
        echo "Could not authenticate the live Tailscale node identity for the build Mac." >&2
        exit 1
    fi
    if ! [[ "$BUILDER_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
        echo "Build Mac Tailscale node identity did not produce a valid SHA-256 digest." >&2
        exit 1
    fi
    BUILDER_IDENTITY_KIND="tailscale_node_id_sha256"
    if [ "$BUILDER_IDENTITY_SHA256" = "$LOCAL_APPROVED_TARGET_IDENTITY_SHA256" ]; then
        echo "Local-only artifacts must be built on a different authenticated Tailscale node." >&2
        exit 1
    fi
    CODESIGN_IDENTITY="-"
    EXPECTED_TEAM_ID="ADHOC"
    ARTIFACT_POLICY="local_only"
    APPROVED_TARGET="$LOCAL_APPROVED_TARGET"
    APPROVED_TARGET_IDENTITY_KIND="$LOCAL_APPROVED_TARGET_IDENTITY_KIND"
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

COMPATIBLE_COHORT_SNAPSHOT=""
if [ "$MODE" = "release" ] && [ "$RELEASE_SUBTYPE" = "app-update" ]; then
    if [ "$HOST_PLATFORM" = "Darwin" ]; then
        prepare_compatible_cohort_manifest
    elif [ -n "$TEST_GIT_EXECUTABLE" ]; then
        COMPATIBLE_COHORT_SNAPSHOT="$BUILD_WORK_DIR/compatible-cohort-fixture.json"
        COMPATIBLE_COHORT_SHA256="$(run_bun \
            "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" snapshot-regular-file \
            --source "$COMPATIBLE_COHORT_MANIFEST" \
            --destination "$COMPATIBLE_COHORT_SNAPSHOT" \
            --maximum-bytes 65536)"
        run_bun "$RELEASE_LIFECYCLE_HELPER" validate-compatible-cohort \
            --manifest "$COMPATIBLE_COHORT_SNAPSHOT" \
            --public-key "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
            --team-id "$EXPECTED_TEAM_ID" \
            --key-epoch "$KEY_EPOCH"
    fi
fi

generate_and_verify_native_fs_guard

echo "Building Recordings.app ($MODE)..."
if [ "$MODE" = "release" ]; then
    OUTPUT_BUILD_DIR="$BUILD_ROOT/release-output"
else
    OUTPUT_BUILD_DIR="$SCRIPT_DIR/.build/$BUILD_CONFIGURATION"
fi
OUTPUT_APP_DIR="$OUTPUT_BUILD_DIR/Recordings.app"
SWIFT_PRODUCT_DIR="$SWIFT_SCRATCH_PATH/$BUILD_CONFIGURATION"
APP_DIR="$BUILD_WORK_DIR/Recordings.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
HELPERS="$CONTENTS/Helpers"
COMPANION_BUILD_SCRIPT="$SOURCE_PACKAGE_ROOT/scripts/build_companion_cli.sh"
SMOKE_SCRIPT="$SOURCE_PACKAGE_ROOT/scripts/smoke_macos_app.sh"

if [ "$MODE" = "release" ]; then
    if [ -e "$OUTPUT_BUILD_DIR" ]; then
        [ -d "$OUTPUT_BUILD_DIR" ] && [ ! -L "$OUTPUT_BUILD_DIR" ] && \
            [ "$("$STAT_EXECUTABLE" -f '%u' "$OUTPUT_BUILD_DIR")" = "$("$ID_EXECUTABLE" -u)" ] && \
            [ "$("$STAT_EXECUTABLE" -f '%Lp' "$OUTPUT_BUILD_DIR")" = "700" ] || {
            echo "Managed release output must be an isolated builder-owned 0700 directory." >&2
            exit 1
        }
    else
        "$MKDIR_EXECUTABLE" -m 0700 "$OUTPUT_BUILD_DIR"
    fi
else
    "$RM_EXECUTABLE" -rf "$OUTPUT_BUILD_DIR"
    "$MKDIR_EXECUTABLE" -p "$OUTPUT_BUILD_DIR"
fi
if [ "$MODE" = "release" ]; then
    run_swift test -c "$BUILD_CONFIGURATION" \
        --package-path "$SOURCE_NATIVE_DIR" \
        --scratch-path "$SWIFT_SCRATCH_PATH/tests"
fi
SWIFT_RESOURCE_PRODUCT_DIR="$SWIFT_PRODUCT_DIR"
if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    RELEASE_ARM64_PRODUCT_DIR=""
    RELEASE_X86_64_PRODUCT_DIR=""
    RELEASE_UPDATER_PRODUCTS=(recordings-update-client recordings-envelope-signer)
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        RELEASE_UPDATER_PRODUCTS+=(recordings-update-broker recordings-bootstrap-preflight)
    fi
    for swift_architecture in "${RELEASE_ARCHITECTURES[@]}"; do
        swift_arch_scratch="$SWIFT_SCRATCH_PATH/$swift_architecture"
        run_swift build -c "$BUILD_CONFIGURATION" \
            --arch "$swift_architecture" \
            --product App \
            --package-path "$SOURCE_NATIVE_DIR" \
            --scratch-path "$swift_arch_scratch"
        for updater_product in "${RELEASE_UPDATER_PRODUCTS[@]}"; do
            run_swift build -c "$BUILD_CONFIGURATION" \
                --arch "$swift_architecture" \
                --product "$updater_product" \
                --package-path "$SOURCE_NATIVE_DIR" \
                --scratch-path "$swift_arch_scratch"
        done
        swift_arch_product_dir="$(run_swift build -c "$BUILD_CONFIGURATION" \
            --arch "$swift_architecture" \
            --package-path "$SOURCE_NATIVE_DIR" \
            --scratch-path "$swift_arch_scratch" \
            --show-bin-path)"
        case "$swift_arch_product_dir" in
            "$swift_arch_scratch"/*) ;;
            *)
                echo "Swift product path escaped the architecture-specific scratch root." >&2
                exit 1
                ;;
        esac
        if [ ! -d "$swift_arch_product_dir" ]; then
            echo "Swift did not emit an architecture-specific product directory." >&2
            exit 1
        fi
        if [ "$swift_architecture" = "arm64" ]; then
            RELEASE_ARM64_PRODUCT_DIR="$swift_arch_product_dir"
        else
            RELEASE_X86_64_PRODUCT_DIR="$swift_arch_product_dir"
        fi
    done
    SWIFT_PRODUCT_DIR="$BUILD_WORK_DIR/swift-products-universal"
    "$MKDIR_EXECUTABLE" -p "$SWIFT_PRODUCT_DIR"
    SWIFT_RESOURCE_PRODUCT_DIR="$RELEASE_ARM64_PRODUCT_DIR"
    merge_release_swift_product "App" "$SWIFT_PRODUCT_DIR/App"
    merge_release_swift_product "recordings-update-client" "$SWIFT_PRODUCT_DIR/recordings-update-client"
    merge_release_swift_product "recordings-envelope-signer" "$SWIFT_PRODUCT_DIR/recordings-envelope-signer"
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        merge_release_swift_product "recordings-update-broker" "$SWIFT_PRODUCT_DIR/recordings-update-broker"
        merge_release_swift_product "recordings-bootstrap-preflight" "$SWIFT_PRODUCT_DIR/recordings-bootstrap-preflight"
    fi
else
    run_swift build -c "$BUILD_CONFIGURATION" \
        --product App \
        --package-path "$SOURCE_NATIVE_DIR" \
        --scratch-path "$SWIFT_SCRATCH_PATH"
fi
if [ "$HOST_PLATFORM" != "Darwin" ] && [ -n "$TEST_SWIFT_EXECUTABLE" ]; then
    SWIFT_PRODUCT_DIR="$OUTPUT_BUILD_DIR"
    SWIFT_RESOURCE_PRODUCT_DIR="$OUTPUT_BUILD_DIR"
fi

"$RM_EXECUTABLE" -rf "$APP_DIR"
"$MKDIR_EXECUTABLE" -p "$MACOS" "$RESOURCES" "$HELPERS"
"$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/App" "$MACOS/Recordings"
UPDATE_BROKER="$BUILD_WORK_DIR/com.hasna.recordings.updater"
UPDATE_CLIENT="$HELPERS/recordings-update-client"
ENVELOPE_SIGNER="$BUILD_WORK_DIR/recordings-envelope-signer"
BOOTSTRAP_PREFLIGHT_VERIFIER="$BUILD_WORK_DIR/recordings-bootstrap-preflight"
ARTIFACT_VERIFIER="$BUILD_WORK_DIR/com.hasna.recordings.artifact-verifier"
if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-update-client" "$UPDATE_CLIENT"
    "$CHMOD_EXECUTABLE" 0755 "$UPDATE_CLIENT"
    "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-envelope-signer" "$ENVELOPE_SIGNER"
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-update-broker" "$UPDATE_BROKER"
        "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-bootstrap-preflight" "$BOOTSTRAP_PREFLIGHT_VERIFIER"
        "$CHMOD_EXECUTABLE" 0755 "$BOOTSTRAP_PREFLIGHT_VERIFIER"
        VERIFIER_ARM64="$BUILD_WORK_DIR/recordings-artifact-verifier.arm64"
        VERIFIER_X86_64="$BUILD_WORK_DIR/recordings-artifact-verifier.x86_64"
        for verifier_target in arm64 x64; do
            verifier_output="$VERIFIER_ARM64"
            [ "$verifier_target" = "arm64" ] || verifier_output="$VERIFIER_X86_64"
            run_bun build \
                --compile \
                --target="bun-darwin-${verifier_target}" \
                --reject-unresolved \
                --no-compile-autoload-dotenv \
                --no-compile-autoload-bunfig \
                --no-compile-autoload-tsconfig \
                --no-compile-autoload-package-json \
                "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" \
                --outfile "$verifier_output"
        done
        run_lipo -create "$VERIFIER_ARM64" "$VERIFIER_X86_64" -output "$ARTIFACT_VERIFIER"
        "$CHMOD_EXECUTABLE" 0755 "$ARTIFACT_VERIFIER"
        verify_exact_binary_architectures "$ARTIFACT_VERIFIER" arm64 x86_64
        "$RM_EXECUTABLE" -f "$VERIFIER_ARM64" "$VERIFIER_X86_64"
    fi
elif [ "$MODE" = "release" ] && [ -n "$TEST_SWIFT_EXECUTABLE" ]; then
    "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-update-client" "$UPDATE_CLIENT"
    "$CHMOD_EXECUTABLE" 0755 "$UPDATE_CLIENT"
    "$CP_EXECUTABLE" "$SWIFT_PRODUCT_DIR/recordings-envelope-signer" "$ENVELOPE_SIGNER"
    "$CHMOD_EXECUTABLE" 0755 "$ENVELOPE_SIGNER"
fi
COMPANION_BUILD_KIND="native"
if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    COMPANION_BUILD_KIND="universal"
fi
"$ENV_EXECUTABLE" -i \
    HOME="$BUILD_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$BUILD_WORK_DIR" \
    ${COMPANION_TEST_ENVIRONMENT[0]+"${COMPANION_TEST_ENVIRONMENT[@]}"} \
    "$BASH_EXECUTABLE" "$COMPANION_BUILD_SCRIPT" "$HELPERS/recordings" "$BUN_EXECUTABLE" "$COMPANION_BUILD_KIND"
if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    verify_exact_binary_architectures "$MACOS/Recordings" arm64 x86_64
    verify_exact_binary_architectures "$UPDATE_CLIENT" arm64 x86_64
    verify_exact_binary_architectures "$ENVELOPE_SIGNER" arm64 x86_64
    verify_exact_binary_architectures "$HELPERS/recordings" arm64 x86_64
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        verify_exact_binary_architectures "$UPDATE_BROKER" arm64 x86_64
        verify_exact_binary_architectures "$ARTIFACT_VERIFIER" arm64 x86_64
        verify_exact_binary_architectures "$BOOTSTRAP_PREFLIGHT_VERIFIER" arm64 x86_64
    fi
fi
"$CP_EXECUTABLE" "$SOURCE_NATIVE_DIR/RecordingsLib/Info.plist" "$CONTENTS/Info.plist"
VERSION="$("$PLIST_BUDDY" -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist")"

compute_release_publication_identity() {
    local -a identity_arguments=(
        --component "release_kind=$RELEASE_SUBTYPE"
        --component "source_sha=$SOURCE_SHA"
        --component "version=$VERSION"
        --component "codesign_identity=$CODESIGN_IDENTITY"
        --component "team_id=$EXPECTED_TEAM_ID"
        --component "notary_profile=$NOTARY_PROFILE"
        --component "release_sequence=$RELEASE_SEQUENCE"
        --component "key_epoch=$KEY_EPOCH"
        --component "expires_at_utc=$ENVELOPE_EXPIRES_AT_UTC"
    )
    identity_arguments+=(--component "envelope_public_key_sha256=$ENVELOPE_PUBLIC_KEY_SHA256")
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        identity_arguments+=(--component "installer_identity=$INSTALLER_IDENTITY")
    else
        identity_arguments+=(--component "compatible_cohort_sha256=$COMPATIBLE_COHORT_SHA256")
    fi
    RELEASE_PUBLICATION_IDENTITY_SHA256="$(run_bun \
        "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" release-publication-identity \
        "${identity_arguments[@]}")"
    [[ "$RELEASE_PUBLICATION_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
        echo "Release publication identity is invalid." >&2
        return 1
    }
}

reserve_release_output() {
    local release_set_basename reserved_output
    release_set_basename="Recordings-${VERSION}-macos-${RELEASE_SUBTYPE}"
    compute_release_publication_identity
    RELEASE_OUTPUT_ROOT="$OUTPUT_BUILD_DIR"
    RELEASE_FINAL_DIR="$RELEASE_OUTPUT_ROOT/${release_set_basename}.release"
    RELEASE_RESERVATION="$RELEASE_OUTPUT_ROOT/.${release_set_basename}.reservation"
    RELEASE_OUTPUT_ALIASES=(
        "${release_set_basename}.zip"
        "${release_set_basename}.manifest.json"
        "${release_set_basename}.notary-submit.json"
        "${release_set_basename}.notary-log.json"
    )
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        RELEASE_OUTPUT_ALIASES+=(
            "${release_set_basename}-updater.pkg"
            "${release_set_basename}-updater.notary-submit.json"
            "${release_set_basename}-updater.notary-log.json"
            "${release_set_basename}-updater.pkg.sha256"
            "${release_set_basename}-updater.bootstrap-envelope.json"
            "${release_set_basename}-updater.compatible-cohort.json"
            "${release_set_basename}-updater.compatible-cohort.json.sha256"
        )
    else
        RELEASE_OUTPUT_ALIASES+=("${release_set_basename}.update-envelope.json")
    fi
    if [ -e "$RELEASE_FINAL_DIR" ] || [ -L "$RELEASE_FINAL_DIR" ]; then
        run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" complete-release-publication \
            --destination "$RELEASE_FINAL_DIR" \
            --reservation "$RELEASE_RESERVATION" \
            --output-root "$RELEASE_OUTPUT_ROOT" \
            --publication-identity-sha256 "$RELEASE_PUBLICATION_IDENTITY_SHA256"
        run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" assert-release-publication-complete \
            --destination "$RELEASE_FINAL_DIR" \
            --output-root "$RELEASE_OUTPUT_ROOT" \
            --publication-identity-sha256 "$RELEASE_PUBLICATION_IDENTITY_SHA256"
        echo "Recovered authenticated same-version release publication: $RELEASE_FINAL_DIR"
        exit 0
    fi
    [ ! -e "$RELEASE_FINAL_DIR" ] && [ ! -L "$RELEASE_FINAL_DIR" ] || {
        echo "Release output already exists; same-version publication is immutable: $RELEASE_FINAL_DIR" >&2
        exit 1
    }
    for reserved_output in "${RELEASE_OUTPUT_ALIASES[@]}"; do
        [ ! -e "$RELEASE_OUTPUT_ROOT/$reserved_output" ] && \
            [ ! -L "$RELEASE_OUTPUT_ROOT/$reserved_output" ] || {
            echo "Release compatibility output already exists and cannot be replaced: $reserved_output" >&2
            exit 1
        }
    done
    if ! "$MKDIR_EXECUTABLE" -m 0700 "$RELEASE_RESERVATION"; then
        echo "Release output is already reserved by another or interrupted builder." >&2
        exit 1
    fi
    RELEASE_RESERVATION_OWNED=1
    [ ! -e "$RELEASE_FINAL_DIR" ] && [ ! -L "$RELEASE_FINAL_DIR" ] || {
        echo "Release output appeared while acquiring its reservation." >&2
        exit 1
    }
    for reserved_output in "${RELEASE_OUTPUT_ALIASES[@]}"; do
        [ ! -e "$RELEASE_OUTPUT_ROOT/$reserved_output" ] && \
            [ ! -L "$RELEASE_OUTPUT_ROOT/$reserved_output" ] || {
            echo "Release compatibility output appeared while acquiring its reservation." >&2
            exit 1
        }
    done
    RELEASE_STAGING_DIR="$($MKTEMP_EXECUTABLE -d "$RELEASE_OUTPUT_ROOT/.${release_set_basename}.staging.XXXXXX")"
    "$CHMOD_EXECUTABLE" 0700 "$RELEASE_STAGING_DIR"
    OUTPUT_BUILD_DIR="$RELEASE_STAGING_DIR"
    OUTPUT_APP_DIR="$OUTPUT_BUILD_DIR/Recordings.app"
}

if [ "$MODE" = "release" ]; then
    reserve_release_output
fi

for bundle in "$SWIFT_RESOURCE_PRODUCT_DIR"/*.resources "$SWIFT_RESOURCE_PRODUCT_DIR"/*.bundle "$SWIFT_SCRATCH_PATH"/*/"$BUILD_CONFIGURATION"/*.resources "$SWIFT_SCRATCH_PATH"/*/"$BUILD_CONFIGURATION"/*.bundle; do
    [ -e "$bundle" ] || continue
    "$RM_EXECUTABLE" -rf "$RESOURCES/$("$BASENAME_EXECUTABLE" "$bundle")"
    run_sensitive_tool "$DITTO_EXECUTABLE" "$bundle" "$RESOURCES/$("$BASENAME_EXECUTABLE" "$bundle")"
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
normalize_unsigned_app_bundle_modes "$APP_DIR"
for standalone_launch_file in \
    "$UPDATE_BROKER" \
    "$ARTIFACT_VERIFIER" \
    "$ENVELOPE_SIGNER" \
    "$BOOTSTRAP_PREFLIGHT_VERIFIER"; do
    [ -e "$standalone_launch_file" ] || [ -L "$standalone_launch_file" ] || continue
    normalize_unsigned_launch_file_mode "$standalone_launch_file" "Release launch file"
done

if [ "$MODE" = "release" ]; then
    run_codesign "${HELPER_SIGN_ARGUMENTS[@]}" \
        --entitlements "$HELPER_ENTITLEMENTS" \
        "$HELPERS/recordings"
else
    "$CODESIGN_EXECUTABLE" "${HELPER_SIGN_ARGUMENTS[@]}" \
        --entitlements "$HELPER_ENTITLEMENTS" \
        "$HELPERS/recordings"
fi

if [ "$MODE" = "release" ] && [ "$HOST_PLATFORM" = "Darwin" ]; then
    run_codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.hasna.recordings.update-client \
        --options runtime --timestamp --entitlements "$SOURCE_PACKAGE_ROOT/packaging/macos/Empty.entitlements" \
        "$UPDATE_CLIENT"
    run_codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.hasna.recordings.envelope-signer \
        --options runtime --timestamp --entitlements "$SOURCE_PACKAGE_ROOT/packaging/macos/Empty.entitlements" \
        "$ENVELOPE_SIGNER"
    RELEASE_SIGNED_UPDATER_CODE=("$UPDATE_CLIENT" "$ENVELOPE_SIGNER")
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        run_codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.hasna.recordings.updater \
            --options runtime --timestamp --entitlements "$SOURCE_PACKAGE_ROOT/packaging/macos/Empty.entitlements" \
            "$UPDATE_BROKER"
        run_codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.hasna.recordings.artifact-verifier \
            --options runtime --timestamp \
            --entitlements "$SOURCE_PACKAGE_ROOT/packaging/macos/Verifier.entitlements" \
            "$ARTIFACT_VERIFIER"
        run_codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.hasna.recordings.bootstrap-preflight \
            --options runtime --timestamp --entitlements "$SOURCE_PACKAGE_ROOT/packaging/macos/Empty.entitlements" \
            "$BOOTSTRAP_PREFLIGHT_VERIFIER"
        RELEASE_SIGNED_UPDATER_CODE+=("$UPDATE_BROKER" "$ARTIFACT_VERIFIER" "$BOOTSTRAP_PREFLIGHT_VERIFIER")
    fi
    for updater_code in "${RELEASE_SIGNED_UPDATER_CODE[@]}"; do
        run_codesign --verify --strict --all-architectures --verbose=2 "$updater_code"
    done
fi

verify_helper_entitlements() {
    local helper="$1"
    local entitlement_plist
    local entitlement_json
    entitlement_plist="$(run_sensitive_tool "$MKTEMP_EXECUTABLE" "$BUILD_WORK_DIR/helper-entitlements.XXXXXX")"
    if ! run_codesign -d --entitlements :- "$helper" >"$entitlement_plist" 2>/dev/null; then
        "$RM_EXECUTABLE" -f "$entitlement_plist"
        echo "Companion CLI signed entitlements could not be read back." >&2
        return 1
    fi
    entitlement_json="$(run_sensitive_tool "$PLUTIL" -convert json -o - "$entitlement_plist" | run_sensitive_tool "$TR_EXECUTABLE" -d '[:space:]')"
    "$RM_EXECUTABLE" -f "$entitlement_plist"
    if ! "$ENV_EXECUTABLE" -i \
        HOME="$BUILD_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        ENTITLEMENT_JSON="$entitlement_json" \
        "$BUN_EXECUTABLE" -e '
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
    flags="$(printf '%s\n' "$details" | run_sensitive_tool "$SED_EXECUTABLE" -n 's/^CodeDirectory .*flags=[^(]*(\([^)]*\)).*/\1/p' | run_sensitive_tool "$HEAD_EXECUTABLE" -n 1)"
    case ",$flags," in
        *,runtime,*) return 0 ;;
        *) return 1 ;;
    esac
}

verify_hardened_helper() {
    local details
    run_codesign --verify --strict --verbose=2 "$HELPERS/recordings"
    details="$(run_codesign -d --verbose=4 "$HELPERS/recordings" 2>&1)"
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
    contract_home="$(run_sensitive_tool "$MKTEMP_EXECUTABLE" -d "$BUILD_WORK_DIR/signed-helper-contract.XXXXXX")"
    helper_executable="$HELPERS/recordings"
    local -a contract_environment=(
        "$ENV_EXECUTABLE" -i
        HOME="$contract_home"
        PATH="/usr/bin:/bin:/usr/sbin:/sbin"
        TMPDIR="$contract_home"
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
        "$RM_EXECUTABLE" -rf "$contract_home"
        echo "Post-sign signed companion CLI contract failed." >&2
        exit 1
    fi
    if ! "$ENV_EXECUTABLE" -i \
        HOME="$BUILD_HOME" \
        PATH="$SANITIZED_PATH" \
        TMPDIR="$BUILD_WORK_DIR" \
        PROJECT_JSON="$project_output" \
        RECORDING_JSON="$recording_output" \
        "$BUN_EXECUTABLE" -e '
        const project = JSON.parse(process.env.PROJECT_JSON ?? "null");
        const recording = JSON.parse(process.env.RECORDING_JSON ?? "null");
        if (project?.name !== "Signed Helper Contract") process.exit(1);
        if (project?.path !== "recordings-app://build/signed-helper-contract") process.exit(1);
        if (recording?.raw_text !== "Signed helper contract") process.exit(1);
    '; then
        "$RM_EXECUTABLE" -rf "$contract_home"
        echo "Post-sign signed companion CLI contract returned invalid JSON." >&2
        exit 1
    fi
    "$RM_EXECUTABLE" -rf "$contract_home"
}

verify_hardened_helper
run_signed_helper_contract
if [ "$MODE" != "debug" ]; then
    verify_source_unchanged
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" provenance \
        --app "$APP_DIR" \
        --source-sha "$SOURCE_SHA" \
        --team-id "$EXPECTED_TEAM_ID" \
        --package-root "$PACKAGE_ROOT" \
        --artifact-policy "$ARTIFACT_POLICY" \
        --approved-target "$APPROVED_TARGET" \
        --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
        --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256" \
        --builder-identity-kind "$BUILDER_IDENTITY_KIND" \
        --builder-identity-sha256 "$BUILDER_IDENTITY_SHA256"
    PROVENANCE_FILE="$RESOURCES/recordings-build-provenance.json"
    if [ -e "$PROVENANCE_FILE" ] || [ -L "$PROVENANCE_FILE" ]; then
        normalize_unsigned_app_data_file_mode "$PROVENANCE_FILE" "App build provenance"
    elif [ "$HOST_PLATFORM" = "Darwin" ]; then
        echo "App build provenance was not emitted: $PROVENANCE_FILE" >&2
        exit 1
    fi
fi
verify_app_bundle_modes "$APP_DIR"
run_codesign "${APP_SIGN_ARGUMENTS[@]}" \
    --entitlements "$APP_ENTITLEMENTS" \
    "$APP_DIR"

verify_signed_code() {
    local code_path="$1"
    local label="$2"
    local details
    local authority
    local team_id
    local timestamp
    run_codesign --verify --strict --verbose=2 "$code_path"
    details="$(run_codesign -d --verbose=4 "$code_path" 2>&1)"
    authority="$(printf '%s\n' "$details" | run_sensitive_tool "$AWK_EXECUTABLE" -F= '/^Authority=/ { print $2; exit }')"
    team_id="$(printf '%s\n' "$details" | run_sensitive_tool "$AWK_EXECUTABLE" -F= '/^TeamIdentifier=/ { print $2; exit }')"
    timestamp="$(printf '%s\n' "$details" | run_sensitive_tool "$AWK_EXECUTABLE" -F= '/^Timestamp=/ { print $2; exit }')"
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

run_codesign --verify --deep --strict --verbose=2 "$APP_DIR"
"$ENV_EXECUTABLE" -i \
    HOME="$OPERATOR_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$BUILD_WORK_DIR" \
    SSH_CONNECTION="${SSH_CONNECTION:-}" \
    ${SMOKE_TEST_ENVIRONMENT[0]+"${SMOKE_TEST_ENVIRONMENT[@]}"} \
    "$BASH_EXECUTABLE" "$SMOKE_SCRIPT" "$APP_DIR" "$BUN_EXECUTABLE"

publish_app_output() {
    local source_tree_digest
    local published_tree_digest
    if [ "$MODE" = "release" ]; then
        [ ! -e "$OUTPUT_APP_DIR" ] && [ ! -L "$OUTPUT_APP_DIR" ] || {
            echo "Release staging already contains an app output; refusing replacement." >&2
            exit 1
        }
    else
        "$RM_EXECUTABLE" -rf "$OUTPUT_APP_DIR"
    fi
    run_sensitive_tool "$DITTO_EXECUTABLE" "$APP_DIR" "$OUTPUT_APP_DIR"
    if [ "$HOST_PLATFORM" = "Darwin" ]; then
        verify_app_bundle_modes "$OUTPUT_APP_DIR"
        require_app_tree_without_extended_acl "$OUTPUT_APP_DIR"
        source_tree_digest="$(run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" tree-digest --path "$APP_DIR")"
        published_tree_digest="$(run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" tree-digest --path "$OUTPUT_APP_DIR")"
        if [ "$published_tree_digest" != "$source_tree_digest" ]; then
            echo "Published app copy does not match the signed source tree." >&2
            exit 1
        fi
        run_codesign --verify --deep --strict --verbose=2 "$OUTPUT_APP_DIR"
    fi
}

verify_complete_release_staging() {
    local output
    for output in \
        "$OUTPUT_APP_DIR" \
        "$FINAL_ARCHIVE" \
        "$FINAL_MANIFEST" \
        "$NOTARY_SUBMISSION" \
        "$NOTARY_LOG"; do
        [ -e "$output" ] && [ ! -L "$output" ] || {
            echo "Release staging is incomplete or unsafe: $output" >&2
            exit 1
        }
    done
    [ -d "$OUTPUT_APP_DIR" ] || { echo "Release staging app is not a directory." >&2; exit 1; }
    for output in "$FINAL_ARCHIVE" "$FINAL_MANIFEST" "$NOTARY_SUBMISSION" "$NOTARY_LOG"; do
        [ -f "$output" ] && [ -s "$output" ] || {
            echo "Release staging file is empty or not regular: $output" >&2
            exit 1
        }
        "$CHMOD_EXECUTABLE" 0444 "$output"
    done
    if [ "$HOST_PLATFORM" = "Darwin" ]; then
        local manifest_archive_digest manifest_notary_log_digest manifest_submitted_digest
        manifest_archive_digest="$(run_release_sensitive_tool "$PLUTIL" -extract archive.sha256 raw -o - \
            "$FINAL_MANIFEST")"
        manifest_notary_log_digest="$(run_release_sensitive_tool "$PLUTIL" -extract notarization.log_sha256 raw -o - \
            "$FINAL_MANIFEST")"
        manifest_submitted_digest="$(run_release_sensitive_tool "$PLUTIL" -extract notarization.submitted_archive_sha256 raw -o - \
            "$FINAL_MANIFEST")"
        [ "$manifest_archive_digest" = "$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
            "$FINAL_ARCHIVE" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')" ] || {
            echo "Release manifest no longer binds the finalized ZIP in staging." >&2
            exit 1
        }
        [ "$manifest_notary_log_digest" = "$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
            "$NOTARY_LOG" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')" ] || {
            echo "Release manifest no longer binds the accepted notary log in staging." >&2
            exit 1
        }
        [ "$manifest_submitted_digest" = "$NOTARY_ARCHIVE_SHA256" ] || {
            echo "Release manifest no longer binds the locally submitted archive digest." >&2
            exit 1
        }
        if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
            local package_set="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.release"
            local pkg="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.pkg"
            local pkg_digest="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.pkg.sha256"
            [ -d "$package_set" ] && [ ! -L "$package_set" ] || {
                echo "Initial-bootstrap staging is missing the canonical updater package set." >&2
                exit 1
            }
            run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" assert-release-publication-complete \
                --destination "$package_set" \
                --output-root "$OUTPUT_BUILD_DIR" \
                --publication-identity-sha256 "$PACKAGE_PUBLICATION_IDENTITY_SHA256"
            for output in \
                "$pkg" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.notary-submit.json" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.notary-log.json" \
                "$pkg_digest" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.bootstrap-envelope.json" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.compatible-cohort.json" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.compatible-cohort.json.sha256"; do
                [ -f "$output" ] && [ ! -L "$output" ] && [ -s "$output" ] || {
                    echo "Initial-bootstrap staging is missing a finalized package output: $output" >&2
                    exit 1
                }
                [ "$("$STAT_EXECUTABLE" -f '%Lp' "$output")" = "444" ] || {
                    echo "Finalized initial-bootstrap output is not read-only: $output" >&2
                    exit 1
                }
            done
            [ ! -e "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.update-envelope.json" ] && \
                [ ! -L "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.update-envelope.json" ] || {
                echo "Initial-bootstrap staging must not contain an app-update envelope." >&2
                exit 1
            }
            local published_pkg_digest
            published_pkg_digest="$(run_release_sensitive_tool "$AWK_EXECUTABLE" 'NR == 1 { print $1 }' \
                "$pkg_digest")"
            [ "$published_pkg_digest" = "$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
                "$pkg" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')" ] || {
                echo "Initial-bootstrap PKG digest does not match the finalized PKG." >&2
                exit 1
            }
        else
            local update_envelope="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.update-envelope.json"
            [ -f "$update_envelope" ] && [ ! -L "$update_envelope" ] && [ -s "$update_envelope" ] && \
                [ "$("$STAT_EXECUTABLE" -f '%Lp' "$update_envelope")" = "444" ] || {
                echo "App-update staging is missing its single finalized update envelope." >&2
                exit 1
            }
            for output in \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.release" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.pkg" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.bootstrap-envelope.json" \
                "$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-updater.compatible-cohort.json"; do
                [ ! -e "$output" ] && [ ! -L "$output" ] || {
                    echo "App-update staging contains a forbidden bootstrap or root-cohort output: $output" >&2
                    exit 1
                }
            done
        fi
    fi
}

publish_complete_release_set() {
    local output_alias
    local -a publication_arguments=()
    verify_complete_release_staging
    verify_source_unchanged
    [ ! -e "$RELEASE_FINAL_DIR" ] && [ ! -L "$RELEASE_FINAL_DIR" ] || {
        echo "Release destination appeared before immutable publication." >&2
        exit 1
    }
    for output_alias in "${RELEASE_OUTPUT_ALIASES[@]}"; do
        [ -f "$RELEASE_STAGING_DIR/$output_alias" ] || continue
        publication_arguments+=(--alias "$output_alias")
    done
    if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
        publication_arguments+=(
            --nested-publication
            "${ARTIFACT_BASENAME}-updater.release=$PACKAGE_PUBLICATION_IDENTITY_SHA256"
        )
    fi
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" prepare-release-publication \
        --staging "$RELEASE_STAGING_DIR" \
        --destination "$RELEASE_FINAL_DIR" \
        --reservation "$RELEASE_RESERVATION" \
        --publication-identity-sha256 "$RELEASE_PUBLICATION_IDENTITY_SHA256" \
        "${publication_arguments[@]}"
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" publish-release-directory \
        --staging "$RELEASE_STAGING_DIR" \
        --destination "$RELEASE_FINAL_DIR"
    RELEASE_DIRECTORY_PUBLISHED=1
    RELEASE_STAGING_DIR=""
    OUTPUT_BUILD_DIR="$RELEASE_FINAL_DIR"
    OUTPUT_APP_DIR="$OUTPUT_BUILD_DIR/Recordings.app"
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" complete-release-publication \
        --destination "$RELEASE_FINAL_DIR" \
        --reservation "$RELEASE_RESERVATION" \
        --output-root "$RELEASE_OUTPUT_ROOT" \
        --publication-identity-sha256 "$RELEASE_PUBLICATION_IDENTITY_SHA256"
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" assert-release-publication-complete \
        --destination "$RELEASE_FINAL_DIR" \
        --output-root "$RELEASE_OUTPUT_ROOT" \
        --publication-identity-sha256 "$RELEASE_PUBLICATION_IDENTITY_SHA256"
    RELEASE_RESERVATION_OWNED=0
    FINAL_ARCHIVE="$RELEASE_FINAL_DIR/${ARTIFACT_BASENAME}.zip"
    FINAL_MANIFEST="$RELEASE_FINAL_DIR/${ARTIFACT_BASENAME}.manifest.json"
    NOTARY_SUBMISSION="$RELEASE_FINAL_DIR/${ARTIFACT_BASENAME}.notary-submit.json"
    NOTARY_LOG="$RELEASE_FINAL_DIR/${ARTIFACT_BASENAME}.notary-log.json"
}

if [ "$MODE" = "debug" ]; then
    verify_source_unchanged
    publish_app_output
    verify_source_unchanged
    echo "Built non-distributable debug app: $OUTPUT_APP_DIR"
    exit 0
fi

if [ "$MODE" = "local" ]; then
    ARTIFACT_BASENAME="Recordings-${VERSION}-macos-${APPROVED_TARGET}-local-only"
    FINAL_ARCHIVE="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.zip"
    FINAL_MANIFEST="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.manifest.json"
    "$RM_EXECUTABLE" -f "$FINAL_ARCHIVE" "$FINAL_MANIFEST"
    run_codesign --verify --deep --strict --all-architectures --verbose=2 "$APP_DIR"
    "$DITTO_EXECUTABLE" -c -k --sequesterRsrc --keepParent "$APP_DIR" "$FINAL_ARCHIVE"
    verify_source_unchanged
    run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" finalize-local \
        --app "$APP_DIR" \
        --source-sha "$SOURCE_SHA" \
        --archive "$FINAL_ARCHIVE" \
        --manifest "$FINAL_MANIFEST" \
        --package-root "$PACKAGE_ROOT" \
        --approved-target "$APPROVED_TARGET" \
        --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
        --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
    publish_app_output
    verify_source_unchanged
    echo "Built immutable local-only app artifact: $FINAL_ARCHIVE"
    echo "Built local-only artifact manifest: $FINAL_MANIFEST"
    echo "This artifact is not notarized and is approved only for ${APPROVED_TARGET}."
    exit 0
fi

verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
ARTIFACT_BASENAME="Recordings-${VERSION}-macos-${RELEASE_SUBTYPE}"
NOTARY_ARCHIVE="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}-notarization.zip"
FINAL_ARCHIVE="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.zip"
FINAL_MANIFEST="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.manifest.json"
NOTARY_SUBMISSION="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.notary-submit.json"
NOTARY_LOG="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.notary-log.json"

for release_staging_output in \
    "$NOTARY_ARCHIVE" \
    "$FINAL_ARCHIVE" \
    "$FINAL_MANIFEST" \
    "$NOTARY_SUBMISSION" \
    "$NOTARY_LOG"; do
    [ ! -e "$release_staging_output" ] && [ ! -L "$release_staging_output" ] || {
        echo "Release staging output already exists; refusing replacement: $release_staging_output" >&2
        exit 1
    }
done
run_release_sensitive_tool "$DITTO_EXECUTABLE" -c -k --sequesterRsrc --keepParent "$APP_DIR" "$NOTARY_ARCHIVE"
NOTARY_ARCHIVE_SHA256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 "$NOTARY_ARCHIVE" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{print $1}')"
run_xcrun notarytool submit "$NOTARY_ARCHIVE" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait --output-format json >"$NOTARY_SUBMISSION"
NOTARY_ID="$("$ENV_EXECUTABLE" -i \
    HOME="$BUILD_HOME" \
    PATH="$SANITIZED_PATH" \
    TMPDIR="$BUILD_WORK_DIR" \
    NOTARY_SUBMISSION_JSON="$(run_release_sensitive_tool "$CAT_EXECUTABLE" "$NOTARY_SUBMISSION")" \
    "$BUN_EXECUTABLE" -e '
    const value = JSON.parse(process.env.NOTARY_SUBMISSION_JSON ?? "null");
    if (value?.status !== "Accepted" || typeof value?.id !== "string" || !value.id) process.exit(1);
    process.stdout.write(value.id);
')" || {
    echo "Notarization submission was not accepted or omitted its submission ID." >&2
    exit 1
}
run_xcrun notarytool log "$NOTARY_ID" \
    --keychain-profile "$NOTARY_PROFILE" >"$NOTARY_LOG"
if ! run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" assert-notary-log \
    --notary-log "$NOTARY_LOG" \
    --submission-id "$NOTARY_ID" \
    --submitted-archive-sha256 "$NOTARY_ARCHIVE_SHA256"; then
    echo "Accepted notarization log contains a rejected status or reported issues." >&2
    exit 1
fi
"$RM_EXECUTABLE" -f "$NOTARY_ARCHIVE"
run_xcrun stapler staple "$APP_DIR"
run_xcrun stapler validate "$APP_DIR"
run_release_sensitive_tool "$SPCTL_EXECUTABLE" --assess --type execute --verbose=2 "$APP_DIR"
run_release_sensitive_tool "$SYSPOLICY_CHECK_EXECUTABLE" distribution "$APP_DIR"
verify_signed_code "$HELPERS/recordings" "Companion CLI"
verify_signed_code "$APP_DIR" "Recordings.app"
run_codesign --verify --deep --strict --verbose=2 "$APP_DIR"

run_release_sensitive_tool "$DITTO_EXECUTABLE" -c -k --sequesterRsrc --keepParent "$APP_DIR" "$FINAL_ARCHIVE"
verify_source_unchanged
run_bun "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" finalize \
    --app "$APP_DIR" \
    --source-sha "$SOURCE_SHA" \
    --archive "$FINAL_ARCHIVE" \
    --manifest "$FINAL_MANIFEST" \
    --package-root "$PACKAGE_ROOT" \
    --team-id "$EXPECTED_TEAM_ID" \
    --notary-log "$NOTARY_LOG" \
    --notary-submission-id "$NOTARY_ID" \
    --submitted-archive-sha256 "$NOTARY_ARCHIVE_SHA256"

designated_requirement() {
    local code_path="$1"
    local requirement
    requirement="$(run_codesign -d -r- "$code_path" 2>&1 | \
        run_release_sensitive_tool "$SED_EXECUTABLE" -n 's/^designated => //p' | \
        run_release_sensitive_tool "$HEAD_EXECUTABLE" -n 1)"
    [ -n "$requirement" ] || {
        echo "Signed component is missing its designated requirement: $code_path" >&2
        return 1
    }
    printf '%s\n' "$requirement"
}

build_app_update_envelope() {
    local payload="$BUILD_WORK_DIR/app-update-envelope-payload.json"
    local update_envelope="$OUTPUT_BUILD_DIR/${ARTIFACT_BASENAME}.update-envelope.json"
    [ "$HOST_PLATFORM" = "Darwin" ] || [ -n "$TEST_SWIFT_EXECUTABLE" ] || {
        echo "App-update release envelopes can only be built on macOS." >&2
        return 1
    }
    [ -f "$COMPATIBLE_COHORT_SNAPSHOT" ] && [ ! -L "$COMPATIBLE_COHORT_SNAPSHOT" ] || {
        echo "App-update compatible-cohort snapshot is missing or unsafe." >&2
        return 1
    }
    [ ! -e "$update_envelope" ] && [ ! -L "$update_envelope" ] || {
        echo "App-update envelope output already exists; refusing replacement." >&2
        return 1
    }
    run_bun "$RELEASE_LIFECYCLE_HELPER" write-update-payload \
        --app-archive "$FINAL_ARCHIVE" \
        --application-designated-requirement "$(designated_requirement "$APP_DIR")" \
        --compatible-cohort-manifest "$COMPATIBLE_COHORT_SNAPSHOT" \
        --envelope-public-key "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
        --expires-at-utc "$ENVELOPE_EXPIRES_AT_UTC" \
        --key-epoch "$KEY_EPOCH" \
        --manifest "$FINAL_MANIFEST" \
        --output "$payload" \
        --release-sequence "$RELEASE_SEQUENCE" \
        --source-sha "$SOURCE_SHA" \
        --team-id "$EXPECTED_TEAM_ID" \
        --update-client "$UPDATE_CLIENT" \
        --update-client-designated-requirement "$(designated_requirement "$UPDATE_CLIENT")" \
        --version "$VERSION"
    run_release_sensitive_tool "$ENVELOPE_SIGNER" \
        --payload "$payload" \
        --private-key "$ENVELOPE_PRIVATE_KEY" \
        --public-key "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
        --output "$update_envelope"
    [ -f "$update_envelope" ] && [ ! -L "$update_envelope" ] && [ -s "$update_envelope" ] || {
        echo "Envelope signer did not emit exactly one app-update sidecar." >&2
        return 1
    }
    "$CHMOD_EXECUTABLE" 0444 "$update_envelope"
}

verify_source_unchanged

compute_package_publication_identity() {
    local app_archive_sha256 manifest_sha256 broker_sha256 verifier_sha256
    local bootstrap_preflight_sha256 envelope_public_key_sha256 envelope_signer_sha256
    if [ "$HOST_PLATFORM" != "Darwin" ] && [ -n "$TEST_SWIFT_EXECUTABLE" ]; then
        PACKAGE_PUBLICATION_IDENTITY_SHA256="$(run_bun \
            "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" release-publication-identity \
            --component "release_kind=initial-bootstrap-updater" \
            --component "source_sha=$SOURCE_SHA" \
            --component "version=$VERSION" \
            --component "fixture_mode=non-darwin-contract")"
        [[ "$PACKAGE_PUBLICATION_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
            echo "Updater package publication identity is invalid." >&2
            return 1
        }
        return
    fi
    app_archive_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$FINAL_ARCHIVE" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    manifest_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$FINAL_MANIFEST" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    broker_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$UPDATE_BROKER" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    verifier_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$ARTIFACT_VERIFIER" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    bootstrap_preflight_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$BOOTSTRAP_PREFLIGHT_VERIFIER" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    envelope_public_key_sha256="$ENVELOPE_PUBLIC_KEY_SHA256"
    envelope_signer_sha256="$(run_release_sensitive_tool "$SHASUM_EXECUTABLE" -a 256 \
        "$ENVELOPE_SIGNER" | run_release_sensitive_tool "$AWK_EXECUTABLE" '{ print $1 }')"
    PACKAGE_PUBLICATION_IDENTITY_SHA256="$(run_bun \
        "$SOURCE_PACKAGE_ROOT/scripts/macos_artifact.ts" release-publication-identity \
        --component "release_kind=initial-bootstrap-updater" \
        --component "source_sha=$SOURCE_SHA" \
        --component "version=$VERSION" \
        --component "team_id=$EXPECTED_TEAM_ID" \
        --component "installer_identity=$INSTALLER_IDENTITY" \
        --component "notary_profile=$NOTARY_PROFILE" \
        --component "release_sequence=$RELEASE_SEQUENCE" \
        --component "key_epoch=$KEY_EPOCH" \
        --component "expires_at_utc=$ENVELOPE_EXPIRES_AT_UTC" \
        --component "app_archive_sha256=$app_archive_sha256" \
        --component "manifest_sha256=$manifest_sha256" \
        --component "broker_sha256=$broker_sha256" \
        --component "artifact_verifier_sha256=$verifier_sha256" \
        --component "bootstrap_preflight_sha256=$bootstrap_preflight_sha256" \
        --component "envelope_public_key_sha256=$envelope_public_key_sha256" \
        --component "envelope_signer_sha256=$envelope_signer_sha256")"
    [[ "$PACKAGE_PUBLICATION_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
        echo "Updater package publication identity is invalid." >&2
        return 1
    }
}

if [ "$RELEASE_SUBTYPE" = "initial-bootstrap" ]; then
    compute_package_publication_identity
    run_release_sensitive_tool "$BASH_EXECUTABLE" \
        "$SOURCE_PACKAGE_ROOT/packaging/macos/build_release_pkg.sh" \
        --source-root "$SOURCE_PACKAGE_ROOT" \
        --app "$APP_DIR" \
        --app-archive "$FINAL_ARCHIVE" \
        --artifact-basename "$ARTIFACT_BASENAME" \
        --manifest "$FINAL_MANIFEST" \
        --broker "$UPDATE_BROKER" \
        --verifier "$ARTIFACT_VERIFIER" \
        --public-key "$ENVELOPE_PUBLIC_KEY_SNAPSHOT" \
        --envelope-private-key "$ENVELOPE_PRIVATE_KEY" \
        --envelope-signer "$ENVELOPE_SIGNER" \
        --bootstrap-preflight-verifier "$BOOTSTRAP_PREFLIGHT_VERIFIER" \
        --bun-executable "$BUN_EXECUTABLE" \
        --version "$VERSION" \
        --source-sha "$SOURCE_SHA" \
        --team-id "$EXPECTED_TEAM_ID" \
        --installer-identity "$INSTALLER_IDENTITY" \
        --notary-profile "$NOTARY_PROFILE" \
        --release-sequence "$RELEASE_SEQUENCE" \
        --key-epoch "$KEY_EPOCH" \
        --expires-at-utc "$ENVELOPE_EXPIRES_AT_UTC" \
        --publication-identity-sha256 "$PACKAGE_PUBLICATION_IDENTITY_SHA256" \
        --output-dir "$OUTPUT_BUILD_DIR"
else
    build_app_update_envelope
fi

publish_app_output
publish_complete_release_set
verify_source_unchanged
echo "Built immutable app artifact: $FINAL_ARCHIVE"
echo "Built artifact manifest: $FINAL_MANIFEST"
echo "Captured accepted notarization log: $NOTARY_LOG"
