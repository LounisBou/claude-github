// The ready guard's pure decisions: which command is an act, which push moves
// which branch, and what a pull request misses at its head.
import { expect, test } from 'claude-code/testing'
import {
  bashActs, bashPushes, ciUndraft, createdPr, missingItems, parseGate, pushOf, toolAct, touchesRecords,
  recordKindFor, producerSlug, autoMergeRefusal, notReadyRefusal,
  type Gate, type RecordFile,
} from './ready.ts'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

function gate(over: Partial<Gate> = {}, ci: Partial<Gate['ci']> = {}): Gate {
  return {
    repo: 'acme/thing', pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1, ...ci },
    ...over,
  }
}

function record(kind: string, result: string, at = '2026-11-01T10:00:00Z', over: Record<string, unknown> = {}): RecordFile {
  const stamp = at.replace(/[-:]/g, '')
  const body = { v: 1, repo: 'acme/thing', pr: 12, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: '', at, ...over }
  return { name: kind + '.' + stamp + '.p-' + kind + '.json', text: JSON.stringify(body) }
}

const ALL = [record('review', 'pass'), record('norms', 'pass'), record('e2e', 'pass')]

test('the four at the head leave nothing missing', () => {
  expect(missingItems(gate(), ALL)).toEqual([])
})

test('each missing condition is named alone', () => {
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('review')))).toEqual(['review: no record at 0123456'])
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('norms')))).toEqual(['norms: no record at 0123456'])
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('e2e')))).toEqual(['e2e: no record at 0123456'])
  expect(missingItems(gate({}, { result: 'FAILURE', failed: ['lint', 'test'] }), ALL)).toEqual(['CI failed: lint, test'])
  expect(missingItems(gate({}, { result: 'PENDING', running: 1 }), ALL)).toEqual(['CI still running'])
})

test('a later fail overrides an earlier pass, and names its producer and detail', () => {
  const files = [...ALL, record('norms', 'fail', '2026-11-01T11:00:00Z', { producer: 'norms', detail: '2 findings open' })]
  expect(missingItems(gate(), files)).toEqual(['norms: fail at 0123456 by norms, 2 findings open'])
  const back = [...files, record('norms', 'pass', '2026-11-01T12:00:00Z')]
  expect(missingItems(gate(), back)).toEqual([])
})

test('an e2e waiver is accepted, a waived review is not', () => {
  const waived = [record('review', 'pass'), record('norms', 'pass'), record('e2e', 'waived', undefined, { detail: 'waived 2026-11-02' })]
  expect(missingItems(gate(), waived)).toEqual([])
  const review = [record('review', 'waived'), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), review)).toEqual(['review: waived at 0123456 by p-review'])
})

test('a record of another head, repository or pull request is skipped and named', () => {
  const files = [
    record('review', 'pass', undefined, { head: OTHER }), record('norms', 'pass'), record('e2e', 'pass'),
  ]
  expect(missingItems(gate(), files)).toEqual(['review: no record at 0123456', 'unreadable record ' + files[0].name])
  const pr = [record('review', 'pass', undefined, { pr: 13 }), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), pr)[1]).toBe('unreadable record ' + pr[0].name)
  const repo = [record('review', 'pass', undefined, { repo: 'acme/other' }), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), repo)[1]).toBe('unreadable record ' + repo[0].name)
})

test('a file that does not parse, or names another kind than its file, is named', () => {
  const noE2e = ALL.filter((r) => !r.name.startsWith('e2e'))
  const files = [...noE2e, { name: 'review.20261101T120000Z.x.json', text: '{not json' }]
  expect(missingItems(gate(), files)).toEqual(['e2e: no record at 0123456', 'unreadable record review.20261101T120000Z.x.json'])
  const misnamed = { name: 'norms.20261101T120000Z.x.json', text: record('review', 'fail').text }
  expect(missingItems(gate(), [...noE2e, misnamed])).toEqual(['e2e: no record at 0123456', 'unreadable record norms.20261101T120000Z.x.json'])
})

test('an unreadable file beside the three accepted records does not block', () => {
  const bad = { name: 'review.20261101T120000Z.x.json', text: '{not json' }
  expect(missingItems(gate(), [...ALL, bad])).toEqual([])
})

test('an unreadable file is named when a kind is missing too', () => {
  const bad = { name: 'e2e.20261101T120000Z.x.json', text: '{not json' }
  const files = [...ALL.filter((r) => !r.name.startsWith('e2e')), bad]
  expect(missingItems(gate(), files)).toEqual(['e2e: no record at 0123456', 'unreadable record ' + bad.name])
  expect(notReadyRefusal('pr-merge', 'acme/thing', 12, HEAD, missingItems(gate(), files)))
    .toContain('Missing: e2e: no record at 0123456, unreadable record ' + bad.name + '.')
})

test('no check at all is green', () => {
  expect(missingItems(gate({}, { result: 'SUCCESS', total: 0 }), ALL)).toEqual([])
})

test('a skipped check is not green, and says so', () => {
  expect(missingItems(gate({}, { result: 'PENDING', skipped: ['test'], running: 0 }), ALL)).toEqual(['CI did not run: test skipped'])
})

test('a closed pull request and a moved head are named first', () => {
  expect(missingItems(gate({ state: 'closed' }), ALL)).toEqual(['the pull request is closed'])
  expect(missingItems(gate(), ALL, OTHER)).toEqual(['the head moved: ' + OTHER + ' given, ' + HEAD + ' on GitHub'])
  expect(missingItems(gate(), ALL, HEAD.toUpperCase())).toEqual([])
})

test('pr-gate\'s answer is read, a malformed one throws', () => {
  expect(parseGate(JSON.stringify(gate())).head).toBe(HEAD)
  expect(() => parseGate('ok')).toThrow()
  expect(() => parseGate('{"head": "abc"}')).toThrow()
})

test('a CI undraft is a Not Ready pull request whose CI is not green', () => {
  expect(ciUndraft(gate({}, { result: 'PENDING' }))).toBe(true)
  expect(ciUndraft(gate({}, { result: 'FAILURE' }))).toBe(true)
  expect(ciUndraft(gate({ labels: ['not ready'] }, { result: 'PENDING' }))).toBe(true)
  expect(ciUndraft(gate())).toBe(false)
  expect(ciUndraft(gate({ labels: [] }, { result: 'PENDING' }))).toBe(false)
  expect(ciUndraft(gate({ labels: ['Ready'] }, { result: 'PENDING' }))).toBe(false)
})

test('the Bash merges, undrafts and Ready labels are recognised with their repository and pull request', () => {
  expect(bashActs('gh pr merge 12 -R o/r --squash')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr merge https://github.com/o/r/pull/12')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr merge 12 --repo=o/r --auto --match-head-commit ' + HEAD))
    .toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12, sha: HEAD }])
  expect(bashActs('gh -R github.com/o/r pr ready 3')).toEqual([{ kind: 'undraft', name: 'gh pr ready', repo: 'o/r', pr: 3 }])
  expect(bashActs('gh pr ready feat -R o/r')).toEqual([{ kind: 'undraft', name: 'gh pr ready', repo: 'o/r', branch: 'feat' }])
  expect(bashActs('gh pr ready')).toEqual([{ kind: 'undraft', name: 'gh pr ready' }])
  expect(bashActs('gh api -X PUT repos/o/r/pulls/12/merge')).toEqual([{ kind: 'merge', name: 'gh api', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh api --method POST repos/o/r/issues/12/labels -f \'labels[]=Ready\''))
    .toEqual([{ kind: 'ready-label', name: 'gh api', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
    .toEqual([{ kind: 'merge', name: 'gh api graphql', unnamed: true }])
  expect(bashActs('gh api graphql -f query=\'mutation{markPullRequestReadyForReview(input:{}){clientMutationId}}\'')[0].kind).toBe('undraft')
  expect(bashActs('gh api graphql -f query=\'mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}\'')[0].kind).toBe('merge')
  expect(bashActs('gh pr edit 12 -R o/r --add-label Ready')).toEqual([{ kind: 'ready-label', name: 'gh pr edit', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh issue edit 12 -R o/r --add-label bug,ready')).toEqual([{ kind: 'ready-label', name: 'gh issue edit', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr create -t t -b b')).toEqual([{ kind: 'create', name: 'gh pr create' }])
  expect(bashActs('gh pr create -d -t t -R o/r')).toEqual([{ kind: 'create-draft', name: 'gh pr create', repo: 'o/r' }])
  expect(bashActs('gh pr create --draft --label Ready')[0].kind).toBe('create')
  expect(bashActs('gh pr ready 3 -R o/r --undo')).toEqual([{ kind: 'redraft', name: 'gh pr ready', repo: 'o/r', pr: 3 }])
})

test('gh pr create --draft=false and --draft=0 open a pull request out of draft, --draft=true and a bare --draft a draft', () => {
  expect(bashActs('gh pr create --draft=false -t t')).toEqual([{ kind: 'create', name: 'gh pr create' }])
  expect(bashActs('gh pr create --draft=0 -t t -R o/r')).toEqual([{ kind: 'create', name: 'gh pr create', repo: 'o/r' }])
  expect(bashActs('gh pr create --draft=true -t t')).toEqual([{ kind: 'create-draft', name: 'gh pr create' }])
  expect(bashActs('gh pr create --draft -t t')).toEqual([{ kind: 'create-draft', name: 'gh pr create' }])
})

test('what only looks like an act is none', () => {
  for (const line of [
    'gh pr merge 12 -R o/r --disable-auto',
    'git commit -m "run gh pr merge later"',
    'echo gh pr ready 3',
    'gh pr edit 12 -R o/r --add-label "Not Ready"',
    'gh pr edit 12 -R o/r --remove-label Ready',
    'gh pr edit 12 -R o/r --title Ready',
    'gh api repos/o/r/pulls/12/merge',
    'gh api -X POST repos/o/r/issues/12/labels -f labels[]=bug',
    'gh api graphql -f query=\'query{viewer{login}}\'',
    'gh pr view 12',
    'cat <<EOF\ngh pr merge 1\nEOF',
  ]) {
    expect(bashActs(line), line).toEqual([])
  }
})

test('a text quoting a gh.py act is no act', () => {
  for (const line of [
    'echo "python3 engine/gh.py pr-merge 12 --repo o/r"',
    'cat <<EOF\npython3 engine/gh.py pr-merge 12 --repo o/r\nEOF',
    'git commit -m "stop running python3 engine/gh.py pr-merge 12 twice"',
    'gh pr comment 3 -b "run python3 engine/gh.py pr-ready 12 --repo o/r later"',
    'printf %s "python3 engine/gh.py label-add 12 Ready" > note.txt',
  ]) {
    expect(bashActs(line), line).toEqual([])
  }
})

test('an act inside bash -c is recognised', () => {
  expect(bashActs('bash -c \'gh pr merge 1 -R o/r\'')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 1 }])
})

test('the tool\'s acts are recognised', () => {
  expect(toolAct('pr-ready', { pr: 3 })).toEqual({ kind: 'undraft', name: 'pr-ready', pr: 3 })
  expect(toolAct('pr-merge', { pr: 3, sha: HEAD })).toEqual({ kind: 'merge', name: 'pr-merge', pr: 3, sha: HEAD })
  expect(toolAct('pr-readiness', { pr: 3, state: 'ready' })?.kind).toBe('ready-label')
  expect(toolAct('pr-readiness', { pr: 3, state: 'not-ready' })).toBeUndefined()
  expect(toolAct('label-add', { pr: 3, label: ['bug', 'READY'] })?.kind).toBe('ready-label')
  expect(toolAct('label-add', { pr: 3, label: ['bug'] })).toBeUndefined()
  expect(toolAct('pr-create', { title: 't', draft: false })?.kind).toBe('create')
  expect(toolAct('pr-create', { title: 't', draft: true })?.kind).toBe('create-draft')
  expect(toolAct('pr-draft', { pr: 3 })?.kind).toBe('redraft')
  expect(toolAct('pr-comment', { pr: 3, body: 'Ready' })).toBeUndefined()
})

test('a push names its remote and the branches it moves', () => {
  expect(pushOf(['git', 'push', 'origin', 'feat'])).toEqual({ remote: 'origin', branches: ['feat'] })
  expect(pushOf(['git', 'push', 'https://github.com/o/r.git', 'HEAD:feat'])).toEqual({ remote: 'https://github.com/o/r.git', branches: ['feat'] })
  expect(pushOf(['git', 'push', '-u', 'origin', '+a:refs/heads/b', 'c'])).toEqual({ remote: 'origin', branches: ['b', 'c'] })
  expect(pushOf(['git', 'push', 'origin', 'HEAD'])).toEqual({ remote: 'origin', branches: [], current: 'branch' })
  expect(pushOf(['git', 'push', 'origin'])).toEqual({ remote: 'origin', branches: [], current: 'branch' })
  expect(pushOf(['git', 'push'])).toEqual({ branches: [], current: 'upstream' })
  expect(pushOf(['git', 'push', 'origin', ':gone'])).toEqual({ remote: 'origin', branches: [] })
  expect(pushOf(['git', 'push', '--tags', 'origin'])?.unsure).toContain('--tags')
  expect(pushOf(['git', '-C', '/x', 'push', 'origin', 'feat'])?.unsure).toContain('another checkout')
  expect(pushOf(['git', 'commit', '-m', 'push'])).toBeUndefined()
  expect(bashPushes('cd /x && git push origin feat').moves).toBe(true)
  expect(bashPushes('git push origin feat').pushes.length).toBe(1)
})

test('the pull request gh pr create printed is read from its URL', () => {
  expect(createdPr('https://github.com/o/r/pull/7\n')).toEqual({ repo: 'o/r', pr: 7 })
  expect(createdPr('Creating pull request\nhttps://github.com/o/r/pull/7')).toEqual({ repo: 'o/r', pr: 7 })
  expect(createdPr('nothing')).toBeUndefined()
})

test('a command naming the records or their writer is caught', () => {
  expect(touchesRecords('echo x > ~/.claude/pr-records/o/r/x.json')).toBe(true)
  expect(touchesRecords('python3 /p/engine/record.py --repo o/r')).toBe(true)
  expect(touchesRecords('ls ~/.claude/pr-records')).toBe(true)
  expect(touchesRecords('cat /cfg/records/x', '/cfg/records')).toBe(true)
  expect(touchesRecords('git status')).toBe(false)
})

test('each producer plugin writes only its own kind, every other caller E2E', () => {
  expect(recordKindFor('pr-review')).toBe('review')
  expect(recordKindFor('norms')).toBe('norms')
  expect(recordKindFor('engine')).toBe('e2e')
  expect(recordKindFor('orchestrator')).toBe('e2e')
  expect(producerSlug('engine')).toBe('session-e2e')
  expect(producerSlug('pr-review')).toBe('pr-review')
})

test('the refusals read as the guard documents them', () => {
  expect(notReadyRefusal('pr-merge', 'o/r', 12, HEAD, ['review: no record at 0123456', 'CI still running'])).toBe(
    'github: pr-merge refused on o/r#12 at 0123456: not ready. Missing: review: no record at 0123456, CI still running.'
    + ' A pull request is ready when a clean review, a passed norms check, passed E2E and green CI are all at its'
    + ' current head (engine/WRITING.md « Ready pull requests »).')
  expect(autoMergeRefusal('merge', 'o/r', 12)).toBe(
    'github: gh pr merge refused on o/r: this repository is not in auto-merge, so a merge or leaving draft needs the'
    + ' operator\'s explicit word. When he gave it, run mcp__github__gh pr-merge {"pr": 12} on o/r: it checks that'
    + ' the pull request is ready, then asks him in the conversation.')
})
