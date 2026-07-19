#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

[ "$(/usr/bin/uname -s)" = "Darwin" ] || {
  echo "The production filesystem guard prebuild must be built on macOS." >&2
  exit 1
}

PACKAGE_ROOT="$(cd "$(/usr/bin/dirname "$0")/.." && /bin/pwd -P)"
SOURCE="$PACKAGE_ROOT/scripts/native/recordings_fs_guard.c"
OUTPUT="${1:-$PACKAGE_ROOT/scripts/native/prebuilds/darwin-universal/recordings_fs_guard.node}"
HEADERS="${2:-$PACKAGE_ROOT/node_modules/node-api-headers/include}"
CLANG="$(/usr/bin/xcrun --find clang)"

[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || {
  echo "Native filesystem guard source is missing or unsafe." >&2
  exit 1
}
[ -f "$HEADERS/node_api.h" ] && [ ! -L "$HEADERS/node_api.h" ] || {
  echo "Pinned Node-API headers are missing or unsafe at ${HEADERS}." >&2
  exit 1
}

OUTPUT_PARENT="$(/usr/bin/dirname "$OUTPUT")"
/bin/mkdir -p "$OUTPUT_PARENT"
WORK_DIR="$(/usr/bin/mktemp -d "$OUTPUT_PARENT/.recordings-fs-guard-build.XXXXXX")"
trap '/bin/rm -rf "$WORK_DIR"' EXIT

COMMON=(
  -bundle
  -undefined dynamic_lookup
  -std=c11
  -O2
  -Wall
  -Wextra
  -Werror
  -DNAPI_VERSION=9
  -DNODE_GYP_MODULE_NAME=recordings_fs_guard
  -I "$HEADERS"
  -mmacosx-version-min=13.0
)

"$CLANG" "${COMMON[@]}" -arch arm64 "$SOURCE" -o "$WORK_DIR/arm64.node"
"$CLANG" "${COMMON[@]}" -arch x86_64 "$SOURCE" -o "$WORK_DIR/x86_64.node"
/usr/bin/lipo -create "$WORK_DIR/arm64.node" "$WORK_DIR/x86_64.node" \
  -output "$WORK_DIR/recordings_fs_guard.node"
/bin/chmod 0644 "$WORK_DIR/recordings_fs_guard.node"
/bin/mv "$WORK_DIR/recordings_fs_guard.node" "$OUTPUT"
/usr/bin/lipo -verify_arch arm64 x86_64 "$OUTPUT"
[ ! -e "$OUTPUT_PARENT/.recordings-fs-guard-build" ] || {
  echo "Native filesystem guard build intermediates escaped the private build directory." >&2
  exit 1
}

printf 'Built universal native filesystem guard: %s\n' "$OUTPUT"
