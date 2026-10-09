// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

export const PANE_ID = 'github-prs'

// The gh.py subcommands, for the tool's command enum. gh.py itself maps the
// arguments (--stdin-json); tests/run-tests.sh fails when this list and the
// engine's parser disagree.
export const COMMANDS = [
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-diff', 'pr-files',
  'pr-commits', 'file-at-ref', 'pr-create', 'pr-merge', 'pr-threads',
  'pr-comments', 'pr-issue-comments', 'pr-reviews', 'thread-reply',
  'pr-comment', 'comment-edit', 'comment-delete', 'thread-resolve',
  'comment-resolve', 'comment-unresolve', 'comment-resolved',
  'comments-resolved-batch', 'review-submit', 'review-pending-create',
  'review-pending-add', 'review-pending', 'repo-review-comments', 'pr-update',
  'pr-ready', 'label-add', 'label-remove', 'reviewer-add', 'reviewer-remove',
  'assignee-add', 'assignee-remove', 'issue-view', 'issue-list',
  'issue-search', 'pr-linked-issues', 'image-upload', 'auth-check',
]

// The subcommands that only read. Every other one writes to GitHub, and a
// command missing here is treated as a write, so the safe side is the default.
export const READS = new Set([
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-diff', 'pr-files', 'pr-commits',
  'file-at-ref', 'pr-threads', 'pr-comments', 'pr-issue-comments', 'pr-reviews',
  'comment-resolved', 'comments-resolved-batch', 'review-pending', 'repo-review-comments',
  'issue-view', 'issue-list', 'issue-search', 'pr-linked-issues', 'auth-check',
])

export const TOOL = 'mcp__github__gh'

// The request travels as JSON on stdin: gh.py maps it onto its own parser,
// refuses what that parser does not declare, and writes the bodies to a
// private directory it removes. No argv is built and no file written here.
async function runGh($: any, command: string, args: Record<string, unknown> = {}, repo?: string): Promise<string> {
  const r = await $.process.run(
    ['python3', $.plugin.root + '/engine/gh.py', '--stdin-json'],
    { stdin: JSON.stringify({ command, args, repo }), timeoutMs: 120_000 },
  )
  if (r.exitCode !== 0) throw new Error(r.stderr || 'gh.py exited ' + r.exitCode)
  return r.isStdoutTruncated ? r.stdout + '\n[output cut at 4 MiB]' : r.stdout
}

/*
 * A tool.call hook that answers in place of next(e) skips core, and with it
 * the permission check: settings rules and the mode would never be read. So
 * the hook asks for the verdict itself. A deny refuses. An ask with no rule
 * behind it lets a read through, as reading is what the tool is mostly for,
 * and puts a write to the person. An ask from an explicit rule always asks.
 * Where nobody can answer (a -p run) the ask rejects and the call is refused.
 */
async function permit($: any, e: any): Promise<string | undefined> {
  const input = { command: e.command, args: e.args, repo: e.repo }
  const verdict = await $.tool.check({ tool: TOOL, input })
  if (verdict.decision === 'allow') return undefined
  if (verdict.decision === 'deny') return verdict.reason || 'refused by a permission rule'
  if (READS.has(e.command) && !verdict.rule) return undefined
  const detail = JSON.stringify(e.args ?? {})
  const question = 'Run gh ' + e.command + ' on ' + (e.repo || 'the origin repository') + ' with '
    + (detail.length > 200 ? detail.slice(0, 199) + '…' : detail) + '?'
  try {
    if ((await $.ui.ask(question, ['Allow', 'Deny'])) === 'Allow') return undefined
  } catch {
    return 'gh ' + e.command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + e.command
}

async function prText(
  $: any,
  rawArgs: string,
  command: string,
  format: string,
  shape: (pr: string, out: string) => string = (_pr, out) => out,
): Promise<string> {
  // "#12" is how a PR number is usually written by hand.
  const explicit = (rawArgs ?? '').trim().replace(/^#/, '')
  if (explicit) return shape(explicit, await runGh($, command, { pr: explicit, format }))
  const current = (await runGh($, 'pr-get', { format: 'pr-number' })).trim()
  if (!current) return 'no open PR for this branch'
  return shape(current, await runGh($, command, { pr: current, format }))
}

// checks-status JSON as a line a person reads: "#12 CI: FAILURE (lint, test)".
export function checksLine(pr: string, out: string): string {
  try {
    const status = JSON.parse(out)
    const failed: string[] = status.failed_checks ?? []
    return '#' + pr + ' CI: ' + status.result + (failed.length > 0 ? ' (' + failed.join(', ') + ')' : '')
  } catch {
    return out
  }
}

export type PaneRow = {
  number: number
  title: string
  url: string
  draft: boolean
  // null when the PR was not looked up in detail, or the lookup failed.
  comments: number | null
  // SUCCESS, FAILURE or PENDING from checks-status; "?" when the checks could
  // not be read, "–" past the PRs looked up in detail.
  ci: string
}

// Each detailed PR costs two engine runs (its checks and its own record,
// which alone carries the comment counts), so only the newest are detailed.
export const DETAILED = 5

let paneRows: PaneRow[] = []
let paneError: string | undefined
let refreshing = false

function ciColor(ci: string): string {
  if (ci === 'SUCCESS') return 'success'
  if (ci === 'FAILURE') return 'error'
  if (ci === 'PENDING') return 'warning'
  return 'inactive'
}

async function detail($: any, pr: number): Promise<{ ci: string; comments: number | null }> {
  const [checks, status] = await Promise.allSettled([
    runGh($, 'pr-checks', { pr, format: 'checks-status' }),
    runGh($, 'pr-status', { pr }),
  ])
  let ci = '?'
  let comments: number | null = null
  try {
    if (checks.status === 'fulfilled') ci = String(JSON.parse(checks.value).result)
  } catch {
    // Unreadable checks stay "?": never shown as a state they are not.
  }
  try {
    if (status.status === 'fulfilled') {
      const pull = JSON.parse(status.value)
      comments = (pull.comments ?? 0) + (pull.review_comments ?? 0)
    }
  } catch {
    // Unreadable record: no count shown.
  }
  return { ci, comments }
}

async function collectRows($: any): Promise<void> {
  const prs = JSON.parse(await runGh($, 'pr-list')) as any[]
  const details = await Promise.all(
    prs.slice(0, DETAILED).map((p) => detail($, Number(p.number))),
  )
  paneRows = prs.map((p, i) => ({
    number: p.number,
    title: String(p.title ?? ''),
    url: String(p.html_url ?? ''),
    draft: Boolean(p.draft),
    comments: details[i]?.comments ?? null,
    ci: details[i]?.ci ?? '–',
  }))
}

async function refresh($: any): Promise<void> {
  if (refreshing) return
  refreshing = true
  $.ui.invalidate('ui.render')
  try {
    await collectRows($)
    paneError = undefined
  } catch (err: any) {
    // The rows from the last good read stay on screen under the error.
    paneError = String(err?.message ?? err).trim()
  } finally {
    refreshing = false
    $.ui.invalidate('ui.render')
  }
}

function clip(text: string, max: number): string {
  const room = Math.max(1, max)
  return text.length > room ? text.slice(0, room - 1) + '…' : text
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const root = $.plugin.root
    await $.tool.register({
      name: 'gh',
      // Listed with its schema from the start: behind ToolSearch the model
      // would reach for Bash and curl before it found this tool.
      isDeferred: false,
      description:
        'GitHub API: pull requests, review threads, comments, reviews, labels, '
        + 'issues, search, image uploads. Before first use, Read '
        + root + '/engine/REFERENCE.md for every subcommand. Before authoring any '
        + 'PR title, body, comment, review or commit message, Read '
        + root + '/engine/WRITING.md. Pass positionals by their documented name '
        + '(pr-checks: {"pr": 12}); other keys become --flags; text bodies go in "body".',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: COMMANDS },
          args: {
            type: 'object',
            description: 'subcommand arguments: positionals by name, flags as keys',
          },
          repo: { type: 'string', description: 'owner/name, overriding origin' },
        },
        required: ['command'],
      },
    })
    // Commands last: a taken name throws and would skip the rest of the hook.
    for (const spec of [
      { name: 'checks', description: 'CI status of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'threads', description: 'Open review threads of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'prs', description: 'Open the PR pane' },
    ]) {
      try {
        await $.command.register(spec)
      } catch {
        // Name already taken by another plugin; skip it.
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: TOOL }, async ($: any, e: any) => {
    const refused = await permit($, e)
    if (refused) return { deny: refused }
    try {
      return { result: await runGh($, e.command, e.args ?? {}, e.repo) || '(no output)' }
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the hook itself failed' }))

  on('command.run', { command: 'checks' }, async ($: any, e: any) => {
    try {
      return { text: await prText($, e.args, 'pr-checks', 'checks-status', checksLine) }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /checks failed; the mod itself errored' }))

  on('command.run', { command: 'threads' }, async ($: any, e: any) => {
    try {
      return { text: await prText($, e.args, 'pr-threads', 'thread-summary') }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /threads failed; the mod itself errored' }))

  on('command.run', { command: 'prs' }, async ($: any, _e: any) => {
    try {
      await collectRows($)
      paneError = undefined
      await $.ui.open({ id: PANE_ID, title: 'PRs', closeOnEscape: true })
      return {}
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /prs failed; the mod itself errored' }))

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const width = e.props?.bodyColumns ?? 80
    const rows = paneRows.length === 0
      ? [Text({ key: 'empty', children: [refreshing ? 'Loading…' : 'No open PRs'] })]
      : paneRows.map((r) =>
          Box({
            key: 'pr-' + r.number,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Link({ key: 'link-' + r.number, href: r.url, label: '#' + r.number }),
              Text(
                { color: ciColor(r.ci), children: [
                  clip(r.title, width - 28)
                  + (r.draft ? ' ○ draft' : '')
                  + ' CI:' + r.ci
                  + (r.comments ? ' 💬' + r.comments : ''),
                ] },
              ),
            ],
          }),
        )
    return Box({
      key: 'prs',
      flexDirection: 'column',
      children: [
        ...rows,
        ...(paneError ? [Text({ key: 'error', color: 'error', children: [paneError] })] : []),
        Button({
          key: 'refresh',
          label: refreshing ? 'Refreshing…' : 'Refresh',
          onPress: () => refresh($),
        }),
      ],
    })
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
