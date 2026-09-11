# Writing rules

These are the rules this tool's operator applies before any text leaves the machine
through `gh.py`: commit messages, pull request titles, pull request descriptions and
review comments.

## Commit messages

Follow the target repository's own convention, read from `git log --format=%s -10`,
never imposed from outside: Conventional Commits `<type>(<scope>): <description>`
where the log already uses that form, imperative prose otherwise. Write in the
imperative mood ("add", not "added" or "adds"). Add a body only when the why is not
obvious from the diff itself. No trailer of any kind: no `Co-Authored-By`, no
`Claude-Session`, no attribution of any form, no semicolon. No reference to a plan
`phase`, an `agent`, an `AI`, an `orchestrator`, a `session`, a `brief` or any other
workflow mechanics — the history must read as a developer's own work, in business and
technical terms only.

## Pull request titles

The same convention as the commits of that repository: Conventional Commits
`<type>(<scope>): <description>` where the log uses it, imperative prose otherwise.
One line, stating what the change does, with no semicolon. No workflow vocabulary —
the same words forbidden in commit messages.

Short and concise: about sixty characters at most, the subject of the change in a
few words after the conventional prefix, with no clause explaining how or why — that
belongs in the description.

Too long: `test(device-server): stop the listen tests on their awaited event instead of a fixed timer`
Right: `test(device-server): fix flaky listen tests`

## Pull request descriptions

Follow this exact template:

```
<summary: what it is about, what it does, in 3-5 lines>

<what it does — only if needed>

<explanation of the complex part — only if needed>

<explanation of a non-obvious decision — only if needed>

Related PR:
- <links to the PRs this one directly depends on, or that directly depend on it>
```

No heading of any kind: the description starts directly with the summary text, never
with `## Summary` or any other title. State what the PR does, never what it does not
do — no list of omissions, no rejected alternatives, no things left untouched. Phrase
a prerequisite positively ("X must have Y set", not "it will fail without Y").
`Related PR:` is a plain last line, never a heading, and lists only directly
dependent PRs: a release or upstream PR this one needs, the PR it is stacked on, a PR
that will consume this work. The PRs of one feature that live in different repositories
(an API change with its front-office and back-office consumers) are dependent PRs of each
other: each one lists the others, on every side, so a reviewer who opens any of them
finds the whole set. Omit the whole block when nothing depends on this PR and
it depends on nothing — never write `Related PR: none`. English always, with no
semicolon. No workflow vocabulary. Every PR is opened as a draft (`pr-create
--draft`, the house default), un-drafted only on the operator's explicit word.
An existing description is never edited without the operator's approval.

## Review comments

One main idea per comment, in plain language. The file and line anchor must be
exact, verified against the current file — never trusted from an unverified source.
A short, ready-to-paste suggestion accompanies the point. English on GitHub, with no
semicolon. Every comment states plainly whether it is blocking or nice-to-have. No
workflow vocabulary. Nothing is posted without the operator's explicit approval of
that exact text. A thread a code change has already closed is answered by the
change itself — a reply only says what the code cannot.

These rules come from the operator and apply to every repository this tool touches.
