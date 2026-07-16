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
ARTIFACT_POLICY="release"
APPROVED_TARGET="fleet"
APPROVED_TARGET_IDENTITY_KIND=""
APPROVED_TARGET_IDENTITY_SHA256="none"
ACKNOWLEDGE_LOCAL_SIGNING_AND_PERMISSIONS=0
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
    --artifact-policy)
      case "${2:-}" in
        release) ARTIFACT_POLICY="release" ;;
        local-only|local_only) ARTIFACT_POLICY="local_only" ;;
        *) echo "Artifact policy must be release or local-only." >&2; exit 2 ;;
      esac
      shift 2
      ;;
    --approved-target)
      APPROVED_TARGET="${2:-}"
      shift 2
      ;;
    --approved-target-identity-sha256)
      APPROVED_TARGET_IDENTITY_SHA256="${2:-}"
      shift 2
      ;;
    --approved-target-identity-kind)
      APPROVED_TARGET_IDENTITY_KIND="${2:-}"
      shift 2
      ;;
    --acknowledge-local-signing-and-permissions)
      ACKNOWLEDGE_LOCAL_SIGNING_AND_PERMISSIONS=1
      shift
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
if [ -z "$APPROVED_TARGET_IDENTITY_KIND" ]; then
  if [ "$ARTIFACT_POLICY" = "release" ]; then
    APPROVED_TARGET_IDENTITY_KIND="none"
  else
    # Schema-v3 artifacts created before the discriminator used the platform UUID hash.
    APPROVED_TARGET_IDENTITY_KIND="hardware_uuid_sha256"
  fi
fi
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_TOOL="${PACKAGE_ROOT}/scripts/macos_artifact.ts"
RUNTIME_SMOKE="${PACKAGE_ROOT}/scripts/smoke_macos_app.sh"
TAILSCALE_RESOLVER="${PACKAGE_ROOT}/scripts/resolve_tailscale_cli.sh"
if [ "$ARTIFACT_POLICY" = "release" ]; then
  if [ -z "$EXPECTED_TEAM_ID" ]; then
    echo "Release install requires --expected-team-id or RECORDINGS_EXPECTED_TEAM_IDENTIFIER." >&2
    exit 2
  fi
  if [ "$APPROVED_TARGET" != "fleet" ]; then
    echo "Release artifacts use the fleet target policy." >&2
    exit 2
  fi
  if [ "$APPROVED_TARGET_IDENTITY_SHA256" != "none" ]; then
    echo "Release artifacts do not accept a local-only target identity." >&2
    exit 2
  fi
  if [ "$APPROVED_TARGET_IDENTITY_KIND" != "none" ]; then
    echo "Release artifacts do not accept a local-only target identity kind." >&2
    exit 2
  fi
  if [ "$ACKNOWLEDGE_LOCAL_SIGNING_AND_PERMISSIONS" -eq 1 ]; then
    echo "Local-only acknowledgment cannot be supplied for a release artifact." >&2
    exit 2
  fi
else
  if [ -n "$EXPECTED_TEAM_ID" ]; then
    echo "Local-only artifacts do not accept --expected-team-id or a release TeamIdentifier environment value." >&2
    exit 2
  fi
  if [ "$APPROVED_TARGET" != "station06" ]; then
    echo "Local-only install is currently restricted to --approved-target station06." >&2
    exit 2
  fi
  if ! [[ "$APPROVED_TARGET_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Local-only install requires --approved-target-identity-sha256 from the approved machine registry." >&2
    exit 2
  fi
  case "$APPROVED_TARGET_IDENTITY_KIND" in
    hardware_uuid_sha256|tailscale_node_id_sha256) ;;
    *) echo "Local-only install requires a supported --approved-target-identity-kind." >&2; exit 2 ;;
  esac
  if [ "$ACKNOWLEDGE_LOCAL_SIGNING_AND_PERMISSIONS" -ne 1 ]; then
    echo "Local-only install requires --acknowledge-local-signing-and-permissions because code identity can change and macOS may require Microphone or Accessibility reauthorization." >&2
    exit 2
  fi
  ACTUAL_TARGET="$(hostname -s)"
  if [ "$ACTUAL_TARGET" != "$APPROVED_TARGET" ]; then
    echo "Local-only artifact target ${APPROVED_TARGET} does not match this Mac (${ACTUAL_TARGET})." >&2
    exit 1
  fi
  if [ "$APPROVED_TARGET_IDENTITY_KIND" = "tailscale_node_id_sha256" ]; then
    if [ ! -r "$TAILSCALE_RESOLVER" ]; then
      echo "Packaged Tailscale CLI resolver is missing." >&2
      exit 1
    fi
    # shellcheck source=/dev/null
    source "$TAILSCALE_RESOLVER"
    if ! TAILSCALE_CLI="$(recordings_resolve_tailscale_cli)"; then
      echo "Tailscale is required to verify this local-only target identity." >&2
      exit 1
    fi
    if ! command -v bun >/dev/null 2>&1; then
      echo "Bun is required to verify this local-only target identity." >&2
      exit 1
    fi
    if ! ACTUAL_TARGET_IDENTITY_SHA256="$("$TAILSCALE_CLI" status --json | bun "$ARTIFACT_TOOL" tailscale-node-id-sha256 --expected-hostname "$APPROVED_TARGET")"; then
      echo "Could not verify the live Tailscale identity for this local-only target." >&2
      exit 1
    fi
  else
    ACTUAL_PLATFORM_ID="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {print $(NF-1); exit}' | tr '[:upper:]' '[:lower:]')"
    if [ -z "$ACTUAL_PLATFORM_ID" ]; then
      echo "Could not read this Mac platform identity." >&2
      exit 1
    fi
    ACTUAL_TARGET_IDENTITY_SHA256="$(printf '%s' "$ACTUAL_PLATFORM_ID" | shasum -a 256 | awk '{print $1}')"
    unset ACTUAL_PLATFORM_ID
  fi
  if [ "$ACTUAL_TARGET_IDENTITY_SHA256" != "$APPROVED_TARGET_IDENTITY_SHA256" ]; then
    echo "Local-only artifact does not match this Mac's approved machine identity." >&2
    exit 1
  fi
  if [ "$ALLOW_IDENTITY_MIGRATION" -eq 1 ] || [ -n "$EXPECTED_OLD_IDENTITY_SHA256" ] || [ -n "$EXPECTED_NEW_IDENTITY_SHA256" ]; then
    echo "Release identity-migration flags are not valid for local-only artifacts." >&2
    exit 2
  fi
  EXPECTED_TEAM_ID="ADHOC"
  echo "WARNING: installing a non-notarized local-only artifact approved only for ${APPROVED_TARGET}." >&2
  echo "WARNING: code identity can change; Microphone or Accessibility may require manual reauthorization." >&2
fi
if [ "$ARTIFACT_POLICY" = "release" ] && [ "$ALLOW_IDENTITY_MIGRATION" -eq 1 ] && \
   { [ -z "$EXPECTED_OLD_IDENTITY_SHA256" ] || [ -z "$EXPECTED_NEW_IDENTITY_SHA256" ]; }; then
  echo "Identity migration requires exact --expected-old-identity-sha256 and --expected-new-identity-sha256 values." >&2
  exit 2
fi
if [ "$ARTIFACT_POLICY" = "release" ] && [ "$ALLOW_IDENTITY_MIGRATION" -eq 0 ] && \
   { [ -n "$EXPECTED_OLD_IDENTITY_SHA256" ] || [ -n "$EXPECTED_NEW_IDENTITY_SHA256" ]; }; then
  echo "Identity migration digests require --allow-signing-identity-migration." >&2
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

[ -x "$RUNTIME_SMOKE" ] || { echo "Packaged runtime smoke verifier is missing." >&2; exit 1; }
DATA_DIR="${HOME}/.hasna/recordings"
DATA_PARENT="$(dirname "$DATA_DIR")"
APP_DEST="${HOME}/Applications/Recordings.app"
APP_PARENT="$(dirname "$APP_DEST")"
ROLLBACK_DIR="${DATA_DIR}/rollbacks"
JOURNAL_PATH="${APP_PARENT}/.Recordings-install-transaction.json"
LOCK_DIR="${APP_PARENT}/.Recordings-install-lock"
LOCK_OWNED=0
TRANSACTION_COMMITTED=0
STOPPED_RUNNING_APP=0
was_running=0
OLD_PIDS=""
RUNNING_EXECUTABLES=()
MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_DIGESTS=()
MOVED_ORIGINAL_COUNT=0

verify_secure_parent() {
  local path="$1"
  local private_mode="${2:-0}"
  [ -d "$path" ] && [ ! -L "$path" ] || { echo "Secure install path must be a non-symlink directory: ${path}" >&2; exit 1; }
  local actual_uid
  local mode
  actual_uid="$(stat -f '%u' "$path")"
  mode="$(stat -f '%Lp' "$path")"
  [ "$actual_uid" = "$(id -u)" ] || { echo "Secure install path has an unexpected owner: ${path}" >&2; exit 1; }
  if [ "$private_mode" -eq 1 ] && [ "$mode" != 700 ]; then
    echo "Private Recordings state path must have mode 700: ${path}" >&2
    exit 1
  fi
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

verify_secure_file() {
  local path="$1"
  local label="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] && \
      [ "$(stat -f '%u' "$path")" = "$(id -u)" ] && \
      [ "$(stat -f '%Lp' "$path")" = 600 ] || {
      echo "${label} has an unsafe type, owner, or mode." >&2
      exit 1
    }
    if ls -lde "$path" | tail -n +2 | grep -q '[^[:space:]]'; then
      echo "${label} has an unexpected ACL." >&2
      exit 1
    fi
  fi
}

verify_safe_home_ancestor() {
  local path="$1"
  [ -d "$path" ] && [ ! -L "$path" ] || {
    echo "Home ancestor must be a non-symlink directory." >&2
    exit 1
  }
  [ "$(stat -f '%u' "$path")" = "$(id -u)" ] || {
    echo "Home ancestor has an unexpected owner." >&2
    exit 1
  }
  home_mode="$(stat -f '%Lp' "$path")"
  case "$home_mode" in
    *[2367][0-7]|*[0-7][2367])
      echo "Home ancestor is group/world writable." >&2
      exit 1
      ;;
  esac
  home_acl="$(ls -lde "$path" | tail -n +2)"
  if [ -n "$home_acl" ] && printf '%s\n' "$home_acl" | grep -v ' deny ' | grep -q '[^[:space:]]'; then
    echo "Home ancestor has an ACL that grants access." >&2
    exit 1
  fi
}

verify_existing_state_root() {
  [ -e "$DATA_DIR" ] || [ -L "$DATA_DIR" ] || return 0
  [ -d "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ] || {
    echo "Recordings state path must be a non-symlink directory." >&2
    exit 1
  }
  [ "$(stat -f '%u' "$DATA_DIR")" = "$(id -u)" ] || {
    echo "Recordings state path has an unexpected owner." >&2
    exit 1
  }
  state_mode="$(stat -f '%Lp' "$DATA_DIR")"
  case "$state_mode" in
    700|755) ;;
    *) echo "Recordings state path must have mode 700 or the supported legacy mode 755." >&2; exit 1 ;;
  esac
  if ls -lde "$DATA_DIR" | tail -n +2 | grep -q '[^[:space:]]'; then
    echo "Recordings state path has an unexpected ACL." >&2
    exit 1
  fi
  bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$DATA_DIR" --uid "$(id -u)"
}

# The target identity above and every existing state path are validated read-only
# before creating an install parent, lock, journal, or state child.
verify_safe_home_ancestor "$HOME"
if [ -e "$DATA_PARENT" ] || [ -L "$DATA_PARENT" ]; then
  verify_secure_parent "$DATA_PARENT"
fi
if [ -e "$APP_PARENT" ] || [ -L "$APP_PARENT" ]; then
  verify_secure_parent "$APP_PARENT"
fi
verify_existing_state_root
[ ! -L "$ROLLBACK_DIR" ] || { echo "Recordings rollback parent must not be a symlink." >&2; exit 1; }

if [ ! -e "$APP_PARENT" ]; then
  mkdir -m 700 "$APP_PARENT"
fi
verify_secure_parent "$APP_PARENT"
verify_secure_file "$JOURNAL_PATH" "Install transaction journal"

release_install_lock() {
  if [ "$LOCK_OWNED" -eq 1 ] && [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
    owner_pid="$(sed -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    [ "$owner_pid" != "$$" ] || rm -rf "$LOCK_DIR"
  fi
  LOCK_OWNED=0
}

acquire_install_lock() {
  local stale_claim
  local owner_pid
  local owner_start
  local actual_start
  local lock_age
  local now
  local stale_seconds="${RECORDINGS_LOCK_STALE_SECONDS:-30}"
  case "$stale_seconds" in
    ''|*[!0-9]*) echo "Install lock stale threshold must be an integer." >&2; exit 2 ;;
  esac
  if [ "$stale_seconds" -gt 3600 ]; then
    echo "Install lock stale threshold must not exceed 3600 seconds." >&2
    exit 2
  fi
  if [ "$stale_seconds" -lt 5 ]; then
    echo "Install lock stale threshold must be at least 5 seconds." >&2
    exit 2
  fi
  if ! mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
    [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] || {
      echo "Install lock path is not a secure directory." >&2
      exit 1
    }
    [ "$(stat -f '%u' "$LOCK_DIR")" = "$(id -u)" ] && \
      [ "$(stat -f '%Lp' "$LOCK_DIR")" = 700 ] || {
        echo "Install lock has unsafe ownership or mode." >&2
        exit 1
      }
    if ls -lde "$LOCK_DIR" | tail -n +2 | grep -q '[^[:space:]]'; then
      echo "Install lock has an unexpected ACL." >&2
      exit 1
    fi
    if [ -e "$LOCK_DIR/owner" ] || [ -L "$LOCK_DIR/owner" ]; then
      [ -f "$LOCK_DIR/owner" ] && [ ! -L "$LOCK_DIR/owner" ] && \
        [ "$(stat -f '%u' "$LOCK_DIR/owner")" = "$(id -u)" ] && \
        [ "$(stat -f '%Lp' "$LOCK_DIR/owner")" = 600 ] || {
          echo "Install lock owner metadata has an unsafe type, owner, or mode." >&2
          exit 1
        }
      if ls -lde "$LOCK_DIR/owner" | tail -n +2 | grep -q '[^[:space:]]'; then
        echo "Install lock owner metadata has an unexpected ACL." >&2
        exit 1
      fi
    fi
    owner_pid="$(sed -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    owner_start="$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    actual_start=""
    case "$owner_pid" in
      ''|*[!0-9]*) ;;
      *)
        if kill -0 "$owner_pid" 2>/dev/null; then
          actual_start="$(ps -o lstart= -p "$owner_pid" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' || true)"
          if [ -z "$owner_start" ] || [ -z "$actual_start" ] || [ "$owner_start" = "$actual_start" ]; then
            echo "Another Recordings.app installer owns the active install lock." >&2
            exit 1
          fi
        fi
        ;;
    esac
    owner_valid=1
    case "$owner_pid" in ''|*[!0-9]*) owner_valid=0 ;; esac
    [ -n "$owner_start" ] || owner_valid=0
    if [ "$owner_valid" -eq 0 ] || [ ! -f "$LOCK_DIR/owner" ] || [ -L "$LOCK_DIR/owner" ]; then
      now="$(date +%s)"
      lock_age=$((now - $(stat -f '%m' "$LOCK_DIR")))
      if [ "$lock_age" -lt "$stale_seconds" ]; then
        echo "Recordings.app install lock is incomplete and too recent to reclaim safely." >&2
        exit 1
      fi
    fi
    stale_claim="${LOCK_DIR}.stale.$$"
    if ! mv "$LOCK_DIR" "$stale_claim" 2>/dev/null; then
      echo "Recordings.app install lock changed during stale-owner recovery." >&2
      exit 1
    fi
    rm -rf "$stale_claim"
    mkdir -m 700 "$LOCK_DIR" || { echo "Could not acquire Recordings.app install lock." >&2; exit 1; }
  fi
  LOCK_OWNED=1
  local start
  start="$(ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' || true)"
  printf '%s\n%s\n' "$$" "$start" >"$LOCK_DIR/owner.tmp.$$"
  chmod 600 "$LOCK_DIR/owner.tmp.$$"
  mv "$LOCK_DIR/owner.tmp.$$" "$LOCK_DIR/owner"
}

trap release_install_lock EXIT
acquire_install_lock
if [ -n "${RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS:-}" ]; then
  sleep "$RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS"
fi

pids_for_exact_executable() {
  local expected="$1"
  local pid
  local command
  while read -r pid command; do
    [ -n "${pid:-}" ] || continue
    case "$command" in
      "$expected"|"$expected "*) printf '%s\n' "$pid" ;;
    esac
  done < <(ps -axo pid=,command= 2>/dev/null || true)
}

stop_uncommitted_candidate() {
  local expected="$APP_DEST/Contents/MacOS/Recordings"
  local candidate_pids
  local pid
  local attempts
  local attempt
  candidate_pids="$(pids_for_exact_executable "$expected")"
  [ -n "$candidate_pids" ] || return 0
  while IFS= read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done <<< "$candidate_pids"
  attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  for ((attempt = 0; attempt < attempts; attempt++)); do
    [ -z "$(pids_for_exact_executable "$expected")" ] && return 0
    sleep 0.1
  done
  while IFS= read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <<< "$candidate_pids"
  sleep 0.1
  [ -z "$(pids_for_exact_executable "$expected")" ] || {
    echo "Uncommitted Recordings.app process could not be stopped before recovery." >&2
    return 1
  }
}

if [ -f "$JOURNAL_PATH" ]; then
  echo "Recovering incomplete Recordings.app installation transaction." >&2
  RECOVER_WAS_RUNNING="$(bun "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field was_running)"
  RECOVER_PHASE="$(bun "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field phase)"
  case "$RECOVER_PHASE" in candidate-moving|candidate-installed|activated|launching) stop_uncommitted_candidate ;; esac
  bun "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"
  if [ "$RECOVER_WAS_RUNNING" = 1 ] && [ -d "$APP_DEST" ] && \
     [ -z "$(pids_for_exact_executable "$APP_DEST/Contents/MacOS/Recordings")" ]; then
    open -n "$APP_DEST" >/dev/null 2>&1 || true
  fi
fi

# Recheck under the install lock. New state is private from creation; legacy
# state remains read-only until its original mode is in the durable journal.
verify_existing_state_root
if [ ! -e "$DATA_PARENT" ]; then
  mkdir -m 700 "$DATA_PARENT"
fi
verify_secure_parent "$DATA_PARENT"
if [ ! -e "$DATA_DIR" ]; then
  mkdir -m 700 "$DATA_DIR"
fi
verify_existing_state_root
ORIGINAL_STATE_MODE="$(stat -f '%Lp' "$DATA_DIR")"

bun "$ARTIFACT_TOOL" verify-archive \
  --archive "$ARTIFACT_PATH" \
  --manifest "$MANIFEST_PATH" \
  --team-id "$EXPECTED_TEAM_ID" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --source-sha "$EXPECTED_SOURCE_SHA" \
  --version "$EXPECTED_VERSION" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
MANIFEST_BUILDER_IDENTITY_KIND="$(bun "$ARTIFACT_TOOL" manifest-get --manifest "$MANIFEST_PATH" --field builder_identity_kind)"

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

verify_secure_parent "$APP_PARENT"
verify_existing_state_root

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
  --version "$EXPECTED_VERSION" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"

add_unique_app() {
  local candidate="$1"
  local existing
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    [ -d "$candidate" ] && [ ! -L "$candidate" ] || {
      echo "Recordings.app path is not a secure directory: ${candidate}" >&2
      exit 1
    }
  fi
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
      if [ -z "$(pids_for_exact_executable "$app_path/Contents/MacOS/Recordings")" ]; then
        open -n "$app_path" >/dev/null 2>&1 || true
      fi
      return 0
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$TRANSACTION_COMMITTED" -ne 1 ] && [ -f "$JOURNAL_PATH" ]; then
    cleanup_phase="$(bun "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field phase 2>/dev/null || true)"
    case "$cleanup_phase" in
      candidate-moving|candidate-installed|activated|launching)
        if ! stop_uncommitted_candidate; then
          echo "Automatic rollback could not stop the uncommitted candidate." >&2
          release_install_lock
          exit 1
        fi
        ;;
    esac
    if ! bun "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"; then
      echo "Automatic rollback failed; preserved transaction evidence at ${JOURNAL_PATH}." >&2
      status=1
    else
      restart_previous_app
    fi
  fi
  rm -rf "$STAGING_DIR" "$WORK_DIR"
  if [ "$TRANSACTION_COMMITTED" -eq 1 ]; then
    rm -rf "$TRANSACTION_DIR"
  elif [ ! -f "$JOURNAL_PATH" ] && [ -d "$TRANSACTION_DIR" ]; then
    rmdir "$TRANSACTION_DIR" 2>/dev/null || true
  fi
  release_install_lock
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
    --state-backup-sha256 "$STATE_BACKUP_SHA256"
    --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256"
    --expected-source-sha "$EXPECTED_SOURCE_SHA"
    --expected-version "$EXPECTED_VERSION"
    --artifact-policy "$ARTIFACT_POLICY"
    --approved-target "$APPROVED_TARGET"
    --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND"
    --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
    --builder-identity-kind "$MANIFEST_BUILDER_IDENTITY_KIND"
    --candidate-identity-sha256 "$candidate_identity_sha256"
    --previous-identity-sha256 "$previous_identity_sha256"
    --original-state-mode "$ORIGINAL_STATE_MODE"
  )
  [ "$was_running" -eq 0 ] || arguments+=(--was-running)
  local index
  for ((index = 0; index < MOVED_ORIGINAL_COUNT; index++)); do
    arguments+=(--original "${MOVED_ORIGINALS[$index]}" "${MOVED_PATHS[$index]}" "${MOVED_DIGESTS[$index]}")
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
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
if [ "$ARTIFACT_POLICY" = "release" ]; then
  xcrun stapler validate "$CANDIDATE_APP"
  spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"
  syspolicy_check distribution "$CANDIDATE_APP"
fi
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

measure_kb() {
  local measured
  measured="$(du -sk "$@" 2>/dev/null | awk '{sum += $1} END {print sum + 0}')"
  case "$measured" in ''|*[!0-9]*) echo "Could not measure transactional storage requirements." >&2; exit 1 ;; esac
  printf '%s\n' "$measured"
}

require_space() {
  local path="$1"
  local required="$2"
  local available
  available="$(df -Pk "$path" | awk 'NR == 2 {print $4}')"
  case "$available" in ''|*[!0-9]*) echo "Could not determine free space for ${path}." >&2; exit 1 ;; esac
  if [ "$available" -lt "$required" ]; then
    echo "Insufficient free space for transactional app and state backups at ${path}." >&2
    exit 1
  fi
}

candidate_kb="$(measure_kb "$CANDIDATE_APP")"
data_kb="$(measure_kb "$DATA_DIR")"
existing_kb=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  existing_kb=$((existing_kb + $(measure_kb "$existing_app")))
done
require_space "$APP_PARENT" $((candidate_kb * 3 + existing_kb * 2 + data_kb * 2 + 10240))
require_space "$DATA_DIR" $((existing_kb * 2 + data_kb * 2 + 10240))

candidate_requirement="$(codesign -d -r- "$CANDIDATE_APP" 2>&1 | sed -n 's/^designated => //p' | head -n 1 || true)"
if [ "$ARTIFACT_POLICY" = "release" ] && [ -z "$candidate_requirement" ]; then
  echo "Candidate app has no designated requirement." >&2
  exit 1
fi
identity_migration=0
candidate_identity_sha256="$(bun "$ARTIFACT_TOOL" requirement-digest --app "$CANDIDATE_APP" --artifact-policy "$ARTIFACT_POLICY")"
[ "$candidate_identity_sha256" = "$(bun "$ARTIFACT_TOOL" manifest-get --manifest "$MANIFEST_SNAPSHOT" --field identity)" ] || {
  echo "Candidate identity does not match the artifact manifest." >&2
  exit 1
}
previous_identity_sha256="none"
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$existing_app" --uid "$(id -u)"
  bun "$ARTIFACT_TOOL" assert-transition --existing-app "$existing_app" --manifest "$MANIFEST_SNAPSHOT"
  existing_requirement="$(codesign -d -r- "$existing_app" 2>&1 | sed -n 's/^designated => //p' | head -n 1 || true)"
  existing_identity_policy="release"
  if [ "$ARTIFACT_POLICY" = "local_only" ] && [ -z "$existing_requirement" ]; then
    existing_identity_policy="local_only"
  fi
  existing_identity_sha256="$(bun "$ARTIFACT_TOOL" requirement-digest --app "$existing_app" --artifact-policy "$existing_identity_policy")"
  if [ "$previous_identity_sha256" = "none" ]; then
    previous_identity_sha256="$existing_identity_sha256"
  elif [ "$previous_identity_sha256" != "$existing_identity_sha256" ]; then
    echo "Installed duplicates have multiple signing identities; automatic migration is unsafe." >&2
    exit 1
  fi
  if [ -z "$existing_requirement" ] || \
     ! codesign --verify --strict -R "$existing_requirement" "$CANDIDATE_APP" >/dev/null 2>&1 || \
     ! codesign --verify --strict -R "$candidate_requirement" "$existing_app" >/dev/null 2>&1; then
    identity_migration=1
  fi
done
if [ "$ARTIFACT_POLICY" = "release" ] && [ "$identity_migration" -eq 1 ] && [ "$ALLOW_IDENTITY_MIGRATION" -ne 1 ]; then
  echo "Candidate and existing app designated requirements are not mutually compatible; review the signer change and rerun once with --allow-signing-identity-migration." >&2
  exit 1
fi
if [ "$ARTIFACT_POLICY" = "release" ] && [ "$identity_migration" -eq 1 ] && {
     [ "$previous_identity_sha256" != "$EXPECTED_OLD_IDENTITY_SHA256" ] ||
     [ "$candidate_identity_sha256" != "$EXPECTED_NEW_IDENTITY_SHA256" ];
   }; then
  echo "Signing identity migration does not match the exact operator-approved old/new identities." >&2
  exit 1
fi
if [ "$ARTIFACT_POLICY" = "release" ] && [ "$identity_migration" -eq 0 ] && [ "$ALLOW_IDENTITY_MIGRATION" -eq 1 ]; then
  echo "Identity migration approval was supplied but no identity migration is required." >&2
  exit 1
fi

chmod 700 "$TRANSACTION_DIR"
mkdir -m 700 "$TRANSACTION_DIR/apps"
mkdir -m 700 "$TRANSACTION_DIR/archives"
verify_secure_parent "$TRANSACTION_DIR"
STATE_BACKUP="$TRANSACTION_DIR/state.initial"
ditto "$DATA_DIR" "$STATE_BACKUP"
if ! diff -qr "$DATA_DIR" "$STATE_BACKUP" >/dev/null; then
  echo "Recordings state backup verification failed before replacement." >&2
  exit 1
fi
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STATE_BACKUP" --uid "$(id -u)"
bun "$ARTIFACT_TOOL" fsync-tree --path "$STATE_BACKUP"
bun "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
STATE_BACKUP_SHA256="$(bun "$ARTIFACT_TOOL" tree-digest --path "$STATE_BACKUP")"

MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_DIGESTS=()
MOVED_ORIGINAL_COUNT=0
move_index=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  move_index=$((move_index + 1))
  MOVED_ORIGINALS+=("$existing_app")
  MOVED_PATHS+=("$TRANSACTION_DIR/apps/original-${move_index}")
  MOVED_DIGESTS+=("$(bun "$ARTIFACT_TOOL" tree-digest --path "$existing_app")")
  MOVED_ORIGINAL_COUNT=$move_index
done
write_journal prepared

ARCHIVE_SEQUENCE=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  ARCHIVE_SEQUENCE=$((ARCHIVE_SEQUENCE + 1))
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$-${ARCHIVE_SEQUENCE}"
  ditto -c -k --sequesterRsrc --keepParent \
    "$existing_app" \
    "$TRANSACTION_DIR/archives/Recordings-pre-install-${stamp}.zip"
  bun "$ARTIFACT_TOOL" fsync-tree --path "$TRANSACTION_DIR/archives/Recordings-pre-install-${stamp}.zip"
done
bun "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR/archives"

ditto "$CANDIDATE_APP" "$STAGED_APP"
bun "$ARTIFACT_TOOL" verify-app \
  --app "$STAGED_APP" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STAGED_APP" --uid "$(id -u)"

for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  RUNNING_EXECUTABLES+=("$existing_app/Contents/MacOS/Recordings")
done
stop_old_processes
NEXT_STATE_BACKUP="$TRANSACTION_DIR/state.stopped"
ditto "$DATA_DIR" "$NEXT_STATE_BACKUP"
if ! diff -qr "$DATA_DIR" "$NEXT_STATE_BACKUP" >/dev/null; then
  echo "Stopped-state backup verification failed before replacement." >&2
  exit 1
fi
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$NEXT_STATE_BACKUP" --uid "$(id -u)"
bun "$ARTIFACT_TOOL" fsync-tree --path "$NEXT_STATE_BACKUP"
bun "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
NEXT_STATE_BACKUP_SHA256="$(bun "$ARTIFACT_TOOL" tree-digest --path "$NEXT_STATE_BACKUP")"
maybe_crash_after_phase state-refresh-copied-before-journal
STATE_BACKUP="$NEXT_STATE_BACKUP"
STATE_BACKUP_SHA256="$NEXT_STATE_BACKUP_SHA256"
write_journal processes-stopped

verify_existing_state_root
[ "$(stat -f '%Lp' "$DATA_DIR")" = "$ORIGINAL_STATE_MODE" ] || {
  echo "Recordings state mode changed after transactional backup." >&2
  exit 1
}
if [ "$ORIGINAL_STATE_MODE" = 755 ]; then
  bun "$ARTIFACT_TOOL" state-mode-harden --path "$DATA_DIR" --uid "$(id -u)"
  maybe_crash_after_phase state-mode-hardened
  [ "${RECORDINGS_TEST_FAIL_AFTER_STATE_MODE_HARDEN:-0}" = 0 ] || exit 1
fi
verify_secure_parent "$DATA_DIR" 1
mkdir -m 700 -p "${DATA_DIR}/audio" "$ROLLBACK_DIR"
verify_secure_parent "$ROLLBACK_DIR" 1
bun "$ARTIFACT_TOOL" fsync-directory --path "$ROLLBACK_DIR"
bun "$ARTIFACT_TOOL" fsync-directory --path "$DATA_DIR"

for rollback_archive in "$TRANSACTION_DIR"/archives/*.zip; do
  [ -e "$rollback_archive" ] || continue
  mv "$rollback_archive" "$ROLLBACK_DIR/$(basename "$rollback_archive")"
  bun "$ARTIFACT_TOOL" fsync-tree --path "$ROLLBACK_DIR/$(basename "$rollback_archive")"
  bun "$ARTIFACT_TOOL" fsync-directory --path "$ROLLBACK_DIR"
done

write_journal originals-moving
for ((move_index = 0; move_index < MOVED_ORIGINAL_COUNT; move_index++)); do
  existing_app="${MOVED_ORIGINALS[$move_index]}"
  moved_path="${MOVED_PATHS[$move_index]}"
  [ "$(bun "$ARTIFACT_TOOL" tree-digest --path "$existing_app")" = "${MOVED_DIGESTS[$move_index]}" ] || {
    echo "Installed Recordings.app changed after transactional backup planning." >&2
    exit 1
  }
  mv "$existing_app" "$moved_path"
  chmod -R go-w "$moved_path"
  bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$moved_path" --uid "$(id -u)"
  bun "$ARTIFACT_TOOL" fsync-tree --path "$moved_path"
  bun "$ARTIFACT_TOOL" fsync-directory --path "$(dirname "$existing_app")"
  bun "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR/apps"
done
write_journal originals-moved

write_journal candidate-moving
mv "$STAGED_APP" "$APP_DEST"
maybe_crash_after_phase candidate-moved-before-journal
bun "$ARTIFACT_TOOL" fsync-tree --path "$APP_DEST"
bun "$ARTIFACT_TOOL" fsync-directory --path "$APP_PARENT"
write_journal candidate-installed
bun "$ARTIFACT_TOOL" verify-app \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
if [ "$ARTIFACT_POLICY" = "release" ]; then
  xcrun stapler validate "$APP_DEST"
  spctl --assess --type execute --verbose=2 "$APP_DEST"
  syspolicy_check distribution "$APP_DEST"
fi
bun "$ARTIFACT_TOOL" verify-filesystem-tree --path "$APP_DEST" --uid "$(id -u)"
bun "$ARTIFACT_TOOL" verify-active \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
"$RUNTIME_SMOKE" "$APP_DEST"
write_journal activated

if [ "$LAUNCH_APP" -eq 1 ] || [ "$was_running" -eq 1 ]; then
  EXPECTED_EXECUTABLE="$APP_DEST/Contents/MacOS/Recordings"
  RUNNING_EXECUTABLES+=("$EXPECTED_EXECUTABLE")
  write_journal launching
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
  maybe_crash_after_phase candidate-launched-before-commit
fi

write_journal committed
bun "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"
TRANSACTION_COMMITTED=1
STOPPED_RUNNING_APP=0

if [ "$ARTIFACT_POLICY" = "local_only" ]; then
  echo "Installed local-only Recordings.app for ${APPROVED_TARGET}; this artifact is ad-hoc signed and non-notarized."
  echo "Microphone or Accessibility may require manual reauthorization after this code-identity change."
elif [ "$identity_migration" -eq 1 ]; then
  echo "Installed a new signing identity; macOS will require one-time permission approval for this migration."
else
  echo "Installed verified Recordings.app release artifact: ${APP_DEST}"
fi
