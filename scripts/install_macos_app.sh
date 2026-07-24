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

# Deterministic, source-freshness-based rebuild skip.
#
# We rebuild only when the app SOURCES or the package VERSION actually changed.
# The decision is a hash of the native app source tree plus the package version
# — NOT the app's signature. This is deliberate:
#   * Identical reinstall (same source/version): keep the already-installed,
#     already-granted app untouched, so macOS permission grants survive.
#   * Genuine app update (source or version changed): rebuild and re-sign with
#     the same stable per-machine certificate. Its certificate-based designated
#     requirement is unchanged, so the grants survive the update too — no
#     update-starvation and no force flag needed.
STAMP_FILE="${DATA_DIR}/.recordings-source-hash"

# Keep the ~/Applications launch point pointed at the current build and restart
# a running instance. A second, stale copy in ~/Applications splits TCC
# permissions and leaves users on an old build, so we refresh it from the
# canonical app on EVERY path — including the skip-rebuild path, where the
# canonical app is the already-installed APP_DEST.
refresh_alt_copy_and_restart() {
  local source_app="$1"
  [ -d "$source_app" ] || return 0

  local alt_copy="${HOME}/Applications/Recordings.app"
  if [ -d "$alt_copy" ]; then
    rm -rf "$alt_copy"
    cp -R "$source_app" "$alt_copy" || true
    echo "Updated stale copy at ${alt_copy} to the current app."
  fi

  # If an old instance is running, restart it on the current build.
  if pgrep -x Recordings >/dev/null 2>&1; then
    pkill -x Recordings || true
    sleep 1
    open "$APP_DEST" || true
    echo "Restarted Recordings.app on the current build."
  fi
}

compute_source_hash() {
  command -v shasum >/dev/null 2>&1 || return 1
  [ -d "$NATIVE_DIR" ] || return 1
  {
    # Version-aware: the package version line participates in the hash.
    grep '"version"' "${PACKAGE_ROOT}/package.json" 2>/dev/null
    # Source-aware: hash every native source file (relative paths, so the hash
    # is independent of the install location), excluding build artifacts.
    ( cd "$NATIVE_DIR" && find . -type f ! -path './.build/*' -exec shasum {} + 2>/dev/null | sort )
  } | shasum | awk '{print $1}'
}

SOURCE_HASH="$(compute_source_hash)"

if [ -d "$APP_DEST" ] && [ "${RECORDINGS_FORCE_APP_REINSTALL:-0}" != "1" ] && \
   [ -n "$SOURCE_HASH" ] && [ -f "$STAMP_FILE" ] && \
   [ "$(cat "$STAMP_FILE" 2>/dev/null)" = "$SOURCE_HASH" ]; then
  echo "Recordings.app at ${APP_DEST} is already built from the current sources; skipping rebuild to preserve macOS permission grants."
  echo "Set RECORDINGS_FORCE_APP_REINSTALL=1 to force a rebuild."
  refresh_alt_copy_and_restart "$APP_DEST"
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

# Record the source/version hash this build was produced from so an identical
# future reinstall is skipped (see the rebuild-skip guard above).
if [ -n "$SOURCE_HASH" ]; then
  printf '%s\n' "$SOURCE_HASH" > "$STAMP_FILE"
fi

# NOTE: this installer must never modify TCC permission state. Automatically
# resetting "stale" grants deleted the user's Microphone/Accessibility
# approvals on every update; users must always keep their existing decisions.

refresh_alt_copy_and_restart "$APP_DEST"

echo "Installed Recordings.app from package: ${APP_DEST}"
