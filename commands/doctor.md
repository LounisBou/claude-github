---
description: Re-run the dependency diagnostic for this plugin
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user verbatim.
It is the same diagnostic `/pr-review:install` runs, available on demand for when
something stops working later.

Read the exit code and tell the user which class of problem it names:

| Code | Meaning | Remedy |
|---|---|---|
| `0` | everything satisfied | — |
| `10` | an upstream plugin is missing **or installed but disabled** | install it, then enable it in `/plugin` |
| `11` | a system tool is missing | install python3 (3.9+) or curl |
| `12` | no GitHub token | `gh auth login` |
| `13` | not a GitHub repository clone | run from one, or check the `origin` remote |

The script writes nothing and changes nothing.

$ARGUMENTS
