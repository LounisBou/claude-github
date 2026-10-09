// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

export const PANE_ID = 'github-prs'

// One entry per gh.py subcommand: the positional argument names, in order.
// A "name..." entry is variadic and takes an array. The tool's command enum
// is Object.keys(POSITIONALS) — there is no second list to keep in sync.
export const POSITIONALS: Record<string, string[]> = {
  'pr-get': [],
  'pr-list': [],
  'pr-status': ['pr'],
  'pr-checks': ['pr'],
  'pr-diff': ['pr'],
  'pr-files': ['pr'],
  'pr-commits': ['pr'],
  'file-at-ref': ['path', 'ref'],
  'pr-create': [],
  'pr-merge': ['pr'],
  'pr-threads': ['pr'],
  'pr-comments': ['pr'],
  'pr-issue-comments': ['pr'],
  'pr-reviews': ['pr'],
  'thread-reply': ['thread_id'],
  'pr-comment': ['pr'],
  'comment-edit': ['comment_id'],
  'comment-delete': ['comment_id'],
  'thread-resolve': ['thread_id'],
  'comment-resolve': ['node_id'],
  'comment-unresolve': ['node_id'],
  'comment-resolved': ['node_id'],
  'comments-resolved-batch': ['nodes'],
  'review-submit': ['pr'],
  'review-pending-create': ['pr'],
  'review-pending-add': ['pr'],
  'review-pending': ['pr'],
  'repo-review-comments': [],
  'pr-update': ['pr'],
  'pr-ready': ['pr'],
  'label-add': ['pr', 'label...'],
  'label-remove': ['pr', 'label'],
  'reviewer-add': ['pr', 'user...'],
  'reviewer-remove': ['pr', 'user...'],
  'assignee-add': ['pr', 'user...'],
  'assignee-remove': ['pr', 'user...'],
  'issue-view': ['number'],
  'issue-list': [],
  'issue-search': ['term...'],
  'pr-linked-issues': ['pr'],
  'image-upload': ['file...'],
  'auth-check': [],
}

// The subcommands that only read. Every other one writes to GitHub, and a
// command missing here is treated as a write, so the safe side is the default.
export const READS = new Set([
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-diff', 'pr-files', 'pr-commits',
  'file-at-ref', 'pr-threads', 'pr-comments', 'pr-issue-comments', 'pr-reviews',
  'comment-resolved', 'comments-resolved-batch', 'review-pending', 'repo-review-comments',
  'issue-view', 'issue-list', 'issue-search', 'pr-linked-issues', 'auth-check',
])

export const TOOL = 'mcp__github__gh'

export class UsageError extends Error {}

let fileSeq = 0

// Random per module load: two concurrent Claude sessions otherwise write the
// same /tmp paths and can post each other's bodies.
const loadId = (Math.random().toString(36) + '000000').slice(2, 8)

function tmpPath(kind: string, ext: string): string {
  fileSeq += 1
  return '/tmp/claude-github-' + kind + '-' + loadId + '-' + fileSeq + ext
}

const FLAG_KEY = /^[a-z][a-z0-9-]*$/

function strings(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.some((v) => typeof v === 'object' || v === null)) {
      throw new UsageError('array values must contain only scalars: ' + key)
    }
    return value.map((v) => String(v))
  }
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  throw new UsageError('unsupported value for "' + key + '"')
}

export function toArgv(
  command: string,
  args: Record<string, unknown>,
  repo?: string,
): { argv: string[]; files: { path: string; text: string }[] } {
  const positionals = POSITIONALS[command]
  if (!positionals) throw new UsageError('unknown command: ' + command)

  const files: { path: string; text: string }[] = []
  const flags: string[] = []
  const byName: Record<string, string[]> = {}

  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue
    if (!FLAG_KEY.test(key)) throw new UsageError('invalid argument name: ' + JSON.stringify(key))
    if (key === 'body-file' || key === 'comments-file') {
      throw new UsageError('"' + key + '" is managed by the mod; pass body or comments instead')
    }
    const isVariadic = positionals.includes(key + '...')
    const isPositional = isVariadic || positionals.includes(key)
    if (key === 'body') {
      if (typeof value !== 'string') throw new UsageError('body must be a string')
      const path = tmpPath('body', '.md')
      files.push({ path, text: value })
      flags.push('--body-file=' + path)
    } else if (key === 'comments') {
      if (!Array.isArray(value)) throw new UsageError('comments must be an array')
      const path = tmpPath('comments', '.json')
      files.push({ path, text: JSON.stringify(value) })
      flags.push('--comments-file=' + path)
    } else if (isPositional && key === 'nodes') {
      if (!Array.isArray(value)) throw new UsageError('nodes must be an array')
      const path = tmpPath('nodes', '.json')
      files.push({ path, text: JSON.stringify(value) })
      byName[key] = [path]
    } else if (isPositional) {
      if (!isVariadic && Array.isArray(value)) throw new UsageError('"' + key + '" takes a single value')
      byName[key] = strings(key, value)
    } else if (typeof value === 'boolean') {
      if (value) flags.push('--' + key)
    } else if (typeof value === 'string' || typeof value === 'number') {
      flags.push('--' + key + '=' + String(value))
    } else if (Array.isArray(value)) {
      for (const v of strings(key, value)) flags.push('--' + key + '=' + v)
    } else {
      throw new UsageError('unsupported value for "' + key + '"')
    }
  }

  // Flags carry their value after "=", and positionals come after "--", so no
  // value the model passes can be read as a flag: "--body-file=/etc/hosts" as
  // a PR number stays a (rejected) PR number.
  const argv: string[] = [...flags]
  if (repo) argv.push('--repo=' + repo)
  const values: string[] = []
  for (const slot of positionals) {
    const bare = slot.replace(/\.\.\.$/, '')
    const got = byName[bare]
    if (!got || got.length === 0) throw new UsageError('missing argument "' + bare + '" for ' + command)
    values.push(...got)
  }
  if (values.length > 0) argv.push('--', ...values)
  return { argv, files }
}

async function runGh($: any, command: string, args: Record<string, unknown> = {}, repo?: string): Promise<string> {
  const { argv, files } = toArgv(command, args, repo)
  try {
    for (const f of files) await $.fs.write(f.path, f.text)
    const r = await $.process.run(
      ['python3', $.plugin.root + '/engine/gh.py', command, ...argv],
      { timeoutMs: 120_000 },
    )
    if (r.exitCode !== 0) throw new Error(r.stderr || 'gh.py exited ' + r.exitCode)
    return r.isStdoutTruncated ? r.stdout + '\n[output cut at 4 MiB]' : r.stdout
  } finally {
    // The bodies may be private review text: none outlives its call.
    if (files.length > 0) {
      await $.process.run(['rm', '-f', ...files.map((f) => f.path)]).catch(() => undefined)
    }
  }
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

async function prText($: any, rawArgs: string, command: string, format: string): Promise<string> {
  const explicit = (rawArgs ?? '').trim()
  if (explicit) return runGh($, command, { pr: explicit, format })
  const current = (await runGh($, 'pr-get', { format: 'pr-number' })).trim()
  if (!current) return 'no open PR for this branch'
  return runGh($, command, { pr: current, format })
}

export type PaneRow = {
  number: number
  title: string
  url: string
  draft: boolean
  comments: number
  ci: string
}

let paneRows: PaneRow[] = []

function ciColor(ci: string): string {
  if (ci === 'SUCCESS') return 'green'
  if (ci === 'FAILURE') return 'red'
  return 'yellow'
}

async function collectRows($: any): Promise<void> {
  const prs = JSON.parse(await runGh($, 'pr-list')) as any[]
  const rows: PaneRow[] = []
  for (const p of prs.slice(0, 5)) {
    let ci = 'PENDING'
    try {
      ci = String(JSON.parse(await runGh($, 'pr-checks', { pr: String(p.number), format: 'checks-status' })).result)
    } catch {
      // Leave the row at PENDING rather than dropping the PR.
    }
    rows.push({
      number: p.number,
      title: String(p.title ?? ''),
      url: String(p.html_url ?? ''),
      draft: Boolean(p.draft),
      comments: (p.comments ?? 0) + (p.review_comments ?? 0),
      ci,
    })
  }
  paneRows = rows
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const root = $.plugin.root
    await $.tool.register({
      name: 'gh',
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
          command: { type: 'string', enum: Object.keys(POSITIONALS) },
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
      return { text: await prText($, e.args, 'pr-checks', 'checks-status') }
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
      ? [Text({ children: ['No open PRs'] })]
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
                  + (r.comments > 0 ? ' 💬' + r.comments : ''),
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
        Button({
          key: 'refresh',
          label: 'Refresh',
          onPress: async () => {
            await collectRows($)
            $.ui.invalidate('ui.render')
          },
        }),
      ],
    })
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
