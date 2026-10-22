# claude-github

A Claude Code mod that talks to the GitHub API through one native tool and a PR
pane, over a Python 3.9+ standard-library engine. No third-party packages and no
npm dependencies in the mod: `gh` only supplies the GitHub token, unless
`GH_TOKEN` is set.

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

Then run `/github:install`. When no GitHub token is found, it installs `gh` if it
is missing (Homebrew on macOS; on Linux the system package manager when it runs
without a password, otherwise the official release archive, checked against its published
sha256 checksum, into `~/.local/bin`) and starts `gh auth login --web`: the GitHub device page opens in the browser
and the command prints the one-time code to enter there. The token stays in the
system credential store where `gh` keeps it; the plugin never prints or writes
it. `/github:doctor` then confirms everything is ready.

## What you get

- **The `mcp__github__gh` tool** — pull requests, review threads, comments,
  reviews, labels, reviewers, issues, search and image attachments. Arguments
  travel as JSON, so multi-line markdown bodies (backticks, quotes, `$VAR`,
  CRLF) arrive byte-identical: the mod hands the request to `gh.py
  --stdin-json`, which maps it onto its own parser, refuses any argument that
  parser does not declare, and passes each body as a private temporary file it
  removes afterwards. Failures come back as `isError` with the
  engine's `error:` line; exit codes 1–5 are documented in
  `engine/REFERENCE.md`. Calls follow the session's permission rules: a
  `deny` rule refuses, reads run unless a rule asks, and every write asks
  first unless a rule or the permission mode allows it. The dialog offers
  « Allow for this session », which covers that one command on that one
  repository until the session ends; it is never offered for `pr-merge` or
  `comment-delete`, nor where an explicit rule asks.
- **Writing rules enforced** — before a title, a description or a comment
  leaves the machine, the mod checks the mechanical rules of
  `engine/WRITING.md`: no semicolon in prose (code spans, fenced blocks and
  URLs are not prose), no `Co-Authored-By` or `Claude-Session` trailer, a
  title on one line and within 72 characters, no heading in a PR description,
  every CVE id in a PR description a link to its advisory, and a security
  update's tables, one per advisory.
  A text that breaks one is refused with the rule, so it can be rewritten. A
  text the user typed in the prompt passes, and the same text sent again is
  put to the user. `pr-create` opens a draft unless the call says otherwise,
  and leaving draft (`draft: false`, `pr-ready`) or replacing an existing
  description is always asked, whatever the rules allow. The one exception
  is a repository in auto-merge (below).
- **`/checks [pr]`** — combined CI status of a PR, with the failed checks
  named, defaulting to the current branch's.
- **`/threads [pr]`** — the open review threads of a PR, as a markdown table.
- **`/prs`** — opens a pane listing every open PR: number, title and draft
  flag, plus CI state and comment count for the five newest, with a Refresh
  button. While it is open it reads the PRs again every minute and after each
  write through the tool, and a toast says when a PR's CI ends in success or
  failure.
- **`/github:install`, `/github:doctor`** — set up `gh` and its sign-in
  (install only), run the dependency diagnostic and name its exit code with no
  model turn; where mods do not load, the markdown commands run the same
  script.

The engine (`engine/gh.py` + `ghlib/`) is plain Python standard library; the
mod (`hooks/register.ts`) is TypeScript loaded directly by Claude Code — no
build step. Writing rules for commits, PR titles, descriptions and review
comments live in `engine/WRITING.md`; the tool's description points Claude at
both files.

Images are attached by committing them to a dedicated `pr-assets` branch
through the Contents API, named after the SHA-256 of their bytes so the same
screenshot uploads once. GitHub's own web upload endpoint would need
whole-account browser cookies; that route is deliberately not used.

## Repositories in auto-merge

No write is asked on a repository listed in `auto-merge.json`, in the
plugin's data directory: `$CLAUDE_PLUGIN_DATA` when the host sets it, else
`~/.claude/plugins/data/github-lounisbou/`.

```json
{ "repositories": ["owner/name"] }
```

Names compare without regard to case. The repository is the call's `repo`,
else `GH_REPO`, else the checkout's `origin`, the order the engine itself
follows. There, replacing a description, opening a pull request out of draft,
`pr-ready`, a merge and every other write run without a question, which ends
agents held on a dialog nobody answers in a repository that merges on its own.
A deny rule still refuses, an ask from an explicit rule still asks, and the
writing rules still apply. Elsewhere every write is asked as before. An absent file lists
no repository; an unreadable or malformed one lists none either and says so in
one transcript line. The plugin never writes the file.

## Tests

Two suites, both offline — no network, no account:

```
bash tests/run-tests.sh        # the Python engine, served from fixtures
claude plugin test             # the mod, with stubbed process/fs/ui calls
```

## Licence

MIT.
