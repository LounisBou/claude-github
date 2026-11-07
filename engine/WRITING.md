# Writing rules

These are the rules this tool's operator applies before any text leaves the machine
through `gh.py`: commit messages, pull request titles, pull request descriptions and
review comments.

## Commit messages

Conventional Commits in every repository: `<type>[(<scope>)]: <description>`. Write in
the imperative mood ("add", not "added" or "adds"). Add a body only when the why is not
obvious from the diff itself. No trailer of any kind: no `Co-Authored-By`, no
`Claude-Session`, no attribution of any form, no semicolon. A trailer is a line that
opens with a `<word>-by:` label (`Co-Authored-By`, `Signed-off-by`, `Reviewed-by`, and
`Drive-by` or `Stand-by` as well), `Claude-Session:` or `Change-Id:`, and the plugin
refuses it in a description and a review comment. Other labelled lines (`Note:`,
`Follow-up work:`) are none. No reference to a plan
`phase`, an `agent`, an `AI`, an `orchestrator`, a `session`, a `brief` or any other
workflow mechanics in any durable artifact (code, comment, doc, commit, PR) — the
history must read as a developer's own work, in business and technical terms only. In
the Claude plugins themselves, the `claude-*` repositories, these words name the
plugin's object and are allowed. No information specific to GeoNative in a public
repository (code, commit, title, description).

Types: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `perf`, `build`,
`ci`. Examples: `feat(scraper): create TvShow nfo file`, `chore: add json5 dependency`,
`refactor(dispatch): extract folder_for to resolver`, `fix(conf): add missing Config
import`. Never a version prefix (`vX.Y.Z: …`): the version belongs to the release notes.

## Pull request titles

The same convention as the commits: `<type>[(<scope>)]: <description>`.
One line, stating what the change does, with no semicolon. No workflow vocabulary —
the same words forbidden in commit messages.

Short and concise: about sixty characters at most, the subject of the change in a
few words after the conventional prefix, with no clause explaining how or why — that
belongs in the description.

Too long: `test(device-server): stop the listen tests on their awaited event instead of a fixed timer`
Right: `test(device-server): fix flaky listen tests`

## References to pull requests and issues

Name a pull request or an issue with its repository, always: `infra#195`,
`api#1778`. Never a bare `#195`, never « PR #15 », and every item of a list
carries its prefix, even in a table whose column names the repository. One number
exists in several repositories and a bare one can send a merge or a review to the
wrong PR. Only the formats GitHub resolves inside its own repository keep `(#N)`: a
squashed commit title, a PR body, where a `PRs Dependency` or `Related PRs` item is the
pull request's full URL.

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

The four sections are mandatory in every description, so an empty one reads as checked,
never as forgotten. A section with nothing in it is written `none`, lowercase
in one word, on its label's line.
With nothing to do at deployment and no linked PR, a description ends with:

```
**TODO Staging:** none
**TODO Prod:** none
**PRs Dependency:** none
**Related PRs:** none
```

No heading of any kind: the description starts directly with the summary text, never
with `## Summary` or any other title. State what the PR does, never what it does not
do — no list of omissions, no rejected alternatives, no things left untouched. Phrase
a prerequisite positively ("X must have Y set", not "it will fail without Y"). The
plugin refuses, through its tool and through the shell alike, in the summary, the phrasings that say what the PR does not do:
"unchanged", "no dependency", "does not", "doesn't", "is not changed", "left untouched",
"no other pull request", "without conflict". The summary names no pull request: no
`#N`, no `repo#N`, no `owner/repo#N`, no pull request URL above the sections, as links
go in `PRs Dependency` or `Related PRs`, a closing keyword such as `Fixes #12` excepted. No horizontal rule (`---`, `***`, `___`)
other than the `---` between two screenshots, and no bold label line (`**Label:**`)
other than the four sections, anywhere in the description.
The four sections come after the summary text, in that order, each in that exact shape
whatever the number of items: the bold label alone on its line, then one item per line,
nothing else on the line, or the label and `none` on one line when the section is
empty. A TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet: the operator ticks it as the step is done. A TODO item stands alone:
it never points to another item ("do the same edit", "same as above", "likewise") and writes
the action in full, the file, the value before and after, and the host or environment. One
checkbox, one action: an edit and the restart, reload, deploy or migration that applies it are
two checkboxes, never joined by "then" or "and run". A PRs Dependency or Related PRs
item is a `- ` bullet — the line break and the dash are what keep
GitHub's preview rendering every link as a pull request card. Never a heading, never a
link inline after the label: `none` is the one thing ever written beside a label, and
never beside items. A label with nothing after it and no item below is an empty section
left unsaid: write `none`. Staging and prod TODOs are always kept apart, even when
they are the same items: then both sections list them. `**PRs Dependency:**` lists the
PRs that must ship before this one or at the same time. When the order is not free, one
PR strictly before the other (an API PR strictly before an infra PR, or the reverse),
the TODOs say that order explicitly. `**Related PRs:**` lists the PRs truly linked to
this work: part of the same batch, the origin of the bug, or a link of that strength,
never a distant link. A follow-up PR, one that must come after this one, is never listed
in Related PRs. State what ships first. `PRs Dependency` lists PRs that ship before it
or with it, and two PRs never depend on each other. English always, with no
semicolon. No workflow vocabulary. Every PR is opened as a draft (`pr-create
--draft`, the house default), and leaves draft only once it is ready (see « Ready
pull requests »). Outside
auto-merge, leaving draft (a CI undraft aside, see « Ready pull requests ») and merging
also need the operator's explicit word, given through this tool, which asks him in the
conversation. In a
repository in auto-merge, the merge, leaving draft and the deployment its method
foresees need no approval of the operator once the pull request is ready. A repository
enters or leaves auto-merge only through `auto-merge-set`, on the operator's words quoted
verbatim.
Reviewers are requested only when the operator asks, and never on a draft.
The description of the operator's own draft PR is published and edited without asking.
A colleague's PR and any review comment are proposed first.

A paragraph stating the ship order is always added to a description, without asking:
add, re-read, report in one line. It names no pull request, it points to the sections
(« Ships after the PRs in PRs Dependency », « Ships in any order with the Related
PRs »), and every pull request goes in `PRs Dependency` or `Related PRs` as its full
URL. Every URL written in those sections comes from that pull request's own files and
body, never by eye. A TODO goes only on the PR that enables its
step: it runs when that PR ships.

A pull request that changes an interface carries screenshots of what it changes,
desktop AND mobile on a project with a mobile version. They sit above the four
sections. Each screenshot is its descriptive title in bold, alone on its line: the
screen, the state shown, the screen size, and before or after when there is a pair
(`**Devices list, desktop 1440 px, after**`), with no colon at its end, which would
read as a section label. Its image, `![…](…)` or an `<img>` tag, is on the next line.
Two screenshots in a row are separated by a `---` line with a blank line before it, so
the line above never turns into a heading: the block `image-upload --title` writes.
Every image is audited before the PR is Ready, and a PR without both is not ready. When
a visual is fixed after the merge, retake the screenshots and replace them on GitHub
and Notion.

A pull request carries no change its purpose does not need: no reformatting, no
renaming, no unrelated file. A refactor needed for the change to be clean and
architecturally sound is part of it: it is done in a commit of its own and named in
the description. A refactor unrelated to the purpose goes in its own pull request.

## Ready pull requests

Every pull request has its end-to-end tests, and they are merged with the ready PR.

A pull request is ready when four things hold at its current head commit: a review ran
there and came out clean, the norms check ran there and every finding is fixed or
passed, its end-to-end tests ran there and passed (or the operator waived them in his
own words, dated), and every CI check is green there. Ready belongs to one head: a new
commit makes the pull request not ready until the four hold again at the new head.

The `Ready` and `Not Ready` labels carry that fact on GitHub. A draft opens with `Not
Ready`. `Ready` is put only when the four hold, and leaving draft or merging needs the
same four. When the CI does not run on a draft, the pull request leaves draft for it,
still `Not Ready`, and goes back to draft once the CI is green, then takes `Ready`.
A push to the pull request's branch puts `Not Ready` back. The plugin refuses `Ready`,
leaving draft and a merge whose four conditions do not hold, through its tool and
through the shell alike. The review, the norms check and the end-to-end run each leave
a record at the head they read (see REFERENCE.md « Records »). CI is read from GitHub.

## Security update pull requests

A pull request that updates dependencies to fix published advisories opens its
description with the first line and the tables below. They take the place of the
summary text, and the four sections of the template above follow, with their rules,
`none` where empty. A description whose first line names a CVE id is read as a security
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
change itself — a reply only says what the code cannot. Verify first, then ask how it
works, in a two-developers tone, with no colon and no semicolon. On the operator's own
PR a review item is fixed in code, not answered by a comment. Dependent PRs stack,
never a follow-up fix PR. A commit to split off stays in the current PR.

These rules come from the operator and apply to every repository this tool touches.
