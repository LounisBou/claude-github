---
description: Re-run the dependency diagnostic for this plugin
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh --check` and report its output to the user
verbatim. It is the check `/github:install` ends with, available on demand for
when something stops working later. With `--check` the script installs nothing
and starts no sign-in.

Read the exit code and tell the user which class of problem it names:

| Code | Meaning | Remedy |
|---|---|---|
| `0` | everything satisfied | — |
| `11` | a system tool is missing | install python3 (3.9+) or curl |
| `12` | no GitHub token | `/github:install` |
| `14` | GitHub sign-in started | enter the one-time code in the browser, then `/github:doctor` |

$ARGUMENTS
