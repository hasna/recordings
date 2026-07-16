#!/usr/bin/env bash
set -euo pipefail
umask 077

ARTIFACT_PATH=""
MANIFEST_PATH=""
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
EXPECTED_MANIFEST_SHA256=""
EXPECTED_SOURCE_SHA=""
EXPECTED_VERSION=""
EXPECTED_OLD_IDENTITY_SHA256=""
EXPECTED_NEW_IDENTITY_SHA256=""
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
    --manifest-sha256)
      EXPECTED_MANIFEST_SHA256="${2:-}"
      shift 2
      ;;
    --expected-source-sha)
      EXPECTED_SOURCE_SHA="${2:-}"
      shift 2
      ;;
    --expected-version)
      EXPECTED_VERSION="${2:-}"
      shift 2
      ;;
    --expected-old-identity-sha256)
      EXPECTED_OLD_IDENTITY_SHA256="${2:-}"
      shift 2
      ;;
    --expected-new-identity-sha256)
      EXPECTED_NEW_IDENTITY_SHA256="${2:-}"
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

if [ -z "$ARTIFACT_PATH" ] || [ -z "$MANIFEST_PATH" ] || \
   [ -z "$EXPECTED_MANIFEST_SHA256" ] || [ -z "$EXPECTED_SOURCE_SHA" ] || \
   [ -z "$EXPECTED_VERSION" ]; then
  echo "Install requires artifact, manifest, authenticated manifest SHA-256, exact source SHA, and exact version." >&2
  exit 2
fi
if [ -z "$EXPECTED_TEAM_ID" ]; then
  echo "Install requires --expected-team-id or RECORDINGS_EXPECTED_TEAM_IDENTIFIER." >&2
  exit 2
fi
if [ "$ALLOW_IDENTITY_MIGRATION" -eq 1 ] && \
   { [ -z "$EXPECTED_OLD_IDENTITY_SHA256" ] || [ -z "$EXPECTED_NEW_IDENTITY_SHA256" ]; }; then
  echo "Identity migration requires exact --expected-old-identity-sha256 and --expected-new-identity-sha256 values." >&2
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
RUNTIME_SMOKE="${PACKAGE_ROOT}/scripts/smoke_macos_app.sh"
[ -x "$RUNTIME_SMOKE" ] || { echo "Packaged runtime smoke verifier is missing." >&2; exit 1; }
DATA_DIR="${HOME}/.hasna/recordings"
APP_DEST="${HOME}/Applications/Recordings.app"
APP_PARENT="$(dirname "$APP_DEST")"
ROLLBACK_DIR="${DATA_DIR}/rollbacks"
JOURNAL_PATH="${APP_PARENT}/.Recordings-install-transaction.json"
TRANSACTION_COMMITTED=0
STOPPED_RUNNING_APP=0
was_running=0
OLD_PIDS=""
RUNNING_EXECUTABLES=()
MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_ORIGINAL_COUNT=0

mkdir -p "${DATA_DIR}/audio" "$ROLLBACK_DIR" "$APP_PARENT"

if [ -f "$JOURNAL_PATH" ]; then
  echo "Recovering incomplete Recordings.app installation transaction." >&2
  RECOVER_WAS_RUNNING="$(bun "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field was_running)"
  bun "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"
  if [ "$RECOVER_WAS_RUNNING" = 1 ] && [ -d "$APP_DEST" ]; then
    open -n "$APP_DEST" >/dev/null 2>&1 || true
  fi
fi

bun "$ARTIFACT_TOOL" verify-archive \
  --archive "$ARTIFACT_PATH" \
  --manifest "$MANIFEST_PATH" \
  --team-id "$EXPECTED_TEAM_ID" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --source-sha "$EXPECTED_SOURCE_SHA" \
  --version "$EXPECTED_VERSION"

CURRENT_MACOS="$(sw_vers -productVersion)"
MINIMUM_MACOS="$(bun "$ARTIFACT_TOOL" manifest-get --manifest "$MANIFEST_PATH" --field minimum_macos)"
if ! bun -e '
  const parse = (value) => value.split(".").map(Number);
  const [actual, minimum] = process.argv.slice(1).map(parse);
  for (let i = 0; i < Math.max(actual.length, minimum.length); i++) {
    if ((actual[i] ?? 0) > (minimum[i] ?? 0)) process.exit(0);
    if ((actual[i] ?? 0) < (minimum[i] ?? 0)) process.exit(1);
  }
' "$CURRENT_MACOS" "$MINIMUM_MACOS"; then
  echo "Recordings.app requires macOS ${MINIMUM_MACOS} or later; target is ${CURRENT_MACOS}." >&2
  exit 1
fi
TARGET_ARCH="$(uname -m)"
MANIFEST_ARCHITECTURES="$(bun "$ARTIFACT_TOOL" manifest-get --manifest "$MANIFEST_PATH" --field architectures)"
case " ${MANIFEST_ARCHITECTURES} " in
  *" ${TARGET_ARCH} "*) ;;
  *) echo "Recordings.app artifact does not support target architecture ${TARGET_ARCH}." >&2; exit 1 ;;
esac

verify_secure_parent() {
  local path="$1"
  [ ! -L "$path" ] || { echo "Secure install path must not be a symlink: ${path}" >&2; exit 1; }
  local actual_uid
  local mode
  actual_uid="$(stat -f '%u' "$path")"
  mode="$(stat -f '%Lp' "$path")"
  [ "$actual_uid" = "$(id -u)" ] || { echo "Secure install path has an unexpected owner: ${path}" >&2; exit 1; }
  case "$mode" in
    *[2367][0-7]|*[0-7][2367])
      echo "Secure install path is group/world writable: ${path}" >&2
      exit 1
      ;;
  esac
  if ls -lde "$path" | tail -n +2 | grep -q '[^[:space:]]'; then
    echo "Secure install path has an unexpected ACL: ${path}" >&2
    exit 1
  fi
}
verify_secure_parent "$APP_PARENT"
verify_secure_parent "$DATA_DIR"
verify_secure_parent "$ROLLBACK_DIR"

required_kb=$(( ($(du -sk "$ARTIFACT_PATH" "$DATA_DIR" 2>/dev/null | awk '{sum += $1} END {print sum + 1024}') ) * 4 ))
available_kb="$(df -Pk "$APP_PARENT" | awk 'NR == 2 {print $4}')"
if [ -z "$available_kb" ] || [ "$available_kb" -lt "$required_kb" ]; then
  echo "Insufficient free space for transactional app and state backups." >&2
  exit 1
fi

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
  --team-id "$EXPECTED_TEAM_ID" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --source-sha "$EXPECTED_SOURCE_SHA" \
  --version "$EXPECTED_VERSION"

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
  write_journal processes-stopping
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
  if [ "$TRANSACTION_COMMITTED" -ne 1 ] && [ -f "$JOURNAL_PATH" ]; then
    if ! bun "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"; then
      echo "Automatic rollback failed; preserved transaction evidence at ${JOURNAL_PATH}." >&2
      status=1
    fi
    restart_previous_app
  fi
  rm -rf "$STAGING_DIR" "$WORK_DIR"
  if [ "$TRANSACTION_COMMITTED" -eq 1 ]; then
    rm -rf "$TRANSACTION_DIR"
  elif [ ! -f "$JOURNAL_PATH" ] && [ -d "$TRANSACTION_DIR" ]; then
    rmdir "$TRANSACTION_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

maybe_crash_after_phase() {
  local phase="$1"
  if [ "${RECORDINGS_TEST_CRASH_AFTER_PHASE:-}" = "$phase" ]; then
    kill -KILL "$$"
  fi
}

write_journal() {
  local phase="$1"
  local -a arguments=(
    journal-write
    --journal "$JOURNAL_PATH"
    --phase "$phase"
    --transaction-dir "$TRANSACTION_DIR"
    --app-parent "$APP_PARENT"
    --app-destination "$APP_DEST"
    --data-dir "$DATA_DIR"
    --state-backup "$STATE_BACKUP"
    --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256"
    --expected-source-sha "$EXPECTED_SOURCE_SHA"
    --expected-version "$EXPECTED_VERSION"
    --candidate-identity-sha256 "$candidate_identity_sha256"
    --previous-identity-sha256 "$previous_identity_sha256"
  )
  [ "$was_running" -eq 0 ] || arguments+=(--was-running)
  local index
  for ((index = 0; index < MOVED_ORIGINAL_COUNT; index++)); do
    arguments+=(--original "${MOVED_ORIGINALS[$index]}" "${MOVED_PATHS[$index]}")
  done
  bun "$ARTIFACT_TOOL" "${arguments[@]}"
  maybe_crash_after_phase "$phase"
}

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
syspolicy_check distribution "$CANDIDATE_APP"
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$CANDIDATE_APP" --uid "$(id -u)"

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
      echo "Duplicate disposition: archive transactionally, remove after activation: ${existing_app}"
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
candidate_identity_sha256="$(bun "$ARTIFACT_TOOL" requirement-digest --app "$CANDIDATE_APP")"
[ "$candidate_identity_sha256" = "$(bun "$ARTIFACT_TOOL" manifest-get --manifest "$MANIFEST_SNAPSHOT" --field identity)" ] || {
  echo "Candidate identity does not match the release manifest." >&2
  exit 1
}
previous_identity_sha256="none"
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$existing_app" --uid "$(id -u)"
  bun "$ARTIFACT_TOOL" assert-transition --existing-app "$existing_app" --manifest "$MANIFEST_SNAPSHOT"
  existing_identity_sha256="$(bun "$ARTIFACT_TOOL" requirement-digest --app "$existing_app")"
  if [ "$previous_identity_sha256" = "none" ]; then
    previous_identity_sha256="$existing_identity_sha256"
  elif [ "$previous_identity_sha256" != "$existing_identity_sha256" ]; then
    echo "Installed duplicates have multiple signing identities; automatic migration is unsafe." >&2
    exit 1
  fi
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
if [ "$identity_migration" -eq 1 ] && {
     [ "$previous_identity_sha256" != "$EXPECTED_OLD_IDENTITY_SHA256" ] ||
     [ "$candidate_identity_sha256" != "$EXPECTED_NEW_IDENTITY_SHA256" ];
   }; then
  echo "Signing identity migration does not match the exact operator-approved old/new identities." >&2
  exit 1
fi
if [ "$identity_migration" -eq 0 ] && [ "$ALLOW_IDENTITY_MIGRATION" -eq 1 ]; then
  echo "Identity migration approval was supplied but no identity migration is required." >&2
  exit 1
fi

chmod 700 "$TRANSACTION_DIR"
mkdir -m 700 "$TRANSACTION_DIR/apps"
verify_secure_parent "$TRANSACTION_DIR"
STATE_BACKUP="$TRANSACTION_DIR/state"
ditto "$DATA_DIR" "$STATE_BACKUP"
if ! diff -qr "$DATA_DIR" "$STATE_BACKUP" >/dev/null; then
  echo "Recordings state backup verification failed before replacement." >&2
  exit 1
fi
chmod -R go-rwx "$STATE_BACKUP"
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STATE_BACKUP" --uid "$(id -u)"

MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_ORIGINAL_COUNT=0
move_index=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  move_index=$((move_index + 1))
  MOVED_ORIGINALS+=("$existing_app")
  MOVED_PATHS+=("$TRANSACTION_DIR/apps/original-${move_index}")
  MOVED_ORIGINAL_COUNT=$move_index
done
write_journal prepared

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
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STAGED_APP" --uid "$(id -u)"

for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  RUNNING_EXECUTABLES+=("$existing_app/Contents/MacOS/Recordings")
done
stop_old_processes
rm -rf "$STATE_BACKUP"
ditto "$DATA_DIR" "$STATE_BACKUP"
if ! diff -qr "$DATA_DIR" "$STATE_BACKUP" >/dev/null; then
  echo "Stopped-state backup verification failed before replacement." >&2
  exit 1
fi
chmod -R go-rwx "$STATE_BACKUP"
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STATE_BACKUP" --uid "$(id -u)"
write_journal processes-stopped

write_journal originals-moving
for ((move_index = 0; move_index < MOVED_ORIGINAL_COUNT; move_index++)); do
  existing_app="${MOVED_ORIGINALS[$move_index]}"
  moved_path="${MOVED_PATHS[$move_index]}"
  mv "$existing_app" "$moved_path"
  chmod -R go-w "$moved_path"
  bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$moved_path" --uid "$(id -u)"
done
write_journal originals-moved

mv "$STAGED_APP" "$APP_DEST"
write_journal candidate-installed
bun "$ARTIFACT_TOOL" verify-app \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"
xcrun stapler validate "$APP_DEST"
spctl --assess --type execute --verbose=2 "$APP_DEST"
syspolicy_check distribution "$APP_DEST"
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$APP_DEST" --uid "$(id -u)"
bun "$ARTIFACT_TOOL" verify-active \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID"
"$RUNTIME_SMOKE" "$APP_DEST"
write_journal activated

if [ "$LAUNCH_APP" -eq 1 ] || [ "$was_running" -eq 1 ]; then
  EXPECTED_EXECUTABLE="$APP_DEST/Contents/MacOS/Recordings"
  RUNNING_EXECUTABLES+=("$EXPECTED_EXECUTABLE")
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
  sleep 1
  stable_pid="$(process_pids_for_known_apps | awk -v expected="$launched_pid" '$1 == expected { print; exit }')"
  if [ -z "$stable_pid" ]; then
    echo "Canonical app process exited before the stability window completed." >&2
    exit 1
  fi
  STOPPED_RUNNING_APP=0
fi

write_journal committed
TRANSACTION_COMMITTED=1
rm -f "$JOURNAL_PATH"
rm -rf "$TRANSACTION_DIR"

if [ "$identity_migration" -eq 1 ]; then
  echo "Installed a new signing identity; macOS will require one-time permission approval for this migration."
fi
echo "Installed verified Recordings.app artifact: ${APP_DEST}"
