#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C
export LANG=C
export TZ=UTC0
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# Release installs never resolve integrity-sensitive tools through PATH. The
# test overrides are accepted only when the real host kernel is not Darwin, so
# an inherited environment cannot replace pinned macOS tools in production.
if ! REAL_HOST_KERNEL="$(/usr/bin/uname -s)"; then
  echo "Could not determine the host platform with pinned /usr/bin/uname." >&2
  exit 1
fi
case "$REAL_HOST_KERNEL" in
  Darwin|Linux) ;;
  *)
    echo "Unsupported host platform from pinned /usr/bin/uname: ${REAL_HOST_KERNEL:-<empty>}." >&2
    exit 1
    ;;
esac
if [ "$REAL_HOST_KERNEL" = "Darwin" ]; then
  AWK_EXECUTABLE="/usr/bin/awk"
  BASENAME_EXECUTABLE="/usr/bin/basename"
  CHMOD_EXECUTABLE="/bin/chmod"
  CODESIGN_EXECUTABLE="/usr/bin/codesign"
  CP_EXECUTABLE="/bin/cp"
  DATE_EXECUTABLE="/bin/date"
  DD_EXECUTABLE="/bin/dd"
  DF_EXECUTABLE="/bin/df"
  DIFF_EXECUTABLE="/usr/bin/diff"
  DIRNAME_EXECUTABLE="/usr/bin/dirname"
  DITTO_EXECUTABLE="/usr/bin/ditto"
  DU_EXECUTABLE="/usr/bin/du"
  GREP_EXECUTABLE="/usr/bin/grep"
  HEAD_EXECUTABLE="/usr/bin/head"
  HOSTNAME_EXECUTABLE="/bin/hostname"
  ID_EXECUTABLE="/usr/bin/id"
  IOREG_EXECUTABLE="/usr/sbin/ioreg"
  LS_EXECUTABLE="/bin/ls"
  LSOF_EXECUTABLE="/usr/sbin/lsof"
  MDFIND_EXECUTABLE="/usr/bin/mdfind"
  MKDIR_EXECUTABLE="/bin/mkdir"
  MKTEMP_EXECUTABLE="/usr/bin/mktemp"
  MV_EXECUTABLE="/bin/mv"
  OPEN_EXECUTABLE="/usr/bin/open"
  PS_EXECUTABLE="/bin/ps"
  RM_EXECUTABLE="/bin/rm"
  RMDIR_EXECUTABLE="/bin/rmdir"
  SED_EXECUTABLE="/usr/bin/sed"
  SHASUM_EXECUTABLE="/usr/bin/shasum"
  SLEEP_EXECUTABLE="/bin/sleep"
  SPCTL_EXECUTABLE="/usr/sbin/spctl"
  SQLITE3_EXECUTABLE="/usr/bin/sqlite3"
  STAT_EXECUTABLE="/usr/bin/stat"
  SW_VERS_EXECUTABLE="/usr/bin/sw_vers"
  SYSPOLICY_CHECK_EXECUTABLE="/usr/bin/syspolicy_check"
  TAIL_EXECUTABLE="/usr/bin/tail"
  TR_EXECUTABLE="/usr/bin/tr"
  UNAME_EXECUTABLE="/usr/bin/uname"
  XCRUN_EXECUTABLE="/usr/bin/xcrun"
else
  AWK_EXECUTABLE="${RECORDINGS_TEST_INSTALL_AWK_EXECUTABLE:-/usr/bin/awk}"
  BASENAME_EXECUTABLE="${RECORDINGS_TEST_INSTALL_BASENAME_EXECUTABLE:-/usr/bin/basename}"
  CHMOD_EXECUTABLE="${RECORDINGS_TEST_INSTALL_CHMOD_EXECUTABLE:-/bin/chmod}"
  CODESIGN_EXECUTABLE="${RECORDINGS_TEST_INSTALL_CODESIGN_EXECUTABLE:-/usr/bin/codesign}"
  CP_EXECUTABLE="${RECORDINGS_TEST_INSTALL_CP_EXECUTABLE:-/bin/cp}"
  DATE_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DATE_EXECUTABLE:-/bin/date}"
  DD_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DD_EXECUTABLE:-/bin/dd}"
  DF_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DF_EXECUTABLE:-/bin/df}"
  DIFF_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DIFF_EXECUTABLE:-/usr/bin/diff}"
  DIRNAME_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DIRNAME_EXECUTABLE:-/usr/bin/dirname}"
  DITTO_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DITTO_EXECUTABLE:-/usr/bin/ditto}"
  DU_EXECUTABLE="${RECORDINGS_TEST_INSTALL_DU_EXECUTABLE:-/usr/bin/du}"
  GREP_EXECUTABLE="${RECORDINGS_TEST_INSTALL_GREP_EXECUTABLE:-/usr/bin/grep}"
  HEAD_EXECUTABLE="${RECORDINGS_TEST_INSTALL_HEAD_EXECUTABLE:-/usr/bin/head}"
  HOSTNAME_EXECUTABLE="${RECORDINGS_TEST_INSTALL_HOSTNAME_EXECUTABLE:-/bin/hostname}"
  ID_EXECUTABLE="${RECORDINGS_TEST_INSTALL_ID_EXECUTABLE:-/usr/bin/id}"
  IOREG_EXECUTABLE="${RECORDINGS_TEST_INSTALL_IOREG_EXECUTABLE:-/usr/sbin/ioreg}"
  LS_EXECUTABLE="${RECORDINGS_TEST_INSTALL_LS_EXECUTABLE:-/bin/ls}"
  LSOF_EXECUTABLE="${RECORDINGS_TEST_INSTALL_LSOF_EXECUTABLE:-/usr/sbin/lsof}"
  MDFIND_EXECUTABLE="${RECORDINGS_TEST_INSTALL_MDFIND_EXECUTABLE:-/usr/bin/mdfind}"
  MKDIR_EXECUTABLE="${RECORDINGS_TEST_INSTALL_MKDIR_EXECUTABLE:-/bin/mkdir}"
  MKTEMP_EXECUTABLE="${RECORDINGS_TEST_INSTALL_MKTEMP_EXECUTABLE:-/usr/bin/mktemp}"
  MV_EXECUTABLE="${RECORDINGS_TEST_INSTALL_MV_EXECUTABLE:-/bin/mv}"
  OPEN_EXECUTABLE="${RECORDINGS_TEST_INSTALL_OPEN_EXECUTABLE:-/usr/bin/open}"
  PS_EXECUTABLE="${RECORDINGS_TEST_INSTALL_PS_EXECUTABLE:-/bin/ps}"
  RM_EXECUTABLE="${RECORDINGS_TEST_INSTALL_RM_EXECUTABLE:-/bin/rm}"
  RMDIR_EXECUTABLE="${RECORDINGS_TEST_INSTALL_RMDIR_EXECUTABLE:-/bin/rmdir}"
  SED_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SED_EXECUTABLE:-/usr/bin/sed}"
  SHASUM_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SHASUM_EXECUTABLE:-/usr/bin/shasum}"
  SLEEP_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SLEEP_EXECUTABLE:-/bin/sleep}"
  SPCTL_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SPCTL_EXECUTABLE:-/usr/sbin/spctl}"
  SQLITE3_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SQLITE3_EXECUTABLE:-/usr/bin/sqlite3}"
  STAT_EXECUTABLE="${RECORDINGS_TEST_INSTALL_STAT_EXECUTABLE:-/usr/bin/stat}"
  SW_VERS_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SW_VERS_EXECUTABLE:-/usr/bin/sw_vers}"
  SYSPOLICY_CHECK_EXECUTABLE="${RECORDINGS_TEST_INSTALL_SYSPOLICY_CHECK_EXECUTABLE:-/usr/bin/syspolicy_check}"
  TAIL_EXECUTABLE="${RECORDINGS_TEST_INSTALL_TAIL_EXECUTABLE:-/usr/bin/tail}"
  TR_EXECUTABLE="${RECORDINGS_TEST_INSTALL_TR_EXECUTABLE:-/usr/bin/tr}"
  UNAME_EXECUTABLE="${RECORDINGS_TEST_INSTALL_UNAME_EXECUTABLE:-/usr/bin/uname}"
  XCRUN_EXECUTABLE="${RECORDINGS_TEST_INSTALL_XCRUN_EXECUTABLE:-/usr/bin/xcrun}"
fi
BUN_EXECUTABLE="${RECORDINGS_BUN_EXECUTABLE:-}"

test_fault_hooks_enabled() {
  [ "$REAL_HOST_KERNEL" != "Darwin" ] && \
    [ "${RECORDINGS_TEST_ENABLE_RECOVERY_HOOKS:-0}" = 1 ]
}

require_absolute_executable() {
  local label="$1"
  local executable="$2"
  case "$executable" in
    /*) ;;
    *) echo "${label} must be an absolute executable path." >&2; exit 1 ;;
  esac
  [ -x "$executable" ] || {
    echo "${label} is missing or is not executable: ${executable}" >&2
    exit 1
  }
}

require_absolute_canonical_owned_home() {
  local candidate="${HOME:-}"
  local canonical
  case "$candidate" in
    /*) ;;
    *) echo "Recordings.app installation requires HOME to be an absolute canonical path." >&2; exit 1 ;;
  esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || {
    echo "Recordings.app installation requires HOME to be an absolute canonical path to a non-symlink directory." >&2
    exit 1
  }
  canonical="$(cd "$candidate" 2>/dev/null && builtin pwd -P)" || {
    echo "Recordings.app installation could not resolve HOME canonically." >&2
    exit 1
  }
  [ "$candidate" = "$canonical" ] || {
    echo "Recordings.app installation requires HOME to be an absolute canonical path." >&2
    exit 1
  }
  [ "$("$STAT_EXECUTABLE" -f '%u' "$candidate")" = "$("$ID_EXECUTABLE" -u)" ] || {
    echo "Home ancestor has an unexpected owner." >&2
    exit 1
  }
}

ARTIFACT_PATH=""
MANIFEST_PATH=""
EXPECTED_TEAM_ID="${RECORDINGS_EXPECTED_TEAM_IDENTIFIER:-}"
EXPECTED_MANIFEST_SHA256=""
EXPECTED_SOURCE_SHA=""
EXPECTED_VERSION=""
EXPECTED_OLD_IDENTITY_SHA256=""
EXPECTED_NEW_IDENTITY_SHA256=""
EXPECTED_HOSTNAME=""
EXPECTED_HOSTNAME_SET=0
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
    --expected-hostname)
      EXPECTED_HOSTNAME="${2:-}"
      EXPECTED_HOSTNAME_SET=1
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

if [ "$REAL_HOST_KERNEL" = "Darwin" ] && [ "$ARTIFACT_POLICY" = "release" ]; then
  echo "Release installation requires the root-owned Recordings updater broker; the user-owned shell installer is local-development only." >&2
  exit 1
fi

for tool_variable in \
  AWK_EXECUTABLE BASENAME_EXECUTABLE CHMOD_EXECUTABLE CODESIGN_EXECUTABLE \
  CP_EXECUTABLE DATE_EXECUTABLE DD_EXECUTABLE DF_EXECUTABLE DIFF_EXECUTABLE \
  DIRNAME_EXECUTABLE DITTO_EXECUTABLE DU_EXECUTABLE GREP_EXECUTABLE \
  HEAD_EXECUTABLE HOSTNAME_EXECUTABLE ID_EXECUTABLE IOREG_EXECUTABLE \
  LS_EXECUTABLE LSOF_EXECUTABLE MDFIND_EXECUTABLE MKDIR_EXECUTABLE MKTEMP_EXECUTABLE \
  MV_EXECUTABLE OPEN_EXECUTABLE PS_EXECUTABLE RM_EXECUTABLE RMDIR_EXECUTABLE \
  SED_EXECUTABLE SHASUM_EXECUTABLE SLEEP_EXECUTABLE SPCTL_EXECUTABLE \
  SQLITE3_EXECUTABLE STAT_EXECUTABLE SW_VERS_EXECUTABLE \
  SYSPOLICY_CHECK_EXECUTABLE TAIL_EXECUTABLE TR_EXECUTABLE UNAME_EXECUTABLE \
  XCRUN_EXECUTABLE; do
  require_absolute_executable "$tool_variable" "${!tool_variable}"
done
require_absolute_executable "BUN_EXECUTABLE" "$BUN_EXECUTABLE"
require_absolute_canonical_owned_home

if [ "$("$UNAME_EXECUTABLE" -s)" != "Darwin" ]; then
  echo "Recordings.app installation is only supported on macOS." >&2
  exit 1
fi

if [ -z "$ARTIFACT_PATH" ] || [ -z "$MANIFEST_PATH" ] || \
   [ -z "$EXPECTED_MANIFEST_SHA256" ] || [ -z "$EXPECTED_SOURCE_SHA" ] || \
   [ -z "$EXPECTED_VERSION" ]; then
  echo "Install requires artifact, manifest, authenticated manifest SHA-256, exact source SHA, and exact version." >&2
  exit 2
fi
if [ "$EXPECTED_HOSTNAME_SET" -eq 1 ] && [ -z "$EXPECTED_HOSTNAME" ]; then
  echo "Expected hostname must not be empty." >&2
  exit 2
fi
WORK_DIR="$("$MKTEMP_EXECUTABLE" -d /tmp/recordings-install.XXXXXX)"
cleanup_preflight_work() {
  local status=$?
  trap - EXIT
  "$RM_EXECUTABLE" -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup_preflight_work EXIT
if [ -n "$EXPECTED_HOSTNAME" ]; then
  ACTUAL_HOSTNAME="$("$HOSTNAME_EXECUTABLE" -s)"
  if [ "$ACTUAL_HOSTNAME" != "$EXPECTED_HOSTNAME" ]; then
    echo "Install target hostname ${ACTUAL_HOSTNAME} does not match the expected hostname ${EXPECTED_HOSTNAME}." >&2
    exit 1
  fi
fi
if [ -z "$APPROVED_TARGET_IDENTITY_KIND" ]; then
  if [ "$ARTIFACT_POLICY" = "release" ]; then
    APPROVED_TARGET_IDENTITY_KIND="none"
  else
    # Schema-v3 artifacts created before the discriminator used the platform UUID hash.
    APPROVED_TARGET_IDENTITY_KIND="hardware_uuid_sha256"
  fi
fi
PACKAGE_ROOT="$(cd "$("$DIRNAME_EXECUTABLE" "${BASH_SOURCE[0]}")/.." && pwd)"
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
  ACTUAL_TARGET="$("$HOSTNAME_EXECUTABLE" -s)"
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
    if ! TAILSCALE_CLI="$(recordings_resolve_trusted_tailscale_app_cli "$WORK_DIR")"; then
      echo "Tailscale is required to verify this local-only target identity." >&2
      exit 1
    fi
    if ! ACTUAL_TARGET_IDENTITY_SHA256="$(recordings_run_trusted_tailscale_status "$TAILSCALE_CLI" "$WORK_DIR" | "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tailscale-node-id-sha256 --expected-hostname "$APPROVED_TARGET")"; then
      echo "Could not verify the live Tailscale identity for this local-only target." >&2
      exit 1
    fi
  else
    ACTUAL_PLATFORM_ID="$("$IOREG_EXECUTABLE" -rd1 -c IOPlatformExpertDevice | "$AWK_EXECUTABLE" -F'"' '/IOPlatformUUID/ {print $(NF-1); exit}' | "$TR_EXECUTABLE" '[:upper:]' '[:lower:]')"
    if [ -z "$ACTUAL_PLATFORM_ID" ]; then
      echo "Could not read this Mac platform identity." >&2
      exit 1
    fi
    ACTUAL_TARGET_IDENTITY_SHA256="$(printf '%s' "$ACTUAL_PLATFORM_ID" | "$SHASUM_EXECUTABLE" -a 256 | "$AWK_EXECUTABLE" '{print $1}')"
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
[ -x "$RUNTIME_SMOKE" ] || { echo "Packaged runtime smoke verifier is missing." >&2; exit 1; }
# Fail before creating Applications, state, lock, or maintenance paths when the
# fixed production descriptor guard prebuild is absent or unsafe.
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" native-fs-guard-check
DATA_DIR="${HOME}/.hasna/recordings"
DATA_PARENT="$("$DIRNAME_EXECUTABLE" "$DATA_DIR")"
APP_DEST="${HOME}/Applications/Recordings.app"
APP_PARENT="$("$DIRNAME_EXECUTABLE" "$APP_DEST")"
ROLLBACK_DIR="${DATA_DIR}/rollbacks"
JOURNAL_PATH="${APP_PARENT}/.Recordings-install-transaction.json"
LOCK_DIR="${APP_PARENT}/.Recordings-install-lock"
MAINTENANCE_DIR="${DATA_PARENT}/.recordings-install-maintenance"
READER_LEASES_DIR="${DATA_PARENT}/.recordings-store-readers"
LOCK_OWNED=0
MAINTENANCE_OWNED=0
MAINTENANCE_CLAIM_DIR=""
PRESERVE_MAINTENANCE_MARKER=0
RECOVERED_APP_RESTART_ON_ABORT=0
TRANSACTION_COMMITTED=0
STAGING_REMOVAL_DELEGATED=0
TRANSACTION_DIR=""
TRANSACTION_NONCE=""
STOPPED_RUNNING_APP=0
was_running=0
OLD_PIDS=""
RUNNING_EXECUTABLES=()
PRIOR_RUNNING_APP_PATHS=()
RECOVERED_RUNNING_APP_PATHS=()
SQLITE_BARRIER_ACTIVE=0
SQLITE_BARRIER_PID=""
SQLITE_BARRIER_DIR=""
MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_DIGESTS=()
MOVED_ORIGINAL_COUNT=0
INSTALLER_OWNED_STATE_PATHS=()
INSTALLER_OWNED_STATE_DIGESTS=()

verify_secure_parent() {
  local path="$1"
  local private_mode="${2:-0}"
  [ -d "$path" ] && [ ! -L "$path" ] || { echo "Secure install path must be a non-symlink directory: ${path}" >&2; exit 1; }
  local actual_uid
  local mode
  actual_uid="$("$STAT_EXECUTABLE" -f '%u' "$path")"
  mode="$("$STAT_EXECUTABLE" -f '%Lp' "$path")"
  [ "$actual_uid" = "$("$ID_EXECUTABLE" -u)" ] || { echo "Secure install path has an unexpected owner: ${path}" >&2; exit 1; }
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
  if "$LS_EXECUTABLE" -lde "$path" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
    echo "Secure install path has an unexpected ACL: ${path}" >&2
    exit 1
  fi
}

verify_secure_file() {
  local path="$1"
  local label="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] && \
      [ "$("$STAT_EXECUTABLE" -f '%u' "$path")" = "$("$ID_EXECUTABLE" -u)" ] && \
      [ "$("$STAT_EXECUTABLE" -f '%Lp' "$path")" = 600 ] || {
      echo "${label} has an unsafe type, owner, or mode." >&2
      exit 1
    }
    if "$LS_EXECUTABLE" -lde "$path" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
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
  [ "$("$STAT_EXECUTABLE" -f '%u' "$path")" = "$("$ID_EXECUTABLE" -u)" ] || {
    echo "Home ancestor has an unexpected owner." >&2
    exit 1
  }
  home_mode="$("$STAT_EXECUTABLE" -f '%Lp' "$path")"
  case "$home_mode" in
    *[2367][0-7]|*[0-7][2367])
      echo "Home ancestor is group/world writable." >&2
      exit 1
      ;;
  esac
  home_acl="$("$LS_EXECUTABLE" -lde "$path" | "$TAIL_EXECUTABLE" -n +2)"
  if [ -n "$home_acl" ] && printf '%s\n' "$home_acl" | "$GREP_EXECUTABLE" -v ' deny ' | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
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
  [ "$("$STAT_EXECUTABLE" -f '%u' "$DATA_DIR")" = "$("$ID_EXECUTABLE" -u)" ] || {
    echo "Recordings state path has an unexpected owner." >&2
    exit 1
  }
  state_mode="$("$STAT_EXECUTABLE" -f '%Lp' "$DATA_DIR")"
  case "$state_mode" in
    700|755) ;;
    *) echo "Recordings state path must have mode 700 or the supported legacy mode 755." >&2; exit 1 ;;
  esac
  if "$LS_EXECUTABLE" -lde "$DATA_DIR" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
    echo "Recordings state path has an unexpected ACL." >&2
    exit 1
  fi
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$DATA_DIR" --uid "$("$ID_EXECUTABLE" -u)"
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
  "$MKDIR_EXECUTABLE" -m 700 "$APP_PARENT"
fi
verify_secure_parent "$APP_PARENT"
verify_secure_file "$JOURNAL_PATH" "Install transaction journal"

release_install_lock() {
  if [ "$LOCK_OWNED" -eq 1 ] && [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
    owner_pid="$("$SED_EXECUTABLE" -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    [ "$owner_pid" != "$$" ] || "$RM_EXECUTABLE" -rf "$LOCK_DIR"
  fi
  LOCK_OWNED=0
}

release_maintenance_marker() {
  local marker_removed=0
  if [ "$MAINTENANCE_OWNED" -eq 1 ] && [ -d "$MAINTENANCE_DIR" ] && [ ! -L "$MAINTENANCE_DIR" ]; then
    owner_pid="$("$SED_EXECUTABLE" -n '1p' "$MAINTENANCE_DIR/owner" 2>/dev/null || true)"
    if [ "$owner_pid" = "$$" ]; then
      "$RM_EXECUTABLE" -rf "$MAINTENANCE_DIR"
      marker_removed=1
    fi
  fi
  if [ -n "$MAINTENANCE_CLAIM_DIR" ] && [ -d "$MAINTENANCE_CLAIM_DIR" ] && \
     [ ! -L "$MAINTENANCE_CLAIM_DIR" ]; then
    "$RM_EXECUTABLE" -rf "$MAINTENANCE_CLAIM_DIR"
  fi
  MAINTENANCE_CLAIM_DIR=""
  MAINTENANCE_OWNED=0
  if [ "$marker_removed" -eq 1 ]; then
    "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$DATA_PARENT"
  fi
}

restart_recorded_app_paths() {
  local app_path
  local executable
  for app_path in ${PRIOR_RUNNING_APP_PATHS[@]+"${PRIOR_RUNNING_APP_PATHS[@]}"}; do
    [ -d "$app_path" ] && [ ! -L "$app_path" ] || continue
    executable="$app_path/Contents/MacOS/Recordings"
    if [ -z "$(pids_for_exact_executable "$executable")" ]; then
      "$OPEN_EXECUTABLE" -n "$app_path" >/dev/null 2>&1 || true
    fi
  done
}

release_install_coordination() {
  local status=0
  release_sqlite_barrier || status=1
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && ! release_maintenance_marker; then
    RECOVERED_APP_RESTART_ON_ABORT=0
    status=1
  fi
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ] && \
     [ "$RECOVERED_APP_RESTART_ON_ABORT" -eq 1 ]; then
    restart_recorded_app_paths
  fi
  release_install_lock
  return "$status"
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
  if ! "$MKDIR_EXECUTABLE" -m 700 "$LOCK_DIR" 2>/dev/null; then
    [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] || {
      echo "Install lock path is not a secure directory." >&2
      exit 1
    }
    [ "$("$STAT_EXECUTABLE" -f '%u' "$LOCK_DIR")" = "$("$ID_EXECUTABLE" -u)" ] && \
      [ "$("$STAT_EXECUTABLE" -f '%Lp' "$LOCK_DIR")" = 700 ] || {
        echo "Install lock has unsafe ownership or mode." >&2
        exit 1
      }
    if "$LS_EXECUTABLE" -lde "$LOCK_DIR" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
      echo "Install lock has an unexpected ACL." >&2
      exit 1
    fi
    if [ -e "$LOCK_DIR/owner" ] || [ -L "$LOCK_DIR/owner" ]; then
      [ -f "$LOCK_DIR/owner" ] && [ ! -L "$LOCK_DIR/owner" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$LOCK_DIR/owner")" = "$("$ID_EXECUTABLE" -u)" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%Lp' "$LOCK_DIR/owner")" = 600 ] || {
          echo "Install lock owner metadata has an unsafe type, owner, or mode." >&2
          exit 1
        }
      if "$LS_EXECUTABLE" -lde "$LOCK_DIR/owner" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
        echo "Install lock owner metadata has an unexpected ACL." >&2
        exit 1
      fi
    fi
    owner_pid="$("$SED_EXECUTABLE" -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    owner_start="$("$SED_EXECUTABLE" -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    actual_start=""
    case "$owner_pid" in
      ''|*[!0-9]*) ;;
      *)
        if kill -0 "$owner_pid" 2>/dev/null; then
          actual_start="$("$PS_EXECUTABLE" -o lstart= -p "$owner_pid" 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
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
      now="$("$DATE_EXECUTABLE" +%s)"
      lock_age=$((now - $("$STAT_EXECUTABLE" -f '%m' "$LOCK_DIR")))
      if [ "$lock_age" -lt "$stale_seconds" ]; then
        echo "Recordings.app install lock is incomplete and too recent to reclaim safely." >&2
        exit 1
      fi
    fi
    stale_claim="${LOCK_DIR}.stale.$$"
    if ! "$MV_EXECUTABLE" "$LOCK_DIR" "$stale_claim" 2>/dev/null; then
      echo "Recordings.app install lock changed during stale-owner recovery." >&2
      exit 1
    fi
    "$RM_EXECUTABLE" -rf "$stale_claim"
    "$MKDIR_EXECUTABLE" -m 700 "$LOCK_DIR" || { echo "Could not acquire Recordings.app install lock." >&2; exit 1; }
  fi
  LOCK_OWNED=1
  local start
  start="$("$PS_EXECUTABLE" -o lstart= -p $$ 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
  printf '%s\n%s\n' "$$" "$start" >"$LOCK_DIR/owner.tmp.$$"
  "$CHMOD_EXECUTABLE" 600 "$LOCK_DIR/owner.tmp.$$"
  "$MV_EXECUTABLE" "$LOCK_DIR/owner.tmp.$$" "$LOCK_DIR/owner"
}

acquire_maintenance_marker() {
  local stale_claim
  local owner_pid
  local owner_start
  local actual_start
  local marker_age
  local now
  local owner_valid
  local start
  local stale_seconds="${RECORDINGS_MAINTENANCE_STALE_SECONDS:-30}"
  case "$stale_seconds" in
    ''|*[!0-9]*) echo "Install maintenance stale threshold must be an integer." >&2; exit 2 ;;
  esac
  if [ "$stale_seconds" -gt 3600 ] || [ "$stale_seconds" -lt 5 ]; then
    echo "Install maintenance stale threshold must be between 5 and 3600 seconds." >&2
    exit 2
  fi

  if [ -e "$MAINTENANCE_DIR" ] || [ -L "$MAINTENANCE_DIR" ]; then
    [ -d "$MAINTENANCE_DIR" ] && [ ! -L "$MAINTENANCE_DIR" ] || {
      echo "Install maintenance marker is not a secure directory." >&2
      exit 1
    }
    [ "$("$STAT_EXECUTABLE" -f '%u' "$MAINTENANCE_DIR")" = "$("$ID_EXECUTABLE" -u)" ] && \
      [ "$("$STAT_EXECUTABLE" -f '%Lp' "$MAINTENANCE_DIR")" = 700 ] || {
        echo "Install maintenance marker has unsafe ownership or mode." >&2
        exit 1
      }
    if "$LS_EXECUTABLE" -lde "$MAINTENANCE_DIR" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
      echo "Install maintenance marker has an unexpected ACL." >&2
      exit 1
    fi
    if [ -e "$MAINTENANCE_DIR/owner" ] || [ -L "$MAINTENANCE_DIR/owner" ]; then
      [ -f "$MAINTENANCE_DIR/owner" ] && [ ! -L "$MAINTENANCE_DIR/owner" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$MAINTENANCE_DIR/owner")" = "$("$ID_EXECUTABLE" -u)" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%Lp' "$MAINTENANCE_DIR/owner")" = 600 ] || {
          echo "Install maintenance owner metadata has an unsafe type, owner, or mode." >&2
          exit 1
        }
      if "$LS_EXECUTABLE" -lde "$MAINTENANCE_DIR/owner" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
        echo "Install maintenance owner metadata has an unexpected ACL." >&2
        exit 1
      fi
    fi
    owner_pid="$("$SED_EXECUTABLE" -n '1p' "$MAINTENANCE_DIR/owner" 2>/dev/null || true)"
    owner_start="$("$SED_EXECUTABLE" -n '2p' "$MAINTENANCE_DIR/owner" 2>/dev/null || true)"
    actual_start=""
    case "$owner_pid" in
      ''|*[!0-9]*) ;;
      *)
        if kill -0 "$owner_pid" 2>/dev/null; then
          actual_start="$("$PS_EXECUTABLE" -o lstart= -p "$owner_pid" 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
          if [ -z "$owner_start" ] || [ -z "$actual_start" ] || [ "$owner_start" = "$actual_start" ]; then
            echo "Recordings storage is already in active installation maintenance." >&2
            exit 1
          fi
        fi
        ;;
    esac
    owner_valid=1
    case "$owner_pid" in ''|*[!0-9]*) owner_valid=0 ;; esac
    [ -n "$owner_start" ] || owner_valid=0
    if [ "$owner_valid" -eq 0 ] || [ ! -f "$MAINTENANCE_DIR/owner" ] || [ -L "$MAINTENANCE_DIR/owner" ]; then
      echo "Install maintenance marker has incomplete ownership evidence; refusing automatic recovery." >&2
      exit 1
    fi
    stale_claim="${MAINTENANCE_DIR}.stale.$$"
    if ! "$MV_EXECUTABLE" "$MAINTENANCE_DIR" "$stale_claim" 2>/dev/null; then
      echo "Install maintenance marker changed during stale-owner recovery." >&2
      exit 1
    fi
    "$RM_EXECUTABLE" -rf "$stale_claim"
  fi

  # Publish only a complete marker. Store clients can now treat the canonical
  # path as an atomic maintenance claim: owner metadata is private, durable,
  # and validated before the directory becomes visible at MAINTENANCE_DIR.
  start="$("$PS_EXECUTABLE" -o lstart= -p $$ 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
  [ -n "$start" ] || {
    echo "Could not establish maintenance marker process identity." >&2
    exit 1
  }
  MAINTENANCE_CLAIM_DIR="$("$MKTEMP_EXECUTABLE" -d "${MAINTENANCE_DIR}.claim.XXXXXX")"
  "$CHMOD_EXECUTABLE" 700 "$MAINTENANCE_CLAIM_DIR"
  printf '%s\n%s\n' "$$" "$start" >"$MAINTENANCE_CLAIM_DIR/owner"
  "$CHMOD_EXECUTABLE" 600 "$MAINTENANCE_CLAIM_DIR/owner"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$MAINTENANCE_CLAIM_DIR"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$DATA_PARENT"
  if test_fault_hooks_enabled && \
     [ "${RECORDINGS_TEST_CRASH_DURING_MAINTENANCE_CLAIM:-}" = "before-rename" ]; then
    kill -KILL "$$"
  fi
  [ ! -e "$MAINTENANCE_DIR" ] && [ ! -L "$MAINTENANCE_DIR" ] || {
    echo "Recordings storage maintenance marker appeared during atomic claim." >&2
    exit 1
  }
  "$MV_EXECUTABLE" "$MAINTENANCE_CLAIM_DIR" "$MAINTENANCE_DIR"
  MAINTENANCE_CLAIM_DIR=""
  MAINTENANCE_OWNED=1
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$DATA_PARENT"
  if test_fault_hooks_enabled && \
     [ "${RECORDINGS_TEST_CRASH_DURING_MAINTENANCE_CLAIM:-}" = "after-rename" ]; then
    kill -KILL "$$"
  fi
}

drain_store_reader_leases() {
  local timeout_ms="${RECORDINGS_READER_DRAIN_TIMEOUT_MS:-30000}"
  local attempts
  local attempt=0
  local active_count
  local lease
  local owner_pid
  local owner_start
  local actual_start
  local stale_claim
  case "$timeout_ms" in
    ''|*[!0-9]*) echo "Store reader drain timeout must be an integer." >&2; exit 2 ;;
  esac
  if [ "$timeout_ms" -lt 1000 ] || [ "$timeout_ms" -gt 120000 ]; then
    echo "Store reader drain timeout must be between 1000 and 120000 milliseconds." >&2
    exit 2
  fi
  [ -e "$READER_LEASES_DIR" ] || [ -L "$READER_LEASES_DIR" ] || return 0
  [ -d "$READER_LEASES_DIR" ] && [ ! -L "$READER_LEASES_DIR" ] && \
    [ "$("$STAT_EXECUTABLE" -f '%u' "$READER_LEASES_DIR")" = "$("$ID_EXECUTABLE" -u)" ] && \
    [ "$("$STAT_EXECUTABLE" -f '%Lp' "$READER_LEASES_DIR")" = 700 ] || {
      echo "Store reader lease root has an unsafe type, owner, or mode." >&2
      exit 1
    }
  if "$LS_EXECUTABLE" -lde "$READER_LEASES_DIR" | "$TAIL_EXECUTABLE" -n +2 | "$GREP_EXECUTABLE" -q '[^[:space:]]'; then
    echo "Store reader lease root has an unexpected ACL." >&2
    exit 1
  fi

  attempts=$((timeout_ms / 50))
  while [ "$attempt" -lt "$attempts" ]; do
    active_count=0
    for lease in "$READER_LEASES_DIR"/lease-*; do
      [ -e "$lease" ] || [ -L "$lease" ] || continue
      [ -d "$lease" ] && [ ! -L "$lease" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$lease" 2>/dev/null || true)" = "$("$ID_EXECUTABLE" -u)" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%Lp' "$lease" 2>/dev/null || true)" = 700 ] || {
          [ ! -e "$lease" ] && continue
          echo "Store reader lease has an unsafe type, owner, or mode." >&2
          exit 1
        }
      if [ ! -e "$lease/owner" ] && [ ! -L "$lease/owner" ]; then
        # A compliant reader may have completed and removed its lease between
        # the directory scan and this check. A still-present incomplete lease
        # is never reclaimed because its ownership cannot be proven.
        [ ! -e "$lease" ] && continue
        echo "Store reader lease is missing owner metadata; refusing maintenance." >&2
        exit 1
      fi
      [ -f "$lease/owner" ] && [ ! -L "$lease/owner" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%u' "$lease/owner" 2>/dev/null || true)" = "$("$ID_EXECUTABLE" -u)" ] && \
        [ "$("$STAT_EXECUTABLE" -f '%Lp' "$lease/owner" 2>/dev/null || true)" = 600 ] || {
          [ ! -e "$lease" ] && continue
          echo "Store reader lease owner metadata is unsafe." >&2
          exit 1
        }
      owner_pid="$("$SED_EXECUTABLE" -n '1p' "$lease/owner" 2>/dev/null || true)"
      owner_start="$("$SED_EXECUTABLE" -n '2p' "$lease/owner" 2>/dev/null || true)"
      [ -e "$lease" ] || continue
      case "$owner_pid" in
        ''|*[!0-9]*) echo "Store reader lease has an invalid owner PID." >&2; exit 1 ;;
      esac
      [ -n "$owner_start" ] || {
        echo "Store reader lease has an invalid process identity." >&2
        exit 1
      }
      actual_start="$("$PS_EXECUTABLE" -o lstart= -p "$owner_pid" 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
      if [ "$actual_start" = "$owner_start" ]; then
        active_count=$((active_count + 1))
        continue
      fi
      if [ -z "$actual_start" ] && kill -0 "$owner_pid" 2>/dev/null; then
        echo "Store reader process exists but its start identity cannot be verified." >&2
        exit 1
      fi
      # Empty process identity means the recorded PID no longer exists; a
      # different identity means the PID has been reused. In both cases the
      # exact reader that created this lease is provably dead.
      stale_claim="${lease}.stale.$$"
      if ! "$MV_EXECUTABLE" "$lease" "$stale_claim" 2>/dev/null; then
        [ ! -e "$lease" ] && continue
        echo "Store reader lease changed during dead-owner recovery." >&2
        exit 1
      fi
      "$RM_EXECUTABLE" -rf "$stale_claim"
    done
    [ "$active_count" -eq 0 ] && return 0
    attempt=$((attempt + 1))
    "$SLEEP_EXECUTABLE" 0.05
  done
  echo "Timed out waiting for active local Store operations to finish." >&2
  exit 1
}

validate_sqlite_busy_timeout() {
  local busy_timeout_ms="${RECORDINGS_SQLITE_BUSY_TIMEOUT_MS:-30000}"
  case "$busy_timeout_ms" in
    ''|*[!0-9]*) echo "SQLite busy timeout must be an integer." >&2; return 2 ;;
  esac
  if [ "$busy_timeout_ms" -lt 1000 ] || [ "$busy_timeout_ms" -gt 120000 ]; then
    echo "SQLite busy timeout must be between 1000 and 120000 milliseconds." >&2
    return 2
  fi
  printf '%s\n' "$busy_timeout_ms"
}

canonical_database_is_sqlite() {
  local database_path="${DATA_DIR}/recordings.db"
  local database_header
  [ -e "$database_path" ] || [ -L "$database_path" ] || return 1
  [ -f "$database_path" ] && [ ! -L "$database_path" ] || {
    echo "Canonical Recordings database must be a non-symlink regular file." >&2
    return 2
  }
  # Legacy installs and lifecycle fixtures may preserve an opaque file at this
  # path. Such a file cannot have SQLite readers/writers to drain; preserve it
  # transactionally without asking sqlite3 to parse or mutate it.
  database_header="$("$DD_EXECUTABLE" if="$database_path" bs=15 count=1 2>/dev/null || true)"
  [ "$database_header" = "SQLite format 3" ]
}

acquire_sqlite_barrier() {
  local database_path="${DATA_DIR}/recordings.db"
  local checkpoint_output
  local checkpoint_busy
  local busy_timeout_ms
  local parent_start
  local attempts
  local attempt=0
  [ "$SQLITE_BARRIER_ACTIVE" -eq 0 ] || {
    echo "Canonical Recordings database barrier is already active." >&2
    return 1
  }
  if canonical_database_is_sqlite; then
    :
  else
    local database_status=$?
    [ "$database_status" -eq 1 ] && return 0
    return "$database_status"
  fi
  busy_timeout_ms="$(validate_sqlite_busy_timeout)" || return $?
  if ! checkpoint_output="$("$SQLITE3_EXECUTABLE" -batch "$database_path" 2>/dev/null <<SQL
.timeout ${busy_timeout_ms}
PRAGMA wal_checkpoint(TRUNCATE);
SQL
  )"; then
    echo "Could not checkpoint the canonical Recordings database; refusing maintenance." >&2
    return 1
  fi
  checkpoint_busy="${checkpoint_output%%|*}"
  if [ "$checkpoint_busy" != 0 ]; then
    echo "Canonical Recordings database checkpoint remained busy; refusing maintenance." >&2
    return 1
  fi

  SQLITE_BARRIER_DIR="$("$MKTEMP_EXECUTABLE" -d "${DATA_PARENT}/.recordings-sqlite-barrier.XXXXXX")"
  "$CHMOD_EXECUTABLE" 700 "$SQLITE_BARRIER_DIR"
  parent_start="$("$PS_EXECUTABLE" -o lstart= -p $$ 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
  [ -n "$parent_start" ] || {
    echo "Could not establish SQLite barrier owner identity." >&2
    "$RM_EXECUTABLE" -rf "$SQLITE_BARRIER_DIR"
    SQLITE_BARRIER_DIR=""
    return 1
  }
  (
    {
      printf '%s\n' '.bail on' ".timeout ${busy_timeout_ms}" 'BEGIN EXCLUSIVE;' \
        "SELECT 'RECORDINGS_SQLITE_BARRIER_READY';"
      while [ ! -e "$SQLITE_BARRIER_DIR/release" ]; do
        actual_parent_start="$("$PS_EXECUTABLE" -o lstart= -p $$ 2>/dev/null | "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true)"
        [ "$actual_parent_start" = "$parent_start" ] || break
        "$SLEEP_EXECUTABLE" 0.05
      done
      printf '%s\n' 'COMMIT;'
    } | "$SQLITE3_EXECUTABLE" -batch "$database_path" \
      >"$SQLITE_BARRIER_DIR/ready" 2>"$SQLITE_BARRIER_DIR/error"
  ) &
  SQLITE_BARRIER_PID=$!
  attempts=$((busy_timeout_ms / 50 + 20))
  while [ "$attempt" -lt "$attempts" ]; do
    if "$GREP_EXECUTABLE" -q '^RECORDINGS_SQLITE_BARRIER_READY$' \
      "$SQLITE_BARRIER_DIR/ready" 2>/dev/null; then
      SQLITE_BARRIER_ACTIVE=1
      return 0
    fi
    if ! kill -0 "$SQLITE_BARRIER_PID" 2>/dev/null; then
      wait "$SQLITE_BARRIER_PID" 2>/dev/null || true
      echo "Could not acquire an exclusive canonical Recordings database barrier." >&2
      "$RM_EXECUTABLE" -rf "$SQLITE_BARRIER_DIR"
      SQLITE_BARRIER_PID=""
      SQLITE_BARRIER_DIR=""
      return 1
    fi
    attempt=$((attempt + 1))
    "$SLEEP_EXECUTABLE" 0.05
  done
  : >"$SQLITE_BARRIER_DIR/release"
  wait "$SQLITE_BARRIER_PID" 2>/dev/null || true
  echo "Timed out acquiring an exclusive canonical Recordings database barrier." >&2
  "$RM_EXECUTABLE" -rf "$SQLITE_BARRIER_DIR"
  SQLITE_BARRIER_PID=""
  SQLITE_BARRIER_DIR=""
  return 1
}

release_sqlite_barrier() {
  local status=0
  if [ "$SQLITE_BARRIER_ACTIVE" -eq 1 ] && [ -n "$SQLITE_BARRIER_DIR" ]; then
    : >"$SQLITE_BARRIER_DIR/release"
    if ! wait "$SQLITE_BARRIER_PID"; then
      echo "Canonical Recordings database barrier did not close cleanly." >&2
      status=1
    fi
  fi
  SQLITE_BARRIER_ACTIVE=0
  SQLITE_BARRIER_PID=""
  if [ -n "$SQLITE_BARRIER_DIR" ]; then
    "$RM_EXECUTABLE" -rf "$SQLITE_BARRIER_DIR"
  fi
  SQLITE_BARRIER_DIR=""
  return "$status"
}

quiesce_canonical_database() {
  acquire_sqlite_barrier
  release_sqlite_barrier
}

cleanup_install_coordination_and_work() {
  local status=$?
  trap - EXIT
  release_install_coordination || status=1
  "$RM_EXECUTABLE" -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup_install_coordination_and_work EXIT
acquire_install_lock
if [ ! -e "$DATA_PARENT" ]; then
  "$MKDIR_EXECUTABLE" -m 700 "$DATA_PARENT"
fi
verify_secure_parent "$DATA_PARENT"
acquire_maintenance_marker
drain_store_reader_leases
acquire_sqlite_barrier
if test_fault_hooks_enabled && [ -n "${RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS:-}" ]; then
  "$SLEEP_EXECUTABLE" "$RECORDINGS_TEST_HOLD_AFTER_LOCK_SECONDS"
fi

pids_for_exact_executable() {
  local expected="$1"
  local pid
  local command
  local start_identity
  local observed_executable
  while read -r pid command; do
    [ -n "${pid:-}" ] || continue
    case "$command" in
      "$expected"|"$expected "*)
        start_identity="$(process_start_identity "$pid")"
        observed_executable="$(observed_executable_for_pid "$pid" "$expected")"
        if [ -n "$start_identity" ] && [ "$observed_executable" = "$expected" ]; then
          printf '%s\t%s\t%s\n' "$pid" "$start_identity" "$observed_executable"
        fi
        ;;
    esac
  done < <("$PS_EXECUTABLE" -axo pid=,command= 2>/dev/null || true)
}

process_start_identity() {
  local pid="$1"
  "$PS_EXECUTABLE" -o lstart= -p "$pid" 2>/dev/null | \
    "$TR_EXECUTABLE" -s ' ' | "$SED_EXECUTABLE" 's/^ //;s/ $//' || true
}

observed_executable_for_pid() {
  local pid="$1"
  local expected="$2"
  "$LSOF_EXECUTABLE" -a -p "$pid" -d txt -Fn 2>/dev/null | \
    "$SED_EXECUTABLE" -n 's/^n//p' | \
    "$AWK_EXECUTABLE" -v expected="$expected" '$0 == expected { found = 1 } END { if (found) print expected }' || true
}

process_identity_is_current() {
  local pid="$1"
  local expected_start="$2"
  local expected_executable="$3"
  local actual_start
  local actual_executable
  actual_start="$(process_start_identity "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ] || return 1
  actual_executable="$(observed_executable_for_pid "$pid" "$expected_executable")"
  [ "$actual_executable" = "$expected_executable" ]
}

signal_process_if_current() {
  local signal="$1"
  local pid="$2"
  local expected_start="$3"
  local expected_executable="$4"
  process_identity_is_current "$pid" "$expected_start" "$expected_executable" || return 0
  kill "-${signal}" "$pid" 2>/dev/null || true
}

stop_uncommitted_candidate() {
  local expected="$APP_DEST/Contents/MacOS/Recordings"
  local candidate_records
  local pid
  local start_identity
  local observed_executable
  local attempts
  local attempt
  local remaining
  candidate_records="$(pids_for_exact_executable "$expected")"
  [ -n "$candidate_records" ] || return 0
  while IFS=$'\t' read -r pid start_identity observed_executable; do
    [ -n "$pid" ] || continue
    signal_process_if_current TERM "$pid" "$start_identity" "$observed_executable"
  done <<< "$candidate_records"
  attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  for ((attempt = 0; attempt < attempts; attempt++)); do
    remaining="$(pids_for_exact_executable "$expected")"
    [ -z "$remaining" ] && return 0
    "$SLEEP_EXECUTABLE" 0.1
  done
  while IFS=$'\t' read -r pid start_identity observed_executable; do
    [ -n "$pid" ] || continue
    signal_process_if_current KILL "$pid" "$start_identity" "$observed_executable"
  done <<< "$remaining"
  "$SLEEP_EXECUTABLE" 0.1
  [ -z "$(pids_for_exact_executable "$expected")" ] || {
    echo "Uncommitted Recordings.app process could not be stopped before recovery." >&2
    return 1
  }
}

if [ -f "$JOURNAL_PATH" ]; then
  echo "Recovering incomplete Recordings.app installation transaction." >&2
  if ! RECOVER_WAS_RUNNING="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field was_running)" || \
     ! RECOVER_PHASE="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field phase)" || \
     ! RECOVER_RUNNING_APP_PATHS_JSON="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field prior_running_app_paths)"; then
    PRESERVE_MAINTENANCE_MARKER=1
    echo "Could not read startup recovery evidence; maintenance remains fail-closed." >&2
    exit 1
  fi
  case "$RECOVER_PHASE" in
    candidate-moving|candidate-installed|activated|launching)
      if ! stop_uncommitted_candidate; then
        PRESERVE_MAINTENANCE_MARKER=1
        echo "Could not stop the uncommitted candidate during startup recovery; maintenance remains fail-closed." >&2
        exit 1
      fi
      ;;
  esac
  if ! "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"; then
    PRESERVE_MAINTENANCE_MARKER=1
    echo "Startup recovery failed; maintenance remains fail-closed." >&2
    exit 1
  fi
  if [ "$RECOVER_WAS_RUNNING" = 1 ]; then
    # Do not relaunch the recovered app while this install still owns storage
    # exclusivity. A later safe abort relaunches it after releasing the marker;
    # a successful install carries the running intent to the new app.
    was_running=1
    STOPPED_RUNNING_APP=1
    RECOVERED_APP_RESTART_ON_ABORT=1
    while IFS= read -r recovered_app_path; do
      [ -n "$recovered_app_path" ] || continue
      RECOVERED_RUNNING_APP_PATHS+=("$recovered_app_path")
      PRIOR_RUNNING_APP_PATHS+=("$recovered_app_path")
    done < <("$BUN_EXECUTABLE" -e '
      const paths = JSON.parse(process.argv[1]);
      if (!Array.isArray(paths)) process.exit(1);
      for (const path of paths) console.log(path);
    ' "$RECOVER_RUNNING_APP_PATHS_JSON")
  fi
fi
release_sqlite_barrier

# Recheck under the install lock. New state is private from creation; legacy
# state remains read-only until its original mode is in the durable journal.
verify_existing_state_root
if [ ! -e "$DATA_PARENT" ]; then
  "$MKDIR_EXECUTABLE" -m 700 "$DATA_PARENT"
fi
verify_secure_parent "$DATA_PARENT"
if [ ! -e "$DATA_DIR" ]; then
  "$MKDIR_EXECUTABLE" -m 700 "$DATA_DIR"
fi
verify_existing_state_root
ORIGINAL_STATE_MODE="$("$STAT_EXECUTABLE" -f '%Lp' "$DATA_DIR")"

UNPACK_DIR="${WORK_DIR}/unpacked"
ARTIFACT_SNAPSHOT="${WORK_DIR}/$("$BASENAME_EXECUTABLE" "$ARTIFACT_PATH")"
MANIFEST_SNAPSHOT="${WORK_DIR}/$("$BASENAME_EXECUTABLE" "$MANIFEST_PATH")"
"$MKDIR_EXECUTABLE" -p "$UNPACK_DIR"
"$CP_EXECUTABLE" "$ARTIFACT_PATH" "$ARTIFACT_SNAPSHOT"
"$CP_EXECUTABLE" "$MANIFEST_PATH" "$MANIFEST_SNAPSHOT"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-archive \
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
MANIFEST_BUILDER_IDENTITY_KIND="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" manifest-get \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --field builder_identity_kind)"

CURRENT_MACOS="$("$SW_VERS_EXECUTABLE" -productVersion)"
MINIMUM_MACOS="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" manifest-get \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --field minimum_macos)"
if ! "$BUN_EXECUTABLE" -e '
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
TARGET_ARCH="$("$UNAME_EXECUTABLE" -m)"
MANIFEST_ARCHITECTURES="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" manifest-get \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --field architectures)"
case " ${MANIFEST_ARCHITECTURES} " in
  *" ${TARGET_ARCH} "*) ;;
  *) echo "Recordings.app artifact does not support target architecture ${TARGET_ARCH}." >&2; exit 1 ;;
esac

verify_secure_parent "$APP_PARENT"
verify_existing_state_root

STAGING_DIR="$("$MKTEMP_EXECUTABLE" -d "${APP_PARENT}/.Recordings-install.XXXXXX")"
STAGED_APP="${STAGING_DIR}/Recordings.app"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-archive \
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

process_records_for_known_apps() {
  local pid
  local command
  local executable
  local command_matches
  local observed_executable
  local start_identity
  while read -r pid command; do
    [ -n "${pid:-}" ] || continue
    command_matches=0
    for executable in ${RUNNING_EXECUTABLES[@]+"${RUNNING_EXECUTABLES[@]}"}; do
      case "$command" in
        "$executable"|"$executable "*)
          command_matches=1
          break
          ;;
      esac
    done
    [ "$command_matches" -eq 1 ] || continue
    observed_executable=""
    for executable in ${RUNNING_EXECUTABLES[@]+"${RUNNING_EXECUTABLES[@]}"}; do
      observed_executable="$(observed_executable_for_pid "$pid" "$executable")"
      if [ -n "$observed_executable" ]; then
        break
      fi
    done
    [ -n "$observed_executable" ] || continue
    start_identity="$(process_start_identity "$pid")"
    [ -n "$start_identity" ] || continue
    printf '%s\t%s\t%s\n' "$pid" "$start_identity" "$observed_executable"
  done < <("$PS_EXECUTABLE" -axo pid=,command= 2>/dev/null || true)
}

stop_old_processes() {
  local journal_phase="${1:-processes-stopping}"
  local current_records
  local app_path
  local executable
  local already_recorded
  local index
  local pid
  local start_identity
  local observed_executable
  current_records="$(process_records_for_known_apps)"
  LAST_STOPPED_PROCESS_COUNT=0
  [ -n "$current_records" ] || return 0
  while IFS=$'\t' read -r pid start_identity observed_executable; do
    [ -n "$pid" ] || continue
    LAST_STOPPED_PROCESS_COUNT=$((LAST_STOPPED_PROCESS_COUNT + 1))
  done <<< "$current_records"
  if [ -n "$OLD_PIDS" ]; then
    while IFS=$'\t' read -r pid start_identity observed_executable; do
      [ -n "$pid" ] || continue
      OLD_PIDS="${OLD_PIDS}"$'\n'"${pid}"
    done <<< "$current_records"
  else
    OLD_PIDS="$(printf '%s\n' "$current_records" | "$AWK_EXECUTABLE" -F '\t' '{ print $1 }')"
  fi
  while IFS=$'\t' read -r pid start_identity observed_executable; do
    case "$observed_executable" in
      */Contents/MacOS/Recordings) app_path="${observed_executable%/Contents/MacOS/Recordings}" ;;
      */Contents/Helpers/recordings) app_path="${observed_executable%/Contents/Helpers/recordings}" ;;
      *) continue ;;
    esac
    for ((index = 0; index < MOVED_ORIGINAL_COUNT; index++)); do
      if [ "$app_path" = "${MOVED_PATHS[$index]}" ]; then
        app_path="${MOVED_ORIGINALS[$index]}"
        break
      fi
    done
    already_recorded=0
    for recorded_path in ${PRIOR_RUNNING_APP_PATHS[@]+"${PRIOR_RUNNING_APP_PATHS[@]}"}; do
      [ "$recorded_path" != "$app_path" ] || already_recorded=1
    done
    [ "$already_recorded" -eq 1 ] || PRIOR_RUNNING_APP_PATHS+=("$app_path")
  done <<< "$current_records"
  was_running=1
  STOPPED_RUNNING_APP=1
  # Before the authoritative state backup there is intentionally no journal:
  # no app or state mutation has happened yet, so a crash can only leave the
  # prior app stopped. Once a journal exists, record every later stop phase.
  [ ! -f "$JOURNAL_PATH" ] || write_journal "$journal_phase"
  while IFS=$'\t' read -r pid start_identity observed_executable; do
    [ -n "$pid" ] || continue
    signal_process_if_current TERM "$pid" "$start_identity" "$observed_executable"
  done <<< "$current_records"
  local attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  local remaining=0
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    remaining=0
    while IFS=$'\t' read -r pid start_identity observed_executable; do
      if process_identity_is_current "$pid" "$start_identity" "$observed_executable"; then
        remaining=1
        break
      fi
    done <<< "$current_records"
    [ "$remaining" -eq 0 ] && break
    "$SLEEP_EXECUTABLE" 0.1
  done
  if [ "$remaining" -ne 0 ]; then
    echo "Existing Recordings.app process did not stop before replacement." >&2
    exit 1
  fi
}

quiesce_old_processes() {
  local journal_phase="$1"
  local required_empty_scans=10
  local consecutive_empty_scans=0
  local attempts=$((LAUNCH_TIMEOUT_SECONDS * 10 + required_empty_scans))
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    stop_old_processes "$journal_phase"
    if [ "$LAST_STOPPED_PROCESS_COUNT" -eq 0 ]; then
      consecutive_empty_scans=$((consecutive_empty_scans + 1))
      [ "$consecutive_empty_scans" -lt "$required_empty_scans" ] || return 0
    else
      consecutive_empty_scans=0
    fi
    "$SLEEP_EXECUTABLE" 0.1
  done
  echo "Existing Recordings.app processes did not remain quiescent before replacement." >&2
  exit 1
}

restart_previous_app() {
  [ "$STOPPED_RUNNING_APP" -eq 1 ] || return 0
  restart_recorded_app_paths
}

cleanup() {
  local status=$?
  local restart_after_release=0
  trap - EXIT
  if [ "$TRANSACTION_COMMITTED" -ne 1 ] && [ -f "$JOURNAL_PATH" ]; then
    STAGING_REMOVAL_DELEGATED=1
    cleanup_phase="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-get --journal "$JOURNAL_PATH" --field phase 2>/dev/null || true)"
    case "$cleanup_phase" in
      candidate-moving|candidate-installed|activated|launching)
        if ! stop_uncommitted_candidate; then
          echo "Automatic rollback could not stop the uncommitted candidate." >&2
          PRESERVE_MAINTENANCE_MARKER=1
          RECOVERED_APP_RESTART_ON_ABORT=0
          release_install_coordination
          exit 1
        fi
        ;;
    esac
    if [ "$SQLITE_BARRIER_ACTIVE" -eq 0 ] && ! acquire_sqlite_barrier; then
      echo "Automatic rollback could not establish the SQLite writer barrier; preserved transaction evidence at ${JOURNAL_PATH}." >&2
      PRESERVE_MAINTENANCE_MARKER=1
      RECOVERED_APP_RESTART_ON_ABORT=0
      status=1
    elif ! "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"; then
      echo "Automatic rollback failed; preserved transaction evidence at ${JOURNAL_PATH}." >&2
      PRESERVE_MAINTENANCE_MARKER=1
      RECOVERED_APP_RESTART_ON_ABORT=0
      status=1
    else
      restart_after_release=1
    fi
  elif [ "$TRANSACTION_COMMITTED" -ne 1 ] && [ "$RECOVERED_APP_RESTART_ON_ABORT" -eq 1 ]; then
    restart_after_release=1
  fi
  if ! release_sqlite_barrier; then
    PRESERVE_MAINTENANCE_MARKER=1
    restart_after_release=0
    status=1
  fi
  if [ "$STAGING_REMOVAL_DELEGATED" -eq 0 ]; then
    "$RM_EXECUTABLE" -rf "$STAGING_DIR"
  fi
  "$RM_EXECUTABLE" -rf "$WORK_DIR"
  if [ -n "$TRANSACTION_DIR" ] && [ ! -f "$JOURNAL_PATH" ] && [ -d "$TRANSACTION_DIR" ]; then
    if ! "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" transaction-cleanup \
      --transaction-dir "$TRANSACTION_DIR" \
      --nonce "$TRANSACTION_NONCE"; then
      echo "Could not safely isolate the pre-journal transaction; preserving maintenance evidence." >&2
      PRESERVE_MAINTENANCE_MARKER=1
      status=1
    fi
  fi
  if [ "$PRESERVE_MAINTENANCE_MARKER" -eq 0 ]; then
    if ! release_maintenance_marker; then
      restart_after_release=0
      status=1
    fi
    [ "$restart_after_release" -eq 0 ] || restart_previous_app
  fi
  release_install_lock
  exit "$status"
}
trap cleanup EXIT

maybe_crash_after_phase() {
  local phase="$1"
  if test_fault_hooks_enabled && [ "${RECORDINGS_TEST_CRASH_AFTER_PHASE:-}" = "$phase" ]; then
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
    --candidate-staging "$STAGING_DIR"
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
    --candidate-tree-sha256 "$candidate_tree_sha256"
    --previous-identity-sha256 "$previous_identity_sha256"
    --original-state-mode "$ORIGINAL_STATE_MODE"
  )
  [ "$was_running" -eq 0 ] || arguments+=(--was-running)
  for prior_running_app_path in ${PRIOR_RUNNING_APP_PATHS[@]+"${PRIOR_RUNNING_APP_PATHS[@]}"}; do
    arguments+=(--prior-running-app-path "$prior_running_app_path")
  done
  local index
  for ((index = 0; index < MOVED_ORIGINAL_COUNT; index++)); do
    arguments+=(--original "${MOVED_ORIGINALS[$index]}" "${MOVED_PATHS[$index]}" "${MOVED_DIGESTS[$index]}")
  done
  for ((index = 0; index < ${#INSTALLER_OWNED_STATE_PATHS[@]}; index++)); do
    arguments+=(
      --installer-owned-state
      "${INSTALLER_OWNED_STATE_PATHS[$index]}"
      "${INSTALLER_OWNED_STATE_DIGESTS[$index]}"
    )
  done
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" "${arguments[@]}"
  STAGING_REMOVAL_DELEGATED=1
  maybe_crash_after_phase "$phase"
}

"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" extract-verified-archive \
  --archive "$ARTIFACT_SNAPSHOT" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --staging-target "$UNPACK_DIR" \
  --team-id "$EXPECTED_TEAM_ID" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --source-sha "$EXPECTED_SOURCE_SHA" \
  --version "$EXPECTED_VERSION" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
CANDIDATE_APP="$UNPACK_DIR/Recordings.app"

"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-app \
  --app "$CANDIDATE_APP" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
if [ "$ARTIFACT_POLICY" = "release" ]; then
  "$XCRUN_EXECUTABLE" stapler validate "$CANDIDATE_APP"
  "$SPCTL_EXECUTABLE" --assess --type execute --verbose=2 "$CANDIDATE_APP"
  "$SYSPOLICY_CHECK_EXECUTABLE" distribution "$CANDIDATE_APP"
fi
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$CANDIDATE_APP" --uid "$("$ID_EXECUTABLE" -u)"

DISCOVERED_APPS=()
add_unique_app "$APP_DEST"
add_unique_app "${DATA_DIR}/Recordings.app"
for candidate in "${HOME}"/Applications/Recordings.app.*; do
  add_unique_app "$candidate"
done
add_unique_app "/Applications/Recordings.app"
if [ -x "$MDFIND_EXECUTABLE" ]; then
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    add_unique_app "$candidate"
  done < <("$MDFIND_EXECUTABLE" "kMDItemCFBundleIdentifier == 'com.hasna.recordings'" 2>/dev/null || true)
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
  measured="$("$DU_EXECUTABLE" -sk "$@" 2>/dev/null | "$AWK_EXECUTABLE" '{sum += $1} END {print sum + 0}')"
  case "$measured" in ''|*[!0-9]*) echo "Could not measure transactional storage requirements." >&2; exit 1 ;; esac
  printf '%s\n' "$measured"
}

require_space() {
  local path="$1"
  local required="$2"
  local available
  available="$("$DF_EXECUTABLE" -Pk "$path" | "$AWK_EXECUTABLE" 'NR == 2 {print $4}')"
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

candidate_requirement="$("$CODESIGN_EXECUTABLE" -d -r- "$CANDIDATE_APP" 2>&1 | "$SED_EXECUTABLE" -n 's/^designated => //p' | "$HEAD_EXECUTABLE" -n 1 || true)"
if [ "$ARTIFACT_POLICY" = "release" ] && [ -z "$candidate_requirement" ]; then
  echo "Candidate app has no designated requirement." >&2
  exit 1
fi
identity_migration=0
candidate_identity_sha256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" requirement-digest --app "$CANDIDATE_APP" --artifact-policy "$ARTIFACT_POLICY")"
candidate_tree_sha256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$CANDIDATE_APP")"
[ "$candidate_identity_sha256" = "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" manifest-get \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --field identity)" ] || {
  echo "Candidate identity does not match the artifact manifest." >&2
  exit 1
}
previous_identity_sha256="none"
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$existing_app" --uid "$("$ID_EXECUTABLE" -u)"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" assert-transition \
    --existing-app "$existing_app" \
    --manifest "$MANIFEST_SNAPSHOT" \
    --manifest-sha256 "$EXPECTED_MANIFEST_SHA256"
  existing_requirement="$("$CODESIGN_EXECUTABLE" -d -r- "$existing_app" 2>&1 | "$SED_EXECUTABLE" -n 's/^designated => //p' | "$HEAD_EXECUTABLE" -n 1 || true)"
  existing_identity_policy="release"
  if [ "$ARTIFACT_POLICY" = "local_only" ] && [ -z "$existing_requirement" ]; then
    existing_identity_policy="local_only"
  fi
  existing_identity_sha256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" requirement-digest --app "$existing_app" --artifact-policy "$existing_identity_policy")"
  if [ "$previous_identity_sha256" = "none" ]; then
    previous_identity_sha256="$existing_identity_sha256"
  elif [ "$previous_identity_sha256" != "$existing_identity_sha256" ]; then
    echo "Installed duplicates have multiple signing identities; automatic migration is unsafe." >&2
    exit 1
  fi
  if [ -z "$existing_requirement" ] || \
     ! "$CODESIGN_EXECUTABLE" --verify --strict -R "$existing_requirement" "$CANDIDATE_APP" >/dev/null 2>&1 || \
     ! "$CODESIGN_EXECUTABLE" --verify --strict -R "$candidate_requirement" "$existing_app" >/dev/null 2>&1; then
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

TRANSACTION_DIR="$("$MKTEMP_EXECUTABLE" -d "${APP_PARENT}/.Recordings-transaction.XXXXXX")"
TRANSACTION_NONCE="$("$BUN_EXECUTABLE" -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
printf '%s\n' "$TRANSACTION_NONCE" >"$TRANSACTION_DIR/.Recordings-transaction-owner"
"$CHMOD_EXECUTABLE" 600 "$TRANSACTION_DIR/.Recordings-transaction-owner"
"$CHMOD_EXECUTABLE" 700 "$TRANSACTION_DIR"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree \
  --path "$TRANSACTION_DIR/.Recordings-transaction-owner"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
"$MKDIR_EXECUTABLE" -m 700 "$TRANSACTION_DIR/apps"
"$MKDIR_EXECUTABLE" -m 700 "$TRANSACTION_DIR/archives"
verify_secure_parent "$TRANSACTION_DIR"

acquire_sqlite_barrier
STATE_BACKUP="$TRANSACTION_DIR/state.initial"
"$DITTO_EXECUTABLE" "$DATA_DIR" "$STATE_BACKUP"
if ! "$DIFF_EXECUTABLE" -qr "$DATA_DIR" "$STATE_BACKUP" >/dev/null; then
  echo "Recordings state backup verification failed before replacement." >&2
  exit 1
fi
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STATE_BACKUP" --uid "$("$ID_EXECUTABLE" -u)"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$STATE_BACKUP"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
STATE_BACKUP_SHA256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$STATE_BACKUP")"
release_sqlite_barrier

MOVED_ORIGINALS=()
MOVED_PATHS=()
MOVED_DIGESTS=()
MOVED_ORIGINAL_COUNT=0
move_index=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  move_index=$((move_index + 1))
  MOVED_ORIGINALS+=("$existing_app")
  MOVED_PATHS+=("$TRANSACTION_DIR/apps/original-${move_index}")
  MOVED_DIGESTS+=("$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$existing_app")")
  MOVED_ORIGINAL_COUNT=$move_index
done
write_journal prepared

ARCHIVE_SEQUENCE=0
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  ARCHIVE_SEQUENCE=$((ARCHIVE_SEQUENCE + 1))
  stamp="$("$DATE_EXECUTABLE" -u +%Y%m%dT%H%M%SZ)-$$-${ARCHIVE_SEQUENCE}"
  rollback_archive="$TRANSACTION_DIR/archives/Recordings-pre-install-${stamp}.zip"
  rollback_destination="$ROLLBACK_DIR/Recordings-pre-install-${stamp}.zip"
  [ ! -e "$rollback_destination" ] && [ ! -L "$rollback_destination" ] || {
    echo "Refusing to overwrite an existing rollback archive destination." >&2
    exit 1
  }
  "$DITTO_EXECUTABLE" -c -k --sequesterRsrc --keepParent \
    "$existing_app" \
    "$rollback_archive"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$rollback_archive"
  INSTALLER_OWNED_STATE_PATHS+=("$rollback_destination")
  INSTALLER_OWNED_STATE_DIGESTS+=(
    "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$rollback_archive")"
  )
done
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR/archives"

"$DITTO_EXECUTABLE" "$CANDIDATE_APP" "$STAGED_APP"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-app \
  --app "$STAGED_APP" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$STAGED_APP" --uid "$("$ID_EXECUTABLE" -u)"
[ "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$STAGED_APP")" = \
  "$candidate_tree_sha256" ] || {
  echo "Staged candidate does not match the authenticated candidate tree." >&2
  exit 1
}

# Store readers are already drained. Archive and stage while the current app
# remains available, then stop every known app and packaged helper immediately
# before the authoritative stopped-state snapshot. Recovery deliberately does
# not restore state for prepared/processes-stopping; only processes-stopped and
# later phases bind rollback to the stopped snapshot.
for existing_app in ${MANAGEABLE_APPS[@]+"${MANAGEABLE_APPS[@]}"}; do
  RUNNING_EXECUTABLES+=("$existing_app/Contents/MacOS/Recordings")
  RUNNING_EXECUTABLES+=("$existing_app/Contents/Helpers/recordings")
done
stop_old_processes
acquire_sqlite_barrier
# A previous release may ignore the new maintenance marker and relaunch from
# its helper. Rescan immediately on both sides of the authoritative copy while
# the exclusive SQLite transaction prevents any surviving writer from landing.
stop_old_processes
NEXT_STATE_BACKUP="$TRANSACTION_DIR/state.stopped"
"$DITTO_EXECUTABLE" "$DATA_DIR" "$NEXT_STATE_BACKUP"
stop_old_processes
if ! "$DIFF_EXECUTABLE" -qr "$DATA_DIR" "$NEXT_STATE_BACKUP" >/dev/null; then
  echo "Stopped-state backup verification failed before replacement." >&2
  exit 1
fi
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$NEXT_STATE_BACKUP" --uid "$("$ID_EXECUTABLE" -u)"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$NEXT_STATE_BACKUP"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
NEXT_STATE_BACKUP_SHA256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$NEXT_STATE_BACKUP")"
maybe_crash_after_phase state-refresh-copied-before-journal
STATE_BACKUP="$NEXT_STATE_BACKUP"
STATE_BACKUP_SHA256="$NEXT_STATE_BACKUP_SHA256"
write_journal processes-stopped
# The durable journal boundary can race an older helper relaunch. Quiesce every
# known bundle, then refresh into a new immutable snapshot. If another known
# writer appears after that journal update, repeat with a fresh generation; an
# already-journaled backup is never changed in place. Standalone writers that
# cannot be identified here are merged conservatively during rollback.
STOPPED_REFRESH_STABLE=0
for ((refresh_attempt = 1; refresh_attempt <= 5; refresh_attempt++)); do
  quiesce_old_processes processes-stopped
  REFRESHED_STATE_BACKUP="$TRANSACTION_DIR/state.stopped.${refresh_attempt}"
  "$DITTO_EXECUTABLE" "$DATA_DIR" "$REFRESHED_STATE_BACKUP"
  stop_old_processes processes-stopped
  if [ "$LAST_STOPPED_PROCESS_COUNT" -ne 0 ] || \
     ! "$DIFF_EXECUTABLE" -qr "$DATA_DIR" "$REFRESHED_STATE_BACKUP" >/dev/null; then
    continue
  fi
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree \
    --path "$REFRESHED_STATE_BACKUP" --uid "$("$ID_EXECUTABLE" -u)"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$REFRESHED_STATE_BACKUP"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR"
  STATE_BACKUP="$REFRESHED_STATE_BACKUP"
  STATE_BACKUP_SHA256="$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$STATE_BACKUP")"
  write_journal processes-stopped
  stop_old_processes processes-stopped
  if [ "$LAST_STOPPED_PROCESS_COUNT" -eq 0 ]; then
    STOPPED_REFRESH_STABLE=1
    break
  fi
done
[ "$STOPPED_REFRESH_STABLE" -eq 1 ] || {
  echo "Existing Recordings.app writers did not remain quiescent around the stopped-state refresh." >&2
  exit 1
}

# This phase is durable before changing state mode, creating install-owned
# directories, or moving exact archived bundles into the state tree.
write_journal state-mutating

verify_existing_state_root
[ "$("$STAT_EXECUTABLE" -f '%Lp' "$DATA_DIR")" = "$ORIGINAL_STATE_MODE" ] || {
  echo "Recordings state mode changed after transactional backup." >&2
  exit 1
}
if [ "$ORIGINAL_STATE_MODE" = 755 ]; then
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" state-mode-harden --path "$DATA_DIR" --uid "$("$ID_EXECUTABLE" -u)"
  maybe_crash_after_phase state-mode-hardened
  if test_fault_hooks_enabled && \
     [ "${RECORDINGS_TEST_FAIL_AFTER_STATE_MODE_HARDEN:-0}" != 0 ]; then
    exit 1
  fi
fi
verify_secure_parent "$DATA_DIR" 1
"$MKDIR_EXECUTABLE" -m 700 -p "${DATA_DIR}/audio" "$ROLLBACK_DIR"
verify_secure_parent "$ROLLBACK_DIR" 1
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$ROLLBACK_DIR"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$DATA_DIR"

for ((archive_index = 0; archive_index < ${#INSTALLER_OWNED_STATE_PATHS[@]}; archive_index++)); do
  rollback_destination="${INSTALLER_OWNED_STATE_PATHS[$archive_index]}"
  rollback_archive="$TRANSACTION_DIR/archives/$("$BASENAME_EXECUTABLE" "$rollback_destination")"
  [ "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$rollback_archive")" = \
    "${INSTALLER_OWNED_STATE_DIGESTS[$archive_index]}" ] || {
    echo "Transactional rollback archive changed before state installation." >&2
    exit 1
  }
  [ ! -e "$rollback_destination" ] && [ ! -L "$rollback_destination" ] || {
    echo "Rollback archive destination appeared during installation." >&2
    exit 1
  }
  "$MV_EXECUTABLE" "$rollback_archive" "$rollback_destination"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$rollback_destination"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$ROLLBACK_DIR"
done

write_journal originals-moving
stop_old_processes originals-moving
for ((move_index = 0; move_index < MOVED_ORIGINAL_COUNT; move_index++)); do
  existing_app="${MOVED_ORIGINALS[$move_index]}"
  moved_path="${MOVED_PATHS[$move_index]}"
  [ "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$existing_app")" = "${MOVED_DIGESTS[$move_index]}" ] || {
    echo "Installed Recordings.app changed after transactional backup planning." >&2
    exit 1
  }
  RECORDINGS_TEST_INSTALLER_PID="$$" \
    "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" install-archive-original \
      --journal "$JOURNAL_PATH" \
      --source "$existing_app" \
      --destination "$moved_path" \
      --expected-tree-sha256 "${MOVED_DIGESTS[$move_index]}"
  RUNNING_EXECUTABLES+=("$moved_path/Contents/MacOS/Recordings")
  RUNNING_EXECUTABLES+=("$moved_path/Contents/Helpers/recordings")
  "$CHMOD_EXECUTABLE" -R go-w "$moved_path"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$moved_path" --uid "$("$ID_EXECUTABLE" -u)"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$moved_path"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$("$DIRNAME_EXECUTABLE" "$existing_app")"
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$TRANSACTION_DIR/apps"
done
write_journal originals-moved
# A process launched in the narrow rename window now resolves through lsof to
# the moved bundle. Stop that exact start/executable identity before releasing
# the SQLite barrier; PID reuse or a different executable is never signalled.
quiesce_old_processes originals-moved
release_sqlite_barrier

write_journal candidate-moving
RECORDINGS_TEST_INSTALLER_PID="$$" \
  "$BUN_EXECUTABLE" "$ARTIFACT_TOOL" install-publish-candidate \
    --journal "$JOURNAL_PATH" \
    --staging "$STAGED_APP" \
    --destination "$APP_DEST" \
    --expected-tree-sha256 "$candidate_tree_sha256"
maybe_crash_after_phase candidate-moved-before-journal
[ "$("$BUN_EXECUTABLE" "$ARTIFACT_TOOL" tree-digest --path "$APP_DEST")" = \
  "$candidate_tree_sha256" ] || {
  echo "Installed candidate changed during publication." >&2
  exit 1
}
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-tree --path "$APP_DEST"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" fsync-directory --path "$APP_PARENT"
write_journal candidate-installed
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-app \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
if [ "$ARTIFACT_POLICY" = "release" ]; then
  "$XCRUN_EXECUTABLE" stapler validate "$APP_DEST"
  "$SPCTL_EXECUTABLE" --assess --type execute --verbose=2 "$APP_DEST"
  "$SYSPOLICY_CHECK_EXECUTABLE" distribution "$APP_DEST"
fi
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-filesystem-tree --path "$APP_DEST" --uid "$("$ID_EXECUTABLE" -u)"
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" verify-active \
  --app "$APP_DEST" \
  --manifest "$MANIFEST_SNAPSHOT" \
  --manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --team-id "$EXPECTED_TEAM_ID" \
  --artifact-policy "$ARTIFACT_POLICY" \
  --approved-target "$APPROVED_TARGET" \
  --approved-target-identity-kind "$APPROVED_TARGET_IDENTITY_KIND" \
  --approved-target-identity-sha256 "$APPROVED_TARGET_IDENTITY_SHA256"
SMOKE_TOOL_PATH="/usr/bin:/bin:/usr/sbin:/sbin:$("$DIRNAME_EXECUTABLE" "$BUN_EXECUTABLE")"
PATH="$SMOKE_TOOL_PATH" "$RUNTIME_SMOKE" "$APP_DEST" "$BUN_EXECUTABLE"
write_journal activated

write_journal committed
STAGING_REMOVAL_DELEGATED=1
"$BUN_EXECUTABLE" "$ARTIFACT_TOOL" journal-recover --journal "$JOURNAL_PATH"
TRANSACTION_COMMITTED=1
STOPPED_RUNNING_APP=0

if [ "$LAUNCH_APP" -eq 1 ] || [ "$was_running" -eq 1 ]; then
  EXPECTED_EXECUTABLE="$APP_DEST/Contents/MacOS/Recordings"
  RUNNING_EXECUTABLES+=("$EXPECTED_EXECUTABLE")
  "$OPEN_EXECUTABLE" -n "$APP_DEST"
  attempts=$((LAUNCH_TIMEOUT_SECONDS * 10))
  launched_pid=""
  launched_start_identity=""
  for ((attempt = 0; attempt < attempts; attempt++)); do
    while IFS=$'\t' read -r pid start_identity observed_executable; do
      [ -n "$pid" ] || continue
      launched_pid="$pid"
      launched_start_identity="$start_identity"
      break
    done < <(pids_for_exact_executable "$EXPECTED_EXECUTABLE")
    [ -n "$launched_pid" ] && break
    "$SLEEP_EXECUTABLE" 0.1
  done
  if [ -z "$launched_pid" ]; then
    echo "Canonical app did not launch from ${EXPECTED_EXECUTABLE} within ${LAUNCH_TIMEOUT_SECONDS} seconds." >&2
    exit 1
  fi
  "$SLEEP_EXECUTABLE" 1
  if ! process_identity_is_current "$launched_pid" "$launched_start_identity" "$EXPECTED_EXECUTABLE"; then
    echo "Canonical app process exited before the stability window completed." >&2
    exit 1
  fi
  maybe_crash_after_phase candidate-launched-after-commit
fi

if [ "$ARTIFACT_POLICY" = "local_only" ]; then
  echo "Installed local-only Recordings.app for ${APPROVED_TARGET}; this artifact is ad-hoc signed and non-notarized."
  echo "Microphone or Accessibility may require manual reauthorization after this code-identity change."
elif [ "$identity_migration" -eq 1 ]; then
  echo "Installed a new signing identity; macOS will require one-time permission approval for this migration."
else
  echo "Installed verified Recordings.app release artifact: ${APP_DEST}"
fi
