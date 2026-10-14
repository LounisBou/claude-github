#!/usr/bin/env bash
# Refuse to run when a dependency is missing, so no skill degrades silently.
set -u

die() {
  printf 'error: %s\n' "$1" >&2
  printf 'fix:   %s\n' "$2" >&2
  exit "$3"
}

# ── System tools ──────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH" "install python3 (3.9 or later)" 11

python3 - <<'PY' || die "python3 is older than 3.9" "install python3 3.9 or later" 11
import sys
sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY

command -v curl >/dev/null 2>&1 || die "curl not found on PATH" "install curl" 11

# ── Repository ────────────────────────────────────────────────
remote=$(git remote get-url origin 2>/dev/null || echo "")
[ -n "$remote" ] || die "no git remote named origin" "run this from a GitHub repository clone" 13
case "$remote" in
  *github.com*) : ;;
  *) die "origin is not a github.com remote: $remote" "run this from a GitHub repository clone" 13 ;;
esac

# ── GitHub token ──────────────────────────────────────────────
# Asked through gh's exit code only: the token itself is never read here. gh is
# looked up on PATH, then where /github:install puts its release archive.
if [ "${GH_SKIP_AUTH:-0}" != "1" ] && [ -z "${GH_TOKEN:-}" ]; then
  gh=$(command -v gh 2>/dev/null || echo "$HOME/.local/bin/gh")
  [ -x "$gh" ] || die "gh is not installed and GH_TOKEN is not set" "/github:install" 12
  "$gh" auth token >/dev/null 2>&1 || die "no GitHub token available" "/github:install" 12
fi

exit 0
