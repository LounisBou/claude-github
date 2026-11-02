// The decisions of the ready guard and the auto-merge split: which call marks
// a pull request ready, leaves draft, merges it or opens it, which push moves
// a branch's head, and what a pull request still misses to be ready at its
// head. Pure functions only: register.ts reads GitHub, the records and the
// session, and answers the calls.

import { gitSubcommand, simpleCommands } from './shell.ts'

// warn: an act that is not ready goes ahead with one warn line. enforce: it is
// refused with what it misses.
export type Phase = 'warn' | 'enforce'

// merge: a merge or an auto-merge armed. undraft: out of draft. ready-label:
// the Ready label put on. create: a pull request opened out of draft.
// create-draft: one opened as a draft. redraft: one put back to draft.
export type ActKind = 'merge' | 'undraft' | 'ready-label' | 'create' | 'create-draft' | 'redraft'

export type Act = {
  kind: ActKind
  // The command as a refusal names it: `gh pr merge`, `gh api`, `pr-merge`.
  name: string
  // owner/name as the command names it, when it does.
  repo?: string
  pr?: number
  // A branch the command names the pull request by.
  branch?: string
  // The head the command pins (`--match-head-commit`, `pr-merge --sha`).
  sha?: string
  // The command names no pull request a reader can find (a GraphQL mutation).
  unnamed?: boolean
}

// What pr-gate answers.
export type Gate = {
  repo: string
  pr: number
  state: string
  draft: boolean
  head: string
  labels: string[]
  ci: { result: string; failed: string[]; running?: number; skipped?: string[]; total: number }
}

// One file of a head's records directory.
export type RecordFile = { name: string; text: string }

export const KINDS = ['review', 'norms', 'e2e'] as const

// The labels, compared without regard to case as GitHub does.
export const READY = 'ready'
export const NOT_READY = 'not ready'

const URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/
const GH = /^(.*\/)?gh$/

// owner/name from what -R takes: OWNER/REPO, HOST/OWNER/REPO or a URL.
export function repoOf(value: string): string | undefined {
  const parts = value.replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter((p) => p !== '')
  if (parts.length < 2) return undefined
  return parts[parts.length - 2] + '/' + parts[parts.length - 1]
}

// Each gh verb's options that take a value, -R and --repo apart.
const VALUED: Record<string, string[]> = {
  merge: ['-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email'],
  ready: [],
  edit: [
    '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '--add-label', '--remove-label',
    '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project',
    '--remove-project', '-m', '--milestone',
  ],
  create: [
    '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-l', '--label',
    '-a', '--assignee', '-r', '--reviewer', '-p', '--project', '-m', '--milestone', '-T', '--template', '--recover',
  ],
}

type Parsed = { repo?: string; opts: Array<[string, string | undefined]>; positionals: string[] }

// The options and positionals of a gh command's words, -R wherever it stands.
function parseWords(words: string[], valued: string[]): Parsed {
  const out: Parsed = { opts: [], positionals: [] }
  for (let k = 0; k < words.length; k++) {
    const word = words[k]
    if (word === '-R' || word === '--repo') {
      out.repo = words[++k]
      continue
    }
    if (word.startsWith('--repo=')) { out.repo = word.slice(7); continue }
    if (/^-R./.test(word)) { out.repo = word.slice(2); continue }
    if (word.startsWith('--') && word.includes('=')) {
      const at = word.indexOf('=')
      out.opts.push([word.slice(0, at), word.slice(at + 1)])
      continue
    }
    if (word.startsWith('-') && word !== '-') {
      if (valued.includes(word)) out.opts.push([word, words[++k]])
      else out.opts.push([word, undefined])
      continue
    }
    out.positionals.push(word)
  }
  return out
}

function has(parsed: Parsed, ...flags: string[]): boolean {
  return parsed.opts.some(([flag]) => flags.includes(flag))
}

function values(parsed: Parsed, ...flags: string[]): string[] {
  return parsed.opts.filter(([flag, value]) => flags.includes(flag) && value !== undefined).map(([, value]) => value as string)
}

function namesReady(list: string[]): boolean {
  return list.some((value) => value.split(',').some((label) => label.trim().toLowerCase() === READY))
}

// The pull request a gh pr command names by its first positional: a number,
// a URL (which also names the repository) or a branch.
function target(act: Act, positional: string | undefined): Act {
  if (positional === undefined) return act
  const url = URL.exec(positional)
  if (url) return { ...act, repo: act.repo ?? url[1] + '/' + url[2], pr: Number(url[3]) }
  if (/^#?\d+$/.test(positional)) return { ...act, pr: Number(positional.replace('#', '')) }
  return { ...act, branch: positional }
}

// The acts of one gh pr command.
function prAct(argv: string[]): Act | undefined {
  // gh [-R x] pr <verb> …: the noun and the verb are the first two words.
  let k = 1
  const named: number[] = []
  while (k < argv.length && named.length < 2) {
    const word = argv[k]
    if (word === '-R' || word === '--repo') { k += 2; continue }
    if (word.startsWith('-')) { k++; continue }
    named.push(k++)
  }
  if (named.length < 2 || argv[named[0]] !== 'pr' && argv[named[0]] !== 'issue') return undefined
  const noun = argv[named[0]]
  const verb = argv[named[1]]
  const words = argv.filter((_w, i) => i > 0 && i !== named[0] && i !== named[1])
  const parsed = parseWords(words, VALUED[verb] ?? [])
  const repo = parsed.repo
  const base: Act = { kind: 'merge', name: 'gh ' + noun + ' ' + verb, ...(repo ? { repo: repoOf(repo) ?? repo } : {}) }
  if (noun === 'issue') {
    if (verb === 'edit' && namesReady(values(parsed, '--add-label'))) {
      return target({ ...base, kind: 'ready-label' }, parsed.positionals[0])
    }
    return undefined
  }
  if (verb === 'merge') {
    if (has(parsed, '--disable-auto')) return undefined
    const sha = values(parsed, '--match-head-commit')[0]
    return target({ ...base, kind: 'merge', ...(sha ? { sha } : {}) }, parsed.positionals[0])
  }
  if (verb === 'ready') {
    return target({ ...base, kind: has(parsed, '--undo') ? 'redraft' : 'undraft' }, parsed.positionals[0])
  }
  if (verb === 'edit' && namesReady(values(parsed, '--add-label'))) {
    return target({ ...base, kind: 'ready-label' }, parsed.positionals[0])
  }
  if (verb === 'create') {
    // A pull request opened with the Ready label is opened as ready.
    const draft = has(parsed, '-d', '--draft') && !namesReady(values(parsed, '-l', '--label'))
    return { ...base, kind: draft ? 'create-draft' : 'create' }
  }
  return undefined
}

const API_VALUED = [
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq',
  '-t', '--template', '--cache', '-p', '--preview', '--hostname',
]
const MERGE_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge\/?$/
const LABELS_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/?$/

// The act of one gh api command: a merge or a label put through the REST API,
// or a GraphQL mutation that merges, leaves draft, arms auto-merge or puts back to draft.
function apiAct(argv: string[]): Act | undefined {
  const parsed = parseWords(argv.slice(2), API_VALUED)
  const endpoint = parsed.positionals[0]
  if (endpoint === undefined) return undefined
  const fields = values(parsed, '-f', '--raw-field', '-F', '--field')
  const explicit = values(parsed, '-X', '--method')[0]
    ?? parsed.opts.filter(([flag]) => /^-X./.test(flag)).map(([flag]) => flag.slice(2))[0]
  const method = (explicit ?? (fields.length > 0 ? 'POST' : 'GET')).toUpperCase()
  if (endpoint === 'graphql') {
    const query = fields.filter((f) => /^query=/.test(f)).map((f) => f.slice(6)).join('\n')
    const base = { name: 'gh api graphql', unnamed: true }
    if (/\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(query)) return { ...base, kind: 'merge' }
    if (/\bmarkPullRequestReadyForReview\b/.test(query)) return { ...base, kind: 'undraft' }
    return undefined
  }
  if (method !== 'PUT' && method !== 'POST') return undefined
  const merge = MERGE_PATH.exec(endpoint)
  if (merge) return { kind: 'merge', name: 'gh api', repo: merge[1] + '/' + merge[2], pr: Number(merge[3]) }
  const labels = LABELS_PATH.exec(endpoint)
  if (labels && fields.some((f) => f.includes('=') && f.slice(f.indexOf('=') + 1).trim().toLowerCase() === READY)) {
    return { kind: 'ready-label', name: 'gh api', repo: labels[1] + '/' + labels[2], pr: Number(labels[3]) }
  }
  return undefined
}

// Every act of a Bash command line, read word by word: a message or a body
// that only mentions one is an argument, not a command.
export function bashActs(line: string): Act[] {
  const found: Act[] = []
  for (const argv of simpleCommands(line)) {
    if (!GH.test(argv[0] ?? '')) continue
    const act = argv[1] === 'api' ? apiAct(argv) : prAct(argv)
    if (act) found.push(act)
  }
  return found
}

// The act of a call of the tool, or undefined.
export function toolAct(command: string, args: Record<string, unknown>): Act | undefined {
  const pr = args.pr === undefined || args.pr === null ? undefined : Number(String(args.pr).replace('#', ''))
  const at = (kind: ActKind, extra: Partial<Act> = {}): Act => ({ kind, name: command, ...(pr !== undefined ? { pr } : {}), ...extra })
  if (command === 'pr-ready') return at('undraft')
  if (command === 'pr-draft') return at('redraft')
  if (command === 'pr-merge') return at('merge', typeof args.sha === 'string' ? { sha: args.sha } : {})
  if (command === 'pr-readiness' && String(args.state ?? '').toLowerCase() === 'ready') return at('ready-label')
  if (command === 'label-add') {
    const named = [args.label, args.names, args.name].flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]))
    if (namesReady(named.map(String))) return at('ready-label')
  }
  if (command === 'pr-create') return { kind: args.draft === false ? 'create' : 'create-draft', name: command }
  return undefined
}

// ---- pushes ----

const PUSH_VALUED = new Set(['--repo', '--push-option', '-o', '--receive-pack', '--exec'])

// What a git push names: its remote and the branches it moves, or why the
// branch cannot be read with certainty. current: the push names no branch,
// so the session's current one moves (upstream: on its upstream remote too).
export type Push = { remote?: string; branches: string[]; current?: 'branch' | 'upstream'; unsure?: string }

export function pushOf(argv: string[]): Push | undefined {
  const git = gitSubcommand(argv)
  if (!git || argv[git.at] !== 'push') return undefined
  if (argv.slice(1, git.at).some((w) => w === '-C' || w === '--git-dir' || w === '--work-tree')) {
    return { branches: [], unsure: 'the push names another checkout' }
  }
  const positionals: string[] = []
  for (let k = git.at + 1; k < argv.length; k++) {
    const word = argv[k]
    if (word === '--') { positionals.push(...argv.slice(k + 1)); break }
    if (['--all', '--branches', '--mirror', '--tags', '--delete', '-d', '--prune'].includes(word)) {
      return { branches: [], unsure: 'the push names no single branch (' + word + ')' }
    }
    if (word.startsWith('-')) {
      if (PUSH_VALUED.has(word)) k++
      continue
    }
    positionals.push(word)
  }
  const [remote, ...refspecs] = positionals
  if (remote === undefined) return { branches: [], current: 'upstream' }
  if (refspecs.length === 0) return { remote, branches: [], current: 'branch' }
  const branches: string[] = []
  let current = false
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, '')
    const colon = spec.indexOf(':')
    const src = colon === -1 ? spec : spec.slice(0, colon)
    const dst = colon === -1 ? spec : spec.slice(colon + 1)
    // A deletion moves no head.
    if (colon !== -1 && src === '') continue
    if (dst === 'HEAD' || dst === '' || dst === '@') { current = true; continue }
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) continue
    branches.push(dst.replace(/^refs\/heads\//, ''))
  }
  return { remote, branches, ...(current ? { current: 'branch' as const } : {}) }
}

// The pushes of a command line, and whether the line moves the shell to
// another directory first, which leaves the session's own unsure.
export function bashPushes(line: string): { pushes: Push[]; moves: boolean } {
  const commands = simpleCommands(line)
  const moves = commands.some((argv) => argv[0] === 'cd' || argv[0] === 'pushd' || argv[0] === 'popd')
  const pushes = commands.map(pushOf).filter((p): p is Push => p !== undefined)
  return { pushes, moves }
}

// The number and repository of the pull request a gh pr create printed.
export function createdPr(stdout: string): { repo: string; pr: number } | undefined {
  for (const word of String(stdout ?? '').split(/\s+/)) {
    const url = URL.exec(word)
    if (url) return { repo: url[1] + '/' + url[2], pr: Number(url[3]) }
  }
  return undefined
}

// ---- readiness ----

// pr-gate's answer, or a throw naming what is wrong with it.
export function parseGate(text: string): Gate {
  const gate = JSON.parse(text)
  if (!gate || typeof gate !== 'object' || typeof gate.head !== 'string' || !/^[0-9a-f]{40}$/.test(gate.head)
    || typeof gate.state !== 'string' || !Array.isArray(gate.labels) || !gate.ci || typeof gate.ci.result !== 'string') {
    throw new Error('pr-gate answered no head, state, labels and ci')
  }
  return gate as Gate
}

const head7 = (sha: string) => sha.slice(0, 7)

// What a pull request misses to be ready at its head: the four conditions,
// and before them an act that cannot be ready at all (closed, moved head).
export function missingItems(gate: Gate, files: RecordFile[], sha?: string): string[] {
  const missing: string[] = []
  if (gate.state !== 'open') missing.push('the pull request is ' + gate.state)
  if (sha && sha.toLowerCase() !== gate.head) missing.push('the head moved: ' + sha + ' given, ' + gate.head + ' on GitHub')
  const latest = new Map<string, any>()
  const skipped: string[] = []
  for (const file of files) {
    let record: any
    try {
      record = JSON.parse(file.text)
    } catch {
      skipped.push(file.name)
      continue
    }
    const kind = String(record?.kind ?? '')
    if (!record || typeof record !== 'object' || !(KINDS as readonly string[]).includes(kind)
      || String(record.head ?? '').toLowerCase() !== gate.head
      || String(record.repo ?? '').toLowerCase() !== gate.repo.toLowerCase()
      || Number(record.pr) !== Number(gate.pr)
      || !file.name.startsWith(kind + '.') || typeof record.at !== 'string') {
      skipped.push(file.name)
      continue
    }
    const before = latest.get(kind)
    if (!before || String(record.at) >= String(before.at)) latest.set(kind, record)
  }
  let kindMissing = false
  for (const kind of KINDS) {
    const record = latest.get(kind)
    const accepted = record && (record.result === 'pass' || (kind === 'e2e' && record.result === 'waived'))
    if (accepted) continue
    kindMissing = true
    if (!record) missing.push(kind + ': no record at ' + head7(gate.head))
    else {
      missing.push(kind + ': ' + record.result + ' at ' + head7(gate.head) + ' by ' + record.producer
        + (record.detail ? ', ' + record.detail : ''))
    }
  }
  // A file skipped is named only beside a kind it may have been meant for: with
  // the three accepted it blocks nothing, as nobody may delete it.
  if (kindMissing) for (const name of skipped) missing.push('unreadable record ' + name)
  const ci = gate.ci
  if (ci.result === 'FAILURE') missing.push('CI failed: ' + (ci.failed ?? []).join(', '))
  else if (ci.result !== 'SUCCESS') {
    const skippedChecks = ci.skipped ?? []
    if (skippedChecks.length > 0 && !ci.running) missing.push('CI did not run: ' + skippedChecks.join(', ') + ' skipped')
    else missing.push('CI still running')
  }
  return missing
}

// An undraft only for the CI to run: the pull request carries Not Ready and
// its CI is not green, so it leaves draft still Not Ready.
export function ciUndraft(gate: Gate): boolean {
  return gate.labels.some((label) => label.toLowerCase() === NOT_READY) && gate.ci.result !== 'SUCCESS'
}

export function carriesReady(gate: Gate): boolean {
  return gate.labels.some((label) => label.toLowerCase() === READY)
}

// ---- the texts ----

export function notReadyRefusal(act: string, repo: string, pr: number, head: string, missing: string[]): string {
  return 'github: ' + act + ' refused on ' + repo + '#' + pr + ' at ' + head7(head) + ': not ready. Missing: '
    + missing.join(', ') + '. A pull request is ready when a clean review, a passed norms check, passed E2E and'
    + ' green CI are all at its current head (engine/WRITING.md « Ready pull requests »).'
}

// repo undefined: the call names no repository the guard could read.
export function unverifiedRefusal(repo: string | undefined, pr: number | string | undefined, error: string): string {
  if (repo === undefined) return 'github: readiness unverified: ' + error
  return 'github: readiness of ' + repo + '#' + (pr ?? '?') + ' unverified: ' + error
}

export function draftRefusal(act: string): string {
  return 'github: ' + act + ' refused: open it as a draft, then leave draft once ready.'
}

export function unnamedRepoRefusal(act: string): string {
  return 'github: ' + act + ' refused: name the repository with -R owner/name.'
}

// A GraphQL mutation names a node, not a repository and a number.
export function graphqlRefusal(kind: ActKind): string {
  const tool = kind === 'merge' ? 'pr-merge' : 'pr-ready'
  return 'github: gh api graphql refused: the pull request it acts on cannot be read from the command. Run'
    + ' mcp__github__gh ' + tool + ' {"pr": <n>} on <owner/name>: it checks that the pull request is ready.'
}

export function autoMergeRefusal(kind: ActKind, repo: string, pr?: number): string {
  const command = kind === 'merge' ? 'gh pr merge' : 'gh pr ready'
  const tool = kind === 'merge' ? 'pr-merge' : 'pr-ready'
  return 'github: ' + command + ' refused on ' + repo + ': this repository is not in auto-merge, so a merge or'
    + ' leaving draft needs the operator\'s explicit word. When he gave it, run mcp__github__gh ' + tool
    + ' {"pr": ' + (pr ?? '<n>') + '} on ' + repo + ': it checks that the pull request is ready, then asks him'
    + ' in the conversation.'
}

export function ciUndraftLine(repo: string, pr: number): string {
  return 'github: ' + repo + '#' + pr + ' out of draft to run CI, still Not Ready'
}

export function warnLine(act: string, repo: string, pr: number | string, missing: string[]): string {
  return 'github: ' + act + ' on ' + repo + '#' + pr + ' is not ready, let through while the guard only warns.'
    + ' Missing: ' + missing.join(', ')
}

export const RECORDS_REFUSAL = 'github: records are written by their producers (claude-review\'s auto-fix-loop,'
  + ' /norms:check, the orchestrator\'s ready, mcp__github__record for E2E), never by hand.'

// A path into the records, or to their directory itself: a message or a body
// that only names the word is no path.
const RECORDS_PATH = /pr-records\/|\/pr-records(?![\w.-])/

// Whether a Bash command line names the records or their writer.
export function touchesRecords(line: string, root?: string): boolean {
  return RECORDS_PATH.test(line) || line.includes('engine/record.py') || (!!root && line.includes(root))
}

// The record kinds a caller of mcp__github__record may write, by the plugin
// whose hook made the call: the model (the engine) and any other plugin write
// only E2E, the review and the norms check have their own producers. The
// review's plugin is claude-review, installed under the name its host gives it.
export const REVIEW_PLUGIN = 'pr-review'
export const RECORD_PRODUCERS: Record<string, string> = { [REVIEW_PLUGIN]: 'review', norms: 'norms' }

export function recordKindFor(origin: string): string {
  return RECORD_PRODUCERS[origin] ?? 'e2e'
}

// A plugin's name as a producer slug.
export function producerSlug(origin: string): string {
  return origin === 'engine' ? 'session-e2e' : origin.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

// The head directories older than the cut-off, by their newest file.
export const PRUNE_DAYS = 90
export const PRUNE_EVERY_MS = 24 * 3600 * 1000
