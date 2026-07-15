#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_PATH=""
MANIFEST_PATH=""
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
ALLOW_IDENTITY_MIGRATION=0
LAUNCH_APP=0
LAUNCH_TIMEOUT_SECONDS="${RECORDINGS_LAUNCH_TIMEOUT_SECONDS:-10}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact)
      ARTIFACT_PATH="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:-}"
      shift 2
      ;;
    --expected-team-id)
      EXPECTED_TEAM_ID="${2:-}"
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
    --launch-timeout)
      LAUNCH_TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Recordings.app installation is only supported on macOS." >&2
  exit 1
fi

if [ -z "$ARTIFACT_PATH" ] || [ -z "$MANIFEST_PATH" ]; then
  echo "Install requires --artifact <finalized.zip> and --manifest <manifest.json>." >&2
  exit 2
fi
if [ -z "$EXPECTED_TEAM_ID" ]; then
  echo "Install requires --expected-team-id or RECORDINGS_EXPECTED_TEAM_IDENTIFIER." >&2
  exit 2
fi
case "$LAUNCH_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    echo "Launch timeout must be an integer number of seconds." >&2
    exit 2
    ;;
esac
if [ "$LAUNCH_TIMEOUT_SECONDS" -lt 1 ] || [ "$LAUNCH_TIMEOUT_SECONDS" -gt 120 ]; then
  echo "Launch timeout must be between 1 and 120 seconds." >&2
  exit 2
fi
if [ ! -f "$ARTIFACT_PATH" ] || [ ! -f "$MANIFEST_PATH" ]; then
  echo "Artifact ZIP or manifest does not exist." >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to verify the macOS artifact manifest." >&2
  exit 1
fi

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_TOOL="${PACKAGE_ROOT}/scripts/macos_artifact.ts"
DATA_DIR="${HOME}/.hasna/recordings"
APP_DEST="${HOME}/Applications/Recordings.app"
APP_PARENT="$(dirname "$APP_DEST")"
ROLLBACK_DIR="${DATA_DIR}/rollbacks"
TRANSACTION_COMMITTED=0
INSTALLED_NEW_APP=0
STOPPED_RUNNING_APP=0
was_running=0
OLD_PIDS=""
RUNNING_EXECUTABLES=()
MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_ORIGINAL_COUNT=0

bun "$ARTIFACT_TOOL" verify-archive \
  --archive "$ARTIFACT_PATH" \
  --manifest "$MANIFEST_PATH" \
  --team-id "$EXPECTED_TEAM_ID"

mkdir -p "${DATA_DIR}/audio" "$ROLLBACK_DIR" "$APP_PARENT"
WORK_DIR="$(mktemp -d)"
UNPACK_DIR="${WORK_DIR}/unpacked"
ARTIFACT_SNAPSHOT="${WORK_DIR}/$(basename "$ARTIFACT_PATH")"
MANIFEST_SNAPSHOT="${WORK_DIR}/$(basename "$MANIFEST_PATH")"
STAGING_DIR="$(mktemp -d "${APP_PARENT}/.Recordings-install.XXXXXX")"
STAGED_APP="${STAGING_DIR}/Recordings.app"
TRANSACTION_DIR="$(mktemp -d "${APP_PARENT}/.Recordings-transaction.XXXXXX")"
mkdir -p "$UNPACK_DIR"
cp "$ARTIFACT_PATH" "$ARTIFACT_SNAPSHOT"
cp "$MANIFEST_PATH" "$MANIFEST_SNAPSHOT"
bun "$ARTIFACT_TOOL" verify-archive \
  --archive "$ARTIFACT_SNAPSHOT" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"

add_unique_app() {
  local candidate="$1"
  local existing
  [ -d "$candidate" ] || return 0
  for existing in ${DISCOVERED_APPS[@]+"${DISCOVERED_APPS[@]}"}; do
    [ "$existing" = "$candidate" ] && return 0
  done
  DISCOVERED_APPS+=("$candidate")
}

process_pids_for_known_apps() {
  local pid
  local command
  local executable
  while read -r pid command; do
    [ -n "${pid:-}" ] || continue
    for executable in ${RUNNING_EXECUTABLES[@]+"${RUNNING_EXECUTABLES[@]}"}; do
      case "$command" in
        "$executable"|"$executable "*)
          printf '%s\n' "$pid"
          break
          ;;
      esac
    done
  done < <(ps -axo pid=,command= 2>/dev/null || true)
}

pid_was_old() {
  local candidate="$1"
  local old_pid
  while IFS= read -r old_pid; do
    [ "$old_pid" = "$candidate" ] && return 0
  done <<< "$OLD_PIDS"
  return 1
}

stop_old_processes() {
  OLD_PIDS="$(process_pids_for_known_apps)"
  [ -n "$OLD_PIDS" ] || return 0
  was_running=1
  STOPPED_RUNNING_APP=1
  while IFS= read -r pid; do
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$OLD_PIDS"
  local attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  local remaining=0
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    remaining=0
    while IFS= read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining=1
        break
      fi
    done <<< "$OLD_PIDS"
    [ "$remaining" -eq 0 ] && break
    sleep 0.1
  done
  if [ "$remaining" -ne 0 ]; then
    echo "Existing Recordings.app process did not stop before replacement." >&2
    exit 1
  fi
}

restore_transaction() {
  local index
  local original
  local moved
  if [ "$INSTALLED_NEW_APP" -eq 1 ]; then
    rm -rf "$APP_DEST"
  fi
  for ((index = MOVED_ORIGINAL_COUNT - 1; index >= 0; index--)); do
    original="${MOVED_ORIGINALS[$index]}"
    moved="${MOVED_PATHS[$index]}"
    if [ -e "$moved" ]; then
      mkdir -p "$(dirname "$original")"
      if ! mv "$moved" "$original"; then
        echo "Failed to restore ${original}; preserved transaction data at ${moved}." >&2
      fi
    fi
  done
}

restart_previous_app() {
  local app_path
  [ "$STOPPED_RUNNING_APP" -eq 1 ] || return 0
  for app_path in ${DISCOVERED_APPS[@]+"${DISCOVERED_APPS[@]}"}; do
    if [ -d "$app_path" ]; then
      open -n "$app_path" >/dev/null 2>&1 || true
      return 0
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$TRANSACTION_COMMITTED" -ne 1 ]; then
    restore_transaction
    restart_previous_app
  fi
  rm -rf "$STAGING_DIR" "$WORK_DIR"
  if [ "$TRANSACTION_COMMITTED" -eq 1 ]; then
    rm -rf "$TRANSACTION_DIR"
  elif [ -d "$TRANSACTION_DIR" ]; then
    rmdir "$TRANSACTION_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

ditto -x -k "$ARTIFACT_SNAPSHOT" "$UNPACK_DIR"
root_entry_count=0
CANDIDATE_APP=""
shopt -s nullglob dotglob
for root_entry in "$UNPACK_DIR"/*; do
  root_entry_count=$((root_entry_count + 1))
  CANDIDATE_APP="$root_entry"
done
shopt -u nullglob dotglob
if [ "$root_entry_count" -ne 1 ] || \
   [ ! -d "$CANDIDATE_APP" ] || \
   [ "$(basename "${CANDIDATE_APP:-missing}")" != "Recordings.app" ]; then
  echo "Finalized artifact must contain only one top-level Recordings.app bundle." >&2
  exit 1
fi

bun "$ARTIFACT_TOOL" verify-app \
  --app "$CANDIDATE_APP" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"
xcrun stapler validate "$CANDIDATE_APP"
spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"

DISCOVERED_APPS=()
add_unique_app "$APP_DEST"
add_unique_app "${DATA_DIR}/Recordings.app"
for candidate in "${HOME}"/Applications/Recordings.app.*; do
  add_unique_app "$candidate"
done
add_unique_app "/Applications/Recordings.app"
if command -v mdfind >/dev/null 2>&1; then
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    add_unique_app "$candidate"
  done < <(mdfind "kMDItemCFBundleIdentifier == 'com.hasna.recordings'" 2>/dev/null || true)
fi

MANAGEABLE_APPS=()
for existing_app in ${DISCOVERED_APPS[@]+"${DISCOVERED_APPS[@]}"}; do
  case "$existing_app" in
    "$APP_DEST"|"${DATA_DIR}/Recordings.app"|"${HOME}/Applications/Recordings.app."*)
      MANAGEABLE_APPS+=("$existing_app")
      ;;
    *)
      echo "Duplicate Recordings.app at ${existing_app} is outside the transactional user install paths; archive or remove it before installing." >&2
      exit 1
      ;;
  esac
done

candidate_requirement="$(codesign -d -r- "$CANDIDATE_APP" 2>&1 | sed -n 's/^designated => //p' | head -n 1 || true)"
if [ -z "$candidate_requirement" ]; then
  echo "Candidate app has no designated requirement." >&2
  exit 1
fi
identity_migration=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  existing_requirement="$(codesign -d -r- "$existing_app" 2>&1 | sed -n 's/^designated => //p' | head -n 1 || true)"
  if [ -z "$existing_requirement" ] || \
     ! codesign --verify --strict -R "$existing_requirement" "$CANDIDATE_APP" >/dev/null 2>&1 || \
     ! codesign --verify --strict -R "$candidate_requirement" "$existing_app" >/dev/null 2>&1; then
    identity_migration=1
  fi
done
if [ "$identity_migration" -eq 1 ] && [ "$ALLOW_IDENTITY_MIGRATION" -ne 1 ]; then
  echo "Candidate and existing app designated requirements are not mutually compatible; review the signer change and rerun once with --allow-signing-identity-migration." >&2
  exit 1
fi

ARCHIVE_SEQUENCE=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  ARCHIVE_SEQUENCE=$((ARCHIVE_SEQUENCE + 1))
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$-${ARCHIVE_SEQUENCE}"
  ditto -c -k --sequesterRsrc --keepParent \
    "$existing_app" \
    "$ROLLBACK_DIR/Recordings-pre-install-${stamp}.zip"
done

ditto "$CANDIDATE_APP" "$STAGED_APP"
bun "$ARTIFACT_TOOL" verify-app \
  --app "$STAGED_APP" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"

for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  RUNNING_EXECUTABLES+=("$existing_app/Contents/MacOS/Recordings")
done
stop_old_processes

move_index=0
MOVED_ORIGINAL_COUNT=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  move_index=$((move_index + 1))
  moved_path="$TRANSACTION_DIR/original-${move_index}"
  MOVED_ORIGINALS+=("$existing_app")
  MOVED_PATHS+=("$moved_path")
  MOVED_ORIGINAL_COUNT=$move_index
  mv "$existing_app" "$moved_path"
done

mv "$STAGED_APP" "$APP_DEST"
INSTALLED_NEW_APP=1
bun "$ARTIFACT_TOOL" verify-app \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"
xcrun stapler validate "$APP_DEST"
spctl --assess --type execute --verbose=2 "$APP_DEST"

if [ "$LAUNCH_APP" -eq 1 ] || [ "$was_running" -eq 1 ]; then
  EXPECTED_EXECUTABLE="$APP_DEST/Contents/MacOS/Recordings"
  open -n "$APP_DEST"
  attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  launched_pid=""
  for ((attempt = 0; attempt < attempts; attempt++)); do
    while read -r pid command; do
      case "$command" in
        "$EXPECTED_EXECUTABLE"|"$EXPECTED_EXECUTABLE "*)
          if ! pid_was_old "$pid"; then
            launched_pid="$pid"
            break
          fi
          ;;
      esac
    done < <(ps -axo pid=,command= 2>/dev/null || true)
    [ -n "$launched_pid" ] && break
    sleep 0.1
  done
  if [ -z "$launched_pid" ]; then
    echo "Canonical app did not launch from ${EXPECTED_EXECUTABLE} within ${LAUNCH_TIMEOUT_SECONDS} seconds." >&2
    exit 1
  fi
  STOPPED_RUNNING_APP=0
fi

TRANSACTION_COMMITTED=1
rm -rf "$TRANSACTION_DIR"

if [ "$identity_migration" -eq 1 ]; then
  echo "Installed a new signing identity; macOS will require one-time permission approval for this migration."
fi
echo "Installed verified Recordings.app artifact: ${APP_DEST}"
