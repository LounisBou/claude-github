// A command line read the way the shell reads it, ported from
// claude-orchestrator's hooks/tokenizer.ts (itself the awk tokeniser of its
// push guard). The same quoting, heredoc, comment, $((…)), assignment and
// wrapper rules: a heredoc body, a comment and text in quotes that is an
// argument (a commit message, a body) are data and never read as a command.
// One change: the argument of bash -c, sh -c and zsh -c is read again, one
// level deep. Pure functions only.

// Words that end a simple command or open a group: skipped in command position
// the way an assignment is.
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])
// Commands that wrap the real one: everything until a word that is not an option
// of the wrapper is skipped before the real command is read.
const WRAPPER = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'sudo', 'xargs'])
// A wrapper's options that take a value, keyed "wrapper option".
const VALUED = new Set([
  'env -u', 'env -C', 'env -S', 'nice -n', 'timeout -s', 'timeout -k', 'gtimeout -s', 'gtimeout -k',
  'sudo -u', 'sudo -g', 'sudo -C', 'sudo -h', 'sudo -p', 'xargs -n', 'xargs -I', 'xargs -P',
  'xargs -L', 'xargs -s', 'xargs -d', 'xargs -E', 'xargs -a',
])
// git global options that take a value: `git -C /tmp/r commit` commits.
const GITVALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
// The shells whose -c argument is a command line of its own.
const SHELL = /^(.*\/)?(bash|sh|zsh)$/

// Where a git command's subcommand sits in its argv, past git's global options,
// or undefined when the argv is not git's or names no subcommand.
export function gitSubcommand(argv: string[]): { at: number } | undefined {
  if (argv.length === 0 || !/^(.*\/)?git$/.test(argv[0])) return undefined
  let k = 1
  for (; k < argv.length && argv[k].startsWith('-'); k++) if (GITVALUED.has(argv[k])) k++
  return k < argv.length ? { at: k } : undefined
}

// The argv of every simple command on the line, quotes removed, from its real
// command on: the assignments, reserved words and wrappers before it skipped.
// A command inside $(…) or backticks is one of its own.
export function simpleCommands(line: string): string[][] {
  const out = tokenize(line)
  for (const argv of [...out]) {
    const inner = shellArgument(argv)
    if (inner !== undefined) out.push(...tokenize(inner))
  }
  return out
}

// The command line a shell runs with -c (alone or in a cluster such as -lc):
// the first word after its options, the option each -o or -O sets skipped
// (`bash -o pipefail -c …`, `bash -euo pipefail -c …`).
function shellArgument(argv: string[]): string | undefined {
  if (!SHELL.test(argv[0] ?? '')) return undefined
  let dashC = false
  for (let k = 1; k < argv.length; k++) {
    const word = argv[k]
    if (/^-[A-Za-z]+$/.test(word)) {
      if (word.includes('c')) dashC = true
      k += word.replace(/[^oO]/g, '').length
      continue
    }
    if (word.startsWith('-')) continue
    return dashC ? word : undefined
  }
  return undefined
}

function tokenize(command: string): string[][] {
  const found: string[][] = []

  // The whole command with one trailing newline, and 1-based positions as in
  // the awk being ported: at() is substr(s, i, 1), rest() substr(s, i), find()
  // index(substr(s, i), c) as an absolute position, 0 when absent.
  const s = command + '\n'
  const L = s.length
  const at = (p: number): string => (p >= 1 && p <= L ? s.charAt(p - 1) : '')
  const rest = (p: number): string => s.slice(p - 1)
  const find = (c: string, p: number): number => {
    const r = s.indexOf(c, p - 1)
    return r === -1 ? 0 : r + 1
  }

  // Per-depth state, index 0 the top level: the closer that ends this nesting
  // (` or )), the words of the simple command being read, the paren depth inside
  // it, whether a double quote is open, whether the next word is a redirected
  // fd's target and must be dropped. Pending heredocs queue their delimiters
  // (HD) and <<- tab stripping (HS) for bodies(), hdone counting those read.
  const closer = ['']
  const words: string[][] = [[]]
  const pd = [0]
  const dq = [0]
  const sk = [0]
  let d = 0
  let cur = ''
  let started = 0
  const HD = ['']
  const HS = [0]
  let hn = 0
  let hdone = 0

  function push(cl: string): void {
    flushWord(); d++; closer[d] = cl; words[d] = []; pd[d] = 0; dq[d] = 0; sk[d] = 0
  }
  function pop(): void {
    flushWord(); flushCmd(); d--
    cur = ''
    started = dq[d] ? 1 : 0
  }
  function flushWord(): void {
    if (started) {
      if (sk[d]) sk[d] = 0
      else words[d].push(cur)
    }
    cur = ''
    started = 0
  }
  function flushCmd(): void {
    analyze(d)
    words[d] = []
    sk[d] = 0
  }
  // `$((...))` is arithmetic, not a command: skipped whole, so a `<<` inside it is no heredoc.
  function arith(j: number): number {
    let n = 0
    for (; j <= L; j++) {
      const ch = at(j)
      if (ch === '(') n++
      else if (ch === ')') { n--; if (n === 0) return j + 1 }
    }
    return j
  }
  // After `<<` or `<<-`: the delimiter, quotes removed. The body starts at the next newline.
  function heredoc(j: number): number {
    let strip = 0
    if (at(j) === '-') { strip = 1; j++ }
    while (at(j) === ' ' || at(j) === '\t') j++
    let dl = ''
    for (; j <= L; j++) {
      const ch = at(j)
      if (ch === "'" || ch === '"') {
        const q = find(ch, j + 1)
        if (q === 0) { dl += rest(j + 1); j = L + 1; break }
        dl += s.slice(j, q - 1)
        j = q
        continue
      }
      if (ch === '\\') { dl += at(j + 1); j++; continue }
      if (/[ \t\n;|&<>()]/.test(ch)) break
      dl += ch
    }
    hn++; HD[hn] = dl; HS[hn] = strip
    return j
  }
  function bodies(j: number): number {
    for (let k = hdone + 1; k <= hn; k++) {
      while (j <= L) {
        const e = find('\n', j)
        let line: string
        if (e === 0) { line = rest(j); j = L + 1 }
        else { line = s.slice(j - 1, e - 1); j = e + 1 }
        if (HS[k]) line = line.replace(/^\t+/, '')
        if (line === HD[k]) break
      }
    }
    hdone = hn
    return j
  }
  // A finished simple command: its argv from the real command on.
  function analyze(depth: number): void {
    const w = words[depth]
    const n = w.length
    let k = 1
    while (k <= n) {
      const word = w[k - 1]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || RESERVED.has(word)) { k++; continue }
      if (WRAPPER.has(word)) {
        const wrap = word
        k++
        while (k <= n && w[k - 1].startsWith('-')) {
          k += VALUED.has(`${wrap} ${w[k - 1]}`) ? 2 : 1
        }
        if (wrap === 'timeout' || wrap === 'gtimeout') k++
        continue
      }
      break
    }
    if (k <= n) found.push(w.slice(k - 1))
  }

  // One pass over s, c the character, n1 the one after it.
  let i = 1
  while (i <= L) {
    const c = at(i), n1 = at(i + 1)
    if (dq[d]) {
      if (c === '"') { dq[d] = 0; i++ }
      else if (c === '\\') {
        if (n1 === '\n') i += 2
        else { cur += /[$`"\\]/.test(n1) ? n1 : c + n1; i += 2 }
      }
      else if (c === '`') { push('`'); i++ }
      else if (c === '$' && n1 === '(') {
        if (at(i + 2) === '(') i = arith(i + 1)
        else { push(')'); i += 2 }
      }
      else { cur += c; i++ }
      continue
    }
    if (c === ' ' || c === '\t') { flushWord(); i++ }
    else if (c === '\n') { flushWord(); flushCmd(); i = bodies(i + 1) }
    else if (c === '\\') { if (n1 !== '\n') { cur += n1; started = 1 } i += 2 }
    else if (c === "'") {
      const j = find("'", i + 1)
      if (j === 0) { cur += rest(i + 1); i = L + 1 }
      else { cur += s.slice(i, j - 1); i = j + 1 }
      started = 1
    }
    else if (c === '$' && (n1 === "'" || n1 === '"')) i++
    else if (c === '"') { dq[d] = 1; started = 1; i++ }
    else if (c === '#' && !started) { while (i <= L && at(i) !== '\n') i++ }
    else if (c === '$' && n1 === '(') {
      if (at(i + 2) === '(') { i = arith(i + 1); started = 1 }
      else { push(')'); i += 2 }
    }
    else if (c === '`') { if (d > 0 && closer[d] === '`') pop(); else push('`'); i++ }
    else if (c === '(') { flushWord(); flushCmd(); pd[d]++; i++ }
    else if (c === ')') {
      flushWord(); flushCmd()
      if (pd[d] > 0) pd[d]--
      else if (d > 0 && closer[d] === ')') pop()
      i++
    }
    else if (c === ';' || c === '|') { flushWord(); flushCmd(); i++ }
    else if (c === '&') { flushWord(); if (n1 !== '>') flushCmd(); i++ }
    else if (c === '<' && n1 === '<') {
      flushWord()
      if (at(i + 2) === '<') { sk[d] = 1; i += 3 }
      else i = heredoc(i + 2)
    }
    else if (c === '<' || c === '>') {
      flushWord(); i++
      while (/[<>&|]/.test(at(i))) i++
      sk[d] = 1
    }
    else if (c === '{' || c === '}') { flushWord(); i++ }
    else { cur += c; started = 1; i++ }
  }
  flushWord(); flushCmd()
  while (d > 0) pop()
  return found
}

// ---- the plugin's own engine, run from Bash ----

// The interpreter a script runs under, and the engine's script itself.
const PYTHON = /^(.*\/)?python(3(\.\d+)*)?$/
const ENGINE_SCRIPT = /(^|\/)gh\.py$/
// A script given by a shell variable (`python3 "$GH" …`, as the github-curl
// skill writes it) is the engine when the word after it is one of its
// subcommands, which all share this shape.
const SCRIPT_VARIABLE = /^\$(\{\w+\}|\w+)$/
const ENGINE_SUBCOMMAND = /^(pr|label|labels|thread|comment|comments|review|reviewer|assignee|issue|image|auth|file|repo)-[a-z-]+$/
// The interpreter's options that take the next word as their value.
const PYTHON_VALUED = new Set(['-W', '-X'])
// The engine's global options, which come before its subcommand and take a value.
const ENGINE_GLOBAL_VALUED = new Set(['--repo', '-R', '--format'])
// The engine's options that take a value, its global --repo and --format included.
const ENGINE_VALUED = new Set([
  '-R', '--repo', '--format', '--title', '--body-file', '--comments-file', '--base', '--head', '--method', '--sha',
  '--state', '--branch', '--pr', '--event', '--review-id', '--path', '--line', '--start-line', '--author',
  '--limit',
])

// One run of engine/gh.py: its subcommand, the repository its --repo names,
// its positionals and its options. `--stdin-json` reads its request from
// stdin, which the command line does not show: it is no call read here.
export type EngineCall = {
  command: string
  repo?: string
  positionals: string[]
  opts: Array<[string, string | undefined]>
}

// Where the engine's words start in a simple command's argv, past the
// interpreter, its options and the script, or undefined when it runs no engine.
export function engineStart(argv: string[]): number | undefined {
  let k = 0
  if (PYTHON.test(argv[0] ?? '')) {
    k = 1
    while (k < argv.length && argv[k].startsWith('-')) k += PYTHON_VALUED.has(argv[k]) ? 2 : 1
  }
  const script = argv[k] ?? ''
  if (ENGINE_SCRIPT.test(script)) return k + 1
  let first: string | undefined
  for (let j = k + 1; j < argv.length && first === undefined; j++) {
    if (ENGINE_GLOBAL_VALUED.has(argv[j])) j++
    else if (!argv[j].startsWith('-')) first = argv[j]
  }
  if (k > 0 && SCRIPT_VARIABLE.test(script) && first !== undefined && ENGINE_SUBCOMMAND.test(first)) return k + 1
  return undefined
}

// The call the engine's words make, or undefined for none read here.
export function engineWords(words: string[]): EngineCall | undefined {
  // The engine reads its request from stdin only when that is its one argument: anywhere
  // else, or after `--`, the word is an ordinary one.
  if (words.length === 1 && words[0] === '--stdin-json') return undefined
  const call: EngineCall = { command: '', positionals: [], opts: [] }
  let optionsEnded = false
  for (let j = 0; j < words.length; j++) {
    const word = words[j]
    if (word === '--' && !optionsEnded) {
      optionsEnded = true
      continue
    }
    let flag: string | undefined
    let value: string | undefined
    if (optionsEnded) {
      flag = undefined
    } else if (word.startsWith('--') && word.includes('=')) {
      flag = word.slice(0, word.indexOf('='))
      value = word.slice(word.indexOf('=') + 1)
    } else if (word.startsWith('-') && word !== '-') {
      flag = word
      if (ENGINE_VALUED.has(word)) value = words[++j]
    }
    if (flag === undefined) {
      if (call.command === '') call.command = word
      else call.positionals.push(word)
    } else if (flag === '--repo' || flag === '-R') {
      call.repo = value
    } else {
      call.opts.push([flag, value])
    }
  }
  return call.command === '' ? undefined : call
}

export function engineCall(argv: string[]): EngineCall | undefined {
  const at = engineStart(argv)
  return at === undefined ? undefined : engineWords(argv.slice(at))
}

// The value the last setting of an engine option gives, or undefined.
export function engineOption(call: EngineCall, flag: string): string | undefined {
  const set = call.opts.filter(([f]) => f === flag)
  return set.length > 0 ? set[set.length - 1][1] : undefined
}

export function engineFlag(call: EngineCall, flag: string): boolean {
  return call.opts.some(([f]) => f === flag)
}
