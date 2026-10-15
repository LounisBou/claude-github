// The mechanical rules of engine/WRITING.md, checked on the text a write
// carries before it leaves the machine. Only what code can decide without
// judgement is here: a semicolon in prose, an attribution trailer, a title on
// more than one line or far past « about sixty characters », a heading in a
// pull request description, a TODO item that points to another or joins two
// actions, a CVE id that is no link, a security update without its tables.
// The workflow vocabulary is left out: « session » and « agent » are also real
// product words, and a refusal there would be a guess. Pure functions only:
// register.ts holds the $ that acts on them.

export type Violation = {
  // Where the text sits in the call: "title", "body" or "comments[2].body".
  field: string
  // The rule as the model reads it, with the WRITING.md section it comes from.
  rule: string
}

// Past this a title is no longer « about sixty characters »: the margin keeps a
// title of 62 or 65 characters, which the rule's « about » allows, out of reach.
export const TITLE_MAX = 72

// The subcommands that carry text written for people, and what kind of text.
const KIND: Record<string, 'pr' | 'comment'> = {
  'pr-create': 'pr',
  'pr-update': 'pr',
  'pr-comment': 'comment',
  'thread-reply': 'comment',
  'comment-edit': 'comment',
  'review-submit': 'comment',
  'review-pending-create': 'comment',
  'review-pending-add': 'comment',
}

export function carriesText(command: string): boolean {
  return command in KIND
}

// The text fields of a call, by name. Only strings are read: anything else is
// the engine's to refuse.
export function textFields(command: string, args: Record<string, unknown>): Array<{ field: string; text: string }> {
  if (!carriesText(command)) return []
  const out: Array<{ field: string; text: string }> = []
  if (KIND[command] === 'pr' && typeof args.title === 'string') out.push({ field: 'title', text: args.title })
  if (typeof args.body === 'string') out.push({ field: 'body', text: args.body })
  if (Array.isArray(args.comments)) {
    args.comments.forEach((c: any, i: number) => {
      if (c && typeof c.body === 'string') out.push({ field: 'comments[' + i + '].body', text: c.body })
    })
  }
  return out
}

// The lines of a markdown text outside fenced code blocks. A fence opens on
// three or more backticks or tildes and closes on a run of the same character
// at least as long; an unclosed fence runs to the end, as GitHub draws it.
export function proseLines(text: string): string[] {
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length
        && line.trim() === marker[1]) fence = null
      continue
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      continue
    }
    out.push(line)
  }
  return out
}

// A prose line with what is not prose taken out: inline code spans, URLs,
// autolinks and HTML character references, which all may hold a semicolon.
function strip(line: string): string {
  return line
    .replace(/(`+)[\s\S]*?\1/g, ' ')
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, ' ')
}

const TRAILER = /^\s*(co-authored-by|claude-session)\s*:/i
const HEADING = /^ {0,3}#{1,6}(\s|$)/

const SEMICOLON_RULE = 'no semicolon in prose (WRITING.md, « Pull request titles », « Pull request descriptions », « Review comments »); code in backticks or a fenced block may keep one'
const TRAILER_RULE = 'no trailer or attribution such as Co-Authored-By or Claude-Session (WRITING.md, « Commit messages »)'
const TITLE_LINE_RULE = 'a title is one line (WRITING.md, « Pull request titles »)'
const TITLE_LENGTH_RULE = 'a title is about sixty characters at most, this one has '
const HEADING_RULE = 'no heading of any kind in a pull request description, it starts with the summary text (WRITING.md, « Pull request descriptions »)'
const TODO_RULE = 'a TODO Staging or TODO Prod item is a task-list checkbox, `- [ ] <step>`, never a bare `- ` bullet (WRITING.md, « Pull request descriptions »)'
const TODO_LABEL = /^\*\*TODO (Staging|Prod):\*\*\s*$/
const BOLD_LABEL = /^\*\*[^*]+:\*\*\s*$/

// A bare bullet under a TODO label: the section runs from its label to the next
// bold label or blank-line-separated prose, and every list item in it must be
// a checkbox the operator can tick.
function bareTodoItem(lines: string[]): boolean {
  let inTodo = false
  for (const raw of lines) {
    const line = raw.trim()
    if (TODO_LABEL.test(line)) { inTodo = true; continue }
    if (BOLD_LABEL.test(line)) { inTodo = false; continue }
    if (!inTodo || line === '') continue
    if (/^[-*+]\s/.test(line) && !/^[-*+]\s+\[[ xX]\]\s/.test(line)) return true
    if (!/^[-*+]\s/.test(line)) inTodo = false
  }
  return false
}

const TODO_ALONE_RULE = 'a TODO item stands alone, it never points to another item (« the same edit », « same as above », « likewise ») and writes the action in full (WRITING.md, « Pull request descriptions »)'
const TODO_ONE_RULE = 'one checkbox, one action: an edit and the restart, reload or deploy that applies it are two checkboxes, never joined by « then » or « and run » (WRITING.md, « Pull request descriptions »)'
const POINTER = /\b(the same (edit|change|step|steps|command)|same as (above|before)|as above|as before|likewise)\b/i
const JOINED = /\b(then|and run)\b/i

// The checkbox items of the TODO sections, as prose with code spans taken out,
// so a value such as `then=1` in backticks is never read as a joining word.
function todoItems(lines: string[]): string[] {
  const out: string[] = []
  let inTodo = false
  for (const raw of lines) {
    const line = raw.trim()
    if (TODO_LABEL.test(line)) { inTodo = true; continue }
    if (BOLD_LABEL.test(line)) { inTodo = false; continue }
    if (!inTodo || line === '') continue
    if (!/^[-*+]\s/.test(line)) { inTodo = false; continue }
    out.push(strip(line.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')))
  }
  return out
}

const CVE_LINK_RULE = 'a CVE id is a markdown link to its advisory, `[CVE-YYYY-NNNNN](<advisory URL>)`, never bare and never in a code span (WRITING.md, « Security update pull requests »)'
const CVE_TABLE_RULE = 'a description whose first line names CVE ids has one table per advisory, with the Package, Advisory, Affected and Reference rows, its Advisory row naming the CVE id (WRITING.md, « Security update pull requests »)'
const CVE = /\bCVE-\d{4}-\d{4,}\b/gi
const CVE_ID = /\bCVE-\d{4}-\d{4,}\b/i
// An inline link, a title after its URL included, or a reference link.
const CVE_LINK = /\[CVE-\d{4}-\d{4,}\](\([^)]*\)|\[[^\]]*\])/gi
const TABLE_ROW = /^\s*\|\s*([^|]*?)\s*\|/

// A line with its URLs taken out: a URL that holds a CVE id, as an
// advisory's often does, names no id. A link keeps its text.
function withoutUrls(line: string): string {
  return line
    .replace(/\]\([^)\s]+\)/g, ']')
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
}

// A CVE id GitHub may leave as plain text: one in prose or in a code span,
// outside a link of its own.
function bareCve(lines: string[]): boolean {
  return lines.some((l) => CVE_ID.test(withoutUrls(l.replace(CVE_LINK, ' '))))
}

function cveIds(text: string): string[] {
  return (text.match(CVE) ?? []).map((id) => id.toUpperCase())
}

// A security update, its first line naming CVE ids, without its tables: an id
// of that line no Advisory row names, or an advisory's table missing a row.
function missingCveTables(lines: string[]): boolean {
  const first = lines.find((l) => l.trim() !== '')
  const ids = first ? cveIds(withoutUrls(first)) : []
  if (ids.length === 0) return false
  const tables: string[][] = []
  let table: string[] | null = null
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) { table = null; continue }
    if (!table) {
      table = []
      tables.push(table)
    }
    table.push(line)
  }
  const label = (row: string) => TABLE_ROW.exec(row)?.[1] ?? ''
  const advisories = tables.filter((rows) => rows.some((row) => label(row) === 'Advisory'))
  if (advisories.some((rows) => !['Package', 'Affected', 'Reference'].every((name) => rows.some((row) => label(row) === name)))) return true
  const named = new Set(advisories.flatMap((rows) => rows.filter((row) => label(row) === 'Advisory').map(withoutUrls).flatMap(cveIds)))
  return ids.some((id) => !named.has(id))
}

// Every rule one field breaks, each named once.
function lintField(kind: 'pr' | 'comment', field: string, text: string): Violation[] {
  const found: Violation[] = []
  const add = (rule: string) => found.push({ field, rule })
  if (field === 'title') {
    if (/[\r\n]/.test(text.trim())) add(TITLE_LINE_RULE)
    const length = [...text.trim()].length
    if (length > TITLE_MAX) add(TITLE_LENGTH_RULE + length + ' (WRITING.md, « Pull request titles »)')
    if (strip(text).includes(';')) add(SEMICOLON_RULE)
    return found
  }
  const lines = proseLines(text)
  if (lines.some((l) => strip(l).includes(';'))) add(SEMICOLON_RULE)
  if (lines.some((l) => TRAILER.test(l))) add(TRAILER_RULE)
  if (kind === 'pr' && field === 'body' && lines.some((l) => HEADING.test(l))) add(HEADING_RULE)
  if (kind === 'pr' && field === 'body' && bareTodoItem(lines)) add(TODO_RULE)
  if (kind === 'pr' && field === 'body') {
    const items = todoItems(lines)
    if (items.some((i) => POINTER.test(i))) add(TODO_ALONE_RULE)
    if (items.some((i) => JOINED.test(i))) add(TODO_ONE_RULE)
    if (bareCve(lines)) add(CVE_LINK_RULE)
    if (missingCveTables(lines)) add(CVE_TABLE_RULE)
  }
  return found
}

// Every rule the call's text breaks. A field whose text the user typed
// verbatim in the prompt passed as `typed` is the user's own words and is
// never refused.
export function lint(command: string, args: Record<string, unknown>, typed = ''): Violation[] {
  const kind = KIND[command]
  if (!kind) return []
  const said = squash(typed)
  const found: Violation[] = []
  for (const { field, text } of textFields(command, args)) {
    const own = squash(text)
    if (own !== '' && said.includes(own)) continue
    found.push(...lintField(kind, field, text))
  }
  return found
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// The refusal the model reads: each broken rule with its field, then how to
// go on.
export function refusal(command: string, found: Violation[]): string {
  const lines = found.map((v) => '- ' + v.field + ': ' + v.rule)
  return 'gh ' + command + ' refused, its text breaks the writing rules:\n' + lines.join('\n')
    + '\nRewrite the text and call again. If the user asked for this exact text, call again unchanged:'
    + ' the user is then asked whether to send it as it is.'
}
