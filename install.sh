#!/usr/bin/env bash
# /github:install: make a GitHub token available, then run the diagnostic.
#
#   install.sh           install gh when it is missing, start the gh browser
#                        sign-in when no token is found, then check everything
#   install.sh --check   check only, install nothing (/github:doctor)
#
# The token stays where gh keeps it (the system credential store). This script
# only asks gh whether one exists, through exit codes: it never reads the token
# into a variable, prints it, logs it or writes it anywhere.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
MODE=install
[ "${1:-}" = "--check" ] && MODE=check

# gh lands here when it is installed from its release archive, without root.
USER_BIN="$HOME/.local/bin"
DEVICE_URL="https://github.com/login/device"

say() { printf 'github: %s\n' "$1"; }

fail() {
  printf 'error: %s\n' "$1" >&2
  printf 'fix:   %s\n' "$2" >&2
  exit "$3"
}

# The gh on PATH, or the one a previous run placed in the user directory.
find_gh() {
  if command -v gh >/dev/null 2>&1; then
    command -v gh
  elif [ -x "$USER_BIN/gh" ]; then
    echo "$USER_BIN/gh"
  fi
}

has_token() {
  [ -n "${GH_TOKEN:-}" ] && return 0
  local gh
  gh=$(find_gh)
  [ -n "$gh" ] && "$gh" auth token >/dev/null 2>&1
}

# sudo only when it runs without a password prompt: the install may run with no
# terminal to type one into.
root_prefix() {
  if [ "$(id -u)" = "0" ]; then
    echo ""
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    echo "sudo -n"
  else
    return 1
  fi
}

install_gh_release() {
  local arch version tmp archive base expected actual
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv6* | armv7*) arch=armv6 ;;
    i386 | i686) arch=386 ;;
    *) fail "no gh release archive for this processor: $(uname -m)" \
      "install gh from https://cli.github.com, then run /github:install again" 11 ;;
  esac
  version=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' 2>/dev/null)
  [ -n "$version" ] || fail "could not read the latest gh release" \
    "install gh from https://cli.github.com, then run /github:install again" 11
  say "installing gh $version from its release archive into $USER_BIN (no root needed)"
  tmp=$(mktemp -d)
  archive="gh_${version}_linux_${arch}.tar.gz"
  base="https://github.com/cli/cli/releases/download/v${version}"
  if ! curl -fsSL -o "$tmp/$archive" "$base/$archive" \
    || ! curl -fsSL -o "$tmp/checksums.txt" "$base/gh_${version}_checksums.txt"; then
    rm -rf "$tmp"
    fail "the gh release archive could not be downloaded" \
      "install gh from https://cli.github.com, then run /github:install again" 11
  fi
  # The archive must match the checksum the same release publishes for it.
  # A missing line or a mismatch installs nothing.
  expected=$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$archive" | awk '{ print $1 }')
  else
    actual=$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    fail "the gh release archive does not match its published sha256 checksum" \
      "install gh from https://cli.github.com, then run /github:install again" 11
  fi
  if ! tar -xzf "$tmp/$archive" -C "$tmp"; then
    rm -rf "$tmp"
    fail "the gh release archive could not be unpacked" \
      "install gh from https://cli.github.com, then run /github:install again" 11
  fi
  mkdir -p "$USER_BIN"
  cp "$tmp"/gh_*/bin/gh "$USER_BIN/gh" && chmod +x "$USER_BIN/gh"
  rm -rf "$tmp"
  case ":$PATH:" in
    *":$USER_BIN:"*) : ;;
    *) say "$USER_BIN is not on your PATH; add it so gh runs from a terminal too" ;;
  esac
}

install_gh_linux() {
  local sudo cmd
  if sudo=$(root_prefix); then
    cmd=""
    if command -v apt-get >/dev/null 2>&1; then cmd="apt-get install -y gh"
    elif command -v dnf >/dev/null 2>&1; then cmd="dnf install -y gh"
    elif command -v zypper >/dev/null 2>&1; then cmd="zypper --non-interactive install gh"
    elif command -v pacman >/dev/null 2>&1; then cmd="pacman -S --noconfirm github-cli"
    elif command -v apk >/dev/null 2>&1; then cmd="apk add github-cli"
    fi
    if [ -n "$cmd" ]; then
      say "installing gh with the system package manager ($cmd)"
      # Word splitting is wanted: both strings are commands with arguments.
      # shellcheck disable=SC2086
      $sudo $cmd && return 0
      say "the package manager could not install gh; using the release archive instead"
    fi
  fi
  install_gh_release
}

install_gh() {
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 \
        || fail "gh is not installed and Homebrew is not available" \
          "install Homebrew (https://brew.sh), then run /github:install again" 11
      say "installing gh with Homebrew (brew install gh)"
      brew install gh || fail "brew install gh failed" "brew install gh" 11
      ;;
    Linux) install_gh_linux ;;
    *) fail "gh is not installed" "install gh from https://cli.github.com, then run /github:install again" 11 ;;
  esac
  hash -r
  [ -n "$(find_gh)" ] || fail "gh is still not found after installing it" \
    "install gh from https://cli.github.com, then run /github:install again" 11
}

# gh's browser sign-in. From a terminal, gh runs in the foreground: it shows a
# one-time code and opens the browser. Without one (the mod runs this script
# with its output captured), gh neither opens the browser nor shows its code
# until it ends, so it runs detached: this script reads the code from gh's
# output, opens the page, prints the code and leaves gh waiting for the user.
sign_in() {
  local gh log code i
  gh=$(find_gh)
  if [ -t 0 ] && [ -t 1 ]; then
    "$gh" auth login --web --git-protocol https --hostname github.com \
      || fail "gh sign-in did not complete" "/github:install" 12
    return 0
  fi
  log=$(mktemp)
  nohup "$gh" auth login --web --git-protocol https --hostname github.com \
    </dev/null >"$log" 2>&1 &
  code=""
  for i in $(seq 1 40); do
    code=$(sed -n 's/.*one-time code: *\([A-Z0-9-]*\).*/\1/p' "$log" | head -1)
    [ -n "$code" ] && break
    kill -0 $! 2>/dev/null || break
    sleep 0.5
  done
  rm -f "$log"
  if [ -z "$code" ]; then
    kill $! 2>/dev/null
    fail "gh did not start its browser sign-in" \
      "run gh auth login --web --git-protocol https in a terminal" 12
  fi
  if command -v open >/dev/null 2>&1; then open "$DEVICE_URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$DEVICE_URL" >/dev/null 2>&1
  fi
  say "GitHub sign-in started."
  say "enter the one-time code $code at $DEVICE_URL (opened in your browser),"
  say "then run /github:doctor to confirm."
  exit 14
}

if [ "$MODE" = install ] && [ "${GH_SKIP_AUTH:-0}" != "1" ] && ! has_token; then
  [ -n "$(find_gh)" ] || install_gh
  has_token || sign_in
fi

# Capture the preflight's own exit code. `if cmd; then ...; fi` with no else
# branch leaves $? at 0 when the condition fails, so reading it after the fi
# would report success for a failed check — in the one script whose whole job
# is to report that failure.
bash "$ROOT/scripts/preflight.sh" --deps-only
code=$?

if [ "$code" -eq 0 ]; then
  echo "github: all dependencies satisfied."
  echo
  echo "Tool available:"
  echo "  gh            GitHub API calls from the standard library: pull requests,"
  echo "                review threads, comments, reviews, labels, issues, search"
  echo "                and image attachments"
  echo
  echo "Skill available (where mods do not load):"
  echo "  github-curl   the same engine from Bash"
  echo
  echo "GitHub engine: \${CLAUDE_PLUGIN_ROOT}/engine/gh.py"
  exit 0
fi

echo "github: not ready. Fix the item above, then run /github:install again." >&2
exit "$code"
