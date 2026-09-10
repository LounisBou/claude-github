---
name: github-curl
description: |
  Use when making GitHub API calls. Provides a Python standard-library tool covering
  pull requests, review threads, comments, reviews, metadata, issues and image
  attachments, without the gh CLI.
  WHEN: any GitHub API interaction (PRs, threads, comments, reviews, labels, issues,
  image upload).
  WHEN NOT: non-GitHub APIs.
---

# github-curl

## Overview

One entry point: `${CLAUDE_PLUGIN_ROOT}/skills/github-curl/gh.py`. Python 3.9+
standard library only — nothing to install. It replaces the older pair of shell and
Python scripts; every subcommand name they used still works, and the only change is
that formatting became a flag instead of a second script in a pipe.

## Preflight

Run this first and stop on a non-zero exit:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh"
```

It verifies the two upstream plugins are installed **and enabled**, that `python3`,
`curl` and a GitHub token are available, and that the working directory is a GitHub
repository clone. On failure it prints one `error:` line and one `fix:` line naming
what to do.

## Usage

```bash
GH="${CLAUDE_PLUGIN_ROOT}/skills/github-curl/gh.py"

PR=$(python3 "$GH" pr-get --format pr-number)
python3 "$GH" pr-threads "$PR" --format thread-summary

cat > /tmp/comment.md <<'EOF'
Multi-line markdown with `backticks`, "quotes" and $VARIABLES is safe here.
EOF
python3 "$GH" pr-comment "$PR" --body-file /tmp/comment.md
```

`--repo owner/name` and `--format NAME` work on either side of the subcommand.
Without `--repo`, the repository is read from the `origin` remote.

## Bodies

**Every text body is passed with `--body-file <path>`. There is no `--body "text"`
form on any subcommand, and none may be added.**

Multi-line markdown containing backticks, quotes and `$VAR` sequences does not
survive shell quoting, and the failure is silent: the request succeeds with mangled
text. Write the text to a file first. The file's bytes are sent unchanged — no
stripping, no newline translation, so a CRLF file round-trips intact.

Subcommands taking `--body-file`: `pr-comment`, `thread-reply`, `comment-edit`,
`review-submit`, `pr-update`, `pr-create`.

## Subcommands

### Pull requests

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-get` | `[--branch B]` | The PR for a branch, defaulting to the current one |
| `pr-list` | | Open PRs |
| `pr-status` | `<pr>` | State, draft flag, head and base |
| `pr-checks` | `<pr>` | Combined commit status and check runs |
| `pr-diff` | `<pr>` | Unified diff as plain text |
| `pr-files` | `<pr>` | Changed paths with their patches, paginated |
| `pr-commits` | `<pr>` | Commits on the PR, paginated |
| `file-at-ref` | `<path> <ref>` | A file's contents at a ref |
| `pr-create` | `--title T [--body-file P] [--base B] [--head H]` | Open a PR from the current branch |
| `pr-merge` | `<pr> [--method merge\|squash\|rebase]` | Merge a PR |

`file-at-ref` returns `content`, plus `binary`. When the file is not valid UTF-8,
`binary` is true and `content` holds base64 — the bytes are never decoded lossily.

### Review threads and comments

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-threads` | `<pr>` | All review threads (GraphQL) |
| `pr-comments` | `<pr>` | Inline review comments, paginated |
| `pr-issue-comments` | `<pr>` | General PR comments, paginated |
| `pr-reviews` | `<pr>` | Review bodies, paginated |
| `thread-reply` | `<thread_id> --body-file P` | Reply inside a review thread |
| `pr-comment` | `<pr> --body-file P` | Post a general PR comment |
| `comment-edit` | `<comment_id> --body-file P` | Edit a comment |
| `comment-delete` | `<comment_id>` | Delete a comment |
| `thread-resolve` | `<thread_id>` | Resolve a review thread |
| `comment-resolve` | `<node_id>` | Minimise an issue comment |
| `comment-unresolve` | `<node_id>` | Restore a minimised comment |
| `comment-resolved` | `<node_id>` | Whether a comment is minimised |
| `comments-resolved-batch` | `<json_file>` | The same check for a JSON array of node ids |

### Reviews

| Subcommand | Arguments | Description |
|---|---|---|
| `review-submit` | `<pr> --event COMMENT\|APPROVE\|REQUEST_CHANGES [--body-file P] [--comments-file P]` | Submit a review |

`--comments-file` holds a JSON array of `{path, line, side, body}` objects.
`APPROVE` may carry no body; the other two events need a body or inline comments.

### Metadata

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-update` | `<pr> [--title T] [--body-file P] [--base B] [--state open\|closed]` | Change a PR's fields |
| `pr-ready` | `<pr>` | Mark a draft ready for review |
| `label-add` | `<pr> <label>...` | Add labels |
| `label-remove` | `<pr> <label>` | Remove one label — GitHub deletes one per call |
| `reviewer-add` / `reviewer-remove` | `<pr> <user>...` | Request or drop reviewers |
| `assignee-add` / `assignee-remove` | `<pr> <user>...` | Assign or unassign |

### Issues and search

| Subcommand | Arguments | Description |
|---|---|---|
| `issue-view` | `<number>` | One issue |
| `issue-list` | `[--state open\|closed\|all]` | Issues in the repository |
| `issue-search` | `<term>...` | Search within this repository |
| `pr-linked-issues` | `<pr>` | Issues the PR closes |

### Assets and auth

| Subcommand | Arguments | Description |
|---|---|---|
| `image-upload` | `<file> [--branch pr-assets]` | Store an image, return its URL and markdown |
| `auth-check` | | Verify the token |

## Formatters

`--format NAME`, default `raw`. Reads leave the unprocessed JSON visible unless a
shape is asked for.

| Format | Input from | Output |
|---|---|---|
| `raw` | anything | pretty-printed JSON |
| `error-check` | any response | raises on an API error, else nothing |
| `pr-number` | `pr-get`, `pr-create` | the number, or empty |
| `pr-url` | `pr-create`, `pr-status` | the HTML URL |
| `pr-merge-status` | `pr-status` | `merged`, `open` or `closed` |
| `pr-details` | `pr-status` | number, title, state, draft, head, base, url |
| `checks-status` | `pr-checks` | `{"result": SUCCESS\|FAILURE\|PENDING, "failed_checks": [...]}` |
| `open-threads` | `pr-threads` | unresolved threads |
| `resolved-threads` | `pr-threads` | resolved threads |
| `thread-summary` | `pr-threads` | a markdown table of open threads |
| `resolve-status` | `thread-resolve` | `resolved` or `unresolved` |
| `issue-comments-summary` | `pr-issue-comments` | a markdown table |

## Image upload

`image-upload` stores the file on a dedicated branch (`pr-assets` by default) through
the Contents API, using the scoped token. The blob is named after the SHA-256 of its
bytes, so uploading the same screenshot twice issues no write at all and reports
`reused`. It prints both the raw URL and ready-to-paste markdown.

GitHub's web upload endpoint would produce a `user-attachments` URL, but it
authenticates with browser session cookies rather than a scoped token. That route is
deliberately not used: it would mean whole-account credentials on disk. The rendered
result in a pull request is the same.

Requires push access to the repository.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error — bad arguments, unreadable file, wrong shape |
| `2` | authentication failure |
| `3` | API error |
| `4` | not found |
| `5` | rate limited after retries |

Every failure prints one `error:` line to stderr. A Python traceback is a bug, not
an expected output.
