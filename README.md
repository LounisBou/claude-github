# claude-github

A Claude Code plugin that talks to the GitHub API from a single Python tool with no
dependencies. No `gh` CLI, no third-party packages — Python 3.9+ standard library only.

The plugin is named `github`, so its tool lives at `skills/github-curl/gh.py`.

## Install

Add the marketplace, then install the plugin:

```
/plugin marketplace add LounisBou/claude-github
/plugin install github@claude-github
```

## The GitHub tool

`skills/github-curl/gh.py` covers pull requests, review threads, comments, reviews,
labels, reviewers, issues, search and image attachments, Python standard library only,
no `gh` CLI. See `skills/github-curl/SKILL.md` for the full surface.

Two rules shape it:

**Every text body travels by file.** There is no `--body "text"` form anywhere.
Multi-line markdown containing backticks, quotes and `$VAR` sequences does not survive
shell quoting, and the failure is silent — the request succeeds with mangled text. So
bodies are written to a file and passed with `--body-file`, and the bytes arrive
unchanged, CRLF included.

**Failures are exit codes, not tracebacks.** `1` usage, `2` auth, `3` API error, `4`
not found, `5` rate limited. A Python traceback is a bug.

Images are attached by committing them to a dedicated `pr-assets` branch through the
Contents API with the scoped token, named after the SHA-256 of their bytes so the
same screenshot uploads once. GitHub's own web upload endpoint would produce a
`user-attachments` URL, but it authenticates with browser session cookies rather than
a token — whole-account credentials on disk — so that route is deliberately not used.
The rendered result in a pull request is identical.

## Tests

```
bash tests/run-tests.sh
```

No network, no installed plugin, no GitHub account. Responses are served from fixture
files and every request the tool would have sent is recorded and asserted against.

## Licence

MIT.
