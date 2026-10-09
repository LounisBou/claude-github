import { expect, test } from 'claude-code/testing'
import { POSITIONALS, toArgv, UsageError } from './register.js'

test('session.start registers the gh tool and the three commands', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    registered.push('tool:' + e.name)
    expect(e.inputSchema.properties.command.enum).toEqual(Object.keys(POSITIONALS))
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

test('toArgv puts named positionals first, then flags, then --repo', () => {
  const { argv, files } = toArgv('pr-checks', { format: 'checks-status', pr: 12 }, 'acme/thing')
  expect(argv).toEqual(['12', '--format', 'checks-status', '--repo', 'acme/thing'])
  expect(files).toEqual([])
})

test('toArgv routes body and comments through temp files', () => {
  const { argv, files } = toArgv('pr-comment', { pr: 7, body: 'hi\r\n`code` $VAR' })
  expect(argv[0]).toBe('7')
  expect(argv).toContain('--body-file')
  expect(files.length).toBe(1)
  expect(files[0].text).toBe('hi\r\n`code` $VAR')
  expect(files[0].path).toMatch(/^\/tmp\/claude-github-body-\d+\.md$/)

  const r2 = toArgv('review-submit', { pr: 7, event: 'APPROVE', comments: [{ path: 'a.py', line: 3, body: 'x' }] })
  expect(r2.argv).toContain('--comments-file')
  expect(r2.files[0].text).toBe(JSON.stringify([{ path: 'a.py', line: 3, body: 'x' }]))
})

test('toArgv handles variadic positionals, repeated flags and booleans', () => {
  const { argv } = toArgv('label-add', { pr: 12, label: ['bug', 'ui'] })
  expect(argv).toEqual(['12', 'bug', 'ui'])
  const img = toArgv('image-upload', { file: ['a.png', 'b.png'], title: ['Before', 'After'] })
  expect(img.argv).toEqual(['a.png', 'b.png', '--title', 'Before', '--title', 'After'])
  const draft = toArgv('pr-create', { title: 'T', draft: true, base: false })
  expect(draft.argv).toEqual(['--title', 'T', '--draft'])
})

test('toArgv serializes nodes for comments-resolved-batch', () => {
  const { argv, files } = toArgv('comments-resolved-batch', { nodes: ['IC_1', 'IC_2'] })
  expect(argv).toEqual([files[0].path])
  expect(files[0].text).toBe(JSON.stringify(['IC_1', 'IC_2']))
})

test('toArgv rejects unknown commands, missing positionals and bad values', () => {
  expect(() => toArgv('nope', {})).toThrow(UsageError)
  expect(() => toArgv('pr-status', {})).toThrow(UsageError)
  expect(() => toArgv('pr-status', { pr: { nested: true } })).toThrow(UsageError)
  expect(() => toArgv('pr-comment', { pr: 1, body: 42 })).toThrow(UsageError)
})

// reply: a fixed { exitCode, stdout, stderr } value, or a function (e) => value
// for sequenced replies. Registered once per test — never register a second
// process.run stub afterwards; pass a function instead.
async function stubMod(
  on: any,
  runs: any[],
  writes: any[],
  reply: any = { exitCode: 0, stdout: 'ok', stderr: '' },
) {
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.write', (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: typeof reply === 'function' ? reply(e) : reply }
  })
}

test('the gh tool runs gh.py with the mapped argv and preserves body bytes', async ($, on) => {
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
  expect(writes.length).toBe(1)
  expect(writes[0].text).toBe('hi **bold**\r\nsecond `line`')
  const argv = runs[0]
  expect(argv[0]).toBe('python3')
  expect(argv[1].endsWith('/engine/gh.py')).toBe(true)
  expect(argv[2]).toBe('pr-comment')
  expect(argv[3]).toBe('12')
  const i = argv.indexOf('--body-file')
  expect(i).toBeGreaterThan(-1)
  expect(argv[i + 1]).toBe(writes[0].path)
  expect(argv[argv.length - 2]).toBe('--repo')
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

test('a usage error in args is reported without running gh.py', async ($, on) => {
  const runs: any[] = []
  const writes: any[] = []
  await stubMod(on, runs, writes)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-status', args: {} })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('missing argument "pr"')
  expect(runs.length).toBe(0)
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
  expect(out.text).toBe('{"result": "SUCCESS"}')
  expect(runs[0][2]).toBe('pr-get')
  expect(runs[1][2]).toBe('pr-checks')
  expect(runs[1]).toContain('12')
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
  expect(runs[0][2]).toBe('pr-threads')
})
