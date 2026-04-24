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

mkdir -p "${DATA_DIR}/audio"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

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

current_cdhash() {
  codesign -d --verbose=4 "$1" 2>&1 | awk -F= '/^CDHash=/ { print toupper($2); exit }'
}

tcc_csreq_hex() {
  local db_path="$1"
  local service="$2"
  if [ ! -r "$db_path" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  sqlite3 "$db_path" \
    "SELECT hex(csreq) FROM access WHERE service = '${service}' AND client = 'com.hasna.recordings' ORDER BY last_modified DESC LIMIT 1;" \
    2>/dev/null || true
}

reset_stale_permission() {
  local service="$1"
  local tcc_service="$2"
  local db_path="$3"
  local cdhash="$4"
  local csreq_hex
  csreq_hex="$(tcc_csreq_hex "$db_path" "$tcc_service" | tr '[:lower:]' '[:upper:]')"
  if [ -n "$cdhash" ] && [ -n "$csreq_hex" ] && [[ "$csreq_hex" != *"$cdhash"* ]]; then
    tccutil reset "$service" com.hasna.recordings >/dev/null 2>&1 || true
    echo "Reset stale ${service} permission for the newly installed Recordings.app."
  fi
}

APP_CDHASH="$(current_cdhash "$APP_DEST" || true)"
reset_stale_permission "Microphone" "kTCCServiceMicrophone" "${HOME}/Library/Application Support/com.apple.TCC/TCC.db" "$APP_CDHASH"
reset_stale_permission "Accessibility" "kTCCServiceAccessibility" "/Library/Application Support/com.apple.TCC/TCC.db" "$APP_CDHASH"

echo "Installed Recordings.app from package: ${APP_DEST}"
