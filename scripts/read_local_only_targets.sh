# shellcheck shell=bash
# Shared reader for the local-only approved-target policy. Sourced by both
# scripts/install_macos_app.sh and src/native/Recordings/build.sh so the builder
# and the target parse one file with one implementation; a divergence between the
# two would let a target pass the build and then fail the install, or worse.
#
# Parsing mirrors localOnlyApprovedTargets() in scripts/macos_artifact.ts exactly:
# strip an optional UTF-8 BOM and CR, trim surrounding whitespace, drop blank and
# comment lines, then require every remaining line to be a well-formed short
# hostname, unique, and never the release fleet target. Anything else fails closed.

# read_local_only_targets <policy-path> <out-list-var> <out-match-var> <requested-target>
# Sets <out-list-var> to a comma-separated list for error messages and
# <out-match-var> to 1 when <requested-target> is approved. Returns non-zero with a
# message on stderr when the policy itself is unusable.
read_local_only_targets() {
  local policy_path="$1"
  local list_var="$2"
  local match_var="$3"
  local requested="$4"

  if [ ! -f "$policy_path" ] || [ -L "$policy_path" ]; then
    echo "Local-only approved target policy is missing." >&2
    return 1
  fi

  local line target list="" matched=0
  local -a seen=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#$'\xef\xbb\xbf'}"
    line="${line%$'\r'}"
    # Trim leading and trailing blanks so an indented entry or comment behaves
    # the same here as it does in the TypeScript reader.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in '' | '#'*) continue ;; esac
    target="$line"
    case "$target" in
      *[!a-z0-9-]* | [!a-z]* | *-)
        echo "Local-only approved target policy has an invalid target name: ${target}" >&2
        return 1
        ;;
    esac
    if [ "${#target}" -lt 3 ] || [ "${#target}" -gt 32 ]; then
      echo "Local-only approved target policy has an invalid target name: ${target}" >&2
      return 1
    fi
    if [ "$target" = "fleet" ]; then
      echo "Local-only approved target policy must not list the release fleet target." >&2
      return 1
    fi
    local previous
    for previous in ${seen[@]+"${seen[@]}"}; do
      if [ "$previous" = "$target" ]; then
        echo "Local-only approved target policy has duplicate targets." >&2
        return 1
      fi
    done
    seen+=("$target")
    list="${list:+${list}, }${target}"
    if [ "$target" = "$requested" ]; then
      matched=1
    fi
  done < "$policy_path"

  if [ -z "$list" ]; then
    echo "Local-only approved target policy lists no targets." >&2
    return 1
  fi

  printf -v "$list_var" '%s' "$list"
  printf -v "$match_var" '%s' "$matched"
}
