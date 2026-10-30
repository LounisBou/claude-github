import { expect, mock, test } from 'claude-code/testing'
import { COMMANDS, READS, NEVER_GRANTED, WATCH_MS, ciTransitions, register } from './register.js'
import { lint, proseLines, refusal, TITLE_MAX } from './writing.js'

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

test('a command name another plugin owns passes through to next', async ($, on) => {
  const runs: any[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', (_$, e) => {
    if (e.name === 'checks') throw new Error('name taken')
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push(e)
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  on('command.run', { command: 'checks' }, () => ({ text: 'other plugin answer' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.command.run({ command: 'checks', args: '' })
  expect(out.text).toBe('other plugin answer')
  expect(runs.length).toBe(0)
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
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  // The dialog a $.ui.ask raises is itself checked: it must not meet the verdict
  // meant for the gh call.
  on('tool.check', (_$: any, e: any) => (e.tool === 'AskUserQuestion' ? { decision: 'allow' } : verdict))
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

test('a line gh.py prints on stderr after a success follows the tool output', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes, { exitCode: 0, stdout: '{"number": 12}\n', stderr: 'error: label not-ready on pull request 12 failed: boom\n' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'T', draft: true } })
  expect(out).toEqual({ result: '{"number": 12}\nerror: label not-ready on pull request 12 failed: boom' })
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

// The colour of the Text a row's Box holds.
const colourOf = (box: any) => box.children[0].props.color

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
  expect(await ui.find({ type: 'Box', key: 'room-12', text: /fix: related PRs 💬3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'room-11', text: /minimize nodes ○ draft$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-11', text: 'CI:FAILURE' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('the pane leaves the title uncoloured and colours only the CI label by state', async ($, on) => {
  const states: Record<string, string> = { '12': 'FAILURE', '11': 'PENDING' }
  await stubMod(on, [], [], byCommand({
    'pr-list': () => ok(PR_LIST),
    'pr-checks': (e) => ok(JSON.stringify({ result: states[prOf(e)], failed_checks: [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 0, review_comments: 0 })),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(colourOf(await ui.find({ type: 'Box', key: 'room-12' }))).toBeUndefined()
  expect(colourOf(await ui.find({ type: 'Box', key: 'room-11' }))).toBeUndefined()
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-12' }))).toBe('error')
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-11' }))).toBe('warning')
  await ui.unmount()
})

test('the pane colours a SUCCESS label green and an unknown one inactive', async ($, on) => {
  const many = [100, 99, 94, 93, 92, 91, 90].map((n) => ({
    number: n, title: 'PR ' + n, html_url: 'https://github.com/acme/thing/pull/' + n, draft: false,
  }))
  await stubMod(on, [], [], byCommand({
    'pr-list': () => ok(JSON.stringify(many)),
    'pr-checks': (e) => prOf(e) === '100'
      ? { exitCode: 3, stdout: '', stderr: 'error: boom' }
      : ok(JSON.stringify({ result: 'SUCCESS', failed_checks: [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 0, review_comments: 0 })),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-99' }))).toBe('success')
  expect(colourOf(await ui.find({ type: 'Box', key: 'label-100' }))).toBe('inactive')
  await ui.unmount()
})

test('the pane clips a long title so the CI label shows at a narrow width', async ($, on) => {
  const long = 'a very long pull request title that would push the label out of a narrow pane'
  await stubMod(on, [], [], byCommand({
    'pr-list': () => ok(JSON.stringify([
      { number: 12, title: long, html_url: 'https://github.com/acme/thing/pull/12', draft: true },
    ])),
    'pr-checks': () => ok(JSON.stringify({ result: 'FAILURE', failed_checks: [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 3, review_comments: 0 })),
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  const ui = await $.ui.mount({ ...PANE_EVENT, props: { ...PANE_EVENT.props, bodyColumns: 40 } })
  const title = await ui.find({ type: 'Box', key: 'room-12' })
  const text = String(title.text)
  expect(text.endsWith('…') || text.includes('… ○ draft')).toBe(true)
  expect(text).toContain('○ draft')
  expect(text).toContain('💬3')
  expect(text.length).toBeLessThanOrEqual(40 - 'CI:FAILURE'.length - 6)
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
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
  expect(await ui.find({ type: 'Box', key: 'room-100', text: /PR 100/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-100', text: 'CI:?' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'room-99', text: /PR 99/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-99', text: 'CI:SUCCESS' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'room-94', text: /PR 94/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-94', text: 'CI:–' })).toBeDefined()
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

test('a write no session grant covers is refused when nobody can be asked', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], undefined)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-merge', args: { pr: 1 } })
  expect(JSON.stringify(out)).toContain('nobody could be asked')
  expect(runs.length).toBe(0)
})

test('a truncated engine output says so', async ($, on) => {
  await stubMod(on, [], [], { exitCode: 0, stdout: 'diff', stderr: '', isStdoutTruncated: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-diff', args: { pr: 1 } })
  expect(out).toEqual({ result: 'diff\n[output cut at 4 MiB]' })
})

// ---- WRITING.md's mechanical rules (writing.ts) ----

const rulesOf = (command: string, args: any, typed = '') => lint(command, args, typed).map((v) => v.field + ': ' + v.rule.split(' (')[0])

test('a semicolon in prose is refused, in a title, a body and an inline comment', () => {
  expect(rulesOf('pr-create', { title: 'fix: a; b' })[0]).toContain('title: no semicolon')
  expect(rulesOf('pr-comment', { pr: 1, body: 'Done; thanks' })[0]).toContain('body: no semicolon')
  expect(rulesOf('review-submit', { pr: 1, event: 'COMMENT', comments: [{ path: 'a', line: 1, body: 'x; y' }] })[0])
    .toContain('comments[0].body: no semicolon')
})

// The false positives the semicolon rule must not raise: each one is code or
// markup, never prose.
test('a semicolon in code, a URL or a character reference passes', () => {
  const body = [
    'Use this:',
    '```ts',
    'const a = 1;',
    '```',
    '~~~~',
    'x = 1; y = 2',
    '~~~~',
    'Inline `let x = 1;` and ``a; `b` ;`` code.',
    'See https://example.com/a;b=c and <https://example.com/x;y>.',
    'Tom &amp; Jerry &#59; done',
  ].join('\n')
  expect(lint('pr-comment', { pr: 1, body })).toEqual([])
  expect(lint('pr-create', { title: 'fix(parser): accept `a;b` in keys' })).toEqual([])
})

test('a heading in a pull request description is refused, a hash in a comment or in code is not', () => {
  expect(rulesOf('pr-create', { title: 't', body: '## Summary\nText' })).toEqual(['body: no heading of any kind in a pull request description, it starts with the summary text'])
  expect(rulesOf('pr-update', { pr: 1, body: 'Text\n\n# Notes\nmore' }).length).toBe(1)
  expect(lint('pr-comment', { pr: 1, body: '## Not a description' })).toEqual([])
  // TODO items are checkboxes the operator ticks; dependency and related links stay bullets.
  const todoBare = 'Adds the reset.\n\n**TODO Prod:**\n- Deploy the API first\n\n**Related PRs:**\n- https://github.com/o/r/pull/1'
  expect(rulesOf('pr-create', { title: 't', body: todoBare })).toEqual(['body: a TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet'])
  expect(rulesOf('pr-update', { pr: 1, body: todoBare })).toEqual(['body: a TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet'])
  const todoBoxes = 'Adds the reset.\n\n**TODO Staging:**\n- [ ] Run the migration\n\n**TODO Prod:**\n- [x] Deploy the API first\n- [ ] Run the migration\n\n**PRs Dependency:**\n- https://github.com/o/r/pull/1'
  expect(lint('pr-create', { title: 't', body: todoBoxes })).toEqual([])
  expect(lint('pr-create', { title: 't', body: 'A list of changes:\n- one\n- two' })).toEqual([])
  expect(lint('pr-create', { title: 't', body: 'Fixes #12\n#hashtag\n```sh\n# a shell comment\n```' })).toEqual([])
})

test('a TODO item that points to another or joins two actions is refused, two full items are not', () => {
  const alone = 'a TODO item stands alone, it never points to another item'
  const one = 'one checkbox, one action: an edit and the restart, reload or deploy that applies it are two checkboxes, never joined by « then » or « and run »'
  const before = 'Lowers the pool.\n\n**TODO Prod:**\n- [ ] Set `size=1000` instead of `size=30000` in `FREDDIE_TRANSPORT_DSN` of the staging `/etc/caddy/caddy.env`, then run `sudo systemctl reload caddy`\n- [ ] Do the same edit on prod-01 to prod-05 and run `sudo systemctl reload caddy` on each'
  expect(rulesOf('pr-create', { title: 't', body: before })).toEqual(['body: ' + alone, 'body: ' + one])
  expect(rulesOf('pr-update', { pr: 1, body: '**TODO Staging:**\n- [ ] Same as above on staging' })).toEqual(['body: ' + alone])
  expect(rulesOf('pr-update', { pr: 1, body: '**TODO Staging:**\n- [ ] Run the migration and run the seeder' })).toEqual(['body: ' + one])
  const after = 'Lowers the pool.\n\n**TODO Prod:**\n- [ ] Set `size=1000` instead of `size=30000` in `FREDDIE_TRANSPORT_DSN` of `/etc/caddy/caddy.env` on prod-01 to prod-05\n- [ ] Run `sudo systemctl reload caddy` on prod-01 to prod-05 to restart the Freddie workers'
  expect(lint('pr-create', { title: 't', body: after })).toEqual([])
  // Outside a TODO section, and inside code spans, the same words are prose like any other.
  expect(lint('pr-create', { title: 't', body: 'Reads the file, then caches it, the same as before.\n\n**TODO Prod:**\n- [ ] Set `mode=then` in `app.env` on prod-01' })).toEqual([])
})

test('an attribution trailer is refused, Signed-off-by is not', () => {
  expect(rulesOf('pr-create', { title: 't', body: 'Text\n\nCo-Authored-By: someone <a@b.c>' })[0]).toContain('no trailer')
  expect(rulesOf('thread-reply', { thread_id: 'x', body: 'ok\nclaude-session: 123' })[0]).toContain('no trailer')
  expect(lint('pr-create', { title: 't', body: 'Text\n\nSigned-off-by: Dev <d@e.f>' })).toEqual([])
})

test('a title past the margin or on two lines is refused, one of about sixty passes', () => {
  expect(lint('pr-create', { title: 'feat(scope): ' + 'x'.repeat(TITLE_MAX - 13) })).toEqual([])
  expect(rulesOf('pr-create', { title: 'feat(scope): ' + 'x'.repeat(TITLE_MAX - 12) })[0]).toContain('about sixty characters')
  expect(rulesOf('pr-update', { pr: 1, title: 'fix: one\ntwo' })[0]).toContain('one line')
})

test('commands without text and fields that are not text are not linted', () => {
  expect(lint('label-add', { pr: 1, label: ['a;b'] })).toEqual([])
  expect(lint('pr-merge', { pr: 1 })).toEqual([])
  expect(lint('pr-comment', { pr: 1, body: 42 } as any)).toEqual([])
})

test('a text the user typed verbatim is the user\'s own and passes', () => {
  expect(lint('pr-comment', { pr: 1, body: 'Done;   thanks' }, 'reply on PR 1:  Done; thanks')).toEqual([])
  expect(lint('pr-comment', { pr: 1, body: 'Done; thanks a lot' }, 'reply Done; thanks').length).toBe(1)
})

test('an unclosed fence runs to the end, a shorter closing run does not close it', () => {
  expect(proseLines('a\n````\nb;\n```\nc;')).toEqual(['a'])
})

// A security update: the description of a pull request already merged in this
// form, each CVE id a link, passes as it is. The older one, its CVE id bare,
// is refused for the link alone.
const cve1743 = [
  'symfony/expression-language, symfony/http-foundation and symfony/yaml to 8.1.9 ([CVE-2026-109449](https://symfony.com/cve-2026-109449), [CVE-2026-108082](https://symfony.com/cve-2026-108082), [CVE-2026-109413](https://symfony.com/cve-2026-109413))',
  '',
  '| | |',
  '|---|---|',
  '| Package | `symfony/expression-language` (locked at v8.1.1, now v8.1.9) |',
  '| Advisory | PKSA-vq1j-sc3k-jzzk / [CVE-2026-109449](https://symfony.com/cve-2026-109449) — Unbounded Nesting in the Expression Parser Lets Untrusted Expressions Crash the Process |',
  '| Affected | `>=2.4.0,<5.4.54`, `>=6.0.0,<6.4.48`, `>=7.0.0,<7.4.21` and `>=8.0.0,<8.1.9` |',
  '| Reference | https://symfony.com/cve-2026-109449 |',
  '',
  '| | |',
  '|---|---|',
  '| Package | `symfony/http-foundation` (locked at v8.1.4, now v8.1.9) |',
  '| Advisory | PKSA-xmwy-rmx5-m7h4 / [CVE-2026-108082](https://symfony.com/cve-2026-108082) — ReDoS in HeaderUtils::split() Reachable Through the Cache-Control Request Header |',
  '| Affected | `>=5.4.1,<5.4.54`, `>=6.0.1,<6.4.46`, `>=7.0.0,<7.4.19` and `>=8.0.0,<8.1.7` |',
  '| Reference | https://symfony.com/cve-2026-108082 |',
  '',
  '| | |',
  '|---|---|',
  '| Package | `symfony/yaml` (locked at v8.1.2, now v8.1.9) |',
  '| Advisory | PKSA-xz3r-9gp4-4m1z / [CVE-2026-109413](https://symfony.com/cve-2026-109413) — Unbounded Recursion in the YAML Inline Lexer Lets a Single Document Crash the Process |',
  '| Affected | `>=2.0.0,<5.4.54`, `>=6.0.0,<6.4.45`, `>=7.0.0,<7.4.18` and `>=8.0.0,<8.1.6` |',
  '| Reference | https://symfony.com/cve-2026-109413 |',
].join('\n')
const cve1557 = [
  'squizlabs/php_codesniffer to 4.0.4 (CVE-2026-67434)',
  '',
  '| | |',
  '|---|---|',
  '| Package | `squizlabs/php_codesniffer` (dev dependency, locked at 4.0.1) |',
  '| Advisory | PKSA-rdkp-vv9z-mjkg / CVE-2026-67434 — OS command injection, **high** |',
  '| Affected | `<3.13.6` and `>=4.0.0,<4.0.2` |',
  '| Reference | https://github.com/PHPCSStandards/PHP_CodeSniffer/security/advisories/GHSA-hmqg-cxww-wqhq |',
].join('\n')

test('a security update in the house form passes, a bare CVE id is refused', () => {
  const link = 'body: a CVE id is a markdown link to its advisory, `[CVE-YYYY-NNNNN](<advisory URL>)`, never bare and never in a code span'
  expect(lint('pr-create', { title: 'chore: update Symfony packages for security', body: cve1743 })).toEqual([])
  expect(lint('pr-update', { pr: 1, body: cve1743 })).toEqual([])
  expect(rulesOf('pr-create', { title: 't', body: cve1557 })).toEqual([link])
  expect(rulesOf('pr-update', { pr: 1, body: 'Bumps the parser.\n\nThe advisory is `CVE-2026-11111`.' })).toEqual([link])
  // In a URL, in a fenced block, in a title and in a comment, a CVE id is not held.
  expect(lint('pr-create', { title: 'fix: patch CVE-2026-11111', body: 'See https://example.com/cve-2026-11111 and <https://example.com/CVE-2026-11111>.\n```\nCVE-2026-11111\n```' })).toEqual([])
  expect(lint('pr-comment', { pr: 1, body: 'Fixes CVE-2026-11111.' })).toEqual([])
})

test('a security update whose first line names a CVE id without its table is refused', () => {
  const tables = 'body: a description whose first line names CVE ids has one table per advisory, with the Package, Advisory, Affected and Reference rows, its Advisory row naming the CVE id'
  const first = 'symfony/yaml and symfony/process to 8.1.9 ([CVE-2026-11111](https://example.com/a), [CVE-2026-22222](https://example.com/b))'
  const table = (id: string, rows = ['Package', 'Advisory', 'Affected', 'Reference']) => ['| | |', '|---|---|', ...rows.map((row) =>
    '| ' + row + ' | ' + (row === 'Advisory' ? 'PKSA-aaaa / [' + id + '](https://example.com/a) — A title' : '`x`') + ' |')].join('\n')
  expect(lint('pr-create', { title: 't', body: [first, table('CVE-2026-11111'), table('CVE-2026-22222')].join('\n\n') })).toEqual([])
  expect(rulesOf('pr-create', { title: 't', body: [first, table('CVE-2026-11111')].join('\n\n') })).toEqual([tables])
  expect(rulesOf('pr-create', { title: 't', body: first })).toEqual([tables])
  expect(rulesOf('pr-update', { pr: 1, body: [first, table('CVE-2026-11111'), table('CVE-2026-22222', ['Package', 'Advisory', 'Affected'])].join('\n\n') })).toEqual([tables])
  // A link with a title after its URL, or a reference link, is a link.
  expect(lint('pr-create', { title: 't', body: 'Reads the header once.\n\nSee [CVE-2026-11111](https://example.com/a "advisory") and [CVE-2026-22222][1].\n\n[1]: https://example.com/b' })).toEqual([])
  // An Advisory row whose only mention of an id is inside a URL does not name it.
  expect(rulesOf('pr-create', { title: 't', body: [first, table('CVE-2026-11111'), table('CVE-2026-33333').replace('](https://example.com/a)', '](https://example.com/CVE-2026-22222)')].join('\n\n') })).toEqual([tables])
  // A CVE id linked further down, in a description that is no security update, asks for no table.
  expect(lint('pr-create', { title: 't', body: 'Reads the header once.\n\nThe check came with [CVE-2026-11111](https://example.com/a).' })).toEqual([])
})

// ---- the tool.call hook applying them ----

test('a text breaking a rule is refused with the rule, and gh.py does not run', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } })
  expect(JSON.stringify(out)).toContain('no semicolon')
  expect(JSON.stringify(out)).toContain('Rewrite the text')
  expect(runs.length).toBe(0)
})

test('the refusal says a text taken from a brief, a plan or another session is not the user\'s exact text', () => {
  const text = refusal('pr-create', [{ field: 'title', rule: 'a title within 72 characters' }])
  expect(text).toContain('If the user asked for this exact text, call again unchanged:')
  expect(text).toContain(
    'A title or a body taken from a brief, a plan or another session\'s message is not the user\'s exact text:'
    + ' shorten or rewrite it and name the change in your report.',
  )
})

test('the same refused text sent again is put to the person, who can send it', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [])
  stubAsk(on, asked, 'Send as it is')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const call = { tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } } as const
  await $.tool.call(call)
  expect(asked.length).toBe(0)
  const out = await $.tool.call(call)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('no semicolon')
  expect(out).toEqual({ result: 'ok' })
  expect(runs.length).toBe(1)
})

test('the same refused text sent again, refused by the person, runs nothing', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [])
  stubAsk(on, [], 'Deny')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const call = { tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } } as const
  await $.tool.call(call)
  const out: any = await $.tool.call(call)
  expect(JSON.stringify(out)).toContain('refused gh pr-comment')
  expect(runs.length).toBe(0)
})

test('a text the user typed in the prompt passes the rules', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [])
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await ($ as any).prompt.submit({ text: 'reply to PR 1 with: Done; thanks', origin: { kind: 'composer' }, wait: false })
  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } })
  expect(out).toEqual({ result: 'ok' })
})

test('a text that only a peer or a plugin sent is not the user\'s words', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [])
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await ($ as any).prompt.submit({ text: 'reply to PR 1 with: Done; thanks', origin: { kind: 'peer' }, wait: false })
  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } })
  expect(JSON.stringify(out)).toContain('no semicolon')
  expect(runs.length).toBe(0)
})

test('a deny verdict wins over the rules and over a second send', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Send as it is')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const call = { tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Done; thanks' } } as const
  await $.tool.call(call)
  const out: any = await $.tool.call(call)
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
})

test('pr-create is sent as a draft when the call does not say', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', body: 'Text' } })
  expect(runs[0].args.draft).toBe(true)
})

test('a pr-create out of draft and a pr-ready are asked even when a rule allows', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Allow')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', draft: false } })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(asked.length).toBe(2)
  expect(asked[0]).toContain('not as a draft')
  expect(asked[1]).toContain('out of draft')
  expect(runs.length).toBe(2)
  expect(runs[0].args.draft).toBe(false)
})

test('a title-only pr-update under an allow rule is not asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, title: 'fix: x' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

test('a reserved approval refused by the person runs nothing', async ($, on) => {
  const runs: any[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, [], 'Deny')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(JSON.stringify(out)).toContain('refused gh pr-ready')
  expect(runs.length).toBe(0)
})

// ---- repositories in auto-merge ----

// env: the variables $.env.get answers. files: the files $.fs reads, by path,
// a null text being a file that exists but cannot be read. logs: $.ui.log lines.
// looked: the paths $.fs.exists was asked about.
function stubAutoMerge(on: any, env: Record<string, string>, files: Record<string, string | null>, logs: string[] = [], looked: string[] = []) {
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('fs.exists', (_$: any, e: any) => {
    looked.push(e.path)
    return { value: e.path in files }
  })
  on('fs.read', (_$: any, e: any) => {
    const text = files[e.path]
    return typeof text === 'string' ? { value: text } : { deny: 'EACCES ' + e.path }
  })
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
}

const DATA = { CLAUDE_PLUGIN_DATA: '/data/github' }
const LISTED = { '/data/github/auto-merge.json': '{"repositories": ["Acme/Thing"]}' }

test('a pr-ready on a repository in auto-merge is not asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(1)
})

test('a pr-ready on a repository not in auto-merge is asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/other' })
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('out of draft')
  expect(JSON.stringify(out)).toContain('refused gh pr-ready')
  expect(runs.length).toBe(0)
})

test('with no auto-merge file a pr-ready is asked, and nothing is logged', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const logs: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, {}, logs)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(0)
  expect(logs).toEqual([])
})

for (const [what, text] of [['unreadable', null], ['without a list', '{"repositories": "acme/thing"}'], ['not JSON', 'not json']] as const) {
  test('an auto-merge file ' + what + ' asks, with one log line naming it', async ($, on) => {
    const runs: any[] = []
    const asked: string[] = []
    const logs: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'allow' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, { '/data/github/auto-merge.json': text }, logs)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
    expect(asked.length).toBe(1)
    expect(runs.length).toBe(0)
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('/data/github/auto-merge.json')
  })
}

test('a description replaced and a pull request opened out of draft on a repository in auto-merge are not asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text' }, repo: 'acme/thing' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', draft: false }, repo: 'acme/thing' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(2)
})

test('a pull request opened out of draft on a repository not in auto-merge is still asked, a description replaced is not', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text' }, repo: 'acme/other' })
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(1)
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 'fix: x', draft: false }, repo: 'acme/other' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/other' })
  expect(asked.length).toBe(2)
  expect(asked[0]).toContain('not as a draft')
  expect(asked[1]).toContain('out of draft')
  expect(runs.length).toBe(1)
})

test('a description replaced is refused under a deny rule', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text' }, repo: 'acme/other' })
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
})

test('a description replaced under an ask from a rule is still asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'New text' }, repo: 'acme/other' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(0)
})

test('a description replaced with a text that breaks a writing rule is refused, then put to the person', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Send as it is')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const call = { tool: 'mcp__github__gh', command: 'pr-update', args: { pr: 1, body: 'Done; thanks' }, repo: 'acme/other' } as const
  await $.tool.call(call)
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
  await $.tool.call(call)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('no semicolon')
  expect(runs.length).toBe(1)
})

const SOME_WRITES: [string, any][] = [
  ['pr-comment', { pr: 1, body: 'Thanks.' }],
  ['pr-merge', { pr: 1 }],
  ['comment-delete', { id: 5 }],
]

for (const [command, args] of SOME_WRITES) {
  test('a ' + command + ' with an ask and no rule on a repository in auto-merge is not asked', async ($, on) => {
    const runs: any[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const out = await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(out).toEqual({ result: 'ok' })
    expect(asked.length).toBe(0)
    expect(runs.length).toBe(1)
  })

  test('a ' + command + ' with an ask and no rule on a repository not in auto-merge is asked', async ($, on) => {
    const runs: any[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/other' })
    expect(asked.length).toBe(1)
    expect(runs.length).toBe(0)
  })

  test('a ' + command + ' with an ask from a rule on a repository in auto-merge is still asked', async ($, on) => {
    const runs: any[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
    stubAsk(on, asked, 'Deny')
    stubAutoMerge(on, DATA, LISTED)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(asked.length).toBe(1)
    expect(runs.length).toBe(0)
  })

  test('a ' + command + ' denied by a rule on a repository in auto-merge is refused', async ($, on) => {
    const runs: any[] = []
    const asked: string[] = []
    await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
    stubAsk(on, asked, 'Allow')
    stubAutoMerge(on, DATA, LISTED)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const out: any = await $.tool.call({ tool: 'mcp__github__gh', command, args, repo: 'acme/thing' })
    expect(JSON.stringify(out)).toContain('denied by rule')
    expect(asked.length).toBe(0)
    expect(runs.length).toBe(0)
  })
}

test('a read on a repository in auto-merge does not read the auto-merge file', async ($, on) => {
  const runs: any[] = []
  const reads: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], 'Deny')
  stubAutoMerge(on, DATA, LISTED, [], reads)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list', repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(reads).toEqual([])
})

test('a write reads the auto-merge file once', async ($, on) => {
  const runs: any[] = []
  const reads: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, [], 'Deny')
  stubAutoMerge(on, DATA, LISTED, [], reads)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(reads.length).toBe(1)
})

test('a body refused by the writing rules on a repository in auto-merge is still refused', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const call = { tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'It works; it is done.' }, repo: 'acme/thing' }
  const out: any = await $.tool.call(call)
  expect(JSON.stringify(out)).toContain('semicolon')
  expect(asked.length).toBe(0)
  expect(runs.length).toBe(0)
  // The same text again goes to the person, as elsewhere.
  await $.tool.call(call)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('writing rules')
  expect(runs.length).toBe(0)
})

test('a pr-ready on a repository in auto-merge still follows the permission rules', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' })
  stubAsk(on, asked, 'Allow')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(JSON.stringify(out)).toContain('denied by rule')
  expect(runs.length).toBe(0)
})

test('without a repo in the call, the checkout\'s origin names the repository', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(runs.map((r) => r.argv[0])).toEqual(['git', 'python3'])
})

test('GH_REPO names the repository before the origin, as it does for the engine', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'https://github.com/acme/thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, { ...DATA, GH_REPO: 'acme/other' }, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(0)
})

test('a repo in the call names the repository before one in its args', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' }, repo: 'acme/other' })
  expect(asked.length).toBe(1)
  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(1)
})

test('an empty repo in the call hides the one in its args, as the engine\'s last --repo= does', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'git@github.com:acme/other.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' }, repo: '' })
  expect(asked.length).toBe(1)
  expect(runs.map((r) => r.argv[0])).toEqual(['git'])
})

test('a repo in the args alone names the repository', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1, repo: 'acme/thing' } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
  expect(runs.map((r) => r.argv[0])).toEqual(['python3'])
})

test('an https origin of a listed repository, in another case, is not asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => e.argv[0] === 'git'
    ? { exitCode: 0, stdout: 'https://github.com/ACME/Thing.git\n', stderr: '' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

test('an origin git cannot give is asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => e.argv[0] === 'git'
    ? { exitCode: 2, stdout: 'https://github.com/acme/thing.git\n', stderr: 'error: No such remote' }
    : { exitCode: 0, stdout: 'ok', stderr: '' }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(asked.length).toBe(1)
  expect(runs.map((r) => r.argv[0])).toEqual(['git'])
})

test('a git run that throws is asked', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const reply = (e: any) => {
    if (e.argv[0] === 'git') throw new Error('spawn git ENOENT')
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }
  await stubMod(on, runs, [], reply, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, LISTED)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 } })
  expect(asked.length).toBe(1)
  expect(runs.map((r) => r.argv[0])).toEqual(['git'])
})

test('an auto-merge list that is not made of strings asks, with one log line', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  const logs: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, DATA, { '/data/github/auto-merge.json': '{"repositories": [1]}' }, logs)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(0)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('/data/github/auto-merge.json')
})

test('without CLAUDE_PLUGIN_DATA the list is read from the plugin\'s data directory under HOME', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'allow' })
  stubAsk(on, asked, 'Deny')
  stubAutoMerge(on, { HOME: '/home/x' }, {
    '/home/x/.claude/plugins/data/github-lounisbou/auto-merge.json': '{"repositories": ["acme/thing"]}',
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-ready', args: { pr: 1 }, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'ok' })
  expect(asked.length).toBe(0)
})

// ---- « Allow for this session » ----

test('« Allow for this session » runs the call and every later one of that command on that repository', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  stubAsk(on, asked, 'Allow for this session')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const reply = (n: number, repo?: string) => $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T' + n, body: 'Fixed' }, ...(repo ? { repo } : {}) })
  await reply(1, 'acme/thing')
  await reply(2, 'Acme/Thing')
  expect(asked.length).toBe(1)
  expect(runs.length).toBe(2)
})

test('a grant covers neither another command nor another repository', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  let first = true
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    const answer = first ? 'Allow for this session' : 'Deny'
    first = false
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T1', body: 'Fixed' }, repo: 'acme/thing' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' }, repo: 'acme/thing' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T2', body: 'Fixed' }, repo: 'acme/other' })
  await $.tool.call({ tool: 'mcp__github__gh', command: 'thread-reply', args: { thread_id: 'T3', body: 'Fixed' } })
  expect(asked.length).toBe(4)
  expect(runs.length).toBe(1)
})

test('a merge and a deletion are never offered for the session', async ($, on) => {
  const runs: any[] = []
  const options: string[][] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0]
    options.push(q.options.map((o: any) => o.label))
    return { result: { questions: e.questions, answers: { [q.question]: 'Allow' } } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const command of NEVER_GRANTED) {
    await $.tool.call({ tool: 'mcp__github__gh', command, args: command === 'pr-merge' ? { pr: 1 } : { comment_id: 1 } })
  }
  expect(options).toEqual([['Allow', 'Deny'], ['Allow', 'Deny']])
  expect(runs.length).toBe(2)
})

test('an explicit ask rule is never answered by a grant', async ($, on) => {
  const runs: any[] = []
  const options: string[][] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask', rule: 'mcp__github__gh' })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0]
    options.push(q.options.map((o: any) => o.label))
    return { result: { questions: e.questions, answers: { [q.question]: 'Allow' } } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(options).toEqual([['Allow', 'Deny']])
})

test('a grant never passes a text that breaks a rule, nor a deny verdict', async ($, on) => {
  const runs: any[] = []
  let verdict: any = { decision: 'ask' }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.check', (_$: any, e: any) => (e.tool === 'AskUserQuestion' ? { decision: 'allow' } : verdict))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    runs.push(JSON.parse(e.init?.stdin ?? '{}'))
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  stubAsk(on, [], 'Allow for this session')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(runs.length).toBe(1)
  const bad: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed; thanks' } })
  expect(JSON.stringify(bad)).toContain('no semicolon')
  verdict = { decision: 'deny', reason: 'now denied', rule: 'mcp__github__gh' }
  const denied: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  expect(JSON.stringify(denied)).toContain('now denied')
  expect(runs.length).toBe(1)
})

test('a grant is not given when the person picks plain Allow, nor by text typed under Other', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  await stubMod(on, runs, [], undefined, { decision: 'ask' })
  const answers = ['Allow', 'yes, allow it for the whole session', 'Deny']
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: answers[asked.length - 1] } } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const n of [1, 2, 3]) await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: n, body: 'Fixed' } })
  expect(asked.length).toBe(3)
  expect(runs.length).toBe(1)
})

test('a grant on the origin repository holds for its directory and its session only', async ($, on) => {
  const runs: any[] = []
  const asked: string[] = []
  let session = 'session-1'
  let cwd = '/work'
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: cwd }))
  on('tool.check', (_$: any, e: any) => ({ decision: e.tool === 'AskUserQuestion' ? 'allow' : 'ask' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    runs.push(JSON.parse(e.init?.stdin ?? '{}'))
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: asked.length === 1 ? 'Allow for this session' : 'Deny' } } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const reply = () => $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 1, body: 'Fixed' } })
  await reply()
  await reply()
  cwd = '/elsewhere'
  await reply()
  cwd = '/work'
  session = 'session-2'
  await reply()
  expect(asked.length).toBe(3)
  expect(runs.length).toBe(2)
})

// ---- the pane's watch ----

const row = (number: number, ci: string, failed: string[] = []) =>
  ({ number, title: 't', url: 'u', draft: false, comments: 0, ci, failed })

test('a CI toast comes only when a PR read twice reaches an end', () => {
  expect(ciTransitions([], [row(1, 'FAILURE')])).toEqual([])
  expect(ciTransitions([row(1, 'PENDING')], [row(1, 'FAILURE', ['lint'])])).toEqual(['#1 CI: FAILURE (lint)'])
  expect(ciTransitions([row(1, 'FAILURE')], [row(1, 'SUCCESS')])).toEqual(['#1 CI: SUCCESS'])
  expect(ciTransitions([row(1, 'SUCCESS')], [row(1, 'SUCCESS')])).toEqual([])
  expect(ciTransitions([row(1, 'SUCCESS')], [row(1, 'PENDING')])).toEqual([])
  expect(ciTransitions([row(1, '?')], [row(1, 'SUCCESS')])).toEqual([])
  expect(ciTransitions([row(1, '–')], [row(1, 'FAILURE')])).toEqual([])
})

function stubPane(on: any, runs: any[], ci: () => string) {
  return stubMod(on, runs, [], byCommand({
    'pr-list': () => ok(PR_LIST),
    'pr-checks': () => ok(JSON.stringify({ result: ci(), failed_checks: ci() === 'FAILURE' ? ['lint'] : [] })),
    'pr-status': () => ok(JSON.stringify({ comments: 0, review_comments: 0 })),
    'pr-comment': () => ok('posted'),
  }))
}

test('the open pane reads its PRs again on the watch and toasts a CI that ended', async ($, on) => {
  const clock = mock.clock(on)
  const runs: any[] = []
  const toasts: string[] = []
  let ci = 'PENDING'
  await stubPane(on, runs, () => ci)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })
  expect(runs.filter((r) => r.command === 'pr-list').length).toBe(1)

  ci = 'FAILURE'
  await clock.advance(WATCH_MS)
  expect(runs.filter((r) => r.command === 'pr-list').length).toBe(2)
  expect(toasts).toEqual(['#12 CI: FAILURE (lint)', '#11 CI: FAILURE (lint)'])

  const ui = await $.ui.mount({ ...PANE_EVENT })
  expect(await ui.find({ type: 'Box', key: 'room-12', text: /fix: related PRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'label-12', text: 'CI:FAILURE' })).toBeDefined()
  await ui.unmount()
})

// The kit's $ cannot raise ui.close (the person's close mark), so the hooks
// are taken from register() itself and driven with a small $ of their own.
test('closing the pane stops the watch, closing another pane does not', async () => {
  const hooks: Record<string, Function> = {}
  const chain = () => ({ catch: () => undefined })
  register(((event: string, matcher: any, hook?: Function) => {
    const fn = hook ?? matcher
    const key = event + (hook ? ':' + JSON.stringify(matcher) : '')
    hooks[key] = fn
    return chain()
  }) as any)
  const timers: Array<{ ms: number; cancelled: boolean }> = []
  const store = new Map<string, any>()
  const fake: any = {
    plugin: { root: '/plugin' },
    command: { register: async () => undefined },
    tool: { register: async () => undefined },
    process: {
      run: async (_argv: string[], init: any) => {
        const { command } = JSON.parse(init.stdin)
        return { exitCode: 0, stdout: command === 'pr-list' ? '[]' : '{}', stderr: '' }
      },
    },
    ui: { open: async () => ({ isPlaced: true }) },
    clock: {
      every: (ms: number) => {
        const timer = { ms, cancelled: false }
        timers.push(timer)
        return { cancel: () => { timer.cancelled = true } }
      },
    },
    state: {
      get: async (ref: any) => ({ value: store.get(ref.key), version: 0 }),
      set: async (ref: any, value: any) => { store.set(ref.key, value); return { isSet: true, version: 1 } },
    },
  }
  const next = (x: any) => x
  await hooks['session.start'](fake, {}, next)
  await hooks['command.run:{"command":"prs"}'](fake, { command: 'prs', args: '' }, next)
  expect(timers).toEqual([{ ms: WATCH_MS, cancelled: false }])
  await hooks['ui.close'](fake, { id: 'another-pane', origin: { kind: 'person' } }, next)
  expect(timers[0].cancelled).toBe(false)
  await hooks['ui.close'](fake, { id: 'github-prs', origin: { kind: 'person' } }, next)
  expect(timers[0].cancelled).toBe(true)
  await hooks['command.run:{"command":"prs"}'](fake, { command: 'prs', args: '' }, next)
  expect(timers.length).toBe(2)
})

test('a write through the tool reads the open pane again, a read does not', async ($, on) => {
  const clock = mock.clock(on)
  const runs: any[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'prs', args: '' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-list' })
  expect(runs.filter((r) => r.command === 'pr-list').length).toBe(2)
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  await clock.settle()
  expect(runs.filter((r) => r.command === 'pr-list').length).toBe(3)
})

test('no pane open, a write reads nothing more', async ($, on) => {
  const runs: any[] = []
  await stubPane(on, runs, () => 'SUCCESS')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 12, body: 'Fixed' } })
  expect(runs.map((r) => r.command)).toEqual(['pr-comment'])
})

// ---- /github:install and /github:doctor ----

test('/github:doctor runs install.sh and names its exit code, with no model turn', async ($, on) => {
  const runs: any[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 12, stdout: '', stderr: 'github: no token\ngithub: not ready.\n' } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const command of ['github:doctor', 'github:install']) {
    const out: any = await $.command.run({ command, args: '' })
    expect(out.text).toBe('github: no token\ngithub: not ready.\n\nExit code 12: no GitHub token: run /github:install.')
  }
  expect(runs[0][0]).toBe('bash')
  expect(runs[0][1].endsWith('/install.sh')).toBe(true)
  // doctor only checks; install may install gh and start the sign-in.
  expect(runs[0].slice(2)).toEqual(['--check'])
  expect(runs[1].slice(2)).toEqual([])
})

test('/github:doctor falls back to the markdown command when the script cannot run', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ deny: 'no process' }))
  on('command.run', { command: 'github:doctor' }, () => ({ text: 'markdown ran' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.command.run({ command: 'github:doctor', args: '' })
  expect(out.text).toBe('markdown ran')
})
