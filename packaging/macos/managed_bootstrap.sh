#!/bin/bash
# Noninteractive MDM/base-image entry point for bootstrap and exact crash recovery.

set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
export LANG=C
export TZ=UTC0

PKG=""
MANIFEST=""
ENVELOPE=""
EXPECTED_PACKAGE_SHA256=""
EXPECTED_INSTALLER_TEAM_ID=""
EXPECTED_INSTALLER_CERTIFICATE_SHA256=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact) PKG="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --envelope) ENVELOPE="${2:-}"; shift 2 ;;
    --expected-package-sha256) EXPECTED_PACKAGE_SHA256="${2:-}"; shift 2 ;;
    --expected-installer-team-id) EXPECTED_INSTALLER_TEAM_ID="${2:-}"; shift 2 ;;
    --expected-installer-certificate-sha256) EXPECTED_INSTALLER_CERTIFICATE_SHA256="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$EXPECTED_PACKAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Managed bootstrap requires an out-of-band pinned package SHA-256." >&2
  exit 2
}
[[ "$EXPECTED_INSTALLER_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "Managed bootstrap requires an exact out-of-band Installer Team ID." >&2
  exit 2
}
[[ "$EXPECTED_INSTALLER_CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Managed bootstrap requires an exact out-of-band Installer certificate SHA-256." >&2
  exit 2
}
[ "$(/usr/bin/id -u)" = "0" ] || { echo "Managed bootstrap must run as root through MDM." >&2; exit 1; }

path_exists_or_symlink() {
  [ -e "$1" ] || [ -L "$1" ]
}

require_no_extended_acl() {
  local path="$1"
  local acl_listing acl_status
  acl_listing="$(/bin/ls -lade "$path")" || {
    echo "Managed bootstrap could not inspect extended ACLs on: $path" >&2
    exit 1
  }
  if /usr/bin/printf '%s\n' "$acl_listing" | /usr/bin/awk '
    NR == 1 && length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
    NR > 1 && $1 ~ /^[0-9]+:$/ { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    echo "Managed bootstrap trust path has an unexpected extended ACL: $path" >&2
    exit 1
  else
    acl_status=$?
    [ "$acl_status" -eq 1 ] || {
      echo "Managed bootstrap could not evaluate extended ACLs on: $path" >&2
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
    echo "Managed bootstrap could not recursively inspect extended ACLs on: $tree" >&2
    exit 1
  }
  if /usr/bin/printf '%s\n' "$acl_listing" | /usr/bin/awk '
    length($1) == 11 && substr($1, 11, 1) == "+" { found = 1 }
    $1 ~ /^[0-9]+:$/ { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    echo "Managed bootstrap tree has an unexpected extended ACL: $tree" >&2
    exit 1
  else
    acl_status=$?
    [ "$acl_status" -eq 1 ] || {
      echo "Managed bootstrap could not evaluate recursive extended ACLs on: $tree" >&2
      exit 1
    }
  fi
}

require_root_owned_nonwritable_directory() {
  local directory="$1"
  local mode
  [ -d "$directory" ] && [ ! -L "$directory" ] && \
    [ "$(/usr/bin/stat -f '%u' "$directory")" = 0 ] || {
    echo "Managed bootstrap target ancestry is missing, linked, or not root-owned: $directory" >&2
    exit 1
  }
  mode="$(/usr/bin/stat -f '%Lp' "$directory")"
  [ $((8#$mode & 8#022)) -eq 0 ] || {
    echo "Managed bootstrap target ancestry is group/other writable: $directory" >&2
    exit 1
  }
  require_no_extended_acl "$directory"
}

# Standard macOS permits the admin group to install app bundles. Executable
# authority remains the pinned Developer ID/audit-token policy, so accept only
# that exact OS topology and reject every ACL or broader mode.
require_managed_applications_directory() {
  local mode group_id
  [ -d "/Applications" ] && [ ! -L "/Applications" ] && \
    [ "$(/usr/bin/stat -f '%u' "/Applications")" = 0 ] || {
    echo "Managed bootstrap requires a root-owned canonical /Applications directory." >&2
    exit 1
  }
  require_no_extended_acl "/Applications"
  mode="$(/usr/bin/stat -f '%Lp' "/Applications")"
  group_id="$(/usr/bin/stat -f '%g' "/Applications")"
  case "$mode:$group_id" in
    755:*|775:80) ;;
    *)
      echo "Managed bootstrap requires ACL-free /Applications mode 0755 or root:admin mode 0775." >&2
      exit 1
      ;;
  esac
}

require_expected_var_link() {
  local var_target
  [ -L "/var" ] || {
    echo "Managed bootstrap requires the canonical macOS /var system link." >&2
    exit 1
  }
  var_target="$(/usr/bin/readlink "/var")" || {
    echo "Managed bootstrap could not inspect the macOS /var system link." >&2
    exit 1
  }
  [ "$var_target" = "private/var" ] && \
    [ "$(cd "/var" && /bin/pwd -P)" = "/private/var" ] || {
    echo "Managed bootstrap found a noncanonical macOS /var system link." >&2
    exit 1
  }
}

validate_target_ancestry() {
  local required_target_ancestor optional_target_ancestor
  require_expected_var_link
  require_managed_applications_directory
  for required_target_ancestor in \
    "/" \
    "/Library" \
    "/Library/Application Support" \
    "/Library/PrivilegedHelperTools" \
    "/Library/LaunchDaemons" \
    "/private" \
    "/private/var" \
    "/private/var/db"; do
    require_root_owned_nonwritable_directory "$required_target_ancestor"
  done
  for optional_target_ancestor in \
    "/Library/Application Support/Hasna" \
    "/Library/Application Support/Hasna/Recordings"; do
    if path_exists_or_symlink "$optional_target_ancestor"; then
      require_root_owned_nonwritable_directory "$optional_target_ancestor"
    fi
  done
}

validate_target_ancestry

CLIENT="/Applications/Recordings.app/Contents/Helpers/recordings-update-client"
STATE="/var/db/com.hasna.recordings.updater/release-state.json"
AUTHORIZATION_ROOT="/private/var/db/com.hasna.recordings.bootstrap-authorization"
AUTHORIZATION_JOURNAL="${AUTHORIZATION_ROOT}/journal"
AUTHORIZATION_NEXT="${AUTHORIZATION_ROOT}/.journal.next"
COHORT_PATHS=(
  "/Library/PrivilegedHelperTools/com.hasna.recordings.updater"
  "/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
  "/Library/LaunchDaemons/com.hasna.recordings.updater.plist"
  "/Applications/Recordings.app"
  "$CLIENT"
  "/Library/Application Support/Hasna/Recordings/Trust"
  "/Library/Application Support/Hasna/Recordings/Bootstrap"
  "/Library/Application Support/Hasna/Recordings/Updates"
  "/var/db/com.hasna.recordings.updater"
)

validate_managed_input() {
  local input="$1"
  local parent canonical_parent leaf expected relative current component mode
  case "$input" in
    /*) ;;
    *) echo "Managed bootstrap inputs must be absolute." >&2; exit 2 ;;
  esac
  case "$input" in
    *$'\n'*|*'//'*|*'/./'*|*'/../'*|*/.|*/..) echo "Managed bootstrap input path is not canonical." >&2; exit 1 ;;
  esac
  parent="$(/usr/bin/dirname "$input")"
  leaf="$(/usr/bin/basename "$input")"
  canonical_parent="$(cd "$parent" && /bin/pwd -P)" || {
    echo "Managed bootstrap input parent is unavailable." >&2
    exit 1
  }
  if [ "$canonical_parent" = / ]; then expected="/$leaf"; else expected="$canonical_parent/$leaf"; fi
  [ "$input" = "$expected" ] || { echo "Managed bootstrap input path is not canonical." >&2; exit 1; }
  require_root_owned_nonwritable_directory "/"
  relative="${canonical_parent#/}"
  current=""
  IFS='/' read -r -a input_components <<<"$relative"
  for component in "${input_components[@]}"; do
    [ -n "$component" ] || continue
    current="$current/$component"
    require_root_owned_nonwritable_directory "$current"
  done
  [ -f "$input" ] && [ ! -L "$input" ] && [ "$(/usr/bin/stat -f '%u' "$input")" = 0 ] || {
    echo "Managed bootstrap input is missing, linked, or not root-owned." >&2
    exit 1
  }
  mode="$(/usr/bin/stat -f '%Lp' "$input")"
  [ $((8#$mode & 8#022)) -eq 0 ] || {
    echo "Managed bootstrap inputs must not be group/other writable." >&2
    exit 1
  }
  require_no_extended_acl "$input"
}

for input in "$PKG" "$MANIFEST" "$ENVELOPE"; do validate_managed_input "$input"; done

SNAPSHOT_PARENT="/private/var/db"
require_root_owned_nonwritable_directory "$SNAPSHOT_PARENT"
WORK_DIR="$(/usr/bin/mktemp -d "$SNAPSHOT_PARENT/recordings-bootstrap.XXXXXX")"
/bin/chmod -N "$WORK_DIR"
/bin/chmod 0700 "$WORK_DIR"
require_no_extended_acl "$WORK_DIR"
cleanup() {
  local status=$?
  trap - EXIT
  /bin/rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

snapshot_input() {
  local source="$1"
  local target="$2"
  local before after copied
  before="$(/usr/bin/shasum -a 256 "$source" | /usr/bin/awk '{ print $1 }')"
  /bin/cp "$source" "$target"
  /bin/chmod -N "$target"
  /bin/chmod 0400 "$target"
  require_no_extended_acl "$target"
  copied="$(/usr/bin/shasum -a 256 "$target" | /usr/bin/awk '{ print $1 }')"
  after="$(/usr/bin/shasum -a 256 "$source" | /usr/bin/awk '{ print $1 }')"
  [ "$before" = "$copied" ] && [ "$before" = "$after" ] || {
    echo "Managed bootstrap input changed while taking a root-private snapshot." >&2
    exit 1
  }
}

SNAPSHOT_PKG="$WORK_DIR/bootstrap.pkg"
SNAPSHOT_MANIFEST="$WORK_DIR/manifest.json"
SNAPSHOT_ENVELOPE="$WORK_DIR/envelope.json"
snapshot_input "$PKG" "$SNAPSHOT_PKG"
snapshot_input "$MANIFEST" "$SNAPSHOT_MANIFEST"
snapshot_input "$ENVELOPE" "$SNAPSHOT_ENVELOPE"
ACTUAL_PKG_SHA256="$(/usr/bin/shasum -a 256 "$SNAPSHOT_PKG" | /usr/bin/awk '{ print $1 }')"
[ "$EXPECTED_PACKAGE_SHA256" = "$ACTUAL_PKG_SHA256" ] || {
  echo "Supplied PKG does not match the management-pinned digest." >&2
  exit 1
}

/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty TMPDIR="$WORK_DIR" \
  /usr/sbin/spctl --assess --type install --verbose=2 "$SNAPSHOT_PKG"
PKG_SIGNATURE="$(/usr/sbin/pkgutil --check-signature "$SNAPSHOT_PKG")"
/usr/bin/grep -E "^[[:space:]]*1\\. Developer ID Installer: .+ \\(${EXPECTED_INSTALLER_TEAM_ID}\\)$" \
  <<<"$PKG_SIGNATURE" >/dev/null
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P)"
PKGUTIL_FINGERPRINT_PARSER="$SCRIPT_DIR/pkgutil_fingerprint.awk"
[ -f "$PKGUTIL_FINGERPRINT_PARSER" ] && [ ! -L "$PKGUTIL_FINGERPRINT_PARSER" ] || {
  echo "Managed bootstrap fingerprint parser is missing or unsafe." >&2
  exit 1
}
ACTUAL_INSTALLER_CERTIFICATE_SHA256="$(printf '%s\n' "$PKG_SIGNATURE" | \
  /usr/bin/awk -f "$PKGUTIL_FINGERPRINT_PARSER")" || {
  echo "Could not parse the Installer certificate SHA-256 fingerprint." >&2
  exit 1
}
[ "$ACTUAL_INSTALLER_CERTIFICATE_SHA256" = "$EXPECTED_INSTALLER_CERTIFICATE_SHA256" ] || {
  echo "Supplied PKG has the wrong Installer certificate fingerprint." >&2
  exit 1
}

EXPANDED="$WORK_DIR/expanded"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty TMPDIR="$WORK_DIR" \
  /usr/sbin/pkgutil --expand-full "$SNAPSHOT_PKG" "$EXPANDED"
/bin/chmod -RN "$EXPANDED"
require_tree_without_extended_acl "$EXPANDED"
PAYLOAD="$EXPANDED/Payload"
PREFLIGHT="$EXPANDED/Scripts/recordings-bootstrap-preflight"
EXPANDED_PREINSTALL="$EXPANDED/Scripts/preinstall"
EXPANDED_POSTINSTALL="$EXPANDED/Scripts/postinstall"
PAYLOAD_CLIENT="$PAYLOAD/Applications/Recordings.app/Contents/Helpers/recordings-update-client"
[ -d "$PAYLOAD" ] && [ ! -L "$PAYLOAD" ] && \
  [ -x "$PREFLIGHT" ] && [ ! -L "$PREFLIGHT" ] && \
  [ -x "$EXPANDED_PREINSTALL" ] && [ ! -L "$EXPANDED_PREINSTALL" ] && \
  [ -x "$EXPANDED_POSTINSTALL" ] && [ ! -L "$EXPANDED_POSTINSTALL" ] && \
  [ -x "$PAYLOAD_CLIENT" ] && [ ! -L "$PAYLOAD_CLIENT" ] || {
  echo "Verified PKG does not contain the expected expanded payload and preflight verifier." >&2
  exit 1
}

extract_package_bootstrap_id() {
  local script="$1"
  local identity
  identity="$(/usr/bin/sed -n 's/^PACKAGE_BOOTSTRAP_ID="\([0-9a-f-]*\)"$/\1/p' "$script")"
  [[ "$identity" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    echo "Verified PKG script does not carry one valid package bootstrap identity." >&2
    exit 1
  }
  printf '%s\n' "$identity"
}

PREINSTALL_BOOTSTRAP_ID="$(extract_package_bootstrap_id "$EXPANDED_PREINSTALL")"
POSTINSTALL_BOOTSTRAP_ID="$(extract_package_bootstrap_id "$EXPANDED_POSTINSTALL")"
[ "$PREINSTALL_BOOTSTRAP_ID" = "$POSTINSTALL_BOOTSTRAP_ID" ] || {
  echo "Verified PKG scripts carry conflicting bootstrap identities." >&2
  exit 1
}
PACKAGE_BOOTSTRAP_ID="$PREINSTALL_BOOTSTRAP_ID"

verify_preflight_identity() {
  local details authority team identifier timestamp flags
  /usr/bin/codesign --verify --strict --all-architectures --verbose=2 "$PREFLIGHT"
  details="$(/usr/bin/codesign -d --verbose=4 "$PREFLIGHT" 2>&1)"
  authority="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Authority=/ { print $2; exit }')"
  team="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  identifier="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Identifier=/ { print $2; exit }')"
  timestamp="$(printf '%s\n' "$details" | /usr/bin/awk -F= '/^Timestamp=/ { print $2; exit }')"
  flags="$(printf '%s\n' "$details" | /usr/bin/sed -n 's/^CodeDirectory .*flags=[^(]*(\([^)]*\)).*/\1/p' | /usr/bin/head -n 1)"
  [[ "$authority" == "Developer ID Application:"* ]] && \
    [ "$team" = "$EXPECTED_INSTALLER_TEAM_ID" ] && \
    [ "$identifier" = "com.hasna.recordings.bootstrap-preflight" ] || {
    echo "Bootstrap preflight verifier has the wrong signed identity." >&2
    exit 1
  }
  case ",$flags," in *,runtime,*) ;; *) echo "Bootstrap preflight verifier lacks hardened runtime." >&2; exit 1 ;; esac
  case "$timestamp" in ''|none|None|NONE) echo "Bootstrap preflight verifier lacks a trusted timestamp." >&2; exit 1 ;; esac
}
verify_preflight_identity

run_preflight() {
  local require_committed="${1:-false}"
  local args=(
    --package "$SNAPSHOT_PKG"
    --manifest "$SNAPSHOT_MANIFEST"
    --envelope "$SNAPSHOT_ENVELOPE"
    --payload-root "$PAYLOAD"
    --expected-team-id "$EXPECTED_INSTALLER_TEAM_ID"
    --installer-certificate-sha256 "$ACTUAL_INSTALLER_CERTIFICATE_SHA256"
  )
  if path_exists_or_symlink "$STATE"; then
    [ -f "$STATE" ] && [ ! -L "$STATE" ] || {
      echo "Installed release state is missing or unsafe." >&2
      exit 1
    }
    require_no_extended_acl "$STATE"
    args+=(--release-state "$STATE")
  fi
  if [ "$require_committed" = true ]; then args+=(--require-committed-state); fi
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty TMPDIR="$WORK_DIR" \
    LC_ALL=C LANG=C TZ=UTC0 "$PREFLIGHT" "${args[@]}"
}

read_journal_value() {
  local key="$1"
  /usr/bin/awk -F= -v key="$key" '
    $1 == key { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$AUTHORIZATION_JOURNAL"
}

require_authorization_journal() {
  path_exists_or_symlink "$AUTHORIZATION_ROOT" && \
    [ -d "$AUTHORIZATION_ROOT" ] && [ ! -L "$AUTHORIZATION_ROOT" ] && \
    [ "$(/usr/bin/stat -f '%u:%g:%Lp' "$AUTHORIZATION_ROOT")" = "0:0:700" ] || {
    echo "Managed bootstrap authorization evidence is missing or unsafe." >&2
    exit 1
  }
  [ -f "$AUTHORIZATION_JOURNAL" ] && [ ! -L "$AUTHORIZATION_JOURNAL" ] && \
    [ "$(/usr/bin/stat -f '%u:%g:%Lp' "$AUTHORIZATION_JOURNAL")" = "0:0:400" ] && \
    [ "$(/usr/bin/stat -f '%l' "$AUTHORIZATION_JOURNAL")" = "1" ] && \
    [ "$(/usr/bin/wc -l <"$AUTHORIZATION_JOURNAL" | /usr/bin/tr -d ' ')" = "6" ] || {
    echo "Managed bootstrap authorization journal is missing or unsafe." >&2
    exit 1
  }
  require_no_extended_acl "$AUTHORIZATION_ROOT"
  require_no_extended_acl "$AUTHORIZATION_JOURNAL"
  [ "$(read_journal_value schema_version)" = "1" ] || { echo "Managed bootstrap authorization journal schema is invalid." >&2; exit 1; }
  JOURNAL_PHASE="$(read_journal_value phase)"
  JOURNAL_PACKAGE_SHA256="$(read_journal_value package_sha256)"
  JOURNAL_PACKAGE_BOOTSTRAP_ID="$(read_journal_value package_bootstrap_id)"
  JOURNAL_INSTALLER_TEAM_ID="$(read_journal_value installer_team_id)"
  JOURNAL_INSTALLER_CERTIFICATE_SHA256="$(read_journal_value installer_certificate_sha256)"
  case "$JOURNAL_PHASE" in authorized|installer-started) ;; *) echo "Managed bootstrap authorization journal phase is invalid." >&2; exit 1 ;; esac
  [[ "$JOURNAL_PACKAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] && \
    [[ "$JOURNAL_PACKAGE_BOOTSTRAP_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && \
    [[ "$JOURNAL_INSTALLER_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] && \
    [[ "$JOURNAL_INSTALLER_CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Managed bootstrap authorization journal values are malformed." >&2
    exit 1
  }
  [ "$JOURNAL_PACKAGE_SHA256" = "$ACTUAL_PKG_SHA256" ] && \
    [ "$JOURNAL_PACKAGE_BOOTSTRAP_ID" = "$PACKAGE_BOOTSTRAP_ID" ] && \
    [ "$JOURNAL_INSTALLER_TEAM_ID" = "$EXPECTED_INSTALLER_TEAM_ID" ] && \
    [ "$JOURNAL_INSTALLER_CERTIFICATE_SHA256" = "$ACTUAL_INSTALLER_CERTIFICATE_SHA256" ] || {
    echo "Managed bootstrap authorization journal belongs to a different authenticated package." >&2
    exit 1
  }
}

write_authorization_journal() {
  local temporary_journal
  ! path_exists_or_symlink "$AUTHORIZATION_ROOT" && ! path_exists_or_symlink "$AUTHORIZATION_JOURNAL" || {
    echo "Managed bootstrap refuses to replace existing authorization evidence." >&2
    exit 1
  }
  /bin/mkdir -m 0700 "$AUTHORIZATION_ROOT"
  /usr/sbin/chown root:wheel "$AUTHORIZATION_ROOT"
  /bin/chmod -N "$AUTHORIZATION_ROOT"
  /bin/chmod 0700 "$AUTHORIZATION_ROOT"
  temporary_journal="$(/usr/bin/mktemp "$AUTHORIZATION_ROOT/.journal.XXXXXX")"
  /usr/bin/printf 'schema_version=1\nphase=authorized\npackage_sha256=%s\npackage_bootstrap_id=%s\ninstaller_team_id=%s\ninstaller_certificate_sha256=%s\n' \
    "$ACTUAL_PKG_SHA256" "$PACKAGE_BOOTSTRAP_ID" "$EXPECTED_INSTALLER_TEAM_ID" \
    "$ACTUAL_INSTALLER_CERTIFICATE_SHA256" >"$temporary_journal"
  /usr/sbin/chown root:wheel "$temporary_journal"
  /bin/chmod -N "$temporary_journal"
  /bin/chmod 0400 "$temporary_journal"
  require_no_extended_acl "$temporary_journal"
  /bin/mv "$temporary_journal" "$AUTHORIZATION_JOURNAL"
  /bin/sync
  require_authorization_journal
}

remove_authorization_journal() {
  require_authorization_journal
  if path_exists_or_symlink "$AUTHORIZATION_NEXT"; then
    [ -f "$AUTHORIZATION_NEXT" ] && [ ! -L "$AUTHORIZATION_NEXT" ] && \
      [ "$(/usr/bin/stat -f '%u:%g' "$AUTHORIZATION_NEXT")" = "0:0" ] && \
      [ "$(/usr/bin/stat -f '%l' "$AUTHORIZATION_NEXT")" = "1" ] || {
      echo "Managed bootstrap authorization journal staging is unsafe." >&2
      exit 1
    }
    case "$(/usr/bin/stat -f '%Lp' "$AUTHORIZATION_NEXT")" in 400|600) ;; *) echo "Managed bootstrap authorization journal staging mode is unsafe." >&2; exit 1 ;; esac
    require_no_extended_acl "$AUTHORIZATION_NEXT"
    /bin/rm -f "$AUTHORIZATION_NEXT"
  fi
  /bin/rm -f "$AUTHORIZATION_JOURNAL"
  /bin/rmdir "$AUTHORIZATION_ROOT"
  /bin/sync
}

require_safe_existing_cohort_path() {
  local path="$1"
  local expected_mode="$2"
  local entry listing device mode owner links invalid=0
  [ ! -L "$path" ] && [ "$(/usr/bin/stat -f '%u' "$path")" = "0" ] || {
    echo "Managed bootstrap cohort evidence is linked or not root-owned: $path" >&2
    exit 1
  }
  mode="$(/usr/bin/stat -f '%Lp' "$path")"
  case "$expected_mode:$mode" in
    "$mode:$mode"|700-or-755:700|700-or-755:755) ;;
    *)
      echo "Managed bootstrap cohort evidence has ownership/mode drift: $path" >&2
      exit 1
      ;;
  esac
  require_tree_without_extended_acl "$path"
  if [ -f "$path" ]; then
    [ "$(/usr/bin/stat -f '%l' "$path")" = "1" ] || { echo "Managed bootstrap cohort evidence is hard-linked: $path" >&2; exit 1; }
    return
  fi
  [ -d "$path" ] || { echo "Managed bootstrap cohort evidence is not a regular file or directory: $path" >&2; exit 1; }
  listing="$(/usr/bin/mktemp -t recordings-bootstrap-cohort)"
  device="$(/usr/bin/stat -f '%d' "$path")"
  /usr/bin/find -x "$path" -print0 >"$listing" || { /bin/rm -f "$listing"; exit 1; }
  while IFS= read -r -d '' entry; do
    owner="$(/usr/bin/stat -f '%u' "$entry")" || { invalid=1; break; }
    mode="$(/usr/bin/stat -f '%Lp' "$entry")" || { invalid=1; break; }
    [ ! -L "$entry" ] && [ "$owner" = "0" ] && \
      [ "$(/usr/bin/stat -f '%d' "$entry")" = "$device" ] && \
      [ $((8#$mode & 8#022)) -eq 0 ] || { invalid=1; break; }
    if [ -f "$entry" ]; then
      links="$(/usr/bin/stat -f '%l' "$entry")" || { invalid=1; break; }
      [ "$links" = "1" ] || { invalid=1; break; }
    elif [ ! -d "$entry" ]; then
      invalid=1
      break
    fi
  done <"$listing"
  /bin/rm -f "$listing"
  [ "$invalid" -eq 0 ] || { echo "Managed bootstrap cohort evidence contains unsafe structure: $path" >&2; exit 1; }
}

cohort_expected_mode() {
  case "$1" in
    "/Library/PrivilegedHelperTools/com.hasna.recordings.updater"|\
    "/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier") printf '555\n' ;;
    "/Library/LaunchDaemons/com.hasna.recordings.updater.plist") printf '444\n' ;;
    "/Applications/Recordings.app"|"$CLIENT") printf '755\n' ;;
    "/Library/Application Support/Hasna/Recordings/Trust") printf '700-or-755\n' ;;
    "/Library/Application Support/Hasna/Recordings/Bootstrap"|\
    "/Library/Application Support/Hasna/Recordings/Updates"|\
    "/var/db/com.hasna.recordings.updater") printf '700\n' ;;
    *) return 1 ;;
  esac
}

# Cryptographic release preflight is mandatory before Installer or any exact
# bootstrap recovery replay. No packaged script or release key is trusted first.
run_preflight false

present_count=0
for cohort_path in "${COHORT_PATHS[@]}"; do
  if path_exists_or_symlink "$cohort_path"; then
    present_count=$((present_count + 1))
    require_safe_existing_cohort_path "$cohort_path" "$(cohort_expected_mode "$cohort_path")"
  fi
done
service_present=false
if /bin/launchctl print system/com.hasna.recordings.updater >/dev/null 2>&1; then service_present=true; fi

if path_exists_or_symlink "$AUTHORIZATION_ROOT" || path_exists_or_symlink "$AUTHORIZATION_JOURNAL"; then
  require_authorization_journal
else
  if [ "$present_count" -ne 0 ] || [ "$service_present" = true ] || path_exists_or_symlink "$STATE"; then
    if path_exists_or_symlink "$STATE"; then
      echo "Managed bootstrap refuses a committed different cohort or any committed cohort without its exact authorization journal." >&2
    else
      echo "Managed bootstrap refuses an existing unrelated cohort without exact-package authorization." >&2
    fi
    exit 1
  fi
  write_authorization_journal
fi

BOOTSTRAP_MODE=""
if [ "$service_present" = true ]; then
  [ "$present_count" -eq "${#COHORT_PATHS[@]}" ] || {
    echo "Recordings updater cohort evidence is partial or conflicting while the service is registered; recovery is refused." >&2
    exit 1
  }
  BOOTSTRAP_MODE="recover"
else
  if path_exists_or_symlink "$STATE"; then
    echo "Recordings updater refuses a committed cohort with no registered service." >&2
    exit 1
  fi
  BOOTSTRAP_MODE="repair"
  if [ "$present_count" -eq "${#COHORT_PATHS[@]}" ]; then
    echo "Managed bootstrap will repair an authorized full cohort without a registered service." >&2
  elif [ "$present_count" -gt 0 ]; then
    echo "Managed bootstrap will repair an authorized partial cohort." >&2
  fi
fi

if [ "$BOOTSTRAP_MODE" = repair ]; then
  validate_target_ancestry
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty TMPDIR="$WORK_DIR" \
    /usr/sbin/installer -pkg "$SNAPSHOT_PKG" -target /
  for cohort_path in "${COHORT_PATHS[@]}"; do
    path_exists_or_symlink "$cohort_path" && [ ! -L "$cohort_path" ] || {
      echo "Installer did not produce a complete immutable updater cohort." >&2
      exit 1
    }
    require_safe_existing_cohort_path "$cohort_path" "$(cohort_expected_mode "$cohort_path")"
  done
  /bin/launchctl print system/com.hasna.recordings.updater >/dev/null 2>&1 || {
    echo "Installer did not start the immutable updater broker." >&2
    exit 1
  }
fi

if path_exists_or_symlink "$STATE"; then
  STATE_PHASE="$(/usr/bin/plutil -extract phase raw -o - "$STATE")" || {
    echo "Installed release state does not expose a valid bootstrap phase." >&2
    exit 1
  }
  if [ "$STATE_PHASE" = committed ]; then
    run_preflight true
    remove_authorization_journal
    exit 0
  fi
  [ "$STATE_PHASE" = seen ] || {
    echo "Installed release state is neither an exact recoverable nor committed bootstrap." >&2
    exit 1
  }
fi

# Reauthenticate the root-private payload immediately before executing its
# signed client. Never execute the installed app copy during bootstrap or
# recovery; only the package copy bound by the signed envelope is authoritative.
validate_target_ancestry
require_tree_without_extended_acl "$EXPANDED"
run_preflight false
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty TMPDIR="$WORK_DIR" \
  "$PAYLOAD_CLIENT" bootstrap \
  --artifact "$SNAPSHOT_PKG" \
  --manifest "$SNAPSHOT_MANIFEST" \
  --envelope "$SNAPSHOT_ENVELOPE"

[ -f "$STATE" ] && [ ! -L "$STATE" ] && [ "$(/usr/bin/stat -f '%u' "$STATE")" = 0 ] || {
  echo "Broker did not initialize root-owned anti-rollback state." >&2
  exit 1
}
require_no_extended_acl "$STATE"
run_preflight true
remove_authorization_journal
