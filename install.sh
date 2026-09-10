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
  echo "pr-review: all dependencies satisfied."
  echo
  echo "Skills available:"
  echo "  /pr-review:start-review       walk through review feedback one item at a time"
  echo "  /pr-review:process-comments   work through a PR's comments interactively"
  echo "  /pr-review:auto-fix-loop      review, fix and re-review until clean"
  echo
  echo "GitHub tool: \${CLAUDE_PLUGIN_ROOT}/skills/github-curl/gh.py"
  exit 0
fi

echo "pr-review: not ready. Fix the item above, then run /pr-review:doctor again." >&2
exit "$code"
