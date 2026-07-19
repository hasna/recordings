#!/bin/bash
# Assemble, sign, notarize, and verify the root-owned Recordings updater bootstrap PKG.

set -euo pipefail
umask 077

export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
export LANG=C
export TZ=UTC0

APP=""
ARTIFACT_BASENAME=""
BROKER=""
VERIFIER=""
PUBLIC_KEY=""
VERSION=""
SOURCE_SHA=""
EXPECTED_TEAM_ID=""
INSTALLER_IDENTITY=""
NOTARY_PROFILE=""
OUTPUT_DIR=""
BUN_EXECUTABLE=""
RELEASE_SEQUENCE=""
KEY_EPOCH=""
EXPIRES_AT_UTC=""
ENVELOPE_SIGNER=""
SOURCE_ROOT=""
ENVELOPE_PRIVATE_KEY=""
APP_ARCHIVE=""
MANIFEST=""
BOOTSTRAP_PREFLIGHT_VERIFIER=""
PACKAGE_STAGE_DIR=""
PACKAGE_FINAL_DIR=""
PACKAGE_RESERVATION=""
PACKAGE_RESERVATION_OWNED=0
PACKAGE_DIRECTORY_PUBLISHED=0
PUBLICATION_IDENTITY_SHA256=""
WORK_DIR=""

require_no_extended_acl() {
  local path="$1"
  local acl_listing acl_status
  acl_listing="$(/bin/ls -lade "$path")" || {
    echo "Package builder could not inspect extended ACLs on: $path" >&2
    exit 1
  }
  if /usr/bin/printf '%s\n' "$acl_listing" | /usr/bin/awk '
    NR == 1 && length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
    NR > 1 && $1 ~ /^[0-9]+:$/ { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    echo "Package input trust path has an unexpected extended ACL: $path" >&2
    exit 1
  else
    acl_status=$?
    [ "$acl_status" -eq 1 ] || {
      echo "Package builder could not evaluate extended ACLs on: $path" >&2
      exit 1
    }
  fi
}

require_tree_without_extended_acl() {
  local tree="$1"
  local acl_listing acl_status
  require_no_extended_acl "$tree"
  [ -d "$tree" ] || return 0
  acl_listing="$(/bin/ls -laeR "$tree")" || {
    echo "Package builder could not recursively inspect extended ACLs on: $tree" >&2
    exit 1
  }
  if /usr/bin/printf '%s\n' "$acl_listing" | /usr/bin/awk '
    length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
    $1 ~ /^[0-9]+:$/ { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    echo "Package input tree has an unexpected extended ACL: $tree" >&2
    exit 1
  else
    acl_status=$?
    [ "$acl_status" -eq 1 ] || {
      echo "Package builder could not evaluate recursive extended ACLs on: $tree" >&2
      exit 1
    }
  fi
}

require_exact_regular_file_mode() {
  local path="$1"
  local expected_mode="$2"
  local label="$3"
  local mode_match
  [ -f "$path" ] && [ ! -L "$path" ] || {
    echo "$label is missing, linked, or not a regular file: $path" >&2
    exit 1
  }
  mode_match="$(/usr/bin/find "$path" -xdev -type f -links 1 -perm "$expected_mode" -print -quit)" || {
    echo "Package builder could not inspect $label mode and link count: $path" >&2
    exit 1
  }
  [ "$mode_match" = "$path" ] || {
    echo "$label must be singly linked with exact mode $expected_mode: $path" >&2
    exit 1
  }
}

require_exact_binary_architectures() {
  local binary="$1"
  shift
  local actual_architectures actual_architecture expected_architecture
  local actual_count=0 expected_count="$#" matches
  actual_architectures="$(/usr/bin/lipo -archs "$binary")" || {
    echo "Package builder could not read binary architectures: $binary" >&2
    exit 1
  }
  for actual_architecture in $actual_architectures; do
    actual_count=$((actual_count + 1))
    case " $* " in
      *" $actual_architecture "*) ;;
      *) echo "Package input contains unsupported architecture $actual_architecture: $binary" >&2; exit 1 ;;
    esac
  done
  [ "$actual_count" -eq "$expected_count" ] || {
    echo "Package input architecture count does not match release policy: $binary" >&2
    exit 1
  }
  for expected_architecture in "$@"; do
    matches=0
    for actual_architecture in $actual_architectures; do
      [ "$actual_architecture" = "$expected_architecture" ] && matches=$((matches + 1))
    done
    [ "$matches" -eq 1 ] || {
      echo "Package input must contain exactly one $expected_architecture slice: $binary" >&2
      exit 1
    }
  done
}

require_safe_signed_app_bundle_modes() {
  local app="$1"
  local unexpected hardlinked bad_mode directory
  local main="$app/Contents/MacOS/Recordings"
  local companion="$app/Contents/Helpers/recordings"
  local client="$app/Contents/Helpers/recordings-update-client"

  for directory in "$app" "$app/Contents" "$app/Contents/MacOS" "$app/Contents/Helpers"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || {
      echo "Signed app launch ancestry is missing, linked, or not a directory: $directory" >&2
      exit 1
    }
  done
  unexpected="$(/usr/bin/find "$app" -xdev ! -type d ! -type f -print -quit)" || {
    echo "Package builder could not inspect the signed app tree structure." >&2
    exit 1
  }
  [ -z "$unexpected" ] || {
    echo "Signed app tree contains a symbolic link or special file: $unexpected" >&2
    exit 1
  }
  hardlinked="$(/usr/bin/find "$app" -xdev -type f -links +1 -print -quit)" || {
    echo "Package builder could not inspect signed app regular-file link counts." >&2
    exit 1
  }
  [ -z "$hardlinked" ] || {
    echo "Signed app tree contains a multiply-linked regular file: $hardlinked" >&2
    exit 1
  }
  bad_mode="$(/usr/bin/find "$app" -xdev -type d ! -perm 0755 -print -quit)" || {
    echo "Package builder could not inspect signed app directory modes." >&2
    exit 1
  }
  [ -z "$bad_mode" ] || {
    echo "Signed app directory must have exact mode 0755: $bad_mode" >&2
    exit 1
  }
  require_exact_regular_file_mode "$main" 0755 "Signed app main executable"
  require_exact_regular_file_mode "$companion" 0755 "Signed app companion helper"
  require_exact_regular_file_mode "$client" 0755 "Signed app updater client"
  bad_mode="$(/usr/bin/find "$app" -xdev -type f \
    ! -path "$main" \
    ! -path "$companion" \
    ! -path "$client" \
    ! -perm 0644 -print -quit)" || {
    echo "Package builder could not inspect signed app data-file modes." >&2
    exit 1
  }
  [ -z "$bad_mode" ] || {
    echo "Signed app data file must have exact mode 0644: $bad_mode" >&2
    exit 1
  }
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --artifact-basename) ARTIFACT_BASENAME="${2:-}"; shift 2 ;;
    --broker) BROKER="${2:-}"; shift 2 ;;
    --verifier) VERIFIER="${2:-}"; shift 2 ;;
    --public-key) PUBLIC_KEY="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --source-sha) SOURCE_SHA="${2:-}"; shift 2 ;;
    --team-id) EXPECTED_TEAM_ID="${2:-}"; shift 2 ;;
    --installer-identity) INSTALLER_IDENTITY="${2:-}"; shift 2 ;;
    --notary-profile) NOTARY_PROFILE="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --bun-executable) BUN_EXECUTABLE="${2:-}"; shift 2 ;;
    --release-sequence) RELEASE_SEQUENCE="${2:-}"; shift 2 ;;
    --key-epoch) KEY_EPOCH="${2:-}"; shift 2 ;;
    --expires-at-utc) EXPIRES_AT_UTC="${2:-}"; shift 2 ;;
    --publication-identity-sha256) PUBLICATION_IDENTITY_SHA256="${2:-}"; shift 2 ;;
    --envelope-signer) ENVELOPE_SIGNER="${2:-}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --envelope-private-key) ENVELOPE_PRIVATE_KEY="${2:-}"; shift 2 ;;
    --app-archive) APP_ARCHIVE="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --bootstrap-preflight-verifier) BOOTSTRAP_PREFLIGHT_VERIFIER="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$VERSION" in
  ''|*[!0-9A-Za-z._+-]*) echo "Package version is missing or invalid." >&2; exit 2 ;;
esac
[ "$ARTIFACT_BASENAME" = "Recordings-${VERSION}-macos-initial-bootstrap" ] || {
  echo "Initial-bootstrap package artifact basename is missing or mode-incompatible." >&2
  exit 2
}
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Package source SHA must be an exact commit." >&2; exit 2; }
[[ "$EXPECTED_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "Package Team ID must be exact." >&2; exit 2; }
[ -n "$INSTALLER_IDENTITY" ] || { echo "Developer ID Installer identity is required." >&2; exit 2; }
[ -n "$NOTARY_PROFILE" ] || { echo "Notary keychain profile is required." >&2; exit 2; }
[[ "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]] || { echo "Release sequence must be a positive integer." >&2; exit 2; }
[[ "$KEY_EPOCH" =~ ^[1-9][0-9]*$ ]] || { echo "Key epoch must be a positive integer." >&2; exit 2; }
[ -n "$EXPIRES_AT_UTC" ] || { echo "Release-envelope expiry is required." >&2; exit 2; }
[[ "$PUBLICATION_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Package publication identity SHA-256 is missing or invalid." >&2
  exit 2
}
case "$BUN_EXECUTABLE" in /*) ;; *) echo "Bun executable must be an explicit absolute path." >&2; exit 2 ;; esac
[ -f "$BUN_EXECUTABLE" ] && [ -x "$BUN_EXECUTABLE" ] || { echo "Bun executable is missing or unsafe." >&2; exit 1; }
case "$ENVELOPE_SIGNER" in /*) ;; *) echo "Envelope signer must be an absolute executable path." >&2; exit 2 ;; esac
[ -x "$ENVELOPE_SIGNER" ] || { echo "Envelope signer is missing or not executable." >&2; exit 1; }
case "$BOOTSTRAP_PREFLIGHT_VERIFIER" in
  /*) ;;
  *) echo "Bootstrap preflight verifier must be an absolute executable path." >&2; exit 2 ;;
esac
[ -x "$BOOTSTRAP_PREFLIGHT_VERIFIER" ] && [ ! -L "$BOOTSTRAP_PREFLIGHT_VERIFIER" ] || {
  echo "Bootstrap preflight verifier is missing or unsafe." >&2
  exit 1
}
case "$ENVELOPE_PRIVATE_KEY" in /*) ;; *) echo "Envelope private-key path must be absolute." >&2; exit 2 ;; esac
for release_input in "$APP_ARCHIVE" "$MANIFEST" "$ENVELOPE_PRIVATE_KEY"; do
  [ -f "$release_input" ] && [ ! -L "$release_input" ] || { echo "Release input is missing or unsafe." >&2; exit 1; }
  require_no_extended_acl "$release_input"
done
case "$OUTPUT_DIR" in
  /*) ;;
  *) echo "Package output directory must be absolute." >&2; exit 2 ;;
esac
case "$SOURCE_ROOT" in /*) ;; *) echo "Archived source root must be absolute." >&2; exit 2 ;; esac
[ -d "$SOURCE_ROOT" ] && [ ! -L "$SOURCE_ROOT" ] || { echo "Archived source root is missing or unsafe." >&2; exit 1; }
[ ! -e "$SOURCE_ROOT/.git" ] || { echo "Package inputs must come from an archived source tree, not a worktree." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P)"
[ "$SCRIPT_DIR" = "$(cd "$SOURCE_ROOT/packaging/macos" && /bin/pwd -P)" ] || {
  echo "Package builder is not executing from the pinned archived source tree." >&2
  exit 1
}
LAUNCHD_PLIST="$SCRIPT_DIR/Library/LaunchDaemons/com.hasna.recordings.updater.plist"
VERIFIER_SANDBOX="$SCRIPT_DIR/artifact-verifier.sb"
PKG_SCRIPTS="$SCRIPT_DIR/scripts"
PKGUTIL_FINGERPRINT_PARSER="$SCRIPT_DIR/pkgutil_fingerprint.awk"
CLIENT="$APP/Contents/Helpers/recordings-update-client"

for path in "$APP" "$BROKER" "$CLIENT" "$VERIFIER" "$BOOTSTRAP_PREFLIGHT_VERIFIER" "$PUBLIC_KEY" "$LAUNCHD_PLIST" "$VERIFIER_SANDBOX" "$PKG_SCRIPTS/preinstall" "$PKG_SCRIPTS/postinstall" "$PKGUTIL_FINGERPRINT_PARSER"; do
  [ -e "$path" ] || { echo "Package input is missing: $path" >&2; exit 1; }
  [ ! -L "$path" ] || { echo "Package input trust boundary cannot be a symbolic link: $path" >&2; exit 1; }
  require_no_extended_acl "$path"
done
require_tree_without_extended_acl "$APP"
require_safe_signed_app_bundle_modes "$APP"
require_exact_regular_file_mode "$BROKER" 0755 "Signed updater broker"
require_exact_regular_file_mode "$VERIFIER" 0755 "Signed artifact verifier launcher"
require_exact_regular_file_mode "$BOOTSTRAP_PREFLIGHT_VERIFIER" 0755 "Signed bootstrap preflight verifier"
require_exact_binary_architectures "$APP/Contents/MacOS/Recordings" arm64 x86_64
require_exact_binary_architectures "$APP/Contents/Helpers/recordings" arm64 x86_64
require_exact_binary_architectures "$CLIENT" arm64 x86_64
require_exact_binary_architectures "$BROKER" arm64 x86_64
require_exact_binary_architectures "$BOOTSTRAP_PREFLIGHT_VERIFIER" arm64 x86_64
require_exact_binary_architectures "$VERIFIER" arm64 x86_64
[ "$(/usr/bin/stat -f '%z' "$PUBLIC_KEY")" = "32" ] || { echo "Ed25519 public key must be exactly 32 raw bytes." >&2; exit 1; }
[ "$(/usr/bin/stat -f '%z' "$ENVELOPE_PRIVATE_KEY")" = "32" ] || { echo "Ed25519 private key must be exactly 32 raw bytes." >&2; exit 1; }
[ "$(/usr/bin/stat -f '%u' "$ENVELOPE_PRIVATE_KEY")" = "$(/usr/bin/id -u)" ] && \
  [ $((8#$(/usr/bin/stat -f '%Lp' "$ENVELOPE_PRIVATE_KEY") & 8#077)) -eq 0 ] || {
  echo "Envelope private key must be owner-only and owned by the isolated builder." >&2
  exit 1
}

ATTESTATION="/Library/Application Support/Hasna/Recordings/BuildTrust/isolated-builder-v1"
TRUSTED_BUILD_ROOT="/private/var/recordings-build"
CURRENT_UID="$(/usr/bin/id -u)"
[ "$(/usr/bin/id -un)" = "_recordingsbuild" ] || {
  echo "Release PKGs may only be assembled by the isolated _recordingsbuild identity." >&2
  exit 1
}
for trusted_path in "$ATTESTATION" "$TRUSTED_BUILD_ROOT"; do
  [ -e "$trusted_path" ] && [ ! -L "$trusted_path" ] || {
    echo "Managed isolated-builder trust path is missing or unsafe: $trusted_path" >&2
    exit 1
  }
  require_no_extended_acl "$trusted_path"
done
[ -f "$ATTESTATION" ] && [ "$(/usr/bin/stat -f '%u' "$ATTESTATION")" = "0" ] || {
  echo "Isolated-builder attestation is not a root-owned regular file." >&2
  exit 1
}
case "$(/usr/bin/stat -f '%Lp' "$ATTESTATION")" in 400|440|444) ;; *) echo "Isolated-builder attestation mode is unsafe." >&2; exit 1 ;; esac
[ "$(/bin/cat "$ATTESTATION")" = "recordings-isolated-builder-v1" ] || {
  echo "Isolated-builder attestation content is invalid." >&2
  exit 1
}
[ -d "$TRUSTED_BUILD_ROOT" ] && [ "$(/usr/bin/stat -f '%u' "$TRUSTED_BUILD_ROOT")" = "$CURRENT_UID" ] && \
  [ "$(/usr/bin/stat -f '%Lp' "$TRUSTED_BUILD_ROOT")" = "700" ] || {
  echo "Managed release build root must be owned by _recordingsbuild with mode 0700." >&2
  exit 1
}
TRUSTED_BUILD_PARENT="$(/usr/bin/dirname "$TRUSTED_BUILD_ROOT")"
[ "$(/usr/bin/stat -f '%u' "$TRUSTED_BUILD_PARENT")" = "0" ] || {
  echo "Managed release build parent must be root-owned." >&2
  exit 1
}
require_no_extended_acl "$TRUSTED_BUILD_PARENT"
case "$(/usr/bin/stat -f '%Lp' "$TRUSTED_BUILD_PARENT")" in
  *[2367][0-9]|*[0-9][2367]) echo "Managed release build parent is group/other writable." >&2; exit 1 ;;
esac

case "$OUTPUT_DIR" in
  "$TRUSTED_BUILD_ROOT"/*) ;;
  *) echo "Package output directory must remain inside the managed release build root." >&2; exit 1 ;;
esac
[ "$(cd "$OUTPUT_DIR" && /bin/pwd -P)" = "$OUTPUT_DIR" ] || {
  echo "Package output directory must be canonical and contain no linked ancestor." >&2
  exit 1
}
[ -d "$OUTPUT_DIR" ] && [ ! -L "$OUTPUT_DIR" ] && \
  [ "$(/usr/bin/stat -f '%u' "$OUTPUT_DIR")" = "$CURRENT_UID" ] && \
  [ "$(/usr/bin/stat -f '%Lp' "$OUTPUT_DIR")" = "700" ] || {
  echo "Package output directory must be an existing isolated-builder-owned 0700 directory." >&2
  exit 1
}
require_no_extended_acl "$OUTPUT_DIR"
output_relative="${OUTPUT_DIR#"$TRUSTED_BUILD_ROOT"/}"
output_ancestor="$TRUSTED_BUILD_ROOT"
IFS='/' read -r -a output_components <<<"$output_relative"
for output_component in "${output_components[@]}"; do
  output_ancestor="$output_ancestor/$output_component"
  [ -d "$output_ancestor" ] && [ ! -L "$output_ancestor" ] && \
    [ "$(/usr/bin/stat -f '%u' "$output_ancestor")" = "$CURRENT_UID" ] && \
    [ "$(/usr/bin/stat -f '%Lp' "$output_ancestor")" = "700" ] || {
    echo "Package output ancestry must remain isolated-builder-owned mode 0700: $output_ancestor" >&2
    exit 1
  }
  require_no_extended_acl "$output_ancestor"
done

WORK_DIR="$(/usr/bin/mktemp -d "$TRUSTED_BUILD_ROOT/recordings-release-pkg.XXXXXX")"
/bin/chmod -N "$WORK_DIR"
/bin/chmod 0700 "$WORK_DIR"
require_no_extended_acl "$WORK_DIR"
cleanup() {
  local status=$?
  trap - EXIT
  /bin/rm -rf "$WORK_DIR"
  if [ "$PACKAGE_DIRECTORY_PUBLISHED" -eq 0 ] && [ -n "$PACKAGE_STAGE_DIR" ]; then
    /bin/rm -rf "$PACKAGE_STAGE_DIR"
  fi
  if [ "$PACKAGE_RESERVATION_OWNED" -eq 1 ] && \
     [ ! -e "$PACKAGE_FINAL_DIR" ] && [ ! -L "$PACKAGE_FINAL_DIR" ]; then
    /bin/rm -f "$PACKAGE_RESERVATION/.recordings-publication.json" 2>/dev/null || true
    /bin/rmdir "$PACKAGE_RESERVATION" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{ print $1 }'
}

verify_developer_id_application() {
  local code_path="$1"
  local expected_identifier="${2:-}"
  local details authority team identifier timestamp
  /usr/bin/codesign --verify --strict --all-architectures --verbose=2 "$code_path"
  details="$(/usr/bin/codesign -d --verbose=4 "$code_path" 2>&1)"
  authority="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Authority=/ { print $2; exit }')"
  team="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  identifier="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Identifier=/ { print $2; exit }')"
  timestamp="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Timestamp=/ { print $2; exit }')"
  [[ "$authority" == "Developer ID Application:"* ]] || { echo "$code_path is not Developer ID Application signed." >&2; exit 1; }
  [ "$team" = "$EXPECTED_TEAM_ID" ] || { echo "$code_path has the wrong TeamIdentifier." >&2; exit 1; }
  [ -z "$expected_identifier" ] || [ "$identifier" = "$expected_identifier" ] || {
    echo "$code_path has the wrong signing identifier." >&2
    exit 1
  }
  case "$timestamp" in ''|none|None|NONE) echo "$code_path has no trusted timestamp." >&2; exit 1 ;; esac
  [[ "$details" == *"flags="*"runtime"* ]] || { echo "$code_path lacks hardened runtime." >&2; exit 1; }
}

verify_developer_id_application "$BROKER" "com.hasna.recordings.updater"
verify_developer_id_application "$CLIENT" "com.hasna.recordings.update-client"
verify_developer_id_application "$VERIFIER" "com.hasna.recordings.artifact-verifier"
verify_developer_id_application "$BOOTSTRAP_PREFLIGHT_VERIFIER" "com.hasna.recordings.bootstrap-preflight"
/usr/bin/codesign --verify --deep --strict --all-architectures --verbose=2 "$APP"

PUBLIC_KEY_SNAPSHOT="$WORK_DIR/release-envelope-public.raw"
PUBLIC_KEY_DIGEST="$("$VERIFIER" snapshot-regular-file \
  --source "$PUBLIC_KEY" \
  --destination "$PUBLIC_KEY_SNAPSHOT" \
  --maximum-bytes 32 \
  --expected-bytes 32)"
PUBLIC_KEY="$PUBLIC_KEY_SNAPSHOT"

COMPUTED_PUBLICATION_IDENTITY_SHA256="$("$VERIFIER" release-publication-identity \
  --component "release_kind=initial-bootstrap-updater" \
  --component "source_sha=$SOURCE_SHA" \
  --component "version=$VERSION" \
  --component "team_id=$EXPECTED_TEAM_ID" \
  --component "installer_identity=$INSTALLER_IDENTITY" \
  --component "notary_profile=$NOTARY_PROFILE" \
  --component "release_sequence=$RELEASE_SEQUENCE" \
  --component "key_epoch=$KEY_EPOCH" \
  --component "expires_at_utc=$EXPIRES_AT_UTC" \
  --component "app_archive_sha256=$(sha256_file "$APP_ARCHIVE")" \
  --component "manifest_sha256=$(sha256_file "$MANIFEST")" \
  --component "broker_sha256=$(sha256_file "$BROKER")" \
  --component "artifact_verifier_sha256=$(sha256_file "$VERIFIER")" \
  --component "bootstrap_preflight_sha256=$(sha256_file "$BOOTSTRAP_PREFLIGHT_VERIFIER")" \
  --component "envelope_public_key_sha256=$(sha256_file "$PUBLIC_KEY")" \
  --component "envelope_signer_sha256=$(sha256_file "$ENVELOPE_SIGNER")")"
[ "$COMPUTED_PUBLICATION_IDENTITY_SHA256" = "$PUBLICATION_IDENTITY_SHA256" ] || {
  echo "Package publication identity does not match the exact release inputs." >&2
  exit 1
}

PACKAGE_SET_BASENAME="${ARTIFACT_BASENAME}-updater"
PKG_LEAF="${PACKAGE_SET_BASENAME}.pkg"
NOTARY_SUBMISSION_LEAF="${PACKAGE_SET_BASENAME}.notary-submit.json"
NOTARY_LOG_LEAF="${PACKAGE_SET_BASENAME}.notary-log.json"
PKG_SHA256_LEAF="${PACKAGE_SET_BASENAME}.pkg.sha256"
BOOTSTRAP_ENVELOPE_LEAF="${PACKAGE_SET_BASENAME}.bootstrap-envelope.json"
COMPATIBLE_COHORT_LEAF="${PACKAGE_SET_BASENAME}.compatible-cohort.json"
COMPATIBLE_COHORT_SHA256_LEAF="${COMPATIBLE_COHORT_LEAF}.sha256"
PACKAGE_FINAL_DIR="$OUTPUT_DIR/${PACKAGE_SET_BASENAME}.release"
PACKAGE_RESERVATION="$OUTPUT_DIR/.${PACKAGE_SET_BASENAME}.reservation"

if [ -e "$PACKAGE_FINAL_DIR" ] || [ -L "$PACKAGE_FINAL_DIR" ]; then
  "$VERIFIER" complete-release-publication \
    --destination "$PACKAGE_FINAL_DIR" \
    --reservation "$PACKAGE_RESERVATION" \
    --output-root "$OUTPUT_DIR" \
    --publication-identity-sha256 "$PUBLICATION_IDENTITY_SHA256"
  "$VERIFIER" assert-release-publication-complete \
    --destination "$PACKAGE_FINAL_DIR" \
    --output-root "$OUTPUT_DIR" \
    --publication-identity-sha256 "$PUBLICATION_IDENTITY_SHA256"
  printf 'Recovered authenticated same-version updater publication: %s\n' "$PACKAGE_FINAL_DIR"
  exit 0
fi

for reserved_output in \
  "$PACKAGE_FINAL_DIR" \
  "$OUTPUT_DIR/$PKG_LEAF" \
  "$OUTPUT_DIR/$NOTARY_SUBMISSION_LEAF" \
  "$OUTPUT_DIR/$NOTARY_LOG_LEAF" \
  "$OUTPUT_DIR/$PKG_SHA256_LEAF" \
  "$OUTPUT_DIR/$BOOTSTRAP_ENVELOPE_LEAF" \
  "$OUTPUT_DIR/$COMPATIBLE_COHORT_LEAF" \
  "$OUTPUT_DIR/$COMPATIBLE_COHORT_SHA256_LEAF"; do
  [ ! -e "$reserved_output" ] && [ ! -L "$reserved_output" ] || {
    echo "Package release output already exists; same-version publication is immutable: $reserved_output" >&2
    exit 1
  }
done
if ! /bin/mkdir -m 0700 "$PACKAGE_RESERVATION"; then
  echo "Package release output is already reserved by another or interrupted builder." >&2
  exit 1
fi
PACKAGE_RESERVATION_OWNED=1
require_no_extended_acl "$PACKAGE_RESERVATION"

# Recheck after taking the exclusive reservation so a builder that completed
# between the initial probe and mkdir cannot be replaced.
for reserved_output in \
  "$PACKAGE_FINAL_DIR" \
  "$OUTPUT_DIR/$PKG_LEAF" \
  "$OUTPUT_DIR/$NOTARY_SUBMISSION_LEAF" \
  "$OUTPUT_DIR/$NOTARY_LOG_LEAF" \
  "$OUTPUT_DIR/$PKG_SHA256_LEAF" \
  "$OUTPUT_DIR/$BOOTSTRAP_ENVELOPE_LEAF" \
  "$OUTPUT_DIR/$COMPATIBLE_COHORT_LEAF" \
  "$OUTPUT_DIR/$COMPATIBLE_COHORT_SHA256_LEAF"; do
  [ ! -e "$reserved_output" ] && [ ! -L "$reserved_output" ] || {
    echo "Package release output appeared while acquiring its reservation." >&2
    exit 1
  }
done
PACKAGE_STAGE_DIR="$(/usr/bin/mktemp -d "$OUTPUT_DIR/.${PACKAGE_SET_BASENAME}.staging.XXXXXX")"
/bin/chmod -N "$PACKAGE_STAGE_DIR"
/bin/chmod 0700 "$PACKAGE_STAGE_DIR"
require_no_extended_acl "$PACKAGE_STAGE_DIR"

ROOT="$WORK_DIR/root"
SCRIPTS="$WORK_DIR/scripts"
PACKAGE_BOOTSTRAP_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
[[ "$PACKAGE_BOOTSTRAP_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "Package builder could not create a valid bootstrap identity." >&2
  exit 1
}
/bin/mkdir -p \
  "$ROOT/Applications" \
  "$ROOT/Library/PrivilegedHelperTools" \
  "$ROOT/Library/LaunchDaemons" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Trust/envelope-keys" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap" \
  "$SCRIPTS"
require_no_extended_acl "$PACKAGE_STAGE_DIR"

/usr/bin/ditto "$APP" "$ROOT/Applications/Recordings.app"
/bin/cp "$BROKER" "$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.updater"
/bin/cp "$VERIFIER" "$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
/bin/cp "$PUBLIC_KEY" "$ROOT/Library/Application Support/Hasna/Recordings/Trust/envelope-keys/${KEY_EPOCH}.raw"
/bin/cp "$LAUNCHD_PLIST" "$ROOT/Library/LaunchDaemons/com.hasna.recordings.updater.plist"
/bin/cp "$VERIFIER_SANDBOX" "$ROOT/Library/Application Support/Hasna/Recordings/Trust/artifact-verifier.sb"
for package_script_name in preinstall postinstall; do
  package_script_source="$PKG_SCRIPTS/$package_script_name"
  package_script_target="$SCRIPTS/$package_script_name"
  [ "$(/usr/bin/grep -c '__RECORDINGS_PACKAGE_BOOTSTRAP_ID__' "$package_script_source")" = "1" ] || {
    echo "Package $package_script_name must contain exactly one bootstrap-identity placeholder." >&2
    exit 1
  }
  /usr/bin/sed "s/__RECORDINGS_PACKAGE_BOOTSTRAP_ID__/$PACKAGE_BOOTSTRAP_ID/" \
    "$package_script_source" >"$package_script_target"
  ! /usr/bin/grep -F '__RECORDINGS_PACKAGE_BOOTSTRAP_ID__' "$package_script_target" >/dev/null || {
    echo "Package $package_script_name retained an unresolved bootstrap identity." >&2
    exit 1
  }
  /usr/bin/grep -F "PACKAGE_BOOTSTRAP_ID=\"$PACKAGE_BOOTSTRAP_ID\"" \
    "$package_script_target" >/dev/null || {
    echo "Package $package_script_name did not bind the generated bootstrap identity." >&2
    exit 1
  }
done
/bin/cp "$BOOTSTRAP_PREFLIGHT_VERIFIER" "$SCRIPTS/recordings-bootstrap-preflight"
/usr/bin/printf '%s\n' "$RELEASE_SEQUENCE" >"$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/release-sequence"
/usr/bin/printf '%s\n' "$KEY_EPOCH" >"$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/key-epoch"
/usr/bin/printf '%s\n' "$SOURCE_SHA" >"$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/source-sha"
/usr/bin/printf '{"schema_version":1,"signing_team_identifier":"%s","allowed_client_identifiers":["com.hasna.recordings.update-client"],"application_identifier":"com.hasna.recordings","initial_key_epoch":%s,"allowed_key_epochs":[%s],"lifecycle":"bootstrap-v1-app-updates-only","root_maintenance_supported":false,"key_rotation_supported":false}\n' \
  "$EXPECTED_TEAM_ID" "$KEY_EPOCH" "$KEY_EPOCH" \
  >"$ROOT/Library/Application Support/Hasna/Recordings/Trust/broker-policy.json"
/bin/chmod -RN "$ROOT" "$SCRIPTS"
require_tree_without_extended_acl "$ROOT"
require_tree_without_extended_acl "$SCRIPTS"
/bin/chmod 0555 \
  "$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.updater" \
  "$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier" \
  "$SCRIPTS/preinstall" "$SCRIPTS/postinstall" "$SCRIPTS/recordings-bootstrap-preflight"
/bin/chmod 0444 \
  "$ROOT/Library/Application Support/Hasna/Recordings/Trust/envelope-keys/${KEY_EPOCH}.raw" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Trust/broker-policy.json" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Trust/artifact-verifier.sb" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/release-sequence" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/key-epoch" \
  "$ROOT/Library/Application Support/Hasna/Recordings/Bootstrap/source-sha" \
  "$ROOT/Library/LaunchDaemons/com.hasna.recordings.updater.plist"
/usr/bin/plutil -lint "$ROOT/Library/LaunchDaemons/com.hasna.recordings.updater.plist" >/dev/null

STAGED_APP="$ROOT/Applications/Recordings.app"
STAGED_BROKER="$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.updater"
STAGED_CLIENT="$STAGED_APP/Contents/Helpers/recordings-update-client"
STAGED_VERIFIER="$ROOT/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
STAGED_BOOTSTRAP_PREFLIGHT="$SCRIPTS/recordings-bootstrap-preflight"
require_safe_signed_app_bundle_modes "$STAGED_APP"
require_exact_regular_file_mode "$STAGED_BROKER" 0555 "Staged updater broker"
require_exact_regular_file_mode "$STAGED_VERIFIER" 0555 "Staged artifact verifier launcher"
require_exact_regular_file_mode "$STAGED_BOOTSTRAP_PREFLIGHT" 0555 "Staged bootstrap preflight verifier"
require_exact_binary_architectures "$STAGED_APP/Contents/MacOS/Recordings" arm64 x86_64
require_exact_binary_architectures "$STAGED_APP/Contents/Helpers/recordings" arm64 x86_64
require_exact_binary_architectures "$STAGED_CLIENT" arm64 x86_64
require_exact_binary_architectures "$STAGED_BROKER" arm64 x86_64
require_exact_binary_architectures "$STAGED_BOOTSTRAP_PREFLIGHT" arm64 x86_64
require_exact_binary_architectures "$STAGED_VERIFIER" arm64 x86_64
verify_developer_id_application "$STAGED_BROKER" "com.hasna.recordings.updater"
verify_developer_id_application "$STAGED_CLIENT" "com.hasna.recordings.update-client"
verify_developer_id_application "$STAGED_VERIFIER" "com.hasna.recordings.artifact-verifier"
verify_developer_id_application "$STAGED_BOOTSTRAP_PREFLIGHT" "com.hasna.recordings.bootstrap-preflight"
/usr/bin/codesign --verify --deep --strict --all-architectures --verbose=2 "$STAGED_APP"
PROVENANCE="$STAGED_APP/Contents/Resources/recordings-build-provenance.json"
[ -f "$PROVENANCE" ] && [ ! -L "$PROVENANCE" ] || { echo "Signed app provenance is missing." >&2; exit 1; }
[ "$(/usr/bin/plutil -extract git_sha raw -o - "$PROVENANCE")" = "$SOURCE_SHA" ] || {
  echo "Signed app provenance does not bind the package source commit." >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract team_id raw -o - "$PROVENANCE")" = "$EXPECTED_TEAM_ID" ] || {
  echo "Signed app provenance does not bind the package TeamIdentifier." >&2
  exit 1
}
RELEASE_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
STAGED_CLIENT_SHA256="$(/usr/bin/shasum -a 256 "$STAGED_CLIENT" | /usr/bin/awk '{ print $1 }')"
STAGED_BROKER_SHA256="$(/usr/bin/shasum -a 256 "$STAGED_BROKER" | /usr/bin/awk '{ print $1 }')"
STAGED_VERIFIER_SHA256="$(/usr/bin/shasum -a 256 "$STAGED_VERIFIER" | /usr/bin/awk '{ print $1 }')"
STAGED_APP_TREE_SHA256="$(/usr/bin/plutil -extract binding.bundle_tree_sha256 raw -o - "$MANIFEST")"
ACTUAL_STAGED_APP_TREE_SHA256="$("$STAGED_VERIFIER" tree-digest --path "$STAGED_APP")"
[ "$ACTUAL_STAGED_APP_TREE_SHA256" = "$STAGED_APP_TREE_SHA256" ] || {
  echo "Staged PKG application tree does not match the finalized manifest binding." >&2
  exit 1
}
BOOTSTRAP_MARKER="$ROOT/Library/Application Support/Hasna/Recordings/Trust/bootstrap-marker.json"
/usr/bin/printf '{"schema_version":1,"key_epoch":%s,"release_sequence":%s,"release_id":"%s","version":"%s","source_commit":"%s","signing_team_identifier":"%s","app_tree_sha256":"%s","update_client_sha256":"%s","update_broker_sha256":"%s","artifact_verifier_sha256":"%s","lifecycle":"bootstrap-v1-app-updates-only","root_maintenance_supported":false,"key_rotation_supported":false}\n' \
  "$KEY_EPOCH" "$RELEASE_SEQUENCE" "$RELEASE_ID" "$VERSION" "$SOURCE_SHA" "$EXPECTED_TEAM_ID" \
  "$STAGED_APP_TREE_SHA256" "$STAGED_CLIENT_SHA256" "$STAGED_BROKER_SHA256" "$STAGED_VERIFIER_SHA256" \
  >"$BOOTSTRAP_MARKER"
/bin/chmod 0444 "$BOOTSTRAP_MARKER"
/usr/bin/plutil -lint "$BOOTSTRAP_MARKER" >/dev/null
BOOTSTRAP_MARKER_SHA256="$(/usr/bin/shasum -a 256 "$BOOTSTRAP_MARKER" | /usr/bin/awk '{ print $1 }')"

PKG="$PACKAGE_STAGE_DIR/$PKG_LEAF"
NOTARY_SUBMISSION="$PACKAGE_STAGE_DIR/$NOTARY_SUBMISSION_LEAF"
NOTARY_LOG="$PACKAGE_STAGE_DIR/$NOTARY_LOG_LEAF"
PKG_SHA256="$PACKAGE_STAGE_DIR/$PKG_SHA256_LEAF"
ENVELOPE_PAYLOAD="$WORK_DIR/bootstrap-envelope-payload.json"
BOOTSTRAP_ENVELOPE="$PACKAGE_STAGE_DIR/$BOOTSTRAP_ENVELOPE_LEAF"
COMPATIBLE_COHORT="$PACKAGE_STAGE_DIR/$COMPATIBLE_COHORT_LEAF"
COMPATIBLE_COHORT_SHA256="$PACKAGE_STAGE_DIR/$COMPATIBLE_COHORT_SHA256_LEAF"

require_tree_without_extended_acl "$ROOT"
require_tree_without_extended_acl "$SCRIPTS"
require_no_extended_acl "$PACKAGE_STAGE_DIR"
/usr/bin/pkgbuild \
  --root "$ROOT" \
  --scripts "$SCRIPTS" \
  --identifier com.hasna.recordings.updater \
  --version "$VERSION" \
  --install-location / \
  --ownership recommended \
  --timestamp \
  --sign "$INSTALLER_IDENTITY" \
  "$PKG"

verify_pkg_signature() {
  local signature_output
  signature_output="$(/usr/sbin/pkgutil --check-signature "$PKG")"
  /usr/bin/grep -F "Status: signed by a certificate trusted by macOS" <<<"$signature_output" >/dev/null || \
    /usr/bin/grep -F "Status: signed by a certificate trusted by Mac OS X" <<<"$signature_output" >/dev/null
  /usr/bin/grep -E "^[[:space:]]*1\\. Developer ID Installer: .+ \\(${EXPECTED_TEAM_ID}\\)$" <<<"$signature_output" >/dev/null
}
verify_pkg_signature
SUBMITTED_PKG_SHA256="$(sha256_file "$PKG")"
/usr/bin/xcrun notarytool submit "$PKG" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait --output-format json >"$NOTARY_SUBMISSION"
[ "$(/usr/bin/plutil -extract status raw -o - "$NOTARY_SUBMISSION")" = "Accepted" ] || {
  echo "Updater PKG notarization was not accepted." >&2
  exit 1
}
NOTARY_ID="$(/usr/bin/plutil -extract id raw -o - "$NOTARY_SUBMISSION")"
[ -n "$NOTARY_ID" ] || { echo "Updater PKG notarization omitted its submission ID." >&2; exit 1; }
/usr/bin/xcrun notarytool log "$NOTARY_ID" --keychain-profile "$NOTARY_PROFILE" >"$NOTARY_LOG"
"$STAGED_VERIFIER" assert-notary-log \
  --notary-log "$NOTARY_LOG" \
  --submission-id "$NOTARY_ID" \
  --submitted-archive-sha256 "$SUBMITTED_PKG_SHA256" || {
    echo "Updater PKG notarization log is not accepted, issue-free, or byte-bound." >&2
    exit 1
  }
NOTARY_ARCHIVE_SHA256="$SUBMITTED_PKG_SHA256"
/usr/bin/xcrun stapler staple "$PKG"
/usr/bin/xcrun stapler validate "$PKG"
/usr/sbin/spctl --assess --type install --verbose=2 "$PKG"
verify_pkg_signature
PKG_PUBLISHED_SHA256="$(sha256_file "$PKG")"
/usr/bin/printf '%s  %s\n' "$PKG_PUBLISHED_SHA256" "$PKG_LEAF" >"$PKG_SHA256"

designated_requirement() {
  local requirement
  requirement="$(/usr/bin/codesign -d -r- "$1" 2>&1 | /usr/bin/sed -n 's/^designated => //p' | /usr/bin/head -n 1)"
  [ -n "$requirement" ] || { echo "Signed component is missing its designated requirement." >&2; exit 1; }
  printf '%s\n' "$requirement"
}

APP_ARCHIVE_SHA256="$(sha256_file "$APP_ARCHIVE")"
MANIFEST_SHA256="$(sha256_file "$MANIFEST")"
PKG_DIGEST="$(sha256_file "$PKG")"
CLIENT_DIGEST="$(sha256_file "$STAGED_CLIENT")"
BROKER_DIGEST="$(sha256_file "$STAGED_BROKER")"
VERIFIER_DIGEST="$(sha256_file "$STAGED_VERIFIER")"
PUBLIC_KEY_DIGEST="$(sha256_file "$PUBLIC_KEY")"
APP_REQUIREMENT="$(designated_requirement "$STAGED_APP")"
CLIENT_REQUIREMENT="$(designated_requirement "$STAGED_CLIENT")"
BROKER_REQUIREMENT="$(designated_requirement "$STAGED_BROKER")"
VERIFIER_REQUIREMENT="$(designated_requirement "$STAGED_VERIFIER")"
[ "$(/usr/bin/plutil -extract archive.sha256 raw -o - "$MANIFEST")" = "$APP_ARCHIVE_SHA256" ] || {
  echo "Final app manifest does not bind the release archive." >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract git_sha raw -o - "$MANIFEST")" = "$SOURCE_SHA" ] || {
  echo "Final app manifest does not bind the source commit." >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract team_id raw -o - "$MANIFEST")" = "$EXPECTED_TEAM_ID" ] || {
  echo "Final app manifest does not bind the TeamIdentifier." >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract bundle_version raw -o - "$MANIFEST")" = "$VERSION" ] || {
  echo "Final app manifest does not bind the package version." >&2
  exit 1
}
MANIFEST_ARCHITECTURES="$(/usr/bin/plutil -extract architectures json -o - "$MANIFEST" | /usr/bin/tr -d '[:space:]')"
[ "$MANIFEST_ARCHITECTURES" = '["arm64","x86_64"]' ] || {
  echo "Release app manifest must bind exactly arm64 and x86_64." >&2
  exit 1
}

PKG_SIGNATURE_OUTPUT="$(/usr/sbin/pkgutil --check-signature "$PKG")"
INSTALLER_CERTIFICATE_SHA256="$(printf '%s\n' "$PKG_SIGNATURE_OUTPUT" | \
  /usr/bin/awk -f "$PKGUTIL_FINGERPRINT_PARSER")" || {
  echo "Could not parse the Developer ID Installer certificate fingerprint." >&2
  exit 1
}
[[ "$INSTALLER_CERTIFICATE_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Could not bind the Developer ID Installer certificate fingerprint." >&2
  exit 1
}

"$BUN_EXECUTABLE" "$SOURCE_ROOT/packaging/macos/release_lifecycle.ts" write-compatible-cohort \
  --artifact-verifier-designated-requirement "$VERIFIER_REQUIREMENT" \
  --artifact-verifier-sha256 "$VERIFIER_DIGEST" \
  --bootstrap-marker-sha256 "$BOOTSTRAP_MARKER_SHA256" \
  --envelope-public-key-sha256 "$PUBLIC_KEY_DIGEST" \
  --installer-certificate-sha256 "$INSTALLER_CERTIFICATE_SHA256" \
  --key-epoch "$KEY_EPOCH" \
  --minimum-broker-version 1.0.0 \
  --output "$COMPATIBLE_COHORT" \
  --package-sha256 "$PKG_DIGEST" \
  --team-id "$EXPECTED_TEAM_ID" \
  --update-broker-designated-requirement "$BROKER_REQUIREMENT" \
  --update-broker-sha256 "$BROKER_DIGEST"
[ -f "$COMPATIBLE_COHORT" ] && [ ! -L "$COMPATIBLE_COHORT" ] && [ -s "$COMPATIBLE_COHORT" ] || {
  echo "Compatible-cohort helper did not emit a schema-v2 manifest." >&2
  exit 1
}
COMPATIBLE_COHORT_DIGEST="$(sha256_file "$COMPATIBLE_COHORT")"
/usr/bin/printf '%s  %s\n' "$COMPATIBLE_COHORT_DIGEST" "$COMPATIBLE_COHORT_LEAF" \
  >"$COMPATIBLE_COHORT_SHA256"

ISSUED_AT_UTC="$(/bin/date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
/usr/bin/plutil -create json "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert purpose -string bootstrap "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert schema_version -integer 1 "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert key_epoch -integer "$KEY_EPOCH" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert release_sequence -integer "$RELEASE_SEQUENCE" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert release_id -string "$RELEASE_ID" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert version -string "$VERSION" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert build -string "$(/usr/bin/plutil -extract bundle_build_version raw -o - "$MANIFEST")" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert source_commit -string "$SOURCE_SHA" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert artifact_sha256 -string "$PKG_DIGEST" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert artifact_byte_count -integer "$(/usr/bin/stat -f '%z' "$PKG")" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert manifest_sha256 -string "$MANIFEST_SHA256" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert manifest_byte_count -integer "$(/usr/bin/stat -f '%z' "$MANIFEST")" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert candidate_tree_sha256 -string "$STAGED_APP_TREE_SHA256" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert package_sha256 -string "$PKG_DIGEST" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert bootstrap_marker_sha256 -string "$BOOTSTRAP_MARKER_SHA256" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert update_client_sha256 -string "$CLIENT_DIGEST" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert update_broker_sha256 -string "$BROKER_DIGEST" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert artifact_verifier_sha256 -string "$VERIFIER_DIGEST" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert architectures -json '["arm64","x86_64"]' "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert minimum_os_version -string "$(/usr/bin/plutil -extract minimum_macos raw -o - "$MANIFEST")" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert minimum_broker_version -string 1.0.0 "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert signing_team_identifier -string "$EXPECTED_TEAM_ID" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert application_designated_requirement -string "$APP_REQUIREMENT" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert update_client_designated_requirement -string "$CLIENT_REQUIREMENT" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert update_broker_designated_requirement -string "$BROKER_REQUIREMENT" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert artifact_verifier_designated_requirement -string "$VERIFIER_REQUIREMENT" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert installer_certificate_sha256 -string "$INSTALLER_CERTIFICATE_SHA256" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert issued_at_utc -string "$ISSUED_AT_UTC" "$ENVELOPE_PAYLOAD"
/usr/bin/plutil -insert expires_at_utc -string "$EXPIRES_AT_UTC" "$ENVELOPE_PAYLOAD"

"$ENVELOPE_SIGNER" \
  --payload "$ENVELOPE_PAYLOAD" \
  --private-key "$ENVELOPE_PRIVATE_KEY" \
  --public-key "$PUBLIC_KEY" \
  --output "$BOOTSTRAP_ENVELOPE"
[ -s "$BOOTSTRAP_ENVELOPE" ] || { echo "Envelope signer did not emit a bootstrap sidecar." >&2; exit 1; }

verify_package_release_set() {
  local output
  for output in \
    "$PKG" \
    "$NOTARY_SUBMISSION" \
    "$NOTARY_LOG" \
    "$PKG_SHA256" \
    "$BOOTSTRAP_ENVELOPE" \
    "$COMPATIBLE_COHORT" \
    "$COMPATIBLE_COHORT_SHA256"; do
    [ -f "$output" ] && [ ! -L "$output" ] && [ -s "$output" ] || {
      echo "Package release staging is incomplete or unsafe: $output" >&2
      exit 1
    }
    require_no_extended_acl "$output"
    /bin/chmod 0444 "$output"
  done
  [ "$(/usr/bin/awk 'NR == 1 { print $1 }' "$PKG_SHA256")" = "$(sha256_file "$PKG")" ] || {
    echo "Published package digest does not match the finalized PKG bytes." >&2
    exit 1
  }
  [ "$(/usr/bin/awk 'NR == 1 { print $2 }' "$PKG_SHA256")" = "$PKG_LEAF" ] || {
    echo "Published package digest names the wrong PKG artifact." >&2
    exit 1
  }
  [ "$(/usr/bin/awk 'NR == 1 { print $1 }' "$COMPATIBLE_COHORT_SHA256")" = "$(sha256_file "$COMPATIBLE_COHORT")" ] || {
    echo "Published compatible-cohort digest does not match the schema-v2 manifest." >&2
    exit 1
  }
  [ "$(/usr/bin/awk 'NR == 1 { print $2 }' "$COMPATIBLE_COHORT_SHA256")" = "$COMPATIBLE_COHORT_LEAF" ] || {
    echo "Published compatible-cohort digest names the wrong manifest." >&2
    exit 1
  }
}

verify_package_release_set
require_no_extended_acl "$PACKAGE_STAGE_DIR"
[ ! -e "$PACKAGE_FINAL_DIR" ] && [ ! -L "$PACKAGE_FINAL_DIR" ] || {
  echo "Package release destination appeared before publication." >&2
  exit 1
}
"$STAGED_VERIFIER" prepare-release-publication \
  --staging "$PACKAGE_STAGE_DIR" \
  --destination "$PACKAGE_FINAL_DIR" \
  --reservation "$PACKAGE_RESERVATION" \
  --publication-identity-sha256 "$PUBLICATION_IDENTITY_SHA256" \
  --alias "$PKG_LEAF" \
  --alias "$NOTARY_SUBMISSION_LEAF" \
  --alias "$NOTARY_LOG_LEAF" \
  --alias "$PKG_SHA256_LEAF" \
  --alias "$BOOTSTRAP_ENVELOPE_LEAF" \
  --alias "$COMPATIBLE_COHORT_LEAF" \
  --alias "$COMPATIBLE_COHORT_SHA256_LEAF"
"$STAGED_VERIFIER" publish-release-directory \
  --staging "$PACKAGE_STAGE_DIR" \
  --destination "$PACKAGE_FINAL_DIR"
PACKAGE_DIRECTORY_PUBLISHED=1
PACKAGE_STAGE_DIR=""
"$STAGED_VERIFIER" complete-release-publication \
  --destination "$PACKAGE_FINAL_DIR" \
  --reservation "$PACKAGE_RESERVATION" \
  --output-root "$OUTPUT_DIR" \
  --publication-identity-sha256 "$PUBLICATION_IDENTITY_SHA256"
"$STAGED_VERIFIER" assert-release-publication-complete \
  --destination "$PACKAGE_FINAL_DIR" \
  --output-root "$OUTPUT_DIR" \
  --publication-identity-sha256 "$PUBLICATION_IDENTITY_SHA256"
PACKAGE_RESERVATION_OWNED=0

PKG="$OUTPUT_DIR/$PKG_LEAF"
BOOTSTRAP_ENVELOPE="$OUTPUT_DIR/$BOOTSTRAP_ENVELOPE_LEAF"
COMPATIBLE_COHORT="$OUTPUT_DIR/$COMPATIBLE_COHORT_LEAF"
COMPATIBLE_COHORT_SHA256="$OUTPUT_DIR/$COMPATIBLE_COHORT_SHA256_LEAF"
printf 'Built signed, notarized updater PKG from source %s: %s\n' "$SOURCE_SHA" "$PKG"
printf 'Built signed external bootstrap envelope: %s\n' "$BOOTSTRAP_ENVELOPE"
printf 'Built schema-v2 compatible-cohort manifest: %s\n' "$COMPATIBLE_COHORT"
printf 'Built compatible-cohort manifest digest: %s\n' "$COMPATIBLE_COHORT_SHA256"
