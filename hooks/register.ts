// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

import { atom, read, update } from 'claude-code'

import type { GithubPane, GithubPaneRow } from '../types'
import { lint, refusal, textFields } from './writing.ts'
import {
  WRITING_FILE, bashAuthoring, lineCount, normalise, printsWhole, readerKey, readsWhole, toolAuthoring,
  unreadRefusal,
} from './guards.ts'
import {
  PRUNE_DAYS, PRUNE_EVERY_MS, RECORDS_REFUSAL, autoMergeRefusal, bashActs, bashPushes, carriesReady, ciUndraft,
  ciUndraftLine, createdPr, draftRefusal, graphqlRefusal, missingItems, notReadyRefusal, parseGate, producerSlug,
  recordKindFor, toolAct, touchesRecords, unnamedRepoRefusal, unverifiedRefusal, warnLine,
  type Act, type Gate, type Phase, type RecordFile,
} from './ready.ts'

export const PANE_ID = 'github-prs'

// The gh.py subcommands, for the tool's command enum. gh.py itself maps the
// arguments (--stdin-json); tests/run-tests.sh fails when this list and the
// engine's parser disagree.
export const COMMANDS = [
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-gate', 'pr-diff', 'pr-files',
  'pr-commits', 'file-at-ref', 'pr-create', 'pr-merge', 'pr-threads',
  'pr-comments', 'pr-issue-comments', 'pr-reviews', 'thread-reply',
  'pr-comment', 'comment-edit', 'comment-delete', 'thread-resolve',
  'comment-resolve', 'comment-unresolve', 'comment-resolved',
  'comments-resolved-batch', 'review-submit', 'review-pending-create',
  'review-pending-add', 'review-pending', 'repo-review-comments', 'pr-update',
  'pr-ready', 'pr-draft', 'label-add', 'label-remove', 'reviewer-add', 'reviewer-remove',
  'assignee-add', 'assignee-remove', 'labels-ensure', 'pr-readiness', 'issue-view', 'issue-list',
  'issue-search', 'pr-linked-issues', 'image-upload', 'auth-check',
]

// The subcommands that only read. Every other one writes to GitHub, and a
// command missing here is treated as a write, so the safe side is the default.
export const READS = new Set([
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-gate', 'pr-diff', 'pr-files', 'pr-commits',
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
async function permit(
  $: any, e: any, beforeAsk?: () => Promise<string | undefined>, ciUndraft?: () => Promise<boolean>,
): Promise<string | undefined> {
  const input = { command: e.command, args: e.args, repo: e.repo }
  const verdict = await $.tool.check({ tool: TOOL, input })
  if (verdict.decision === 'deny') return verdict.reason || 'refused by a permission rule'
  const args = e.args ?? {}

  const unread = await writingUnread($, toolAuthoring(e.command, args), e.agentId)
  if (unread) return unread

  // The ready guard, before any question: nobody is asked about a pull
  // request that is not ready.
  const notReady = beforeAsk ? await beforeAsk() : undefined
  if (notReady) return notReady

  // Going back to draft, and leaving it for CI still Not Ready, are no
  // approvals to give: they run in every repository, as through Bash. An ask
  // from an explicit rule stands.
  if (e.command === 'pr-draft' || (ciUndraft && await ciUndraft())) {
    if (verdict.decision === 'allow' || !verdict.rule) return undefined
    return ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
  }

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

// ---- the guard « WRITING.md read » ----

/*
 * Every text engine/WRITING.md governs (a commit, a pull request, a comment, a
 * review) waits until its author read the file whole in the context that
 * writes it. A whole Read of the loaded version's file marks the reader, the
 * session and the loop within it, and so do a Bash cat or sed -n '1,$p' of it,
 * and, in a checkout of this plugin, a Read of the checkout's copy. A
 * compaction of that loop clears its mark, as the text left its context, and
 * a reload of the module clears them all: both cost one more Read. A failure
 * of the guard itself never holds a text back: the writing rules still run.
 */

// The readers who hold WRITING.md in their context, by readerKey, and those
// whose read of it could not be marked: a failure of the guard, which lets
// their texts through rather than hold them back for ever.
const readers = new Map<string, 'read' | 'marking failed'>()

// The repository whose checkout carries the file as its own engine/WRITING.md.
export const PLUGIN_REPOSITORY = 'lounisbou/claude-github'

function guardFailed($: any, err: any): undefined {
  $.ui.log('github: the WRITING.md guard failed and let the call through: ' + String(err?.message ?? err))
  return undefined
}

// The session's id, or a throw: an absent or empty one would make every
// session without one the same reader.
async function sessionId($: any): Promise<string> {
  const id = await $.session.id()
  if (typeof id !== 'string' || id === '') throw new Error('the session id is unreadable: ' + String(id))
  return id
}

// The refusal for an authoring command whose reader has not read the file,
// or undefined: no authoring, a reader who read it, or a guard failure.
async function writingUnread($: any, command: string | undefined, agentId?: string): Promise<string | undefined> {
  if (!command) return undefined
  try {
    const state = readers.get(readerKey(await sessionId($), agentId))
    if (state === 'read') return undefined
    if (state === 'marking failed') return guardFailed($, 'a read of WRITING.md could not be marked')
    return unreadRefusal($.plugin.root, command)
  } catch (err) {
    return guardFailed($, err)
  }
}

// Whether a path is a WRITING.md this reader may read for the rules: the
// loaded version's, or the session's checkout's when it is this plugin. Any
// other file costs one string comparison.
async function isWritingFile($: any, path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !path.endsWith('WRITING.md')) return false
  const dir = String(await $.session.cwd())
  const file = normalise(path, dir)
  if (file === normalise($.plugin.root + WRITING_FILE)) return true
  if (file !== normalise(dir + WRITING_FILE)) return false
  const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  const match = r.exitCode === 0 ? GITHUB_ORIGIN.exec(String(r.stdout).trim()) : null
  return match !== null && (match[1] + '/' + match[2]).toLowerCase() === PLUGIN_REPOSITORY
}

async function markReader($: any, agentId?: string): Promise<void> {
  readers.set(readerKey(await sessionId($), agentId), 'read')
}

// A read of the file that could not be marked: logged, and its reader let
// through until a compaction, unless an earlier read marked it.
async function markFailed($: any, err: any, agentId?: string): Promise<void> {
  guardFailed($, err)
  try {
    const key = readerKey(await sessionId($), agentId)
    if (readers.get(key) !== 'read') readers.set(key, 'marking failed')
  } catch {
    // No reader to name: writingUnread fails on the same session id and lets the call through.
  }
}

function failed(result: any): boolean {
  return !result || result.deny !== undefined || result.isError === true
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
// repository he put in auto-merge (autoMerge), where nothing is reserved. The
// description of his own draft is published and edited without asking, under
// the writing rules.
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
// The plugin's data directory: the host's, else the one under HOME, else ''.
async function dataDir($: any): Promise<string> {
  const home = await $.env.get('HOME')
  return (await $.env.get('CLAUDE_PLUGIN_DATA')) || (home ? home + DATA_UNDER_HOME : '')
}

async function autoMergeRepos($: any): Promise<Set<string>> {
  let path = ''
  try {
    const dir = await dataDir($)
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
// Read once per call: the ready guard and the auto-merge check ask for it both.
const targets = new WeakMap<object, Promise<string | undefined>>()

function targetRepo($: any, e: any): Promise<string | undefined> {
  let found = targets.get(e)
  if (!found) {
    found = readTargetRepo($, e)
    targets.set(e, found)
  }
  return found
}

async function readTargetRepo($: any, e: any): Promise<string | undefined> {
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

// ---- the ready guard and the auto-merge split ----

/*
 * A pull request is ready when a clean review, a passed norms check, passed
 * E2E and green CI all stand at its current head (engine/WRITING.md « Ready
 * pull requests »). Marking it Ready, taking it out of draft and merging it
 * need the four, through the tool and through Bash alike. Under the warn
 * phase an act that is not ready goes ahead with one warn line, under the
 * enforce phase it is refused. Through Bash a merge or leaving draft in a
 * repository not in auto-merge is refused in both: the tool asks the person.
 * A pull request that carries Not Ready and whose CI is not green may leave
 * draft for its CI to run, still Not Ready, in every repository.
 */

// The phase this release ships with.
export const READY_PHASE: Phase = 'warn'
// Set to 1 in the environment, it brings the enforce phase forward. It only
// ever tightens: no variable turns a release's enforce phase back to warn.
export const ENFORCE_ENV = 'CLAUDE_GITHUB_READY_ENFORCE'

async function phaseOf($: any): Promise<Phase> {
  if (READY_PHASE === 'enforce') return 'enforce'
  try {
    return (await $.env.get('CLAUDE_GITHUB_READY_ENFORCE')) === '1' ? 'enforce' : 'warn'
  } catch {
    return READY_PHASE
  }
}

export const RECORD_TOOL = 'mcp__github__record'
export const WARN_LOG = 'guard-warn.log'

// A line in the transcript that never fails what it reports on.
function note($: any, text: string): void {
  try {
    const sent = $.ui.log(text)
    if (sent && typeof sent.catch === 'function') sent.catch(() => undefined)
  } catch {
    // Nowhere to say it: the act it notes is not held for that.
  }
}

async function configDir($: any): Promise<string | undefined> {
  const named = await $.env.get('CLAUDE_CONFIG_DIR')
  if (named) return String(named)
  const home = await $.env.get('HOME')
  return home ? home + '/.claude' : undefined
}

// ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records, or undefined when unreadable.
async function recordsRoot($: any): Promise<string | undefined> {
  try {
    const dir = await configDir($)
    return dir ? dir + '/pr-records' : undefined
  } catch {
    return undefined
  }
}

// The records of a pull request's head, as files. A directory that cannot be
// listed holds none, a file that cannot be read is one that does not parse.
async function headRecords($: any, gate: Gate): Promise<RecordFile[]> {
  const root = await recordsRoot($)
  if (!root) return []
  const dir = root + '/' + gate.repo.toLowerCase() + '/' + gate.head
  let entries: any[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const files: RecordFile[] = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (entry?.kind === 'directory' || name.startsWith('.') || !name.endsWith('.json')) continue
    let text = ''
    try {
      text = String(await $.fs.read(dir + '/' + name))
    } catch {
      // Left empty: it is named as unreadable.
    }
    files.push({ name, text })
  }
  return files
}

type Readiness = { gate?: Gate; missing: string[]; error?: string }

// What a pull request misses at its head, read from GitHub and the records.
async function readiness($: any, repo: string, pr: number, sha?: string): Promise<Readiness> {
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return { missing: [], error: String(err?.message ?? err).trim() }
  }
  return { gate, missing: missingItems(gate, await headRecords($, gate), sha) }
}

// A line added at the end of a file, the file created when absent. $.fs only
// rewrites a file whole: a file already there is appended to by the shell, so
// a read that fails or another session's line in between loses nothing.
async function appendLine($: any, path: string, text: string): Promise<void> {
  let present = true
  try {
    await $.fs.stat(path)
  } catch {
    present = false
  }
  if (!present) {
    await $.fs.write(path, text)
    return
  }
  const r = await $.process.run(['sh', '-c', 'cat >> "$1"', 'sh', path], { stdin: text, timeoutMs: 10_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr || 'the append exited ' + r.exitCode)
}

// One transcript line and one JSON line in the plugin's guard-warn.log.
async function warnAct(
  $: any, act: Act, route: 'tool' | 'bash', repo: string, pr: number | string, head: string, missing: string[],
): Promise<void> {
  note($, warnLine(act.name, repo, pr, missing))
  try {
    const dir = await dataDir($)
    if (!dir) return
    const path = dir + '/' + WARN_LOG
    let session = ''
    try {
      session = String(await $.session.id() ?? '')
    } catch {
      // Logged without it.
    }
    const line = { at: new Date().toISOString(), session, repo, pr, head, act: act.name, route, missing }
    await appendLine($, path, JSON.stringify(line) + '\n')
  } catch {
    // The transcript line stands for it.
  }
}

async function labelNotReady($: any, repo: string, pr: number): Promise<void> {
  await runGh($, 'pr-readiness', { pr, state: 'not-ready' }, repo)
}

// The number of the open pull request of a branch, the current one when none
// is named, or undefined.
async function prOfBranch($: any, repo: string, branch?: string): Promise<number | undefined> {
  const pulls = JSON.parse(await runGh($, 'pr-get', branch ? { branch } : {}, repo))
  const pull = Array.isArray(pulls) ? pulls.find((p: any) => p && p.number) : undefined
  return pull ? Number(pull.number) : undefined
}

// The enforce phase's refusal, which also takes Ready off a pull request
// that still carries it, so the label never claims what the guard refused.
async function refuseNotReady($: any, act: Act, repo: string, pr: number, r: Readiness): Promise<string> {
  const gate = r.gate as Gate
  if (carriesReady(gate)) {
    try {
      await labelNotReady($, repo, pr)
    } catch (err: any) {
      note($, 'github: ' + repo + '#' + pr + ' keeps Ready, the label could not be changed: ' + String(err?.message ?? err))
    }
  }
  return notReadyRefusal(act.name, repo, pr, gate.head, r.missing)
}

// The Bash ready guard failed on its own: under warn the command goes on with
// a warn line, under enforce it is refused as a readiness that could not be read.
async function guardThrew($: any, act: Act | undefined, err: any): Promise<string | undefined> {
  const error = String(err?.message ?? err).trim()
  if (await phaseOf($) === 'enforce') return unverifiedRefusal(act?.repo, act?.pr, error)
  const named: Act = act ?? { kind: 'merge', name: 'the command' }
  await warnAct($, named, 'bash', act?.repo ?? '?', act?.pr ?? '?', '', ['readiness unverified: ' + error])
  return undefined
}

// The tool's act: checked before any question under enforce, and once it goes
// ahead under warn. A CI undraft runs as pr-ready --for-ci, which keeps Not Ready.
function toolReady($: any, e: any, act: Act) {
  let read: Readiness | undefined
  let forCi = false
  const repoPr = async (): Promise<{ repo?: string; pr?: number }> => {
    let repo: string | undefined
    try {
      repo = await targetRepo($, e)
    } catch {
      repo = undefined
    }
    return { repo, pr: act.pr !== undefined && Number.isFinite(act.pr) ? act.pr : undefined }
  }
  // undefined when the act may go on; else what it misses, or why that is unknown.
  const evaluate = async (): Promise<{ repo: string; pr: number | string; r: Readiness } | undefined> => {
    const { repo, pr } = await repoPr()
    if (!repo || pr === undefined) {
      return { repo: repo ?? 'the origin repository', pr: pr ?? '?', r: { missing: [], error: 'no repository or pull request named' } }
    }
    try {
      read = read ?? await readiness($, repo, pr, act.sha)
      if (act.kind === 'undraft' && read.gate && ciUndraft(read.gate)) {
        forCi = true
        e.args = { ...e.args, 'for-ci': true }
        return undefined
      }
    } catch (err: any) {
      // The guard's own failure reads as a readiness that could not be read.
      read = { missing: [], error: String(err?.message ?? err).trim() }
    }
    if (read.error || read.missing.length > 0) return { repo, pr, r: read }
    return undefined
  }
  const gated = act.kind === 'merge' || act.kind === 'undraft' || act.kind === 'ready-label'
  return {
    async beforeAsk(): Promise<string | undefined> {
      if (await phaseOf($) !== 'enforce') return undefined
      if (act.kind === 'create') return draftRefusal(act.name)
      if (!gated) return undefined
      const found = await evaluate()
      if (!found) return undefined
      if (found.r.error) return unverifiedRefusal(found.repo, found.pr, found.r.error)
      try {
        return await refuseNotReady($, act, found.repo, Number(found.pr), found.r)
      } catch (err: any) {
        return unverifiedRefusal(found.repo, found.pr, String(err?.message ?? err).trim())
      }
    },
    // Whether this is an undraft for CI, read in both phases.
    async ciUndraft(): Promise<boolean> {
      if (act.kind !== 'undraft') return false
      await evaluate()
      return forCi
    },
    async goingAhead(): Promise<void> {
      if (await phaseOf($) !== 'warn') return
      if (act.kind === 'create') {
        const { repo } = await repoPr()
        await warnAct($, act, 'tool', repo ?? 'the origin repository', '?', '', ['opened out of draft'])
        return
      }
      if (!gated) return
      const found = await evaluate()
      if (!found) return
      const missing = found.r.error ? ['readiness unverified: ' + found.r.error] : found.r.missing
      await warnAct($, act, 'tool', found.repo, found.pr, found.r.gate?.head ?? '', missing)
    },
    async ran(): Promise<void> {
      if (!forCi) return
      const { repo, pr } = await repoPr()
      if (repo && pr !== undefined) note($, ciUndraftLine(repo, pr))
    },
  }
}

// The Bash act's refusal, or undefined; what must follow its success goes in after.
async function bashReady($: any, act: Act, after: Array<(result: any) => Promise<void>>): Promise<string | undefined> {
  const readyPhase = await phaseOf($)
  if (act.kind === 'create') {
    if (readyPhase === 'enforce') return draftRefusal(act.name)
    await warnAct($, act, 'bash', act.repo ?? '?', '?', '', ['opened out of draft'])
    return undefined
  }
  if (act.kind === 'create-draft') {
    after.push(async (result) => {
      const made = createdPr(stdoutOf(result))
      if (made) await labelNotReady($, made.repo, made.pr)
      else note($, 'github: the new draft keeps its labels: gh pr create printed no pull request URL')
    })
    return undefined
  }
  if (act.kind === 'redraft') {
    after.push(async () => {
      const pr = act.repo ? act.pr ?? await prOfBranch($, act.repo, act.branch) : undefined
      if (act.repo && pr !== undefined) await labelNotReady($, act.repo, pr)
      else note($, 'github: the pull request back in draft keeps its labels: name it with -R owner/name and its number')
    })
    return undefined
  }
  if (act.unnamed) return graphqlRefusal(act.kind)
  if (!act.repo) {
    // A merge or leaving draft is refused in both phases, as the auto-merge
    // split needs the repository. The Ready label is the ready guard's alone.
    if (act.kind !== 'ready-label' || readyPhase === 'enforce') return unnamedRepoRefusal(act.name)
    await warnAct($, act, 'bash', '?', act.pr ?? '?', '', ['readiness unverified: the command names no repository'])
    return undefined
  }
  const repo = act.repo
  const listed = act.kind === 'ready-label' ? false : (await autoMergeRepos($)).has(repo.toLowerCase())
  if (act.kind === 'merge' && !listed) return autoMergeRefusal('merge', repo, act.pr)
  let pr = act.pr
  let lookup = ''
  if (pr === undefined) {
    try {
      pr = await prOfBranch($, repo, act.branch)
      if (pr === undefined) lookup = 'no open pull request for ' + (act.branch ?? 'the current branch')
    } catch (err: any) {
      lookup = String(err?.message ?? err).trim()
    }
  }
  const r: Readiness = pr === undefined ? { missing: [], error: lookup } : await readiness($, repo, pr, act.sha)
  if (act.kind === 'undraft') {
    if (r.gate && ciUndraft(r.gate) && pr !== undefined) {
      const n = pr
      after.push(async () => note($, ciUndraftLine(repo, n)))
      return undefined
    }
    if (!listed) return autoMergeRefusal('undraft', repo, pr)
  }
  const shown = pr ?? '?'
  if (r.error) {
    if (readyPhase === 'enforce') return unverifiedRefusal(repo, shown, r.error)
    await warnAct($, act, 'bash', repo, shown, '', ['readiness unverified: ' + r.error])
    return undefined
  }
  if (r.missing.length > 0) {
    if (readyPhase === 'enforce') return refuseNotReady($, act, repo, Number(pr), r)
    await warnAct($, act, 'bash', repo, shown, r.gate?.head ?? '', r.missing)
  }
  return undefined
}

function stdoutOf(result: any): string {
  const out = result?.result
  if (typeof out === 'string') return out
  return String(out?.stdout ?? '')
}

// A push moves the head of the branches it names: a pull request of theirs
// that carries Ready goes back to Not Ready. A branch or a repository read
// with any doubt is left alone, with one line saying so.
async function followPushes($: any, line: string): Promise<void> {
  const { pushes, moves } = bashPushes(line)
  for (const push of pushes) {
    try {
      const byUrl = push.remote !== undefined && GITHUB_ORIGIN.test(push.remote)
      if (push.unsure || (moves && (push.current !== undefined || !byUrl))) {
        note($, 'github: the labels are left as they are after the push: ' + (push.unsure ?? 'the command changes directory first'))
        continue
      }
      let remote = push.remote
      const branches = [...push.branches]
      if (push.current === 'upstream') {
        const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 10_000 })
        const upstream = r.exitCode === 0 ? String(r.stdout).trim() : ''
        const slash = upstream.indexOf('/')
        if (slash <= 0) {
          note($, 'github: the labels are left as they are after the push: the current branch has no upstream')
          continue
        }
        remote = upstream.slice(0, slash)
        branches.push(upstream.slice(slash + 1))
      } else if (push.current === 'branch') {
        const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
        const branch = r.exitCode === 0 ? String(r.stdout).trim() : ''
        if (!branch || branch === 'HEAD') {
          note($, 'github: the labels are left as they are after the push: the current branch cannot be read')
          continue
        }
        branches.push(branch)
      }
      let url = remote ?? ''
      if (!GITHUB_ORIGIN.test(url)) {
        const r = await $.process.run(['git', 'remote', 'get-url', url], { timeoutMs: 10_000 })
        url = r.exitCode === 0 ? String(r.stdout).trim() : ''
      }
      const match = GITHUB_ORIGIN.exec(url)
      if (!match) {
        note($, 'github: the labels are left as they are after the push: ' + (remote ?? 'its remote') + ' is no GitHub repository')
        continue
      }
      const repo = match[1] + '/' + match[2]
      for (const branch of branches) {
        const pulls = JSON.parse(await runGh($, 'pr-get', { branch }, repo))
        for (const pull of Array.isArray(pulls) ? pulls : []) {
          const labels = (pull?.labels ?? []).map((l: any) => String(l?.name ?? l).toLowerCase())
          if (!labels.includes('ready')) continue
          await labelNotReady($, repo, Number(pull.number))
          note($, 'github: ' + repo + '#' + pull.number + ' back to Not Ready after the push to ' + branch)
        }
      }
    } catch (err: any) {
      note($, 'github: the labels could not be read after the push: ' + String(err?.message ?? err))
    }
  }
}

// ---- records ----

// The prompts the person typed in this session, at the terminal or through
// the bridge: an E2E waiver quotes one of them.
const typedPrompts: string[] = []
const TYPED_KEPT = 200

function typedVerbatim(text: string): boolean {
  return text.trim() !== '' && typedPrompts.some((prompt) => prompt.includes(text))
}

// The round store, one JSON file per question the operator answers:
// read-only here, the newest files only.
const ROUND_READ = 200
const ROUND_ANSWERERS = ['pane', 'coordinator', 'tab']

// A waiver never rests on a few characters: the quoted text is at least this long.
const ROUND_QUOTE_MIN = 8

// What a waiver must quote of an answer: a pane answer is often a letter (« A », « A : oui »),
// then the text of the choice it names; a letter that is not among the entry's choices is
// nothing to quote ('').
function roundAnswerText(entry: any, answer: string): string {
  const letter = /^([A-Za-z])\s*(?:[:\u2014)\-.]|$)/.exec(answer)
  if (!letter) return answer
  const choices: any[] = Array.isArray(entry?.choices) ? entry.choices : []
  const chosen = choices.find((choice) => String(choice?.letter ?? '').toUpperCase() === letter[1].toUpperCase())
  return chosen ? String(chosen.text ?? '').trim() : ''
}

// True when some answer the operator gave in the round, about this pull request,
// is quoted whole in the detail, for an E2E question naming it. A store or a file that cannot be read matches nothing.
async function roundAnswered($: any, detail: string, repo: string, pr: number): Promise<boolean> {
  try {
    const dir = await configDir($)
    if (!dir) return false
    const root = dir + '/claude-orchestrator/round'
    const named = String(repo).split('/').pop() + '#' + pr
    const mention = new RegExp('(^|[^A-Za-z0-9_.-])' + named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)', 'i')
    const dated: Array<{ path: string; mtime: number }> = []
    for (const entry of await $.fs.list(root)) {
      const name = String(entry?.name ?? '')
      if (entry?.kind === 'directory' || name.startsWith('.') || !name.endsWith('.json')) continue
      try {
        dated.push({ path: root + '/' + name, mtime: Number((await $.fs.stat(root + '/' + name)).mtimeMs) })
      } catch {
        // Not a match.
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const { path } of dated.slice(0, ROUND_READ)) {
      try {
        const entry = JSON.parse(String(await $.fs.read(path)))
        const answer = entry?.answer
        if (!answer || !ROUND_ANSWERERS.includes(answer.by)) continue
        const asked = String(entry.question ?? '') + '\n' + String(entry.blocks ?? '')
        if (!/E2E/i.test(asked) || !mention.test(asked)) continue
        const text = roundAnswerText(entry, String(answer.text ?? '').trim())
        if (text.length >= ROUND_QUOTE_MIN && detail.includes(text)) return true
      } catch {
        // Not a match.
      }
    }
  } catch {
    // No store: no match.
  }
  return false
}

async function writeRecord($: any, e: any, origin: string): Promise<{ result?: string; deny?: string; isError?: boolean }> {
  const verdict = await $.tool.check({ tool: RECORD_TOOL, input: { pr: e.pr, repo: e.repo, kind: e.kind, result: e.result, detail: e.detail } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const owned = recordKindFor(origin)
  const kind = e.kind === undefined || e.kind === null || e.kind === '' ? owned : String(e.kind)
  if (kind !== owned) {
    return {
      deny: 'github: ' + kind + ' records are written by their producer (claude-review\'s auto-fix-loop for review,'
        + ' /norms:check for norms): ' + (origin === 'engine' ? 'this tool' : origin) + ' writes ' + owned + ' only.',
    }
  }
  const result = String(e.result ?? '')
  const detail = e.detail === undefined || e.detail === null ? '' : String(e.detail)
  const pr = Number(String(e.pr ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return { deny: 'github: name the pull request: {"pr": <n>}' }
  const repo = await targetRepo($, { repo: e.repo, args: {} })
  if (!repo) return { deny: 'github: name the repository: {"repo": "owner/name"}' }
  if (result === 'waived' && !typedVerbatim(detail) && !(await roundAnswered($, detail, repo, pr))) {
    return {
      deny: 'github: an E2E waiver quotes the operator: its detail must be words he typed in this session,'
        + ' or his answer recorded in the round about this pull request, with their date.',
    }
  }
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return { deny: unverifiedRefusal(repo, pr, String(err?.message ?? err).trim()) }
  }
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  const local = head.exitCode === 0 ? String(head.stdout).trim().toLowerCase() : ''
  if (local !== gate.head) {
    return { deny: 'github: the checkout is at ' + (local.slice(0, 7) || 'no commit') + ', the pull request\'s head is ' + gate.head.slice(0, 7) + ': a record is written at the head it read.' }
  }
  const status = await $.process.run(['git', 'status', '--porcelain', '-uno'], { timeoutMs: 10_000 })
  if (status.exitCode !== 0 || String(status.stdout).trim() !== '') {
    return { deny: 'github: the tracked files have changes: a record is written on a clean checkout of the head.' }
  }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Written without it.
  }
  const argv = [
    'python3', $.plugin.root + '/engine/record.py', '--repo', repo, '--pr', String(pr), '--head', gate.head,
    '--kind', kind, '--result', result, '--producer', producerSlug(origin), '--detail', detail, '--session', session,
  ]
  const run = await $.process.run(argv, { timeoutMs: 30_000 })
  if (run.exitCode !== 0) return { result: String(run.stderr || 'record.py exited ' + run.exitCode).trim(), isError: true }
  return { result: String(run.stdout).trim() }
}

// At most once a day, the head directories whose newest record is older than
// PRUNE_DAYS go: their pull request merged or moved on long ago.
async function pruneRecords($: any): Promise<void> {
  const root = await recordsRoot($)
  if (!root || !(await $.fs.exists(root))) return
  const stamp = root + '/.pruned'
  try {
    const last = await $.fs.stat(stamp)
    if (Date.now() - Number(last.mtimeMs) < PRUNE_EVERY_MS) return
  } catch {
    // Never pruned.
  }
  const cut = Date.now() - PRUNE_DAYS * 24 * 3600 * 1000
  const dirs = async (path: string): Promise<string[]> =>
    (await $.fs.list(path)).filter((x: any) => x?.kind === 'directory').map((x: any) => path + '/' + x.name)
  const stale: string[] = []
  for (const owner of await dirs(root)) {
    for (const name of await dirs(owner)) {
      for (const head of await dirs(name)) {
        let newest = Number((await $.fs.stat(head)).mtimeMs)
        for (const file of await $.fs.list(head)) {
          newest = Math.max(newest, Number((await $.fs.stat(head + '/' + file.name)).mtimeMs))
        }
        if (newest < cut) stale.push(head)
      }
    }
  }
  if (stale.length > 0) await $.process.run(['rm', '-rf', '--', ...stale], { timeoutMs: 60_000 })
  await $.fs.write(stamp, new Date().toISOString() + '\n')
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
    // Apart from the gh tool: a failure here leaves it and the commands registered.
    try {
      await $.tool.register({
        name: 'record',
        isDeferred: false,
        description:
          'Record the end-to-end tests of a pull request at its head commit: pass, fail, or waived by '
          + 'the operator in his own words. Run from a clean checkout at the pull request\'s head, after '
          + 'the tests ran there. A waiver\'s detail quotes words he typed in this session, with their date '
          + '(YYYY-MM-DD). Reviews and norms checks are recorded by their own tools. See '
          + root + '/engine/REFERENCE.md « Records ».',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name, overriding origin' },
            result: { type: 'string', enum: ['pass', 'fail', 'waived'] },
            detail: { type: 'string', description: 'what ran, or the operator\'s waiver with its date' },
            kind: { type: 'string', enum: ['review', 'norms', 'e2e'], description: 'default: the kind this caller writes' },
          },
          required: ['pr', 'result'],
        },
      })
    } catch (err: any) {
      note($, 'github: the record tool could not be registered: ' + String(err?.message ?? err))
    }
    try {
      await pruneRecords($)
    } catch (err: any) {
      note($, 'github: the old records could not be pruned: ' + String(err?.message ?? err))
    }
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
    if (kind === 'composer' || kind === 'bridge') {
      lastTyped = String(e.text ?? '')
      typedPrompts.push(lastTyped)
      if (typedPrompts.length > TYPED_KEPT) typedPrompts.shift()
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    try {
      if (touchesRecords(String(e.command), await recordsRoot($))) return { deny: RECORDS_REFUSAL }
    } catch {
      // A command that is no text names no record either.
    }
    let command: string | undefined
    try {
      command = bashAuthoring(e.command)
    } catch (err) {
      guardFailed($, err)
      return next(e)
    }
    const unread = await writingUnread($, command, e.agentId)
    if (unread) return { deny: unread }
    const after: Array<(result: any) => Promise<void>> = []
    let current: Act | undefined
    try {
      for (const act of bashActs(String(e.command))) {
        current = act
        const refused = await bashReady($, act, after)
        if (refused) return { deny: refused }
      }
    } catch (err) {
      // The ready guard failed on its own: its readiness reads as unverified, never as a pass.
      const refused = await guardThrew($, current, err)
      if (refused) return { deny: refused }
    }
    const result = await next(e)
    try {
      const printed = printsWhole(e.command)
      if (printed && !failed(result) && await isWritingFile($, printed)) {
        await markReader($, e.agentId)
      }
    } catch (err) {
      await markFailed($, err, e.agentId)
    }
    if (!failed(result)) {
      for (const then of after) {
        try {
          await then(result)
        } catch (err: any) {
          note($, 'github: the label could not be set after the command: ' + String(err?.message ?? err))
        }
      }
      await followPushes($, String(e.command))
    }
    return result
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // The records are written by their producers only.
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    on('tool.call', { tool }, async ($: any, e: any, next: any) => {
      const root = await recordsRoot($)
      const path = normalise(String(e.file_path ?? ''), String(await $.session.cwd()))
      if ((root && (path === root || path.startsWith(root + '/'))) || path.includes('/.claude/pr-records/')) {
        return { deny: RECORDS_REFUSAL }
      }
      return next(e)
    }).catch(async (_$: any, e: any, next: any) => next(e))
  }

  on('tool.call', { tool: RECORD_TOOL }, async ($: any, e: any, next: any) => {
    try {
      return await writeRecord($, e, String(next?.origin?.plugin ?? 'engine'))
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the record hook itself failed' }))

  on('tool.call', { tool: 'Read' }, async ($: any, e: any, next: any) => {
    const result = await next(e)
    try {
      if (!failed(result) && !result.result?.file?.truncatedByTokenCap
        && await isWritingFile($, e.file_path)) {
        // The file's length as the Read counted it, else read from the file,
        // and only when a limit makes it matter.
        let total = result.result?.file?.totalLines
        if (typeof total !== 'number' && e.limit !== undefined && e.limit !== null) {
          total = lineCount(String(await $.fs.read(normalise(e.file_path))))
        }
        if (readsWhole(e.offset, e.limit, () => Number(total))) await markReader($, e.agentId)
      }
    } catch (err) {
      await markFailed($, err, e.agentId)
    }
    return result
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // Cleared as the compaction starts: one that is vetoed costs one more Read.
  on('session.compact', async ($: any, e: any, next: any) => {
    try {
      readers.delete(readerKey(await sessionId($), e.agentId))
    } catch (err) {
      guardFailed($, err)
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: TOOL }, async ($: any, raw: any) => {
    const e = { ...raw, args: withHouseDefaults(raw.command, raw.args ?? {}) }
    const act = toolAct(e.command, e.args)
    const ready = act ? toolReady($, e, act) : undefined
    const refused = await permit($, e, ready?.beforeAsk, ready?.ciUndraft)
    if (refused) return { deny: refused }
    if (ready) await ready.goingAhead()
    try {
      const result = await runGh($, e.command, e.args, e.repo, true) || '(no output)'
      if (ready) await ready.ran()
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
