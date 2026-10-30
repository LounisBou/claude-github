// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

import { atom, read, update } from 'claude-code'

import type { GithubPane, GithubPaneRow } from '../types'
import { lint, refusal, textFields } from './writing.ts'

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
  'assignee-add', 'assignee-remove', 'labels-ensure', 'pr-readiness', 'issue-view', 'issue-list',
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
// notes: a call that succeeds can still print a line on stderr (a label that could not
// be set after a pull request was opened). The tool shows it after the output.
async function runGh(
  $: any, command: string, args: Record<string, unknown> = {}, repo?: string, notes = false,
): Promise<string> {
  const r = await $.process.run(
    ['python3', $.plugin.root + '/engine/gh.py', '--stdin-json'],
    { stdin: JSON.stringify({ command, args, repo }), timeoutMs: 120_000 },
  )
  if (r.exitCode !== 0) throw new Error(r.stderr || 'gh.py exited ' + r.exitCode)
  const out = r.isStdoutTruncated ? r.stdout + '\n[output cut at 4 MiB]' : r.stdout
  return notes && r.stderr?.trim() ? out.trimEnd() + '\n' + r.stderr.trim() : out
}

/*
 * A tool.call hook that answers in place of next(e) skips core, and with it
 * the permission check: settings rules and the mode would never be read. So
 * the hook asks for the verdict itself. A deny refuses. An ask with no rule
 * behind it lets a read through, as reading is what the tool is mostly for,
 * and puts a write to the person. An ask from an explicit rule always asks.
 * Where nobody can answer (a -p run) the ask rejects and the call is refused.
 *
 * Between the verdict and the run come the house rules of engine/WRITING.md:
 * the mechanical ones refuse a text before it leaves the machine, and the
 * approvals the file reserves to the person (a pull request out of draft) are
 * asked whatever the settings allow.
 *
 * In a repository in auto-merge no write is put to the person: the reserved
 * approvals lift and an ask with no rule behind it runs. A deny and an ask
 * from an explicit rule stand, and so do the mechanical writing rules.
 */
async function permit($: any, e: any): Promise<string | undefined> {
  const input = { command: e.command, args: e.args, repo: e.repo }
  const verdict = await $.tool.check({ tool: TOOL, input })
  if (verdict.decision === 'deny') return verdict.reason || 'refused by a permission rule'
  const args = e.args ?? {}

  const found = lint(e.command, args, lastTyped)
  if (found.length > 0) {
    const print = fingerprint(e)
    if (!refusedOnce.has(print)) {
      refusedOnce.add(print)
      return refusal(e.command, found)
    }
    // The same text again: the person decides whether it goes as it is.
    const rules = [...new Set(found.map((v) => v.rule.split(' (')[0]))].join(', ')
    return ask($, describe(e) + ', which breaks the writing rules (' + rules + '). Send it as it is?',
      ['Send as it is', 'Deny'], e.command)
  }

  // Read once per call, for a write only.
  const autoMerge = !READS.has(e.command) && await inAutoMerge($, e)
  const reserved = reservedToPerson(e.command, args, autoMerge)
  if (reserved) return ask($, reserved + ' ' + describe(e) + '?', ['Allow', 'Deny'], e.command)

  if (verdict.decision === 'allow') return undefined
  if (READS.has(e.command) && !verdict.rule) return undefined
  if (autoMerge && !verdict.rule) return undefined

  // A grant for the session stands in for an ask no rule demanded, and only
  // for the command and repository it was given on.
  const grantable = !verdict.rule && !NEVER_GRANTED.has(e.command)
  const key = grantable ? await grantKey($, e) : undefined
  if (key && sessionGrants.has(key)) return undefined
  if (!key) return ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
  const where = e.repo || 'the origin repository'
  const question = '« Allow for this session » also allows every later gh ' + e.command + ' on '
    + where + ' until the session ends. ' + describe(e) + '?'
  try {
    const answer = await $.ui.ask(question, ['Allow', 'Allow for this session', 'Deny'])
    if (answer === 'Allow') return undefined
    if (answer === 'Allow for this session') {
      sessionGrants.add(key)
      return undefined
    }
  } catch {
    return 'gh ' + e.command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + e.command
}

async function ask($: any, question: string, options: string[], command: string): Promise<string | undefined> {
  try {
    if ((await $.ui.ask(question, options)) === options[0]) return undefined
  } catch {
    return 'gh ' + command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + command
}

function describe(e: any): string {
  const detail = JSON.stringify(e.args ?? {})
  return 'Run gh ' + e.command + ' on ' + (e.repo || 'the origin repository') + ' with '
    + (detail.length > 200 ? detail.slice(0, 199) + '…' : detail)
}

// The writes no session grant covers: a merge and a deletion are asked each
// time, as neither can be taken back.
export const NEVER_GRANTED = new Set(['pr-merge', 'comment-delete'])

// The approvals WRITING.md reserves to the person, asked whatever a rule or
// the mode allows: a pull request leaves draft only on his word, except in a
// repository he put in auto-merge (autoMerge), where nothing is reserved. A
// description is replaced without asking, under the writing rules.
export function reservedToPerson(command: string, args: Record<string, unknown>, autoMerge = false): string | undefined {
  if (autoMerge) return undefined
  if (command === 'pr-ready') return 'Take a pull request out of draft:'
  if (command === 'pr-create' && args.draft === false) return 'Open a pull request ready for review, not as a draft:'
  return undefined
}

// The repositories in auto-merge, as owner/name: there no write is put to the
// person. The file is the operator's, in the
// host's data directory for this plugin, and nothing here ever writes it.
export const AUTO_MERGE_FILE = 'auto-merge.json'
// The data directory under HOME when the host does not name it.
export const DATA_UNDER_HOME = '/.claude/plugins/data/github-lounisbou'
// The forms of a GitHub origin URL, as engine/ghlib/repo.py reads them.
const GITHUB_ORIGIN = /(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/

// The listed repositories, lowercased. An absent file lists none, and so does
// an unreadable or malformed one, which also says so in one log line.
async function autoMergeRepos($: any): Promise<Set<string>> {
  let path = ''
  try {
    const home = await $.env.get('HOME')
    const dir = (await $.env.get('CLAUDE_PLUGIN_DATA')) || (home ? home + DATA_UNDER_HOME : '')
    if (!dir) return new Set()
    path = dir + '/' + AUTO_MERGE_FILE
    if (!(await $.fs.exists(path))) return new Set()
    const listed = JSON.parse(String(await $.fs.read(path))).repositories
    if (!Array.isArray(listed) || !listed.every((r) => typeof r === 'string')) {
      throw new Error('"repositories" is not a list of owner/name strings')
    }
    return new Set(listed.map((r: string) => r.trim().toLowerCase()))
  } catch (err: any) {
    if (path) $.ui.log('github: ' + path + ' unread, every write is asked: ' + String(err?.message ?? err))
    return new Set()
  }
}

// The repository the engine will act on, in its own order. The call's repo is
// passed last as --repo=, so it wins over a repo in its args even when empty;
// an empty or absent one falls through to GH_REPO, then to the checkout's origin.
async function targetRepo($: any, e: any): Promise<string | undefined> {
  const override = e.repo !== undefined && e.repo !== null ? e.repo : e.args?.repo
  for (const named of [override, await $.env.get('GH_REPO')]) {
    if (named !== undefined && named !== null && String(named) !== '') return String(named)
  }
  const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  const match = r.exitCode === 0 ? GITHUB_ORIGIN.exec(String(r.stdout).trim()) : null
  return match ? match[1] + '/' + match[2] : undefined
}

// Whether a write goes to a repository in auto-merge. Any doubt answers no,
// and the person is asked as before.
async function inAutoMerge($: any, e: any): Promise<boolean> {
  const listed = await autoMergeRepos($)
  if (listed.size === 0) return false
  try {
    const repo = await targetRepo($, e)
    return repo !== undefined && listed.has(repo.trim().toLowerCase())
  } catch {
    return false
  }
}

// Every pull request is opened as a draft unless the call says otherwise,
// and saying otherwise is put to the person (reservedToPerson).
export function withHouseDefaults(command: string, args: Record<string, unknown>): Record<string, unknown> {
  if (command === 'pr-create' && (args.draft === undefined || args.draft === null)) return { ...args, draft: true }
  return args
}

// A grant is the session's, the command's and the repository's: an explicit
// repo by its name, the origin by the directory whose remote it is.
async function grantKey($: any, e: any): Promise<string | undefined> {
  try {
    const session = await $.session.id()
    const repo = e.repo ? 'repo:' + String(e.repo).toLowerCase() : 'origin:' + await $.session.cwd()
    return session + '\n' + e.command + '\n' + repo
  } catch {
    // Without the session or its directory no grant can be scoped: ask.
    return undefined
  }
}

function fingerprint(e: any): string {
  return JSON.stringify([e.command, e.repo ?? '', textFields(e.command, e.args ?? {})])
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

export type PaneRow = GithubPaneRow

// Each detailed PR costs two engine runs (its checks and its own record,
// which alone carries the comment counts), so only the newest are detailed.
export const DETAILED = 5

// How often the open pane reads its PRs again, for CI and review counts that
// change with nobody asking: one pr-list and two runs per detailed PR, well
// under GitHub's hourly limit.
export const WATCH_MS = 60_000

// The pane's rows live in the session's state: a reload of the module keeps
// them, and a write redraws the pane with nobody invalidating it.
const pane = atom({ plugin: 'github', key: 'pane' } as const, { rows: [], error: null, refreshing: false } as GithubPane)

// Names this module registered; a taken name is left to its owner.
const ownedCommands = new Set<string>()
// The last prompt the user typed (at the terminal or through the bridge): a
// text found in it verbatim is the user's own words, never refused.
let lastTyped = ''
// The texts refused once: the same text sent again goes to the person.
const refusedOnce = new Set<string>()
// The grants « Allow for this session » gave, by session, command and repository.
// Kept in the module: a reload or a restart drops them, which only asks again.
const sessionGrants = new Set<string>()
let refreshing = false
// The timer reading the PRs while the pane is open.
let watch: { cancel: () => void } | undefined

// The width of the label column: CI:SUCCESS, CI:FAILURE and CI:PENDING.
const LABEL_COLUMN = 10

function ciColor(ci: string): string {
  if (ci === 'SUCCESS') return 'success'
  if (ci === 'FAILURE') return 'error'
  if (ci === 'PENDING') return 'warning'
  return 'inactive'
}

async function detail($: any, pr: number): Promise<{ ci: string; failed: string[]; comments: number | null }> {
  const [checks, status] = await Promise.allSettled([
    runGh($, 'pr-checks', { pr, format: 'checks-status' }),
    runGh($, 'pr-status', { pr }),
  ])
  let ci = '?'
  let failed: string[] = []
  let comments: number | null = null
  try {
    if (checks.status === 'fulfilled') {
      const parsed = JSON.parse(checks.value)
      ci = String(parsed.result)
      failed = Array.isArray(parsed.failed_checks) ? parsed.failed_checks.map(String) : []
    }
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
  return { ci, failed, comments }
}

async function collectRows($: any): Promise<PaneRow[]> {
  const prs = JSON.parse(await runGh($, 'pr-list')) as any[]
  const details = await Promise.all(
    prs.slice(0, DETAILED).map((p) => detail($, Number(p.number))),
  )
  return prs.map((p, i) => ({
    number: p.number,
    title: String(p.title ?? ''),
    url: String(p.html_url ?? ''),
    draft: Boolean(p.draft),
    comments: details[i]?.comments ?? null,
    ci: details[i]?.ci ?? '–',
    failed: details[i]?.failed ?? [],
  }))
}

// The CI changes worth a toast between two reads: a PR read in both whose
// checks came to an end (SUCCESS or FAILURE) or changed from one end to the
// other. A first read, an unreadable one and a PR new to the list say nothing.
export function ciTransitions(before: PaneRow[], after: PaneRow[]): string[] {
  const old = new Map(before.map((r) => [r.number, r.ci]))
  const lines: string[] = []
  for (const r of after) {
    const was = old.get(r.number)
    if (was === undefined || was === r.ci) continue
    if (was === '?' || was === '–') continue
    if (r.ci !== 'SUCCESS' && r.ci !== 'FAILURE') continue
    lines.push('#' + r.number + ' CI: ' + r.ci + (r.failed.length > 0 ? ' (' + r.failed.join(', ') + ')' : ''))
  }
  return lines
}

async function refresh($: any): Promise<void> {
  if (refreshing) return
  refreshing = true
  await update($, pane, (p) => ({ ...p, refreshing: true }))
  try {
    const before = (await read($, pane)).rows
    const rows = await collectRows($)
    await update($, pane, (p) => ({ ...p, rows, error: null }))
    for (const line of ciTransitions(before, rows)) $.ui.toast(line)
  } catch (err: any) {
    // The rows from the last good read stay on screen under the error.
    const error = String(err?.message ?? err).trim()
    await update($, pane, (p) => ({ ...p, error }))
  } finally {
    refreshing = false
    await update($, pane, (p) => ({ ...p, refreshing: false }))
  }
}

// One timer while the pane is open; a reload of the module cancels it with
// the old copy, and the next /prs or Refresh starts it again.
function startWatch($: any): void {
  if (watch) return
  watch = $.clock.every(WATCH_MS, () => {
    void refresh($)
  })
}

function stopWatch(): void {
  watch?.cancel()
  watch = undefined
}

function clip(text: string, max: number): string {
  const room = Math.max(1, max)
  return text.length > room ? text.slice(0, room - 1) + '…' : text
}

// install.sh's exit codes, the table commands/doctor.md gives in prose.
export const DIAGNOSTIC: Record<number, string> = {
  0: 'everything satisfied',
  11: 'a system tool is missing: install python3 (3.9+) or curl',
  12: 'no GitHub token: run /github:install',
  14: 'GitHub sign-in started: enter the code above in the browser, then run /github:doctor',
}

// install.sh run in the session's directory, its output verbatim and its exit
// code named. /github:install lets it install gh and start the browser
// sign-in, which can take minutes; /github:doctor only checks (--check).
export async function diagnose($: any, check = false): Promise<string> {
  const argv = ['bash', $.plugin.root + '/install.sh', ...(check ? ['--check'] : [])]
  const r = await $.process.run(argv, { timeoutMs: check ? 60_000 : 600_000 })
  const out = [r.stdout, r.stderr].map((t: string) => (t ?? '').trimEnd()).filter(Boolean).join('\n')
  const meaning = DIAGNOSTIC[r.exitCode] ?? 'an unexpected failure'
  return out + '\n\nExit code ' + r.exitCode + ': ' + meaning + '.'
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
    ownedCommands.clear()
    // Commands last: a taken name throws and would skip the rest of the hook.
    for (const spec of [
      { name: 'checks', description: 'CI status of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'threads', description: 'Open review threads of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'prs', description: 'Open the PR pane' },
    ]) {
      try {
        await $.command.register(spec)
        ownedCommands.add(spec.name)
      } catch {
        // Name already taken by another plugin; skip it.
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('prompt.submit', async (_$: any, e: any, next: any) => {
    const kind = String(e.origin?.kind ?? '')
    if (kind === 'composer' || kind === 'bridge') lastTyped = String(e.text ?? '')
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: TOOL }, async ($: any, raw: any) => {
    const e = { ...raw, args: withHouseDefaults(raw.command, raw.args ?? {}) }
    const refused = await permit($, e)
    if (refused) return { deny: refused }
    try {
      const result = await runGh($, e.command, e.args, e.repo, true) || '(no output)'
      // A write changes what the open pane shows: read it again, unawaited.
      if (watch && !READS.has(e.command)) void refresh($)
      return { result }
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the hook itself failed' }))

  on('command.run', { command: 'checks' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('checks')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-checks', 'checks-status', checksLine) }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /checks failed; the mod itself errored' }))

  on('command.run', { command: 'threads' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('threads')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-threads', 'thread-summary') }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /threads failed; the mod itself errored' }))

  on('command.run', { command: 'prs' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('prs')) return next(e)
    try {
      const rows = await collectRows($)
      await update($, pane, (p) => ({ ...p, rows, error: null }))
      await $.ui.open({ id: PANE_ID, title: 'PRs', closeOnEscape: true })
      startWatch($)
      return {}
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /prs failed; the mod itself errored' }))

  // The markdown commands answered here without a model turn. A failure falls
  // back to the markdown, which runs the same script through the model.
  on('command.run', { command: 'github:install' }, async ($: any) => ({ text: await diagnose($) }))
    .catch(async (_$: any, e: any, next: any) => next(e))
  on('command.run', { command: 'github:doctor' }, async ($: any) => ({ text: await diagnose($, true) }))
    .catch(async (_$: any, e: any, next: any) => next(e))

  on('ui.close', async (_$: any, e: any, next: any) => {
    if (e.id === PANE_ID) stopWatch()
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const width = e.props?.bodyColumns ?? 80
    const state = await read($, pane)
    const rows = state.rows.length === 0
      ? [Text({ key: 'empty', children: [state.refreshing ? 'Loading…' : 'No open PRs'] })]
      : state.rows.map((r) => {
          const suffix = (r.draft ? ' ○ draft' : '') + (r.comments ? ' 💬' + r.comments : '')
          return Box({
            key: 'pr-' + r.number,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Link({ key: 'link-' + r.number, href: r.url, label: '#' + r.number }),
              // The title takes the room the number and the label leave, so the
              // label always shows; only the label is coloured.
              Box({
                key: 'room-' + r.number,
                flexGrow: 1,
                flexShrink: 1,
                children: [
                  Text({
                    wrap: 'truncate-end',
                    children: [clip(r.title, width - LABEL_COLUMN - 10 - suffix.length) + suffix],
                  }),
                ],
              }),
              Box({
                key: 'label-' + r.number,
                width: LABEL_COLUMN,
                flexShrink: 0,
                children: [Text({ color: ciColor(r.ci), children: ['CI:' + r.ci] })],
              }),
            ],
          })
        })
    return Box({
      key: 'prs',
      flexDirection: 'column',
      children: [
        ...rows,
        ...(state.error ? [Text({ key: 'error', color: 'error', children: [state.error] })] : []),
        Button({
          key: 'refresh',
          label: state.refreshing ? 'Refreshing…' : 'Refresh',
          onPress: () => {
            startWatch($)
            return refresh($)
          },
        }),
      ],
    })
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
