---
description: Check that python3, curl, a GitHub token and a GitHub repository clone are available
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user verbatim.

The script writes nothing. It verifies that python3, curl and a GitHub token are
available, and that the working directory is a GitHub repository clone. On failure it
prints the exact command that fixes the first problem it found.

$ARGUMENTS
