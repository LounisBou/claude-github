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
whatever the number of items: the bold label alone on its line, then one item per line,
nothing else on the line. A TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`,
never a bare `- ` bullet: the operator ticks it as the step is done. A TODO item stands alone:
it never points to another item ("do the same edit", "same as above", "likewise") and writes
the action in full, the file, the value before and after, and the host or environment. One
checkbox, one action: an edit and the restart, reload, deploy or migration that applies it are
two checkboxes, never joined by "then" or "and run". A PRs Dependency or Related PRs
item is a `- ` bullet — the line break and the dash are what keep
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
--draft`, the house default), un-drafted only on the operator's explicit word,
except in a repository he lists in auto-merge (see the README), where `pr-ready`
needs no word of his.
An existing description is never edited without the operator's approval, except
in a repository he lists in auto-merge, where asking held agents on a dialog nobody answers.

## Security update pull requests

A pull request that updates dependencies to fix published advisories opens its
description with the first line and the tables below. They take the place of the
summary text, and the four sections of the template above follow when needed, with
their rules. A description whose first line names a CVE id is read as a security
update and needs its tables:

```
<package>, <package> and <package> to <version> ([<CVE id>](<advisory URL>), [<CVE id>](<advisory URL>))

| | |
|---|---|
| Package | `<vendor/name>` (locked at <old version>, now <new version>) |
| Advisory | <advisory id> / [<CVE id>](<advisory URL>) — <advisory title>, **<severity>** |
| Affected | `<range>`, `<range>` and `<range>` |
| Reference | <advisory URL> |
```

The first line names the packages, the version they move to and every CVE id the
pull request fixes. Then one table per advisory, in the order of the first line, a
blank line between two tables, the header row empty (`| | |`) and the four rows always
Package, Advisory, Affected, Reference. Package: the package in a code span, then its
locked version and the new one, with `dev dependency, ` first when it is one.
Advisory: the advisory's own id as the audit prints it (`PKSA-…`, `GHSA-…`), the CVE
id, the advisory's title, then its severity in bold when the advisory gives one.
Affected: each affected range in its own code span. Reference: the advisory URL, bare.
An advisory with no CVE id puts its GHSA id where the CVE id goes, as a link too.

Every CVE id in a pull request description is a markdown link to its advisory,
`[CVE-2026-12345](<advisory URL>)`, the URL the audit prints for it: never bare and
never in a code span. GitHub turns a bare CVE id into a link only when its own
advisory database holds that advisory, and never one in a code span.

## Review comments

One main idea per comment, in plain language. The file and line anchor must be
exact, verified against the current file — never trusted from an unverified source.
A short, ready-to-paste suggestion accompanies the point. English on GitHub, with no
semicolon. Every comment states plainly whether it is blocking or nice-to-have. No
workflow vocabulary. Nothing is posted without the operator's explicit approval of
that exact text. A thread a code change has already closed is answered by the
change itself — a reply only says what the code cannot.

These rules come from the operator and apply to every repository this tool touches.
