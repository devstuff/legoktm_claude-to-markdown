#!/usr/bin/env bash

#
# build.sh
#
# Packages the extension into a zip one level above the repo, named after the
# version in manifest.json, ready for `web-ext sign` or an upload to AMO.
#
# Development-only files are excluded: they are not part of the extension, and
# web-ext-artifacts holds previously signed builds, which must not be carried
# inside a new package.
#
# Usage:
#   ./build.sh
#

# shellcheck disable=SC2155
#   (see https://github.com/koalaman/shellcheck/wiki)
#

set -euo pipefail;

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)";

die() {
  echo "ERROR: $*" >&2;
  exit 1;
}

show_help() {
  awk 'NR==1 && /^#!/ { next }
       /^#/            { seen=1; sub(/^# ?/, ""); print; next }
       seen            { exit }' "${BASH_SOURCE[0]}";
}

read_version() {
  jq -r '.version' "${SCRIPT_DIR}/manifest.json";
}

build_zip() {
  local version="$1";
  local output="${SCRIPT_DIR}/../claude-to-markdown-${version}.zip";

  cd "$SCRIPT_DIR";
  zip -r -FS "$output" ./* \
    --exclude '*.git*' \
    --exclude 'build.sh' \
    --exclude 'dev-run.sh' \
    --exclude 'dev-run.log' \
    --exclude 'web-ext-artifacts' \
    --exclude 'web-ext-artifacts/*';

  echo "Built ${output}";
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in

      -h|--help)
        show_help;
        exit 0;
        ;;

      *)
        die "Unknown argument: $1";
        ;;

    esac;
  done;

  command -v jq >/dev/null 2>&1 || die "jq is required (brew install jq).";

  local version="$(read_version)";
  [[ -n "$version" && "$version" != "null" ]] || die "No version in manifest.json.";

  build_zip "$version";
}

main "$@";
