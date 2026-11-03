// The ready guard, the auto-merge split, the label following the head, the
// records guard and the record tool, through the module as the session runs
// it: the tool's calls, Bash, Write, and the engine stubbed per scenario.
import { expect, test } from 'claude-code/testing'
import { ENFORCE_ENV, READY_PHASE } from './register.js'

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '')
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED = 'fedcba9876543210fedcba9876543210fedcba98'
const RECORDS = '/cfg/pr-records'
const HEAD_DIR = RECORDS + '/acme/thing/' + HEAD
const WARN_LOG = '/data/guard-warn.log'
const AUTO_MERGE = '/data/auto-merge.json'

let sessions = 0

type World = {
  // pr-gate's answer: an object, raw text, or a failing exit with this stderr.
  gate?: any
  gateFails?: string
  labels?: string[]
  ci?: Record<string, unknown>
  // The records at the head, by file name; omitted: the four pass.
  records?: Record<string, string>
  // pr-get's pull requests, by branch ('' for the current one).
  pulls?: Record<string, any[]>
  autoMerge?: string[]
  // git's answers, by its argv after git.
  git?: Record<string, { exitCode: number; stdout: string }>
  verdict?: any
  answer?: string
  // What the Bash tool answers.
  bashResult?: any
  // What record.py answers when it fails: its exit code and stderr.
  recordFails?: { exitCode: number; stderr: string }
  // guard-warn.log already there with this text, which $.fs cannot read back
  // (a file past what one read copies): only an append keeps it.
  warnLog?: string
  // The files and directories $.fs sees beside the records, by path.
  tree?: Record<string, { kind: 'file' | 'directory'; mtimeMs: number; text?: string }>
  // The move that puts a new auto-merge.json in place fails with this stderr.
  mvFails?: string
}

type Seen = {
  runs: any[]; asked: string[]; logs: string[]; writes: Array<{ path: string; text: string }>; bash: string[]
  // guard-warn.log's text as the disk holds it, when the world starts with one.
  warnLog?: string
  // The files of the plugin's data directory, guard-warn.log apart, by path.
  files: Record<string, string>
  // The context each prompt entered with.
  contexts: string[][]
}

function record(kind: string, result: string, at = '2026-11-01T10:00:00Z', over: Record<string, unknown> = {}): [string, string] {
  const name = kind + '.' + at.replace(/[-:]/g, '') + '.p-' + kind + '.json'
  const body = { v: 1, repo: 'acme/thing', pr: 12, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: '', at, ...over }
  return [name, JSON.stringify(body)]
}

const FOUR = Object.fromEntries([record('review', 'pass'), record('norms', 'pass'), record('e2e', 'pass')])

function gateOf(w: World) {
  return w.gate ?? {
    repo: 'acme/thing', pr: 12, state: 'open', draft: true, head: HEAD, labels: w.labels ?? ['Not Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1, ...(w.ci ?? {}) },
  }
}

async function world($: any, on: any, w: World = {}): Promise<Seen> {
  const seen: Seen = { runs: [], asked: [], logs: [], writes: [], bash: [], warnLog: w.warnLog, files: {}, contexts: [] }
  if (w.autoMerge !== undefined) seen.files[AUTO_MERGE] = JSON.stringify({ repositories: w.autoMerge })
  const session = 'guard-session-' + ++sessions
  const records = w.records ?? FOUR
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_PLUGIN_DATA: '/data', HOME: '/home/x' }
  const tree = w.tree ?? {}
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('tool.check', (_$: any, e: any) => (e.tool === 'AskUserQuestion' || e.tool === 'Read' ? { decision: 'allow' } : w.verdict ?? { decision: 'allow' }))
  on('tool.call', { tool: 'Read' }, (_$: any, e: any) =>
    ({ result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 222, startLine: 1, totalLines: 222 } } }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    seen.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: w.answer ?? 'Allow' } } }
  })
  on('tool.call', { tool: 'Bash' }, (_$: any, e: any) => {
    seen.bash.push(e.command)
    return w.bashResult ?? { result: { stdout: '', stderr: '', interrupted: false } }
  })
  for (const tool of ['Write', 'Edit', 'MultiEdit']) on('tool.call', { tool }, () => ({ result: 'written' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === ENFORCE_ENV ? (enforcing ? '1' : undefined) : env[e.name] }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('ui.log', (_$: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in tree || e.path in seen.files }))
  on('fs.stat', (_$: any, e: any) => (e.path === WARN_LOG && seen.warnLog !== undefined
    ? { value: { kind: 'file', size: seen.warnLog.length, mtimeMs: 0, isLink: false } }
    : e.path in tree ? { value: { kind: tree[e.path].kind, size: 0, mtimeMs: tree[e.path].mtimeMs, isLink: false } } : { deny: 'ENOENT ' + e.path }))
  on('fs.list', (_$: any, e: any) => {
    if (e.path === HEAD_DIR) {
      return { value: Object.keys(records).map((name) => ({ name, kind: 'file', size: 1, isLink: false })) }
    }
    const below = Object.keys(tree).filter((p) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
    if (e.path in tree) return { value: below.map((p) => ({ name: p.slice(e.path.length + 1), kind: tree[p].kind, size: 0, isLink: false })) }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.read', (_$: any, e: any) => {
    if (e.path in seen.files) return { value: seen.files[e.path] }
    if (tree[e.path]?.text !== undefined) return { value: tree[e.path].text }
    if (e.path.startsWith(HEAD_DIR + '/')) {
      const name = e.path.slice(HEAD_DIR.length + 1)
      if (name in records) return { value: records[name] }
    }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.write', (_$: any, e: any) => {
    seen.writes.push({ path: e.path, text: e.text })
    if (e.path === WARN_LOG && seen.warnLog !== undefined) seen.warnLog = e.text
    else if (e.path !== WARN_LOG && e.path.startsWith('/data/')) seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    if (e.argv.includes(WARN_LOG)) {
      seen.runs.push({ argv: e.argv })
      if (seen.warnLog !== undefined && /cat >> /.test(e.argv.join(' '))) seen.warnLog += String(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[0] === 'mv' || e.argv[0] === 'rm' || e.argv[0] === 'mkdir') {
      seen.runs.push({ argv: e.argv })
      const [from, to] = e.argv.slice(-2)
      if (e.argv[0] === 'mv') {
        if (w.mvFails) return { value: { exitCode: 1, stdout: '', stderr: w.mvFails } }
        seen.files[to] = seen.files[from]
        delete seen.files[from]
      }
      if (e.argv[0] === 'rm') delete seen.files[to]
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const stdin = JSON.parse(e.init?.stdin ?? '{}')
    seen.runs.push({ argv: e.argv, ...stdin })
    if (e.argv[0] === 'git') {
      const answer = w.git?.[e.argv.slice(1).join(' ')]
      return { value: answer ? { stderr: '', ...answer } : { exitCode: 1, stdout: '', stderr: 'no' } }
    }
    if (String(e.argv[1] ?? '').endsWith('/engine/record.py')) {
      if (w.recordFails) return { value: { stdout: '', ...w.recordFails } }
      return { value: { exitCode: 0, stdout: HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json\n', stderr: '' } }
    }
    if (stdin.command === 'pr-gate') {
      if (w.gateFails) return { value: { exitCode: 3, stdout: '', stderr: w.gateFails } }
      const gate = gateOf(w)
      return { value: { exitCode: 0, stdout: typeof gate === 'string' ? gate : JSON.stringify(gate), stderr: '' } }
    }
    if (stdin.command === 'pr-get') {
      return { value: { exitCode: 0, stdout: JSON.stringify(w.pulls?.[stdin.args?.branch ?? ''] ?? []), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Read', file_path: ROOT + '/engine/WRITING.md' })
  return seen
}

const gh = (command: string, args: Record<string, unknown>, repo = 'acme/thing') =>
  ({ tool: 'mcp__github__gh', command, args, repo }) as any
const bash = (command: string) => ({ tool: 'Bash', command }) as any
const commands = (seen: Seen) => seen.runs.map((r) => r.command ?? r.argv.join(' '))
const gates = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-gate').length
// No record at all: review, norms and E2E missing, CI green.
const NO_RECORDS = { records: {} }

// The enforce phase, brought forward through the environment as the tests of
// both phases need it: the module runs apart from the test, out of reach of a setter.
let enforcing = false

async function inPhase(phase: 'warn' | 'enforce', body: () => Promise<void>): Promise<void> {
  enforcing = phase === 'enforce'
  try {
    await body()
  } finally {
    enforcing = false
  }
}

test('this release ships the ready guard in its warn phase', () => {
  expect(READY_PHASE).toBe('warn')
})

// ---- the tool, warn phase ----

test('warn: a pr-ready that is not ready, outside auto-merge, is asked as before, then runs with a warn line', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(1)
  expect(seen.asked[0]).toContain('out of draft')
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('github: pr-ready on acme/thing#12 is not ready')
  expect(seen.logs[0]).toContain('review: no record at 0123456, norms: no record at 0123456, e2e: no record at 0123456')
  const line = JSON.parse(seen.writes.find((w) => w.path === '/data/guard-warn.log')!.text.trim())
  expect(line.repo).toBe('acme/thing')
  expect(line.pr).toBe(12)
  expect(line.head).toBe(HEAD)
  expect(line.act).toBe('pr-ready')
  expect(line.route).toBe('tool')
  expect(line.missing.length).toBe(3)
  expect(typeof line.at).toBe('string')
  expect(line.session).toContain('guard-session-')
})

test('warn: refused by the person, the gate is read once, nothing runs and nothing is logged', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, answer: 'Deny' })
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(gates(seen)).toBe(1)
  expect(commands(seen)).toEqual(['pr-gate'])
  expect(seen.logs).toEqual([])
})

test('warn: a not-ready pr-merge in auto-merge runs with no question and a warn line', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
  expect(seen.logs.length).toBe(1)
})

test('warn: a ready pr-merge in auto-merge runs with no question and no warn line', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(seen.asked.length).toBe(0)
  expect(seen.logs).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
})

test('warn: an unreadable readiness lets the act through with a warn line naming the error', async ($, on) => {
  const seen = await world($, on, { gateFails: 'error: boom' })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
  expect(seen.logs[0]).toContain('readiness unverified: error: boom')
})

test('warn: a pull request opened out of draft is asked as before, with a warn line', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
  expect(seen.asked[0]).toContain('not as a draft')
  expect(commands(seen)).toEqual(['pr-create'])
  expect(seen.logs[0]).toContain('opened out of draft')
})

test('warn: the Ready label on a pull request not ready goes on with a warn line, a ready one with none', async ($, on) => {
  const seen = await world($, on, { records: Object.fromEntries([record('review', 'pass'), record('norms', 'pass')]) })
  await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('e2e: no record')
  await $.tool.call(gh('label-add', { pr: 12, label: ['Ready'] }))
  expect(seen.logs.length).toBe(2)
  await $.tool.call(gh('pr-readiness', { pr: 12, state: 'not-ready' }))
  expect(seen.logs.length).toBe(2)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-readiness', 'pr-gate', 'label-add', 'pr-readiness'])
})

test('warn: each warn line is appended to guard-warn.log, the lines before it kept', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], warnLog: '{"old":1}\n' })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  const lines = String(seen.warnLog).trim().split('\n')
  expect(lines.length).toBe(3)
  expect(lines[0]).toBe('{"old":1}')
  expect(JSON.parse(lines[1]).route).toBe('tool')
  expect(JSON.parse(lines[2]).route).toBe('bash')
})

// ---- the tool, enforce phase ----

test('enforce: a not-ready pr-ready outside auto-merge is refused before anyone is asked', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, NO_RECORDS)
    const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(out.deny).toBe('github: pr-ready refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
      + ' 0123456, norms: no record at 0123456, e2e: no record at 0123456. A pull request is ready when a clean review,'
      + ' a passed norms check, passed E2E and green CI are all at its current head (engine/WRITING.md « Ready pull requests »).')
    expect(seen.asked.length).toBe(0)
    expect(commands(seen)).toEqual(['pr-gate'])
  })
})

test('enforce: a ready pr-ready outside auto-merge is asked in the conversation, as today', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on)
    await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(seen.asked.length).toBe(1)
    expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
  })
})

test('enforce: in auto-merge a not-ready merge is refused, a ready one runs with no question', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toContain('Missing: CI failed: lint.')
    expect(seen.asked.length).toBe(0)
  })
})

test('enforce: in auto-merge a ready merge runs with no question', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out).toEqual({ result: 'ok' })
    expect(seen.asked.length).toBe(0)
  })
})

test('enforce: a merge pinned to a head that moved is refused', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { autoMerge: ['acme/thing'] })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12, sha: MOVED }))
    expect(out.deny).toContain('the head moved: ' + MOVED + ' given, ' + HEAD + ' on GitHub')
  })
})

test('enforce: a refused Ready label on a pull request still carrying Ready puts Not Ready back', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
    const out: any = await $.tool.call(gh('label-add', { pr: 12, label: ['Ready'] }))
    expect(out.deny).toContain('not ready')
    expect(seen.runs.find((r) => r.command === 'pr-readiness')?.args).toEqual({ pr: 12, state: 'not-ready' })
    expect(commands(seen)).toEqual(['pr-gate', 'pr-readiness'])
  })
})

test('enforce: a pull request opened out of draft is refused, a draft is not', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on)
    const out: any = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
    expect(out.deny).toBe('github: pr-create refused: open it as a draft, then leave draft once ready.')
    expect(seen.asked.length).toBe(0)
    const draft: any = await $.tool.call(gh('pr-create', { title: 'fix: x' }))
    expect(draft).toEqual({ result: 'ok' })
  })
})

test('enforce: an unreadable readiness refuses with the engine error', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { gateFails: 'error: rate limited' })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: rate limited')
  })
})

test('enforce: a deny rule still refuses first, and the guard reads nothing', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { verdict: { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('denied by rule')
    expect(seen.runs).toEqual([])
  })
})

// ---- a failure of the guard itself ----

// A pr-gate answer with no repository: reading the records at its head throws
// inside the guard.
const BROKEN_GATE = {
  pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
  ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
}

for (const phase of ['warn', 'enforce'] as const) {
  for (const [route, call] of [['Bash', bash('gh pr merge 12 -R acme/thing --squash')], ['tool', gh('pr-merge', { pr: 12 })]] as const) {
    test(phase + ': a guard that throws on a ' + route + ' merge reads as unverified readiness', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/thing'] })
        const out: any = await $.tool.call(call)
        const ran = route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === 'pr-merge').length
        if (phase === 'enforce') {
          expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: ')
          expect(ran).toBe(0)
        } else {
          expect(out.deny).toBeUndefined()
          expect(ran).toBe(1)
          expect(seen.logs.length).toBe(1)
          expect(seen.logs[0]).toContain('github: ' + (route === 'Bash' ? 'gh pr merge' : 'pr-merge') + ' on acme/thing#12 is not ready')
          expect(seen.logs[0]).toContain('readiness unverified: ')
          expect(JSON.parse(seen.writes.find((w) => w.path === '/data/guard-warn.log')!.text.trim()).route).toBe(route.toLowerCase())
        }
      })
    })
  }
}

// ---- leaving draft for CI ----

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Not Ready pull request whose CI is not green leaves draft through the tool, still Not Ready', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out).toEqual({ result: 'ok' })
      expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': a CI undraft through the tool passes outside auto-merge too, with no question', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, verdict: { decision: 'ask' }, answer: 'Deny', ci: { result: 'PENDING', skipped: ['test'] } })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out).toEqual({ result: 'ok' })
      expect(seen.asked).toEqual([])
      expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': an undraft outside auto-merge that is no CI undraft is still asked', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { answer: 'Deny' })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out.deny).toBeDefined()
      expect(seen.asked).toHaveLength(1)
      expect(commands(seen)).toEqual(['pr-gate'])
    })
  })

  test(phase + ': a Bash CI undraft passes outside auto-merge too, with one line', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'FAILURE', failed: ['test'] } })
      const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(out.deny).toBeUndefined()
      expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing'])
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': going back to draft is always let through, and puts Not Ready', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
      const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo'))
      expect(out.deny).toBeUndefined()
      expect(seen.runs.map((r) => r.command)).toEqual(['pr-readiness'])
      expect(seen.runs[0].args).toEqual({ pr: 12, state: 'not-ready' })
      const tool: any = await $.tool.call(gh('pr-draft', { pr: 12 }))
      expect(tool).toEqual({ result: 'ok' })
      expect(gates(seen)).toBe(0)
    })
  })
}

test('going back to draft through the tool is not asked outside auto-merge', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Deny' })
  const out: any = await $.tool.call(gh('pr-draft', { pr: 12 }, 'acme/other'))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-draft'])
})

test('a pull request that carries Ready, or whose CI is green, is no CI undraft', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
    const green: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(green.deny).toContain('not ready')
  })
})

// ---- the Ready label and the undraft against CI ----

const LABEL_ACTS = [
  ['tool', gh('pr-readiness', { pr: 12, state: 'ready' })],
  ['Bash', bash('gh pr edit 12 -R acme/thing --add-label Ready')],
] as const
const UNDRAFT_ACTS = [
  ['tool', gh('pr-ready', { pr: 12 })],
  ['Bash', bash('gh pr ready 12 -R acme/thing')],
] as const

// Whether the act itself ran: the engine's command, or the Bash line.
const actRan = (seen: Seen, route: string, command: string) =>
  route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === command).length

for (const phase of ['warn', 'enforce'] as const) {
  for (const [route, call] of LABEL_ACTS) {
    for (const ci of [{ result: 'PENDING', running: 1 }, { result: 'FAILURE', failed: ['test'] }]) {
      test(phase + ': the ' + route + ' Ready label on a Not Ready pull request with the three records and CI '
        + ci.result + ' is no CI undraft', async ($, on) => {
        await inPhase(phase, async () => {
          const seen = await world($, on, { ci })
          const out: any = await $.tool.call(call)
          const missing = ci.result === 'FAILURE' ? 'CI failed: test' : 'CI still running'
          if (phase === 'enforce') {
            expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: ' + missing + '.')
            expect(actRan(seen, route, 'pr-readiness')).toBe(0)
          } else {
            expect(out.deny).toBeUndefined()
            expect(actRan(seen, route, 'pr-readiness')).toBe(1)
            expect(seen.logs).toEqual([expect.stringContaining('is not ready, let through while the guard only warns. Missing: ' + missing)])
          }
        })
      })
    }

    test(phase + ': the ' + route + ' Ready label with the four holding passes with no warn line', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on)
        const out: any = await $.tool.call(call)
        expect(out.deny).toBeUndefined()
        expect(actRan(seen, route, 'pr-readiness')).toBe(1)
        expect(seen.logs).toEqual([])
        expect(seen.writes.filter((w) => w.path === WARN_LOG)).toEqual([])
      })
    })
  }

  for (const [route, call] of UNDRAFT_ACTS) {
    test(phase + ': a ' + route + ' undraft of a pull request carrying Ready with CI not green is no CI undraft', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on, { labels: ['Ready'], autoMerge: ['acme/thing'], ci: { result: 'PENDING', running: 1 } })
        const out: any = await $.tool.call(call)
        expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
        if (phase === 'enforce') {
          expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: CI still running.')
          expect(actRan(seen, route, 'pr-ready')).toBe(0)
        } else {
          expect(out.deny).toBeUndefined()
          expect(actRan(seen, route, 'pr-ready')).toBe(1)
          expect(seen.runs.find((r) => r.command === 'pr-ready')?.args?.['for-ci']).toBeUndefined()
          expect(seen.logs).toEqual([expect.stringContaining('is not ready, let through while the guard only warns. Missing: CI still running')])
        }
      })
    })
  }
}

// ---- Bash ----

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Bash merge or undraft outside auto-merge is refused with the tool call to make', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on)
      const merge: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
      expect(merge.deny).toBe('github: gh pr merge refused on acme/thing: this repository is not in auto-merge, so a merge'
        + ' or leaving draft needs the operator\'s explicit word. When he gave it, run mcp__github__gh pr-merge {"pr": 12}'
        + ' on acme/thing: it checks that the pull request is ready, then asks him in the conversation.')
      const ready: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(ready.deny).toContain('github: gh pr ready refused on acme/thing: this repository is not in auto-merge')
      expect(ready.deny).toContain('mcp__github__gh pr-ready {"pr": 12}')
      const api: any = await $.tool.call(bash('gh api -X PUT repos/acme/thing/pulls/12/merge'))
      expect(api.deny).toContain('not in auto-merge')
      expect(seen.bash).toEqual([])
    })
  })

  test(phase + ': a Bash merge without a repository is refused, so is a GraphQL merge', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(bash('gh pr merge 12 --squash'))
      expect(out.deny).toBe('github: gh pr merge refused: name the repository with -R owner/name.')
      const graphql: any = await $.tool.call(bash('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
      expect(graphql.deny).toContain('github: gh api graphql refused')
      expect(seen.bash).toEqual([])
    })
  })

  test(phase + ': a ready Bash merge in auto-merge passes', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD))
      expect(out.deny).toBeUndefined()
      expect(seen.bash.length).toBe(1)
      expect(seen.logs).toEqual([])
    })
  })
}

test('warn: a not-ready Bash merge in auto-merge passes with a warn line, enforce refuses it', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const warned: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(warned.deny).toBeUndefined()
  expect(seen.logs[0]).toContain('github: gh pr merge on acme/thing#12 is not ready')
  expect(JSON.parse(seen.writes[0].text.trim()).route).toBe('bash')
  await inPhase('enforce', async () => {
    const refused: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --auto'))
    expect(refused.deny).toContain('github: gh pr merge refused on acme/thing#12 at 0123456: not ready.')
  })
  expect(seen.bash.length).toBe(1)
})

test('warn and enforce: a not-ready Bash undraft in auto-merge, out of CI undraft, warns then refuses', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], labels: [] })
  await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(seen.logs.length).toBe(1)
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
    expect(out.deny).toContain('not ready')
  })
})

test('a Bash merge whose readiness cannot be read warns, then is refused under enforce', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], gateFails: 'error: boom' })
  const warned: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
  expect(warned.deny).toBeUndefined()
  expect(seen.logs[0]).toContain('readiness unverified: error: boom')
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
    expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: boom')
  })
})

test('the Ready label needs the four on a draft as out of draft', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { gate: {
      repo: 'acme/thing', pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
      ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
    }, records: {} })
    const open: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
    expect(open.deny).toContain('not ready')
  })
})

test('a Bash merge of the current branch\'s pull request reads it with pr-get', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], pulls: { '': [{ number: 12 }] } })
  await $.tool.call(bash('gh pr merge -R acme/thing'))
  expect(commands(seen)).toEqual(['pr-get', 'pr-gate'])
  expect(seen.runs[0].repo).toBe('acme/thing')
  expect(seen.runs[1].args).toEqual({ pr: 12 })
})

test('a Bash Ready label is the ready guard\'s in every repository', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  await $.tool.call(bash('gh pr edit 12 -R acme/thing --add-label Ready'))
  await $.tool.call(bash('gh api --method POST repos/acme/thing/issues/12/labels -f \'labels[]=Ready\''))
  expect(seen.bash.length).toBe(2)
  expect(seen.logs.length).toBe(2)
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh issue edit 12 -R acme/thing --add-label ready'))
    expect(out.deny).toContain('github: gh issue edit refused on acme/thing#12')
    const unnamed: any = await $.tool.call(bash('gh pr edit 12 --add-label Ready'))
    expect(unnamed.deny).toBe('github: gh pr edit refused: name the repository with -R owner/name.')
  })
})

test('a Bash pull request opened out of draft warns, then is refused under enforce', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
  expect(seen.logs[0]).toContain('opened out of draft')
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
    expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  })
})

test('a Bash draft opened gets Not Ready from the URL gh printed', async ($, on) => {
  const seen = await world($, on, { bashResult: { result: { stdout: 'https://github.com/acme/thing/pull/31\n', stderr: '', interrupted: false } } })
  await $.tool.call(bash('gh pr create --draft -t "fix: x" -b body'))
  expect(seen.runs.map((r) => [r.command, r.repo, r.args])).toEqual([['pr-readiness', 'acme/thing', { pr: 31, state: 'not-ready' }]])
})

test('commands that only look like an act pass with nothing read', async ($, on) => {
  const seen = await world($, on)
  for (const line of ['gh pr merge 12 -R acme/thing --disable-auto', 'git commit -m "run gh pr merge later"', 'gh pr view 12']) {
    const out: any = await $.tool.call(bash(line))
    expect(out.deny, line).toBeUndefined()
  }
  expect(seen.runs).toEqual([])
})

// ---- the label follows the head ----

test('a push to the branch of a Ready pull request puts Not Ready back, a Not Ready one is left', async ($, on) => {
  const seen = await world($, on, {
    git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }], other: [{ number: 13, labels: [{ name: 'Not Ready' }] }] },
  })
  await $.tool.call(bash('git push origin feat'))
  expect(seen.runs.filter((r) => r.command === 'pr-readiness').map((r) => [r.repo, r.args])).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready after the push to feat'])
  await $.tool.call(bash('git push origin other'))
  expect(seen.runs.filter((r) => r.command === 'pr-readiness').length).toBe(1)
})

test('a push by URL reads the repository and the branch from the command', async ($, on) => {
  const seen = await world($, on, { pulls: { feat: [{ number: 4, labels: [{ name: 'ready' }] }] } })
  await $.tool.call(bash('git push https://github.com/o/r.git HEAD:feat'))
  expect(seen.runs.map((r) => [r.command, r.repo, r.args])).toEqual([
    ['pr-get', 'o/r', { branch: 'feat' }],
    ['pr-readiness', 'o/r', { pr: 4, state: 'not-ready' }],
  ])
})

test('a failed push changes nothing', async ($, on) => {
  const seen = await world($, on, {
    bashResult: { result: 'rejected', isError: true },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }] },
  })
  await $.tool.call(bash('git push https://github.com/acme/thing.git feat'))
  expect(seen.runs).toEqual([])
})

test('a push whose branch cannot be read writes nothing and says so', async ($, on) => {
  const seen = await world($, on, { git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } } })
  await $.tool.call(bash('git push origin HEAD'))
  expect(seen.runs.filter((r) => r.command).length).toBe(0)
  expect(seen.logs).toEqual(['github: the labels are left as they are after the push: the current branch cannot be read'])
  await $.tool.call(bash('cd /elsewhere && git push origin feat'))
  expect(seen.logs[1]).toContain('changes directory first')
})

test('a push of the current branch reads it in the session\'s checkout', async ($, on) => {
  const seen = await world($, on, {
    git: {
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feat\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'https://github.com/acme/thing.git\n' },
    },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }] },
  })
  await $.tool.call(bash('git push -u origin HEAD'))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready after the push to feat'])
})

// ---- the records guard ----

test('the records are refused to Write, Edit and Bash, a Read of one passes', async ($, on) => {
  const seen = await world($, on)
  const refusal = 'github: records are written by their producers (claude-review\'s auto-fix-loop, /norms:check, the'
    + ' orchestrator\'s ready, mcp__github__record for E2E), never by hand.'
  for (const call of [
    { tool: 'Write', file_path: RECORDS + '/acme/thing/' + HEAD + '/e2e.x.json', content: '{}' },
    { tool: 'Edit', file_path: '/home/x/.claude/pr-records/o/r/x.json', old_string: 'a', new_string: 'b' },
    { tool: 'MultiEdit', file_path: RECORDS + '/o/r/x.json', edits: [] },
    bash('echo x > ~/.claude/pr-records/o/r/x.json'),
    bash('python3 ' + ROOT + '/engine/record.py --repo o/r --pr 1'),
    bash('ls ~/.claude/pr-records'),
  ]) {
    const out: any = await $.tool.call(call as any)
    expect(out.deny, JSON.stringify(call)).toBe(refusal)
  }
  const read: any = await $.tool.call({ tool: 'Read', file_path: HEAD_DIR + '/e2e.x.json' } as any)
  expect(read.deny).toBeUndefined()
  const other: any = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' } as any)
  expect(other.deny).toBeUndefined()
  expect(seen.bash).toEqual([])
})

test('a command that only mentions the records in its text passes, a path to them is refused', async ($, on) => {
  const seen = await world($, on)
  const commit: any = await $.tool.call(bash('git commit -m "docs: mention pr-records in the README"'))
  expect(commit.deny).toBeUndefined()
  const rm: any = await $.tool.call(bash('rm ~/.claude/pr-records/x'))
  expect(rm.deny).toContain('github: records are written by their producers')
  expect(seen.bash).toEqual(['git commit -m "docs: mention pr-records in the README"'])
})

// ---- the record tool ----

const CLEAN = {
  'rev-parse HEAD': { exitCode: 0, stdout: HEAD + '\n' },
  'status --porcelain -uno': { exitCode: 0, stdout: '' },
}

const recordRun = (seen: Seen) => seen.runs.find((r) => String(r.argv[1]).endsWith('/engine/record.py'))?.argv.slice(2)

test('the model records its E2E at the pull request\'s head from a clean checkout', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'ran the smoke suite' } as any)
  expect(out.result).toBe(HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json')
  const argv = recordRun(seen)!
  expect(argv.slice(0, 14)).toEqual(['--repo', 'acme/thing', '--pr', '12', '--head', HEAD, '--kind', 'e2e', '--result', 'pass',
    '--producer', 'session-e2e', '--detail', 'ran the smoke suite'])
  expect(argv[15]).toContain('guard-session-')
})

test('a record.py that fails is an error to the caller, with its message', async ($, on) => {
  await world($, on, { git: CLEAN, recordFails: { exitCode: 2, stderr: 'error: --detail is past 500 characters\n' } })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'x' } as any)
  expect(out).toEqual({ result: 'error: --detail is past 500 characters', isError: true })
})

test('the model may not record a review or a norms check', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  for (const kind of ['review', 'norms']) {
    const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind, result: 'pass' } as any)
    expect(out.deny).toContain('github: ' + kind + ' records are written by their producer')
    expect(out.deny).toContain('this tool writes e2e only')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('a record is refused away from the head, or on a checkout with changes', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } })
  const moved: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(moved.deny).toContain('the checkout is at fedcba9, the pull request\'s head is 0123456')
  expect(recordRun(seen)).toBeUndefined()
})

test('a record is refused on a checkout whose tracked files changed', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } })
  const dirty: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(dirty.deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('an E2E waiver quotes words the operator typed in this session', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const words = 'no E2E for this docs change, 2026-11-02'
  const before: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail: words } as any)
  expect(before.deny).toContain('an E2E waiver quotes the operator')
  await ($ as any).prompt.submit({ text: 'ok: ' + words, origin: { kind: 'composer' }, wait: false })
  const after: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail: words } as any)
  expect(after.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

const ROUND = '/cfg/claude-orchestrator/round'

function roundWorld(entries: Record<string, unknown>): World {
  const tree: NonNullable<World['tree']> = { [ROUND]: { kind: 'directory', mtimeMs: 1 } }
  for (const [id, body] of Object.entries(entries)) tree[ROUND + '/' + id + '.json'] = { kind: 'file', mtimeMs: 2, text: JSON.stringify(body) }
  return { git: CLEAN, tree }
}

const answered = (over: Record<string, unknown> = {}, by = 'pane') => ({
  question: 'E2E for thing#12: waive it?', blocks: null, status: 'answered',
  answer: { text: 'waive it, no E2E for this docs change, 2026-11-03', by, at: '2026-11-03T10:00:00Z' }, ...over,
})
const ROUND_WORDS = 'waive it, no E2E for this docs change, 2026-11-03'
const waiveCall = (detail: string) =>
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail }) as any

test('an E2E waiver may quote the operator\'s answer recorded in the round for that pull request', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered() }))
  const out: any = await $.tool.call(waiveCall('operator ruled: ' + ROUND_WORDS))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

test('a round answer that names another pull request does not carry a waiver', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered({ question: 'E2E for thing#13: waive it?' }) }))
  const out: any = await $.tool.call(waiveCall(ROUND_WORDS))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

const CHOICE_A = 'waive the E2E, docs change only'
const lettered = (text: string, over: Record<string, unknown> = {}) => answered({
  choices: [{ letter: 'A', text: CHOICE_A }, { letter: 'B', text: 'run the E2E first' }],
  answer: { text, by: 'pane', at: '2026-11-03T10:00:00Z' }, ...over,
})

test('a letter answer is resolved to its choice, quoted whole', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: lettered('A') }))
  const out: any = await $.tool.call(waiveCall('operator chose: ' + CHOICE_A))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

test('a letter answer quoted as the letter alone does not carry a waiver', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: lettered('A : oui') }))
  const out: any = await $.tool.call(waiveCall('operator answered A : oui, 2026-11-03'))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

test('a question naming the pull request but not E2E does not carry a waiver', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered({ question: 'Merge thing#12 now?' }) }))
  const out: any = await $.tool.call(waiveCall(ROUND_WORDS))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

test('a letter that is not among the choices matches nothing', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: lettered('C: ' + CHOICE_A) }))
  const out: any = await $.tool.call(waiveCall('operator chose: ' + CHOICE_A + ' C: ' + CHOICE_A))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

test('a free-text answer of 8 characters or more, quoted, carries a waiver', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered({ answer: { text: 'no E2E ok', by: 'pane', at: 'x' } }) }))
  const out: any = await $.tool.call(waiveCall('operator: no E2E ok'))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

test('a free-text answer of 3 characters does not carry a waiver', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered({ answer: { text: 'oui', by: 'pane', at: 'x' } }) }))
  const out: any = await $.tool.call(waiveCall('operator said oui, 2026-11-03'))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

for (const [label, entry] of [
  ['no answer yet', answered({ answer: null })],
  ['an answer given by the sender', answered({}, 'sender')],
] as const) {
  test('a round entry with ' + label + ' does not carry a waiver', async ($, on) => {
    const seen = await world($, on, roundWorld({ a: entry }))
    const out: any = await $.tool.call(waiveCall(ROUND_WORDS))
    expect(out.deny).toContain('an E2E waiver quotes the operator')
    expect(recordRun(seen)).toBeUndefined()
  })
}

test('a waiver that quotes no round answer is refused, and says both ways to give one', async ($, on) => {
  const seen = await world($, on, roundWorld({ a: answered() }))
  const out: any = await $.tool.call(waiveCall('some words nobody said, 2026-11-03'))
  expect(out.deny).toContain('typed in this session')
  expect(out.deny).toContain('recorded in the round')
  expect(recordRun(seen)).toBeUndefined()
})

test('a missing round store carries no waiver and does not crash', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out: any = await $.tool.call(waiveCall(ROUND_WORDS))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

for (const [plugin, kind, allowed] of [
  ['pr-review', 'review', true], ['pr-review', 'norms', false], ['norms', 'norms', true], ['norms', 'review', false],
  ['orchestrator', 'review', false], ['orchestrator', 'e2e', true],
] as const) {
  test('a call from the ' + plugin + ' plugin ' + (allowed ? 'writes' : 'is refused') + ' a ' + kind + ' record', {
    plugins: [{
      name: plugin,
      register(on: any) {
        on('command.run', { command: 'emit-record' }, async ($: any, e: any) => {
          const [k] = String(e.args).split(' ')
          const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind: k, result: 'pass' })
          return { text: JSON.stringify(out) }
        })
      },
    }],
  }, async ($, on) => {
    const seen = await world($, on, { git: CLEAN })
    const out = await $.command.run({ command: 'emit-record', args: kind })
    if (allowed) {
      const argv = recordRun(seen)!
      expect(argv[argv.indexOf('--kind') + 1]).toBe(kind)
      expect(argv[argv.indexOf('--producer') + 1]).toBe(plugin)
    } else {
      expect(String(out.text)).toContain(kind + ' records are written by their producer')
      expect(String(out.text)).toContain(plugin + ' writes ')
      expect(recordRun(seen)).toBeUndefined()
    }
  })
}

// ---- pruning ----

const DAY = 24 * 3600 * 1000

test('at session start the head directories untouched for 90 days are pruned, once a day', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'directory', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + MOVED + '/e2e.x.json']: { kind: 'file', mtimeMs: now - 100 * DAY },
    [RECORDS + '/o/r/' + HEAD]: { kind: 'directory', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + HEAD + '/review.x.json']: { kind: 'file', mtimeMs: now - 10 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs.map((r) => r.argv)).toEqual([['rm', '-rf', '--', RECORDS + '/o/r/' + MOVED]])
  expect(seen.writes.map((w) => w.path)).toEqual([RECORDS + '/.pruned'])
})

test('a stamp from today prunes nothing', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/.pruned']: { kind: 'file', mtimeMs: now - 3600 * 1000 },
    [RECORDS + '/o']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'directory', mtimeMs: now - 200 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs).toEqual([])
  expect(seen.writes).toEqual([])
})

// ---- auto-merge on the operator's word ----

const HIS_WORDS = 'on est en auto-merge, pour cette orchestration infra compris'
const typed = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })
const setAutoMerge = (on: boolean, words: string, repo = 'acme/thing') =>
  gh('auto-merge-set', { repo, on, words }, undefined as any)
const listed = (seen: Seen) => JSON.parse(seen.files[AUTO_MERGE]).repositories

test('auto-merge-set on with words the operator typed lists the repository, and its pr-ready asks nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  await typed($, 'thing : ' + HIS_WORDS)
  const set: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
  const ready: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(ready.deny).toBeUndefined()
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toContain('pr-ready')
})

test('auto-merge-set with words the operator never typed is refused, naming both proofs, and writes nothing', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'something else entirely')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('typed in this session')
  expect(out.deny).toContain('recorded in the round')
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})

test('a peer message is not the operator\'s word', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_WORDS, 'peer')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('typed in this session')
  expect(seen.files).toEqual({})
})

test('words of a few characters never carry auto-merge, typed or not', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'oui')
  const out: any = await $.tool.call(setAutoMerge(true, 'oui'))
  expect(out.deny).toContain('at least 8 characters')
  expect(seen.files).toEqual({})
})

test('typed words that do not name auto-merge are refused even though he typed them', async ($, on) => {
  const seen = await world($, on)
  const words = 'ok, lance la suite maintenant'
  await typed($, 'thing : ' + words)
  const out: any = await $.tool.call(setAutoMerge(true, words))
  expect(out.deny).toContain('auto-merge')
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})

test('typed words naming auto-merge without the repository pass', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'le projet est en auto-merge')
  const out: any = await $.tool.call(setAutoMerge(true, 'le projet est en auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

for (const spelling of ['auto merge', 'automerge', 'AUTO-MERGE']) {
  test('the word « ' + spelling + ' » names auto-merge in his words', async ($, on) => {
    const seen = await world($, on)
    const words = 'le projet est en ' + spelling
    await typed($, words)
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toBeUndefined()
    expect(listed(seen)).toEqual(['acme/thing'])
  })
}

test('the words match the typed prompt with its whitespace normalised', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'on est en  auto-merge,\npour cette orchestration infra compris')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

const roundAutoMerge = (question: string, text = 'oui, thing passe en auto-merge') => ({
  ...roundWorld({ a: { question, blocks: null, status: 'answered', answer: { text, by: 'coordinator', at: '2026-11-03T10:00:00Z' } } }),
})

test('auto-merge-set may quote the operator\'s round answer about auto-merge of that repository', async ($, on) => {
  const seen = await world($, on, roundAutoMerge('Put thing in auto-merge?'))
  const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

test('a round answer without the auto-merge word is refused', async ($, on) => {
  const seen = await world($, on, roundAutoMerge('Put thing in auto-merge?', 'oui, thing passe en automatique'))
  const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en automatique'))
  expect(out.deny).toContain('auto-merge')
  expect(seen.files).toEqual({})
})

test('a round answer naming auto-merge without the repository passes', async ($, on) => {
  const seen = await world($, on, roundAutoMerge('Put thing in auto-merge?', 'le projet est en auto-merge'))
  const out: any = await $.tool.call(setAutoMerge(true, 'le projet est en auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

for (const [label, question] of [
  ['another repository', 'Put other in auto-merge?'],
  ['no auto-merge', 'Merge thing#12 now?'],
] as const) {
  test('a round answer to a question naming ' + label + ' does not carry auto-merge', async ($, on) => {
    const seen = await world($, on, roundAutoMerge(question))
    const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en auto-merge'))
    expect(out.deny).toContain('recorded in the round')
    expect(seen.files).toEqual({})
  })
}

test('auto-merge-set off takes the repository out, whatever its case, and its pr-ready is asked again', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['Acme/Thing', 'acme/other'] })
  const words = 'thing sort de l\'auto-merge'
  await typed($, words)
  const out: any = await $.tool.call(setAutoMerge(false, words))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/other'])
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(seen.asked.length).toBe(1)
  expect(seen.asked[0]).toContain('out of draft')
})

test('the list is written whole to a temporary file then moved in place, leaving no temporary file', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'] })
  await typed($, HIS_WORDS)
  await $.tool.call(setAutoMerge(true, HIS_WORDS))
  const written = seen.writes.filter((x) => x.path.startsWith('/data/'))
  expect(written.length).toBe(1)
  expect(written[0].path).not.toBe(AUTO_MERGE)
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv' && r.argv.includes(written[0].path) && r.argv.at(-1) === AUTO_MERGE)).toBe(true)
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(JSON.parse(seen.files[AUTO_MERGE])).toEqual({ repositories: ['acme/other', 'acme/thing'] })
})

test('a move that fails removes the temporary file and leaves the list as it was', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'], mvFails: 'EACCES' })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('EACCES')
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other'])
})

test('a malformed list is never overwritten', async ($, on) => {
  const seen = await world($, on)
  seen.files[AUTO_MERGE] = '{"repositories": [1]}'
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_MERGE]).toBe('{"repositories": [1]}')
})

test('auto-merge-set refuses a repository that is not owner/name', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS, 'thing'))
  expect(out.deny).toContain('owner/name')
  expect(seen.files).toEqual({})
})

test('auto-merge-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'deny', reason: 'no' } })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toBe('no')
  expect(seen.files).toEqual({})
})

test('auto-merge-list prints the repositories in auto-merge', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing', 'acme/other'] })
  const out: any = await $.tool.call(gh('auto-merge-list', {}, undefined as any))
  expect(out.result).toBe('acme/thing\nacme/other')
})

test('auto-merge-list with no file says so', async ($, on) => {
  await world($, on)
  const out: any = await $.tool.call(gh('auto-merge-list', {}, undefined as any))
  expect(out.result).toBe('no repository in auto-merge')
})

for (const command of [
  'echo \'{"repositories":["a/b"]}\' > /data/auto-merge.json',
  'cd ~/.claude/plugins/data/github-lounisbou && jq . auto-merge.json > x && mv x auto-merge.json',
]) {
  test('a Bash command that names the auto-merge list is refused: ' + command.slice(0, 30), async ($, on) => {
    const seen = await world($, on)
    const out: any = await $.tool.call(bash(command))
    expect(out.deny).toContain('auto-merge-set')
    expect(seen.bash).toEqual([])
  })
}

for (const [tool, path] of [
  ['Write', AUTO_MERGE], ['Edit', AUTO_MERGE], ['Write', '/home/x/.claude/plugins/data/github-lounisbou/auto-merge.json'],
] as const) {
  test('a ' + tool + ' of the auto-merge list is refused: ' + path, async ($, on) => {
    await world($, on)
    const out: any = await $.tool.call({ tool, file_path: path, content: '{}', old_string: 'a', new_string: 'b' } as any)
    expect(out.deny).toContain('auto-merge-set')
  })
}

test('a Bash command that names the file outside the plugins\' data goes through', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(bash('grep -n auto-merge.json README.md'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['grep -n auto-merge.json README.md'])
})

test('a Write of another auto-merge.json, outside the plugins\' data, goes through', async ($, on) => {
  await world($, on)
  const out: any = await $.tool.call({ tool: 'Write', file_path: '/work/fixtures/auto-merge.json', content: '{}' } as any)
  expect(out.deny).toBeUndefined()
})

// ---- the operator speaks of auto-merge ----

test('a typed prompt that speaks of auto-merge enters with the line to call auto-merge-set and today\'s list', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'] })
  await typed($, 'le projet est en auto-merge')
  const context = seen.contexts.at(-1) ?? []
  expect(context.length).toBe(1)
  expect(context[0]).toContain('auto-merge-set')
  expect(context[0]).toContain('verbatim')
  expect(context[0]).toContain('acme/other')
})

for (const text of ['passe infra en Auto Merge', 'AUTOMERGE pour tout']) {
  test('every spelling of auto-merge is heard: ' + text, async ($, on) => {
    const seen = await world($, on)
    await typed($, text, 'bridge')
    expect((seen.contexts.at(-1) ?? []).join('')).toContain('auto-merge-set')
  })
}

test('a peer message that speaks of auto-merge adds no line', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'le projet est en auto-merge', 'peer')
  expect(seen.contexts.at(-1)).toEqual([])
})

test('a typed prompt that does not speak of auto-merge adds no line', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'merge it when green')
  expect(seen.contexts.at(-1)).toEqual([])
})
