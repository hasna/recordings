#!/usr/bin/env bash
set -u

MODE="release"
POSTINSTALL=0

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

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${HOME}/.hasna/recordings"
NATIVE_DIR="${PACKAGE_ROOT}/src/native/Recordings"
APP_SOURCE="${NATIVE_DIR}/.build/${MODE}/Recordings.app"
APP_DEST="${DATA_DIR}/Recordings.app"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

mkdir -p "${DATA_DIR}/audio"

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

# A Recordings.app signed with a real certificate (not ad-hoc) has a stable
# code-signing identity: its TCC designated requirement is certificate-based,
# so macOS Microphone/Accessibility grants survive app updates. Rebuilding it
# here would replace that identity with a fresh ad-hoc CDHash and invalidate
# the user's grants. Preserve it unless a rebuild is explicitly forced.
app_signature_is_stable() {
  local app="$1"
  command -v codesign >/dev/null 2>&1 || return 1
  local info
  info="$(codesign -d --verbose=4 "$app" 2>&1)" || return 1
  printf '%s\n' "$info" | grep -q '^Identifier=com\.hasna\.recordings$' || return 1
  if printf '%s\n' "$info" | grep -q '^Signature=adhoc$'; then
    return 1
  fi
  codesign --verify "$app" >/dev/null 2>&1 || return 1
  return 0
}

if [ -d "$APP_DEST" ] && [ "${RECORDINGS_FORCE_APP_REINSTALL:-0}" != "1" ] && \
   app_signature_is_stable "$APP_DEST"; then
  echo "Recordings.app at ${APP_DEST} is signed with a stable certificate identity; skipping rebuild to preserve macOS permission grants."
  echo "Set RECORDINGS_FORCE_APP_REINSTALL=1 to force a rebuild (macOS may require re-granting Microphone and Accessibility)."
  exit 0
fi

if ! command -v swift >/dev/null 2>&1; then
  warn_or_fail "Swift toolchain not found"
fi

if [ ! -d "$NATIVE_DIR" ]; then
  warn_or_fail "native app sources are missing from package: ${NATIVE_DIR}"
fi

(
  cd "$NATIVE_DIR" || exit 1
  ./build.sh "$MODE"
) || warn_or_fail "native app build failed"

if [ ! -d "$APP_SOURCE" ]; then
  warn_or_fail "native build did not produce ${APP_SOURCE}"
fi

rm -rf "$APP_DEST"
mkdir -p "$DATA_DIR"
cp -R "$APP_SOURCE" "$APP_DEST" || warn_or_fail "failed to copy app bundle"

# NOTE: this installer must never modify TCC permission state. Automatically
# resetting "stale" grants deleted the user's Microphone/Accessibility
# approvals on every update; users must always keep their existing decisions.

# A second copy in ~/Applications splits TCC permissions and leaves users running
# stale builds. Keep that launch point but always point it at the fresh build.
ALT_COPY="${HOME}/Applications/Recordings.app"
if [ -d "$ALT_COPY" ]; then
  rm -rf "$ALT_COPY"
  cp -R "$APP_SOURCE" "$ALT_COPY" || true
  echo "Updated stale copy at ${ALT_COPY} to the freshly built app."
fi

# If an old instance is running, restart it on the new build.
if pgrep -x Recordings >/dev/null 2>&1; then
  pkill -x Recordings || true
  sleep 1
  open "$APP_DEST" || true
  echo "Restarted Recordings.app on the new build."
fi

echo "Installed Recordings.app from package: ${APP_DEST}"
