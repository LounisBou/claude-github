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

// The authoring command one simple command runs, as the refusal names it, or
// undefined when it writes no text WRITING.md governs.
export function authoringCommand(argv: string[]): string | undefined {
  const git = gitSubcommand(argv)
  if (git && argv[git.at] === 'commit') return 'git commit'
  if (argv.length < 3 || !/^(.*\/)?gh$/.test(argv[0])) return undefined
  const [noun, verb] = [argv[1], argv[2]]
  if (noun !== 'pr' && noun !== 'issue') return undefined
  const name = 'gh ' + noun + ' ' + verb
  if (verb === 'create' || verb === 'comment') return name
  const flags = argv.slice(3)
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
    + ': its rules (commit convention, references, PR titles and descriptions, comments)'
    + ' apply to this text. Then run the same command again.'
}
