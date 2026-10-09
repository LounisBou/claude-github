import { expect, test } from 'claude-code/testing'
import { COMMANDS, READS } from './register.js'

test('session.start registers the gh tool and the three commands', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    registered.push('tool:' + e.name)
    expect(e.inputSchema.properties.command.enum).toEqual(COMMANDS)
    expect(e.isDeferred).toBe(false)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    registered.push('cmd:' + e.name)
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(registered).toContain('tool:gh')
  expect(registered).toContain('cmd:checks')
  expect(registered).toContain('cmd:threads')
  expect(registered).toContain('cmd:prs')
})

// reply: a fixed { exitCode, stdout, stderr } value, or a function (e) => value
// for sequenced replies. Registered once per test — never register a second
// process.run stub afterwards; pass a function instead.
async function stubMod(
  on: any,
  runs: any[],
  writes: any[],
  reply: any = { exitCode: 0, stdout: 'ok', stderr: '' },
  verdict: any = { decision: 'allow' },
) {
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.check', () => verdict)
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.write', (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    // Each run is recorded as the request gh.py reads on stdin, plus its argv.
    runs.push({ argv: e.argv, ...JSON.parse(e.init?.stdin ?? '{}') })
    return { value: typeof reply === 'function' ? reply(e) : reply }
  })
}

test('the gh tool hands the request to gh.py on stdin, body bytes intact', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({
    tool: 'mcp__github__gh',
    command: 'pr-comment',
    args: { pr: 12, body: 'hi **bold**\r\nsecond `line`' },
    repo: 'acme/thing',
  })

  expect(out).toEqual({ result: 'ok' })
  expect(writes.length).toBe(0)
  expect(runs.length).toBe(1)
  expect(runs[0].argv[0]).toBe('python3')
  expect(runs[0].argv[1].endsWith('/engine/gh.py')).toBe(true)
  expect(runs[0].argv.slice(2)).toEqual(['--stdin-json'])
  expect(runs[0].command).toBe('pr-comment')
  expect(runs[0].args).toEqual({ pr: 12, body: 'hi **bold**\r\nsecond `line`' })
  expect(runs[0].repo).toBe('acme/thing')
})

test('a non-zero gh.py exit returns isError with stderr', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { exitCode: 4, stdout: '', stderr: 'error: not found' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-status', args: { pr: 99 } })
  expect(out.isError).toBe(true)
  expect(out.result).toBe('error: not found')
})

test('a rejected process.run surfaces as isError, not a skipped hook', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { deny: 'python3: not found' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'auth-check' })
  expect(out.isError).toBe(true)
})

test('a usage error from the engine comes back as isError', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], { exitCode: 1, stdout: '', stderr: 'error: missing argument "pr" for pr-status\n' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-status', args: {} })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('missing argument "pr"')
})

test('/checks reports the current branch PR CI status', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  // Sequenced reply: pr-get first, then pr-checks.
  let call = 0
  await stubMod(on, runs, writes, () =>
    (call += 1) === 1
      ? { exitCode: 0, stdout: '12\n', stderr: '' }
      : { exitCode: 0, stdout: '{"result": "SUCCESS"}', stderr: '' },
  )
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('#12 CI: SUCCESS')
  expect(runs[0].command).toBe('pr-get')
  expect(runs[1].command).toBe('pr-checks')
  expect(runs[1].args.pr).toBe('12')
})

test('/checks without a PR on the branch says so, in one call', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '\n', stderr: '' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('no open PR for this branch')
  expect(runs.length).toBe(1)
})

test('/threads with an explicit PR skips the lookup', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '| thread | line |', stderr: '' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'threads', args: ' 12 ' })
  expect(out.text).toBe('| thread | line |')
  expect(runs.length).toBe(1)
  expect(runs[0].command).toBe('pr-threads')
})

test('command failures surface the engine error, not a generic diagnostics line', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { exitCode: 4, stdout: '', stderr: 'error: no PR 999' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const checks = await $.command.run({ command: 'checks', args: '999' })
  expect(checks.text).toBe('error: no PR 999')
  const threads = await $.command.run({ command: 'threads', args: '999' })
  expect(threads.text).toBe('error: no PR 999')
  const prs = await $.command.run({ command: 'prs', args: '' })
  expect(prs.text).toBe('error: no PR 999')
})

// The list endpoint carries no comment counts: those come from pr-status.
const PR_LIST = JSON.stringify([
  { number: 12, title: 'fix: related PRs', html_url: 'https://github.com/acme/thing/pull/12', draft: false },
  { number: 11, title: 'feat: minimize nodes', html_url: 'https://github.com/acme/thing/pull/11', draft: true },
])

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

// A process.run reply chosen by subcommand, so parallel runs need no order.
function byCommand(replies: Record<string, (e: any) => any>) {
  return (e: any) => {
    const { command } = JSON.parse(e.init.stdin)
    const reply = replies[command]
    return reply ? reply(e) : { exitCode: 3, stdout: '', stderr: 'error: unexpected ' + command }
  }
}

const prOf = (e: any) => String(JSON.parse(e.init.stdin).args.pr)

test('/prs reads each listed PR in detail and opens the pane', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], byCommand({
    'pr-list': () => ok(PR_LIST),
    'pr-checks': () => ok(JSON.stringify({ result: 'SUCCESS', failed_checks: [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 0, review_comments: 0 })),
  }))
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'prs', args: '' })
  expect(out).toEqual({})
  expect(opened).toEqual([{ id: 'github-prs', title: 'PRs', closeOnEscape: true }])
  expect(runs.length).toBe(5) // pr-list + (pr-checks, pr-status) x 2
  expect(runs.filter((r) => r.command === 'pr-status').map((r) => String(r.args.pr)).sort()).toEqual(['11', '12'])
})

const PANE_EVENT = {
  plugin: 'github',
  component: 'Pane',
  requestId: 'github-prs',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'PRs',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the pane renders one row per PR with CI, comments and a refresh button', async ($, on) => {
  await stubMod(on, [], [], byCommand({
    'pr-list': () => ok(PR_LIST),
    'pr-checks': () => ok(JSON.stringify({ result: 'FAILURE', failed_checks: ['lint'] })),
    'pr-status': (e) => ok(JSON.stringify(prOf(e) === '12' ? { comments: 2, review_comments: 1 } : { comments: 0, review_comments: 0 })),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Link', props: { href: 'https://github.com/acme/thing/pull/12' } })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fix: related PRs .*CI:FAILURE 💬3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /minimize nodes ○ draft CI:FAILURE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists every PR, details the newest five and marks unreadable checks', async ($, on) => {
  const many = Array.from({ length: 7 }, (_, i) => ({
    number: 100 - i, title: 'PR ' + (100 - i), html_url: 'https://github.com/acme/thing/pull/' + (100 - i), draft: false,
  }))
  const runs: any[] = []
  await stubMod(on, runs, [], byCommand({
    'pr-list': () => ok(JSON.stringify(many)),
    'pr-checks': (e) => prOf(e) === '100'
      ? { exitCode: 3, stdout: '', stderr: 'error: boom' }
      : ok(JSON.stringify({ result: 'SUCCESS', failed_checks: [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 0, review_comments: 0 })),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Text', text: /PR 100 CI:\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR 99 CI:SUCCESS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR 94 CI:–/ })).toBeDefined()
  expect(runs.filter((r) => r.command === 'pr-checks').length).toBe(5)
  await ui.unmount()
})

test('the pane with no open PRs says so and Refresh re-collects', async ($, on) => {
  const runs: any[] = []
  let lists = 0
  await stubMod(on, runs, [], byCommand({
    'pr-list': () => ok((lists += 1) === 1 ? '[]' : PR_LIST),
    'pr-checks': () => ok(JSON.stringify({ result: 'PENDING', failed_checks: [] })),
    'pr-status': () => ok('{}'),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Text', text: /No open PRs/ })).toBeDefined()

  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /fix: related PRs/ })).toBeDefined()
  expect(runs.filter((r) => r.command === 'pr-list').length).toBe(2)
  await ui.unmount()
})

test('a failed Refresh keeps the last rows and shows the error', async ($, on) => {
  let lists = 0
  await stubMod(on, [], [], byCommand({
    'pr-list': () => (lists += 1) === 1 ? ok(PR_LIST) : { exitCode: 5, stdout: '', stderr: 'error: rate limited\n' },
    'pr-checks': () => ok(JSON.stringify({ result: 'SUCCESS', failed_checks: [] })),
    'pr-status': () => ok('{}'),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /fix: related PRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'error: rate limited' })).toBeDefined()
  expect(await ui.find({ type: 'Button', props: { label: 'Refresh' } })).toBeDefined()
  await ui.unmount()
})

test('/checks names the failed checks and accepts #12', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], ok(JSON.stringify({ result: 'FAILURE', failed_checks: ['lint', 'test'] })))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'checks', args: '#12' })
  expect(out.text).toBe('#12 CI: FAILURE (lint, test)')
  expect(runs[0].args.pr).toBe('12')
})

test('every read-only command is a real subcommand', () => {
  for (const name of READS) expect(COMMANDS).toContain(name)
})

// answer: the label the stubbed dialog returns, or undefined for a dialog
// nobody can answer (a -p run).
function stubAsk(on: any, asked: string[], answer: string | undefined) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    if (answer === undefined) return { deny: 'no one to ask' }
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
}

test('a deny verdict refuses the call without running gh.py', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by mcp__github__gh', rule: 'mcp__github__gh' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(JSON.stringify(out)).toContain('denied by mcp__github__gh')
  expect(out.result).toBeUndefined()
  expect(runs.length).toBe(0)
})

test('an ask with no rule lets a read through without a dialog', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(1)
})

test('an ask puts a write to the person, and Allow runs it', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 12 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked[0]).toContain('pr-merge')
  expect(runs.length).toBe(1)
})

test('an ask on a write refused by the person runs nothing', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'comment-delete', args: { comment_id: 5 } })
  expect(JSON.stringify(out)).toContain('refused gh comment-delete')
  expect(runs.length).toBe(0)
})

test('an ask from an explicit rule asks even for a read', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(1)
})

test('a write that needs permission is refused when nobody can be asked', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], undefined)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'x' } })
  expect(JSON.stringify(out)).toContain('nobody could be asked')
  expect(runs.length).toBe(0)
})

test('a truncated engine output says so', async ($, on) => {
  await stubMod(on, [], [], { exitCode: 0, stdout: 'diff', stderr: '', isStdoutTruncated: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-diff', args: { pr: 1 } })
  expect(out).toEqual({ result: 'diff\n[output cut at 4 MiB]' })
})
