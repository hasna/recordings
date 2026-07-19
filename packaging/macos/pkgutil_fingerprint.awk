# Extract exactly one SHA-256 fingerprint from pkgutil --check-signature output.
# macOS has emitted both same-line and indented following-line forms. Accept
# whitespace/colon separators only and fail closed on malformed or missing data.
BEGIN {
  collecting = 0
  candidate = ""
  found = 0
}

function consume(value) {
  gsub(/[[:space:]:]/, "", value)
  if (value == "") return
  if (value ~ /[^0-9A-Fa-f]/) exit 1
  candidate = candidate value
  if (length(candidate) > 64) exit 1
  if (length(candidate) == 64) {
    print tolower(candidate)
    found = 1
    exit 0
  }
}

!collecting && /SHA256 Fingerprint:/ {
  collecting = 1
  value = $0
  sub(/^.*SHA256 Fingerprint:[[:space:]]*/, "", value)
  consume(value)
  next
}

collecting {
  consume($0)
}

END {
  if (!found) exit 1
}
