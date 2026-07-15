#!/usr/bin/env bash
set -euo pipefail

MODE="release"
POSTINSTALL=0
ALLOW_IDENTITY_MIGRATION=0
LAUNCH_APP=0
APP_SOURCE_OVERRIDE="${RECORDINGS_APP_SOURCE:-}"
EXPECTED_TEAM_IDENTIFIER="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-release}"
      shift 2
      ;;
    --postinstall)
      POSTINSTALL=1
      shift
      ;;
    --app-source)
      APP_SOURCE_OVERRIDE="${2:-}"
      shift 2
      ;;
    --allow-signing-identity-migration)
      ALLOW_IDENTITY_MIGRATION=1
      shift
      ;;
    --launch)
      LAUNCH_APP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  debug|release) ;;
  *)
    echo "Mode must be debug or release" >&2
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${HOME}/.hasna/recordings"
NATIVE_DIR="${PACKAGE_ROOT}/src/native/Recordings"
APP_DEST="${HOME}/Applications/Recordings.app"
ROLLBACK_DIR="${DATA_DIR}/rollbacks"
LEGACY_APP="${DATA_DIR}/Recordings.app"

warn_or_fail() {
  local message="$1"
  if [ "$POSTINSTALL" -eq 1 ]; then
    echo "Recordings.app was not installed: ${message}" >&2
    echo "Run 'recordings app install' after fixing this machine." >&2
    exit 0
  fi
  echo "${message}" >&2
  exit 1
}

mkdir -p "${DATA_DIR}/audio" "$ROLLBACK_DIR" "$(dirname "$APP_DEST")"

DISCOVERABLE_LEGACY_APPS=()
for legacy_path in "${HOME}"/Applications/Recordings.app.*; do
  [ -d "$legacy_path" ] || continue
  DISCOVERABLE_LEGACY_APPS+=("$legacy_path")
done

if [ -n "$APP_SOURCE_OVERRIDE" ]; then
  APP_SOURCE="$APP_SOURCE_OVERRIDE"
else
  APP_SOURCE="${NATIVE_DIR}/.build/${MODE}/Recordings.app"
  if ! command -v swift >/dev/null 2>&1; then
    warn_or_fail "Swift toolchain not found"
  fi
  if [ ! -d "$NATIVE_DIR" ]; then
    warn_or_fail "native app sources are missing from package: ${NATIVE_DIR}"
  fi
  (
    cd "$NATIVE_DIR"
    ./build.sh "$MODE"
  ) || warn_or_fail "native app build failed"
fi

if [ ! -d "$APP_SOURCE" ]; then
  warn_or_fail "app bundle not found: ${APP_SOURCE}"
fi

verify_candidate() {
  local candidate="$1"
  local enforce_release_policy="${2:-1}"
  local details
  local identifier
  if ! codesign --verify --deep --strict --verbose=2 "$candidate"; then
    warn_or_fail "candidate app has an invalid code signature"
  fi
  details="$(codesign -d --verbose=4 "$candidate" 2>&1 || true)"
  identifier="$(printf '%s\n' "$details" | awk -F= '/^Identifier=/ { print $2; exit }')"
  if [ "$identifier" != "com.hasna.recordings" ]; then
    warn_or_fail "candidate app has unexpected bundle identifier: ${identifier:-missing}"
  fi
  if [ "$MODE" = "release" ] && [ "$enforce_release_policy" -eq 1 ]; then
    local authority
    local team_identifier
    authority="$(printf '%s\n' "$details" | awk -F= '/^Authority=/ { print $2; exit }')"
    team_identifier="$(printf '%s\n' "$details" | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
    if [[ "$details" == *"Signature=adhoc"* ]]; then
      warn_or_fail "release candidate is ad-hoc signed; a stable Developer ID signing identity is required"
    fi
    if [[ "$authority" != "Developer ID Application:"* ]] || [ -z "$team_identifier" ]; then
      warn_or_fail "release candidate is not signed with a Developer ID Application identity"
    fi
    if [[ "$details" != *"(runtime)"* ]]; then
      warn_or_fail "release candidate is missing the hardened runtime signature flag"
    fi
    if [ -n "$EXPECTED_TEAM_IDENTIFIER" ] && [ "$team_identifier" != "$EXPECTED_TEAM_IDENTIFIER" ]; then
      warn_or_fail "release candidate Developer ID team ${team_identifier} does not match expected team ${EXPECTED_TEAM_IDENTIFIER}"
    fi
    if ! xcrun stapler validate "$candidate"; then
      warn_or_fail "release candidate does not contain a valid notarization ticket"
    fi
    if ! spctl --assess --type execute --verbose=2 "$candidate"; then
      warn_or_fail "release candidate failed Gatekeeper assessment"
    fi
  fi
}

verify_candidate "$APP_SOURCE"

if [ -d "/Applications/Recordings.app" ]; then
  warn_or_fail "duplicate app exists at /Applications/Recordings.app; archive or remove it before installing the canonical app"
fi

identity_migration=0
EXISTING_APPS=()
if [ -d "$APP_DEST" ]; then
  EXISTING_APPS+=("$APP_DEST")
fi
if [ -d "$LEGACY_APP" ]; then
  EXISTING_APPS+=("$LEGACY_APP")
fi
for legacy_path in "${DISCOVERABLE_LEGACY_APPS[@]}"; do
  EXISTING_APPS+=("$legacy_path")
done

for existing_app in "${EXISTING_APPS[@]}"; do
  installed_requirement="$(codesign -d -r- "$existing_app" 2>&1 | sed -n 's/^designated => //p' | head -n 1 || true)"
  compatible=0
  if [ -n "$installed_requirement" ] && \
      codesign --verify --deep --strict -R "$installed_requirement" "$APP_SOURCE" >/dev/null 2>&1; then
    compatible=1
  fi
  if [ "$compatible" -ne 1 ]; then
    identity_migration=1
  fi
done
if [ "$identity_migration" -eq 1 ] && [ "$ALLOW_IDENTITY_MIGRATION" -ne 1 ]; then
  warn_or_fail "candidate signing identity is incompatible with one or more existing app copies; rerun once with --allow-signing-identity-migration after reviewing the signer change"
fi

ARCHIVE_SEQUENCE=0
archive_app() {
  local app_path="$1"
  local label="$2"
  local stamp
  ARCHIVE_SEQUENCE=$((ARCHIVE_SEQUENCE + 1))
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$-${ARCHIVE_SEQUENCE}"
  ditto -c -k --sequesterRsrc --keepParent \
    "$app_path" \
    "$ROLLBACK_DIR/Recordings-${label}-${stamp}.zip"
}

APP_PARENT="$(dirname "$APP_DEST")"
STAGED_APP="${APP_PARENT}/.Recordings-install-$$"
PREVIOUS_APP="${APP_PARENT}/.Recordings-previous-$$"
TRANSACTION_COMMITTED=0
INSTALLED_NEW_APP=0
PREVIOUS_APP_MOVED=0
was_running=0
STOPPED_RUNNING_APP=0
RUNNING_EXECUTABLES=()
cleanup() {
  rm -rf "$STAGED_APP"
  if [ "$TRANSACTION_COMMITTED" -eq 0 ]; then
    if [ "$INSTALLED_NEW_APP" -eq 1 ]; then
      rm -rf "$APP_DEST"
    fi
    if [ "$PREVIOUS_APP_MOVED" -eq 1 ] && [ -d "$PREVIOUS_APP" ]; then
      if [ -e "$APP_DEST" ]; then
        echo "Previous app preserved at ${PREVIOUS_APP}; restore was blocked because ${APP_DEST} exists." >&2
      elif ! mv "$PREVIOUS_APP" "$APP_DEST"; then
        echo "Previous app could not be restored and remains at ${PREVIOUS_APP}." >&2
      fi
    fi
  else
    rm -rf "$PREVIOUS_APP"
  fi
  if [ "$STOPPED_RUNNING_APP" -eq 1 ]; then
    if [ "$TRANSACTION_COMMITTED" -eq 1 ] && [ -d "$APP_DEST" ]; then
      open -n "$APP_DEST" >/dev/null 2>&1 || true
    else
      for executable in "${RUNNING_EXECUTABLES[@]}"; do
        prior_app="${executable%/Contents/MacOS/Recordings}"
        if [ -d "$prior_app" ]; then
          open -n "$prior_app" >/dev/null 2>&1 || true
          break
        fi
      done
    fi
  fi
}
trap cleanup EXIT

rm -rf "$STAGED_APP" "$PREVIOUS_APP"
ditto "$APP_SOURCE" "$STAGED_APP" || warn_or_fail "failed to stage app bundle"
verify_candidate "$STAGED_APP" 0

RUNNING_EXECUTABLES=(
  "$APP_DEST/Contents/MacOS/Recordings"
  "$LEGACY_APP/Contents/MacOS/Recordings"
)
for legacy_path in "${DISCOVERABLE_LEGACY_APPS[@]}"; do
  RUNNING_EXECUTABLES+=("$legacy_path/Contents/MacOS/Recordings")
done

recordings_process_pids() {
  local pid
  local command
  local executable
  while read -r pid command; do
    [ -n "${pid:-}" ] || continue
    for executable in "${RUNNING_EXECUTABLES[@]}"; do
      case "$command" in
        "$executable"|"$executable "*)
          printf '%s\n' "$pid"
          break
          ;;
      esac
    done
  done < <(ps -axo pid=,command= 2>/dev/null || true)
}

RUNNING_PIDS="$(recordings_process_pids)"
if [ -n "$RUNNING_PIDS" ]; then
  was_running=1
  while IFS= read -r pid; do
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$RUNNING_PIDS"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    remaining=0
    while IFS= read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining=1
        break
      fi
    done <<< "$RUNNING_PIDS"
    [ "$remaining" -eq 0 ] && break
    sleep 0.1
  done
  if [ "$remaining" -ne 0 ]; then
    warn_or_fail "existing Recordings.app process did not stop before replacement"
  fi
  STOPPED_RUNNING_APP=1
fi

if [ -d "$APP_DEST" ]; then
  archive_app "$APP_DEST" "rollback"
  PREVIOUS_APP_MOVED=1
  mv "$APP_DEST" "$PREVIOUS_APP"
fi

if ! mv "$STAGED_APP" "$APP_DEST"; then
  if [ -d "$PREVIOUS_APP" ]; then
    if mv "$PREVIOUS_APP" "$APP_DEST"; then
      PREVIOUS_APP_MOVED=0
    fi
  fi
  warn_or_fail "failed to install the staged app bundle"
fi
INSTALLED_NEW_APP=1

test -x "$APP_DEST/Contents/MacOS/Recordings" || warn_or_fail "installed app executable is missing"
verify_candidate "$APP_DEST"
TRANSACTION_COMMITTED=1
rm -rf "$PREVIOUS_APP"
PREVIOUS_APP_MOVED=0

if [ -d "$LEGACY_APP" ]; then
  archive_app "$LEGACY_APP" "legacy"
  rm -rf "$LEGACY_APP"
  echo "Archived and removed legacy app copy at ${LEGACY_APP}."
fi

legacy_index=0
for legacy_path in "${DISCOVERABLE_LEGACY_APPS[@]}"; do
  legacy_index=$((legacy_index + 1))
  archive_app "$legacy_path" "legacy-user-${legacy_index}"
  rm -rf "$legacy_path"
  echo "Archived and removed discoverable rollback app at ${legacy_path}."
done

if [ "$was_running" -eq 1 ] || [ "$LAUNCH_APP" -eq 1 ]; then
  EXPECTED_EXECUTABLE="$APP_DEST/Contents/MacOS/Recordings"
  open -n "$APP_DEST" || warn_or_fail "failed to start the canonical app"
  canonical_process_running=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    while IFS= read -r command; do
      case "$command" in
        "$EXPECTED_EXECUTABLE"|"$EXPECTED_EXECUTABLE "*)
          canonical_process_running=1
          break
          ;;
      esac
    done < <(ps -axo command= 2>/dev/null || true)
    [ "$canonical_process_running" -eq 1 ] && break
    sleep 0.1
  done
  if [ "$canonical_process_running" -ne 1 ]; then
    warn_or_fail "canonical app process did not start from ${EXPECTED_EXECUTABLE}"
  fi
  STOPPED_RUNNING_APP=0
  echo "Started Recordings.app from ${APP_DEST}."
fi

if [ "$identity_migration" -eq 1 ]; then
  echo "Installed a new signing identity; macOS will require one-time permission approval for this migration."
fi

echo "Installed Recordings.app from package: ${APP_DEST}"
