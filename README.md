# claude-github

A Claude Code mod that talks to the GitHub API through one native tool and a PR
pane, over a Python 3.9+ standard-library engine. No `gh` CLI needed at runtime,
no third-party packages, no npm dependencies in the mod.

The tool, the commands and the pane need Claude Code v2.1.287 or later with
mods enabled (tested against 2.1.292). Where mods do not load (`claude -p`, an
older Claude Code), the `github-curl` skill runs the same engine from Bash.
`skills/github-curl/gh.py` stays as an entry point for plugins built on earlier
releases and runs `engine/gh.py` unchanged.

## Install

Add the marketplace, then install the plugin:

```
/plugin marketplace add LounisBou/claude-github
/plugin install github@claude-github
```

## What you get

- **The `mcp__github__gh` tool** — pull requests, review threads, comments,
  reviews, labels, reviewers, issues, search and image attachments. Arguments
  travel as JSON, so multi-line markdown bodies (backticks, quotes, `$VAR`,
  CRLF) arrive byte-identical: the mod writes each body to a file and hands it
  to the engine as `--body-file`. Failures come back as `isError` with the
  engine's `error:` line; exit codes 1–5 are documented in
  `engine/REFERENCE.md`. Calls follow the session's permission rules: a
  `deny` rule refuses, reads run unless a rule asks, and every write asks
  first unless a rule or the permission mode allows it.
- **`/checks [pr]`** — combined CI status of a PR, with the failed checks
  named, defaulting to the current branch's.
- **`/threads [pr]`** — the open review threads of a PR, as a markdown table.
- **`/prs`** — opens a pane listing every open PR: number, title and draft
  flag, plus CI state and comment count for the five newest, with a Refresh
  button.

The engine (`engine/gh.py` + `ghlib/`) is plain Python standard library; the
mod (`hooks/register.ts`) is TypeScript loaded directly by Claude Code — no
build step. Writing rules for commits, PR titles, descriptions and review
comments live in `engine/WRITING.md`; the tool's description points Claude at
both files.

Images are attached by committing them to a dedicated `pr-assets` branch
through the Contents API, named after the SHA-256 of their bytes so the same
screenshot uploads once. GitHub's own web upload endpoint would need
whole-account browser cookies; that route is deliberately not used.

## Tests

Two suites, both offline — no network, no account:

```
bash tests/run-tests.sh        # the Python engine, served from fixtures
claude plugin test             # the mod, with stubbed process/fs/ui calls
```

## Licence

MIT.
