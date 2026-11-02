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
  and leaving draft (`draft: false`, `pr-ready`) is always asked, whatever
  the rules allow, except in a repository in auto-merge (below). An existing
  description is replaced without asking, under the writing rules.
- **Ready and Not Ready labels** — `pr-readiness <pr> ready|not-ready` puts
  the `Ready` (`27e760`) or `Not Ready` (`8c1455`) label on a pull request and
  takes the other off, and `labels-ensure` creates both on a repository that
  lacks them. `pr-create` labels the new pull request (`Not Ready` for a draft,
  `Ready` otherwise) and `pr-ready` puts `Ready` on it, so the label says what
  the draft flag says. A label failure never fails the command it follows.
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
follows. There, opening a pull request out of draft, `pr-ready`, a merge
and every other write run without a question, which ends agents held on a
dialog nobody answers in a repository that merges on its own. A deny rule
still refuses, an ask from an explicit rule still asks, and the writing
rules still apply. Elsewhere every write is asked as before. An absent file
lists no repository; an unreadable or malformed one lists none either and
says so in one transcript line. The plugin never writes the file.

## Ready pull requests

A pull request is ready when four things hold at its current head commit: a
clean review, a passed norms check, passed end-to-end tests (or a waiver the
operator dated in his own words) and green CI. The `Ready` label, leaving
draft and a merge need the four; a draft carries `Not Ready`, and a push to
the branch puts `Not Ready` back. CI is read from GitHub: no check at all is
green, a check that failed, still runs, was skipped, or is neutral on a draft
is not. The other three are records, one small JSON file per run under
`~/.claude/pr-records/<owner>/<name>/<head>/`, written by their producers:
claude-review's auto-fix-loop for the review, `/norms:check` for the norms,
`mcp__github__record` for the end-to-end run, and the orchestrator's ready
step. A record counts only at the head it names, so a new commit voids them
all without anything deleted. `engine/REFERENCE.md` « Records » holds the
contract; `engine/WRITING.md` « Ready pull requests » the rule.

When the CI does not run on a draft, the pull request leaves draft for it,
still `Not Ready`, goes back to draft once the CI is green, then takes
`Ready`. That undraft runs in every repository, with one transcript line:

```
github: <owner/name>#<n> out of draft to run CI, still Not Ready
```

This release ships the ready guard in its warn phase: an act that is not ready
goes ahead with one transcript line and one JSON line in `guard-warn.log`, in
the plugin's data directory. `CLAUDE_GITHUB_READY_ENFORCE=1` in the
environment brings the enforce phase forward, where it is refused.

## Guards

**WRITING.md read.** Before a session writes a commit (`git commit`), opens, edits
or comments a pull request or an issue (`gh pr create`, `gh issue create`, `gh pr
comment`, `gh issue comment`, `gh pr review` with a body, `gh pr edit` and `gh
issue edit` with a title or a body), or calls the tool with a text, it reads
`engine/WRITING.md` whole: the Read tool from its first line to its last, or a
Bash `cat` or `sed -n '1,$p'` of it. Each subagent reads for itself, and a
compaction asks for one more read. Commands are read word by word, so a message
that only mentions one passes. Until then the call is refused with:

```
github: read <root>/engine/WRITING.md with the Read tool, whole, before <command>: its rules (commit convention, references, PR titles and descriptions, comments, ready pull requests) apply to this text. Then run the same command again.
```

A failure of the guard itself lets the call through with one transcript line,
and the writing rules above still apply.

**Ready.** Marking a pull request `Ready`, taking it out of draft and merging it
(`gh pr merge --auto` included) need the four conditions above, through the tool
(`pr-ready`, `pr-merge`, `pr-readiness ready`, `label-add Ready`) and through the
shell (`gh pr ready`, `gh pr merge`, `gh pr edit` or `gh issue edit` with
`--add-label Ready`, `gh api` on a pull request's merge or labels). Under enforce
the act is refused before anyone is asked, and a pull request still carrying
`Ready` goes back to `Not Ready`:

```
github: <act> refused on <owner/name>#<n> at <head7>: not ready. Missing: <item>, <item>. A pull request is ready when a clean review, a passed norms check, passed E2E and green CI are all at its current head (engine/WRITING.md « Ready pull requests »).
```

Under warn the act goes ahead with `github: <act> on <owner/name>#<n> is not
ready, let through while the guard only warns. Missing: <item>`. A pull request
opened out of draft is refused under enforce with `github: <act> refused: open it
as a draft, then leave draft once ready.`, and a readiness GitHub did not answer
with `github: readiness of <owner/name>#<n> unverified: <error>`. Going back to
draft always passes, and `gh pr create --draft` and `gh pr ready --undo` put
`Not Ready` on, as the tool does. A merge, an undraft or a `Ready` label in the
shell names its repository, else under both phases (the label under enforce
only) it is refused with `github: <command> refused: name the repository with -R
owner/name.`; a GraphQL merge or undraft names none and is always refused, with
the tool call to run instead.

**Auto-merge split.** In the shell, a merge or leaving draft runs only in a
repository listed in `auto-merge.json`, and the ready guard applies on top.
Elsewhere it is refused in both phases, so the operator is asked in the
conversation through the tool:

```
github: <gh pr merge | gh pr ready> refused on <owner/name>: this repository is not in auto-merge, so a merge or leaving draft needs the operator's explicit word. When he gave it, run mcp__github__gh <pr-merge | pr-ready> {"pr": <n>} on <owner/name>: it checks that the pull request is ready, then asks him in the conversation.
```

A CI undraft, as above, is the exception, through the shell and the tool alike.

**Records.** The records are written by their producers alone. A Write, an Edit
or a MultiEdit under the records root, and a shell command that names it,
a `pr-records/` path or `engine/record.py`, are refused with:

```
github: records are written by their producers (claude-review's auto-fix-loop, /norms:check, the orchestrator's ready, mcp__github__record for E2E), never by hand.
```

The command is read as text, so a plain `ls` of the root is refused too; reading
a record with the Read tool passes. `mcp__github__record` writes at the head the
checkout and the pull request share, on a clean tree, one kind per caller: E2E
for a session, the review for claude-review's hooks, the norms for the norms
plugin's. A waiver quotes words the operator typed in the session, with their
date. Once a
day at most, the start of a session prunes the head directories whose newest
record is older than 90 days.

## Tests

Two suites, both offline — no network, no account:

```
bash tests/run-tests.sh        # the Python engine, served from fixtures
claude plugin test             # the mod, with stubbed process/fs/ui calls
```

## Licence

MIT.
