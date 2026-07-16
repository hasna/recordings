#!/usr/bin/env bash

# Resolve the Tailscale CLI without evaluating shell-provided command text.

recordings_tailscale_standard_app_cli() {
  printf '%s\n' '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
}

recordings_validate_tailscale_cli() {
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
  if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then
    echo "Resolved Tailscale CLI path is not an executable file." >&2
    return 1
  fi
}

recordings_resolve_tailscale_cli() {
  local candidate

  candidate="$(builtin type -P tailscale 2>/dev/null || true)"
  if [ -z "$candidate" ]; then
    candidate="$(recordings_tailscale_standard_app_cli)"
  fi
  recordings_validate_tailscale_cli "$candidate" || return 1
  printf '%s\n' "$candidate"
}
