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
if [ "${GH_SKIP_AUTH:-0}" != "1" ]; then
  token="${GH_TOKEN:-$(gh auth token 2>/dev/null || echo "")}"
  [ -n "$token" ] || die "no GitHub token available" "gh auth login" 12
fi

exit 0
