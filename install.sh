#!/usr/bin/env bash
# Verify only. This plugin writes nothing outside its own directory, so there is
# nothing to install and nothing to undo — removing the plugin is the uninstall.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)

# Capture the preflight's own exit code. `if cmd; then ...; fi` with no else
# branch leaves $? at 0 when the condition fails, so reading it after the fi
# would report success for a failed check — in the one script whose whole job
# is to report that failure.
bash "$ROOT/scripts/preflight.sh"
code=$?

if [ "$code" -eq 0 ]; then
  echo "github: all dependencies satisfied."
  echo
  echo "Skills available:"
  echo "  github-curl   GitHub API calls from the standard library: pull requests,"
  echo "                review threads, comments, reviews, labels, issues, search"
  echo "                and image attachments"
  echo
  echo "GitHub tool: \${CLAUDE_PLUGIN_ROOT}/skills/github-curl/gh.py"
  exit 0
fi

echo "github: not ready. Fix the item above, then run /github:doctor again." >&2
exit "$code"
