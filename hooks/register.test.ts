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
