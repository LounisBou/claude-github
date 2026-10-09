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

**TODO Staging:**
- [ ] <deploy step for staging>
- [ ] <next step>

**TODO Prod:**
- [ ] <deploy step for prod>
- [ ] <next step>

**PRs Dependency:**
- <url of a PR that must ship before this one or at the same time>
- <url of the next one>

**Related PRs:**
- <url of a PR truly linked to this work>
- <url of the next one>
```

No heading of any kind: the description starts directly with the summary text, never
with `## Summary` or any other title. State what the PR does, never what it does not
do — no list of omissions, no rejected alternatives, no things left untouched. Phrase
a prerequisite positively ("X must have Y set", not "it will fail without Y").
The four sections come after the summary text, in that order, each in that exact shape
whatever the number of items: the bold label alone on its line, then one `- ` bullet per item, one
item per line, nothing else on the line — the line break and the dash are what keep
GitHub's preview rendering every link as a pull request card. Never a heading, never a
link inline after the label. Every section is optional and present only when needed,
never written empty or as `none`. A TODO section is mandatory whenever there is
something to do at deployment. Staging and prod TODOs are always kept apart, even when
they are the same items: then both sections list them. `**PRs Dependency:**` lists the
PRs that must ship before this one or at the same time. When the order is not free, one
PR strictly before the other (an API PR strictly before an infra PR, or the reverse),
the TODOs say that order explicitly. `**Related PRs:**` lists the PRs truly linked to
this work: part of the same batch, the origin of the bug, or a link of that strength,
never a distant link. A follow-up PR, one that must come after this one, is never listed
in Related PRs. English always, with no
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
