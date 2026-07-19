#!/bin/bash

# Resolve the Tailscale CLI without evaluating shell-provided command text.

recordings_tailscale_standard_app_cli() {
  printf '%s\n' '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
}

recordings_tailscale_standard_app() {
  printf '%s\n' '/Applications/Tailscale.app'
}

recordings_real_host_kernel() {
  local kernel
  if ! kernel="$(/usr/bin/uname -s)"; then
    echo "Could not determine the host platform with pinned /usr/bin/uname." >&2
    return 1
  fi
  case "$kernel" in
    Darwin|Linux) printf '%s\n' "$kernel" ;;
    *)
      echo "Unsupported host platform from pinned /usr/bin/uname: ${kernel:-<empty>}." >&2
      return 1
      ;;
  esac
}

recordings_validate_tailscale_cli_shape() {
  local candidate="$1"

  case "$candidate" in
    /*) ;;
    *)
      echo "Resolved Tailscale CLI path must be absolute." >&2
      return 1
      ;;
  esac
  if [[ "$candidate" == *$'\n'* ]] || [[ "$candidate" == *$'\r'* ]]; then
    echo "Resolved Tailscale CLI path is malformed." >&2
    return 1
  fi
}

recordings_validate_tailscale_cli() {
  local candidate="$1"

  recordings_validate_tailscale_cli_shape "$candidate" || return 1
  if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then
    echo "Resolved Tailscale CLI path is not an executable file." >&2
    return 1
  fi
}

recordings_resolve_tailscale_cli() {
  local candidate

  candidate="$(builtin type -P tailscale 2>/dev/null || true)"
  if [ -n "$candidate" ]; then
    recordings_validate_tailscale_cli_shape "$candidate" || return 1
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  candidate="$(recordings_tailscale_standard_app_cli)"
  recordings_validate_tailscale_cli "$candidate" || return 1
  printf '%s\n' "$candidate"
}

recordings_tailscale_stat_owner_and_mode() {
  local candidate="$1"
  local real_host_kernel="$2"

  case "$real_host_kernel" in
    Darwin) /usr/bin/stat -f '%u %Lp' "$candidate" ;;
    *) /usr/bin/stat -c '%u %a' "$candidate" ;;
  esac
}

recordings_validate_trusted_tailscale_app_cli() {
  local candidate="$1"
  local real_host_kernel="$2"
  local canonical
  local current_uid
  local owner
  local mode
  local other_permissions
  local group_permissions

  recordings_validate_tailscale_cli_shape "$candidate" || return 1
  if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then
    echo "Trusted Tailscale CLI path is not an executable file." >&2
    return 1
  fi
  if [ -L "$candidate" ]; then
    echo "Trusted Tailscale CLI must be a canonical non-symlink trusted executable." >&2
    return 1
  fi
  canonical="$(/usr/bin/realpath "$candidate" 2>/dev/null)" || {
    echo "Trusted Tailscale CLI could not be resolved canonically." >&2
    return 1
  }
  if [ "$canonical" != "$candidate" ]; then
    echo "Trusted Tailscale CLI must be a canonical non-symlink trusted executable." >&2
    return 1
  fi

  read -r owner mode <<EOF
$(recordings_tailscale_stat_owner_and_mode "$candidate" "$real_host_kernel")
EOF
  current_uid="$(/usr/bin/id -u)"
  case "$owner" in
    0|"$current_uid") ;;
    *)
      echo "Trusted Tailscale CLI has an unsafe owner." >&2
      return 1
      ;;
  esac
  case "$mode" in
    [0-7][0-7][0-7]|0[0-7][0-7][0-7]) ;;
    *)
      echo "Trusted Tailscale CLI has an invalid mode." >&2
      return 1
      ;;
  esac
  other_permissions="${mode: -1}"
  group_permissions="${mode: -2:1}"
  case "$group_permissions$other_permissions" in
    *[2367]*)
      echo "Trusted Tailscale CLI must not be group- or world-writable." >&2
      return 1
      ;;
  esac
}

recordings_validate_private_tailscale_snapshot_parent() {
  local snapshot_parent="$1"
  local real_host_kernel="$2"
  local canonical
  local owner
  local mode

  recordings_validate_tailscale_cli_shape "$snapshot_parent" || return 1
  if [ ! -d "$snapshot_parent" ] || [ -L "$snapshot_parent" ]; then
    echo "Tailscale snapshot parent must be an existing private directory." >&2
    return 1
  fi
  canonical="$(/usr/bin/realpath "$snapshot_parent" 2>/dev/null)" || {
    echo "Tailscale snapshot parent could not be resolved canonically." >&2
    return 1
  }
  if [ "$canonical" != "$snapshot_parent" ]; then
    echo "Tailscale snapshot parent must be a canonical non-symlink directory." >&2
    return 1
  fi
  read -r owner mode <<EOF
$(recordings_tailscale_stat_owner_and_mode "$snapshot_parent" "$real_host_kernel")
EOF
  if [ "$owner" != "$(/usr/bin/id -u)" ] || [ "$mode" != 700 ]; then
    echo "Tailscale snapshot parent must be owned by the current user with mode 700." >&2
    return 1
  fi
}

recordings_require_tailscale_snapshot_tool() {
  local label="$1"
  local executable="$2"

  case "$executable" in
    /*) ;;
    *)
      echo "$label must be an absolute executable path." >&2
      return 1
      ;;
  esac
  if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
    echo "$label is missing or is not executable." >&2
    return 1
  fi
}

recordings_run_tailscale_snapshot_tool() {
  local real_host_kernel="$1"
  local snapshot_parent="$2"
  local executable="$3"
  shift 3

  if [ "$real_host_kernel" = "Darwin" ]; then
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$snapshot_parent" \
      "$executable" "$@"
  else
    # Test-only allowlist. This entire branch is unreachable on a real Darwin
    # host because the kernel probe and branch are both fixed above the test
    # overrides in recordings_resolve_trusted_tailscale_app_cli.
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$snapshot_parent" \
      MARKER_DIRECTORY="${MARKER_DIRECTORY:-}" \
      "$executable" "$@"
  fi
}

recordings_tailscale_details_have_official_identity() {
  local details="$1"
  local found_identifier=0
  local found_team=0
  local line

  while IFS= read -r line; do
    case "$line" in
      Identifier=io.tailscale.ipn.macsys) found_identifier=1 ;;
      TeamIdentifier=W5364U7YZB) found_team=1 ;;
    esac
  done <<EOF
$details
EOF
  if [ "$found_team" -ne 1 ]; then
    echo "Tailscale code does not carry the official TeamIdentifier W5364U7YZB." >&2
    return 1
  fi
  if [ "$found_identifier" -ne 1 ]; then
    echo "Tailscale code does not carry the official bundle identifier io.tailscale.ipn.macsys." >&2
    return 1
  fi
}

recordings_verify_official_tailscale_code() {
  local code_path="$1"
  local label="$2"
  local real_host_kernel="$3"
  local snapshot_parent="$4"
  local codesign_executable="$5"
  local requirement
  local details

  requirement='anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB" and identifier "io.tailscale.ipn.macsys"'
  local -a verification_arguments=(--verify --strict --all-architectures --verbose=2)
  if [ -d "$code_path" ]; then
    verification_arguments+=(--deep)
  fi
  verification_arguments+=(-R "$requirement" "$code_path")
  if ! recordings_run_tailscale_snapshot_tool \
    "$real_host_kernel" "$snapshot_parent" "$codesign_executable" \
    "${verification_arguments[@]}"; then
    echo "$label does not satisfy the official TeamIdentifier W5364U7YZB and official bundle identifier io.tailscale.ipn.macsys." >&2
    return 1
  fi
  details="$(recordings_run_tailscale_snapshot_tool \
    "$real_host_kernel" "$snapshot_parent" "$codesign_executable" \
    -d --verbose=4 "$code_path" 2>&1)" || {
    echo "$label signing identity could not be read." >&2
    return 1
  }
  recordings_tailscale_details_have_official_identity "$details"
}

recordings_verify_official_tailscale_app_and_cli() {
  local app="$1"
  local cli="$2"
  local real_host_kernel="$3"
  local snapshot_parent="$4"
  local codesign_executable="$5"
  local canonical_app

  if [ ! -d "$app" ] || [ -L "$app" ]; then
    echo "Trusted Tailscale app must be a canonical non-symlink directory." >&2
    return 1
  fi
  canonical_app="$(/usr/bin/realpath "$app" 2>/dev/null)" || {
    echo "Trusted Tailscale app could not be resolved canonically." >&2
    return 1
  }
  if [ "$canonical_app" != "$app" ]; then
    echo "Trusted Tailscale app must be a canonical non-symlink directory." >&2
    return 1
  fi
  recordings_validate_trusted_tailscale_app_cli "$cli" "$real_host_kernel" || return 1
  recordings_verify_official_tailscale_code \
    "$app" "Tailscale.app" "$real_host_kernel" "$snapshot_parent" "$codesign_executable" || return 1
  recordings_verify_official_tailscale_code \
    "$cli" "Tailscale CLI" "$real_host_kernel" "$snapshot_parent" "$codesign_executable"
}

recordings_resolve_trusted_tailscale_app_cli() {
  local snapshot_parent="${1:-}"
  local real_host_kernel
  local source_app
  local source_cli
  local snapshot_root
  local snapshot_app
  local snapshot_cli
  local codesign_executable
  local ditto_executable

  # This probe is deliberately absolute and cannot be replaced by the
  # installer's test tool overrides or caller PATH.
  real_host_kernel="$(recordings_real_host_kernel)" || return 1
  if [ "$real_host_kernel" = "Darwin" ]; then
    source_app='/Applications/Tailscale.app'
    codesign_executable='/usr/bin/codesign'
    ditto_executable='/usr/bin/ditto'
  else
    # Test-only: Linux fixtures cannot authenticate or materialize the macOS
    # /Applications bundle. These overrides are structurally unreachable on
    # Darwin because the real kernel branch above pins every production input.
    source_app="${RECORDINGS_TEST_TRUSTED_TAILSCALE_APP:-$(recordings_tailscale_standard_app)}"
    codesign_executable="${RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE:-/usr/bin/codesign}"
    ditto_executable="${RECORDINGS_TEST_TAILSCALE_DITTO_EXECUTABLE:-/usr/bin/ditto}"
  fi
  recordings_validate_private_tailscale_snapshot_parent "$snapshot_parent" "$real_host_kernel" || return 1
  recordings_require_tailscale_snapshot_tool "Tailscale codesign verifier" "$codesign_executable" || return 1
  recordings_require_tailscale_snapshot_tool "Tailscale app copier" "$ditto_executable" || return 1

  source_cli="$source_app/Contents/MacOS/Tailscale"
  recordings_verify_official_tailscale_app_and_cli \
    "$source_app" "$source_cli" "$real_host_kernel" "$snapshot_parent" "$codesign_executable" || return 1

  snapshot_root="$snapshot_parent/tailscale-identity-snapshot"
  snapshot_app="$snapshot_root/Tailscale.app"
  snapshot_cli="$snapshot_app/Contents/MacOS/Tailscale"
  if [ -e "$snapshot_root" ] || [ -L "$snapshot_root" ]; then
    echo "Tailscale identity snapshot destination already exists." >&2
    return 1
  fi
  /bin/mkdir -m 700 "$snapshot_root" || return 1
  if ! recordings_run_tailscale_snapshot_tool \
    "$real_host_kernel" "$snapshot_parent" "$ditto_executable" "$source_app" "$snapshot_app"; then
    echo "Could not copy the authenticated Tailscale app into the private snapshot." >&2
    return 1
  fi
  if ! recordings_verify_official_tailscale_app_and_cli \
    "$snapshot_app" "$snapshot_cli" "$real_host_kernel" "$snapshot_parent" "$codesign_executable"; then
    echo "Tailscale app snapshot was not authenticated after copying." >&2
    return 1
  fi
  printf '%s\n' "$snapshot_cli"
}

recordings_run_trusted_tailscale_status() {
  local snapshot_cli="$1"
  local snapshot_parent="$2"
  local real_host_kernel
  local expected_cli
  local snapshot_app
  local codesign_executable

  real_host_kernel="$(recordings_real_host_kernel)" || return 1
  expected_cli="$snapshot_parent/tailscale-identity-snapshot/Tailscale.app/Contents/MacOS/Tailscale"
  if [ "$snapshot_cli" != "$expected_cli" ]; then
    echo "Tailscale status executable is not bound to the private authenticated snapshot." >&2
    return 1
  fi
  if [ "$real_host_kernel" = "Darwin" ]; then
    codesign_executable='/usr/bin/codesign'
  else
    # Test-only override; unreachable on a real Darwin host.
    codesign_executable="${RECORDINGS_TEST_TAILSCALE_CODESIGN_EXECUTABLE:-/usr/bin/codesign}"
  fi
  recordings_validate_private_tailscale_snapshot_parent "$snapshot_parent" "$real_host_kernel" || return 1
  recordings_require_tailscale_snapshot_tool "Tailscale codesign verifier" "$codesign_executable" || return 1
  snapshot_app="$snapshot_parent/tailscale-identity-snapshot/Tailscale.app"
  recordings_verify_official_tailscale_app_and_cli \
    "$snapshot_app" "$snapshot_cli" "$real_host_kernel" "$snapshot_parent" "$codesign_executable" || return 1

  if [ "$real_host_kernel" = "Darwin" ]; then
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$snapshot_parent" \
      "$snapshot_cli" status --json
  else
    # Test-only fixture controls. No caller-provided status environment reaches
    # the official CLI on Darwin.
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$snapshot_parent" \
      MARKER_DIRECTORY="${MARKER_DIRECTORY:-}" \
      FAIL_TAILSCALE_STATUS="${FAIL_TAILSCALE_STATUS:-0}" \
      TAILSCALE_STATUS_JSON="${TAILSCALE_STATUS_JSON:-}" \
      FAIL_BUILDER_TAILSCALE_STATUS="${FAIL_BUILDER_TAILSCALE_STATUS:-0}" \
      BUILDER_TAILSCALE_STATUS_JSON="${BUILDER_TAILSCALE_STATUS_JSON:-}" \
      "$snapshot_cli" status --json
  fi
}
