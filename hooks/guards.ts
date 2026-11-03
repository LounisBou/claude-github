// The decisions of the guard « WRITING.md read »: which call authors a text
// that engine/WRITING.md governs, and which read puts that file in the
// reader's context. Pure functions only: register.ts holds the $ that reads
// the session, keeps the marks and answers the calls.

import { textFields } from './writing.ts'
import { gitSubcommand, simpleCommands } from './shell.ts'

// The file every author reads, under the plugin's root.
export const WRITING_FILE = '/engine/WRITING.md'

// The text flags of gh pr review, and those of gh pr edit and gh issue edit.
const REVIEW_TEXT = ['-b', '--body', '-F', '--body-file']
const EDIT_TEXT = ['-t', '--title', ...REVIEW_TEXT]

// Whether a word sets one of the flags: `--body x`, `--body=x`, `-bx`.
function setsOne(word: string, flags: string[]): boolean {
  return flags.some((flag) => word === flag
    || (flag.startsWith('--') ? word.startsWith(flag + '=') : word.startsWith(flag) && word.length > 2))
}

// The noun and the verb of a gh command, past its repository option wherever
// it stands before the verb (`gh -R o/r pr create`, `gh pr --repo=o/r create`),
// and the words after the verb.
function ghWords(argv: string[]): { noun: string; verb: string; flags: string[] } | undefined {
  const named: string[] = []
  let k = 1
  while (k < argv.length && named.length < 2) {
    const word = argv[k++]
    if (word === '-R' || word === '--repo') k++
    else if (!word.startsWith('-R') && !word.startsWith('--repo=')) named.push(word)
  }
  return named.length === 2 ? { noun: named[0], verb: named[1], flags: argv.slice(k) } : undefined
}

// The authoring command one simple command runs, as the refusal names it, or
// undefined when it writes no text WRITING.md governs.
export function authoringCommand(argv: string[]): string | undefined {
  const git = gitSubcommand(argv)
  if (git && argv[git.at] === 'commit') return 'git commit'
  const gh = /^(.*\/)?gh$/.test(argv[0] ?? '') ? ghWords(argv) : undefined
  if (!gh || (gh.noun !== 'pr' && gh.noun !== 'issue')) return undefined
  const { noun, verb, flags } = gh
  const name = 'gh ' + noun + ' ' + verb
  if (verb === 'create' || verb === 'comment') return name
  if (noun === 'pr' && verb === 'review' && flags.some((w) => setsOne(w, REVIEW_TEXT))) return name
  if (verb === 'edit' && flags.some((w) => setsOne(w, EDIT_TEXT))) return name
  return undefined
}

// The first authoring command of a Bash command line, read word by word: a
// message or a body that only mentions one is an argument, not a command.
export function bashAuthoring(line: string): string | undefined {
  for (const argv of simpleCommands(line)) {
    const found = authoringCommand(argv)
    if (found) return found
  }
  return undefined
}

// The tool's subcommand whose writing rules a gh pr command's text keeps.
const LINTED_AS: Record<string, string> = {
  create: 'pr-create', edit: 'pr-update', comment: 'pr-comment', review: 'review-submit',
}

// A text a gh pr command of a Bash line writes: the command as the refusal
// names it, the tool's subcommand whose rules apply, its argv, its title and
// its body inline or the file that holds it.
export type BashText = {
  name: string
  command: string
  argv: string[]
  title?: string
  body?: string
  bodyFile?: string
}

// The value the last of a flag's settings gives, as gh reads it: `--body x`,
// `--body=x`, `-bx` or `-b x`.
function flagValue(flags: string[], short: string, long: string): string | undefined {
  let value: string | undefined
  for (let k = 0; k < flags.length; k++) {
    const word = flags[k]
    if (word === short || word === long) value = flags[++k]
    else if (word.startsWith(long + '=')) value = word.slice(long.length + 1)
    else if (!word.startsWith('--') && word.startsWith(short) && word.length > 2) value = word.slice(2)
  }
  return value
}

// Whether the shell substitutes a command somewhere on the line: a $(…) or a
// backtick outside single quotes, unescaped. An inline text there may not be
// the one gh receives.
export function substitutes(line: string): boolean {
  let single = false
  let double = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (single) {
      if (c === "'") single = false
      continue
    }
    if (c === '\\') i++
    else if (c === "'" && !double) single = true
    else if (c === '"') double = !double
    else if (c === '`' || (c === '$' && line[i + 1] === '(')) return true
  }
  return false
}

// The body a `--body "$(cat <<'EOF' … EOF\n)"` substitution gives, when the
// line holds exactly one.
const HEREDOC_BODY = /(?:^|\s)(?:-b|--body)(?:\s+|=)"\$\(cat\s+<<-?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*\n([\s\S]*?)\n\2[ \t]*\n\s*\)"/g
export function heredocBody(line: string): string | undefined {
  const found = [...line.matchAll(HEREDOC_BODY)]
  return found.length === 1 ? found[0][3] : undefined
}

// The mark put before each `$` or backtick the shell expands: a word that
// holds it after the line is read is not the text gh receives.
const EXPANDED = ''

// The line with EXPANDED before every expansion the shell makes, outside single
// quotes and unescaped: `$name`, `${…}`, `$1`, `$(…)`, a backtick, and `$'…'`
// outside double quotes. It adds a plain character inside a word, so the line
// splits into the same commands and words.
function markExpansions(line: string): string {
  let out = ''
  let single = false
  let ansi = false
  let double = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1] ?? ''
    if (single || ansi) {
      if (ansi && c === '\\') { out += c + next; i++; continue }
      if (c === "'") { single = false; ansi = false }
      out += c
      continue
    }
    if (c === '\\') { out += c + next; i++; continue }
    if (c === "'" && !double) single = true
    else if (c === '"') double = !double
    else if (c === '`' || (c === '$' && /[A-Za-z0-9_{(@*#?!$-]/.test(next))) out += EXPANDED
    else if (c === '$' && next === "'" && !double) { out += EXPANDED; ansi = true; out += c + next; i++; continue }
    out += c
  }
  return out
}

// The texts the gh pr commands of a Bash line write, each with the tool's
// subcommand whose writing rules it keeps. A body read from stdin, one a
// command substitution makes and no heredoc shows, a title, body or file a
// shell variable or substitution gives, and a relative file after a cd are left
// out.
export function bashTexts(line: string): BashText[] {
  const out: BashText[] = []
  const substituted = substitutes(line)
  const marked = simpleCommands(markExpansions(line))
  const commands = simpleCommands(line)
  // A cd moves the directory a relative path is read from: the hook knows only
  // the session's.
  const moves = commands.some((argv) => argv[0] === 'cd')
  commands.forEach((argv, n) => {
    const name = authoringCommand(argv)
    const gh = name?.startsWith('gh pr ') ? ghWords(argv) : undefined
    const command = gh ? LINTED_AS[gh.verb] : undefined
    const words = marked[n] ? ghWords(marked[n]) : undefined
    if (!gh || !command || !name || !words) return
    const text: BashText = { name, command, argv }
    const read = (value: string | undefined) => (value === undefined || value.includes(EXPANDED) ? undefined : value)
    const title = flagValue(words.flags, '-t', '--title')
    if (read(title) !== undefined && (command === 'pr-create' || command === 'pr-update')) text.title = title
    const body = flagValue(words.flags, '-b', '--body')
    const file = flagValue(words.flags, '-F', '--body-file')
    if (body !== undefined) {
      if (!substituted && read(body) !== undefined) text.body = body
      else if (substituted && heredocBody(line) !== undefined) text.body = heredocBody(line)
    } else if (read(file) !== undefined && file !== '-' && !(moves && !/^[/~]/.test(file ?? ''))) {
      text.bodyFile = file
    }
    if (text.title !== undefined || text.body !== undefined || text.bodyFile !== undefined) out.push(text)
  })
  return out
}

// The tool's authoring call: a subcommand that carries text, with text in it.
export function toolAuthoring(command: string, args: Record<string, unknown>): string | undefined {
  return textFields(command, args).length > 0 ? command : undefined
}

// Whether a Read took the file whole: from its first line, and up to its last.
export function readsWhole(offset: unknown, limit: unknown, lines: () => number): boolean {
  if (offset !== undefined && offset !== null && !(Number(offset) <= 1)) return false
  if (limit === undefined || limit === null) return true
  return Number(limit) >= lines()
}

// The file a Bash command line prints whole, when it is that one command and
// nothing else: `cat <path>` or `sed -n '1,$p' <path>`.
export function printsWhole(line: string): string | undefined {
  const commands = simpleCommands(line)
  if (commands.length !== 1) return undefined
  const argv = commands[0]
  if (argv.length === 2 && argv[0] === 'cat' && !argv[1].startsWith('-')) return argv[1]
  if (argv.length === 4 && argv[0] === 'sed' && argv[1] === '-n' && argv[2] === '1,$p') return argv[3]
  return undefined
}

// A path with its . and .. parts and repeated slashes resolved, a relative one
// against dir.
export function normalise(path: string, dir = '/'): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : dir + '/' + path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

// The lines of a file as the Read tool counts them: a last newline ends the
// last line, it opens no other.
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length
}

// The reader a mark belongs to: the session, and the loop within it, as a
// subagent has a context of its own.
export function readerKey(session: string, agentId?: string): string {
  return session + '\n' + (agentId ?? 'main')
}

export function unreadRefusal(root: string, command: string): string {
  return 'github: read ' + root + WRITING_FILE + ' with the Read tool, whole, before ' + command
    + ': its rules (commit convention, references, PR titles and descriptions, comments, ready pull requests)'
    + ' apply to this text. Then run the same command again.'
}
