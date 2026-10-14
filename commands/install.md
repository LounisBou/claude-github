---
description: Install gh if missing, sign in to GitHub in the browser, then check python3, curl and the token
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user verbatim.

When neither `GH_TOKEN` nor a `gh` sign-in provides a GitHub token, the script
installs `gh` if it is missing (Homebrew on macOS, the system package manager on
Linux when it can run without a password, otherwise the official release archive,
checked against its published sha256 checksum, into `~/.local/bin`), then starts `gh auth login --web`: it opens the GitHub
device page in the browser and prints a one-time code (exit code 14). Tell the
user to enter that code, then run `/github:doctor`. The token stays where `gh`
keeps it; the script never prints or writes it.

It then verifies that python3, curl and a GitHub token are available. It needs
no repository: it runs from any directory. On failure it prints the exact
command that fixes the first problem it found.

$ARGUMENTS
