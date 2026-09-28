#!/usr/bin/env bash

#
# dev-run.sh
#
# Launches Firefox with this repo loaded as an unpacked (temporary) add-on,
# using a dedicated development profile so the signed build installed in the
# normal profile is left alone and no add-on ID collision occurs.
#
# The profile is persistent (--keep-profile-changes), so a claude.ai login
# survives between runs: log in once, then every later launch is ready to go.
#
# Extension diagnostics are routed to the terminal and to a log file. That needs
# two things that are not on by default. web-ext --verbose makes web-ext relay
# Firefox's stdout, and browser.dom.window.dump.enabled makes the extension's
# dump() calls reach that stdout. console.log is deliberately not the transport:
# an extension holding host permissions runs in the extension child process,
# whose console never reaches Firefox's stdout, so console-only records are
# visible in about:debugging and nowhere else.
#
# Usage:
#   ./dev-run.sh                       # launch, append to dev-run.log
#   ./dev-run.sh --clean               # discard the dev profile first
#   ./dev-run.sh --url https://claude.ai/recents
#   ./dev-run.sh --log /tmp/other.log
#

# shellcheck disable=SC2155
#   (see https://github.com/koalaman/shellcheck/wiki)
#

set -euo pipefail;

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)";
readonly DEFAULT_PROFILE_DIR="${HOME}/.firefox-dev-profiles/claude-to-markdown";
readonly DEFAULT_LOG_FILE="${SCRIPT_DIR}/dev-run.log";
readonly DEFAULT_START_URL="https://claude.ai/recents";
readonly FIREFOX_BIN="/Applications/Firefox.app/Contents/MacOS/firefox";

die() {
  echo "ERROR: $*" >&2;
  exit 1;
}

show_help() {
  awk 'NR==1 && /^#!/ { next }
       /^#/            { seen=1; sub(/^# ?/, ""); print; next }
       seen            { exit }' "${BASH_SOURCE[0]}";
}

check_prerequisites() {
  command -v web-ext >/dev/null 2>&1 || die "web-ext is not on PATH (npm install -g web-ext).";
  [[ -x "$FIREFOX_BIN" ]] || die "Firefox not found at ${FIREFOX_BIN}.";
  [[ -f "${SCRIPT_DIR}/manifest.json" ]] || die "No manifest.json in ${SCRIPT_DIR}.";
}

reset_profile() {
  local profile_dir="$1";

  if [[ -d "$profile_dir" ]]; then
    echo "Removing dev profile ${profile_dir}";
    rm -rf "$profile_dir";
  fi;
}

run_firefox() {
  local profile_dir="$1";
  local log_file="$2";
  local start_url="$3";

  mkdir -p "$(dirname "$profile_dir")";
  mkdir -p "$(dirname "$log_file")";

  echo "Source     : ${SCRIPT_DIR}";
  echo "Dev profile: ${profile_dir}";
  echo "Log file   : ${log_file}";
  echo "Start URL  : ${start_url}";
  echo "";

  {
    echo "=== dev-run.sh started $(date -Iseconds) ===";
  } >> "$log_file";

  # --verbose is required for console relay, not merely for chattiness.
  web-ext run \
    --source-dir "$SCRIPT_DIR" \
    --firefox "$FIREFOX_BIN" \
    --firefox-profile "$profile_dir" \
    --profile-create-if-missing \
    --keep-profile-changes \
    --start-url "$start_url" \
    --verbose \
    --pref devtools.console.stdout.chrome=true \
    --pref devtools.console.stdout.content=true \
    --pref browser.dom.window.dump.enabled=true \
    --pref browser.aboutConfig.showWarning=false \
    --pref extensions.webextensions.remote=true \
    2>&1 | tee -a "$log_file";
}

main() {
  local clean="no";
  local log_file="$DEFAULT_LOG_FILE";
  local profile_dir="$DEFAULT_PROFILE_DIR";
  local start_url="$DEFAULT_START_URL";

  while [[ $# -gt 0 ]]; do
    case "$1" in

      --clean)
        clean="yes";
        shift;
        ;;

      -h|--help)
        show_help;
        exit 0;
        ;;

      --log)
        log_file="$2";
        shift 2;
        ;;

      --profile)
        profile_dir="$2";
        shift 2;
        ;;

      --url)
        start_url="$2";
        shift 2;
        ;;

      *)
        die "Unknown argument: $1";
        ;;

    esac;
  done;

  check_prerequisites;

  if [[ "$clean" == "yes" ]]; then
    reset_profile "$profile_dir";
  fi;

  run_firefox "$profile_dir" "$log_file" "$start_url";
}

main "$@";
