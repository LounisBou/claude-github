// The tokeniser's fixtures: the command lines claude-orchestrator's push guard
// refuses and accepts, read here through simpleCommands() and a push-force
// check over its argv, then the cases of its one change (bash -c, sh -c and
// zsh -c read again, one level deep).
import { expect, test } from 'claude-code/testing'
import { engineCall, gitSubcommand, simpleCommands } from './shell.ts'

// push options that take a value: `git push --repo x --force-with-lease` still forces.
const PUSHVALUED = new Set(['--repo', '--push-option', '--receive-pack', '--exec'])

function prefixOf(name: string, full: string, min: number): boolean {
  return name.length >= min && full.indexOf(name) === 0
}

// The orchestrator's force rules, over one simple command's argv.
function forcesOf(argv: string[]): string[] {
  const found: string[] = []
  const seen = (reason: string) => { if (!found.includes(reason)) found.push(reason) }
  const git = gitSubcommand(argv)
  if (!git || argv[git.at] !== 'push') return found
  let skip = false
  let ddash = false
  for (const word of argv.slice(git.at + 1)) {
    if (skip) { skip = false; continue }
    if (!ddash && word === '--') { ddash = true; continue }
    if (!ddash && /^--/.test(word)) {
      const eq = word.indexOf('=') + 1
      const name = eq ? word.slice(0, eq - 1) : word
      const val = eq ? word.slice(eq) : ''
      if (prefixOf(name, '--force', 4)) seen('--force')
      else if (prefixOf(name, '--force-with-lease', 9)) {
        if (!eq || !/^[^:= \t\n]+:[^ \t\n]+$/.test(val)) seen('--force-with-lease without <branch>:<sha>')
      }
      else if (prefixOf(name, '--mirror', 4)) seen('--mirror')
      else if (!eq && PUSHVALUED.has(name)) skip = true
      continue
    }
    if (!ddash && /^-./.test(word)) {
      for (let j = 1; j < word.length; j++) {
        if (word[j] === 'f') seen('-f')
        if (word[j] === 'o') { if (j === word.length - 1) skip = true; break }
      }
      continue
    }
    if (/^\+/.test(word)) seen('a +<refspec>')
  }
  return found
}

const forces = (line: string) => simpleCommands(line).flatMap(forcesOf)

const refused = [
  'git push --force origin main',
  'git push -f origin main',
  'git push origin +feature:main',
  'git push --force-with-lease origin main',
  'git push --force-with-lease=main origin main',
  'git -C /tmp/r push --force',
  'git -C . push --force-with-lease',
  'git -c x=y push -f',
  'git --no-pager push -f',
  '/usr/bin/git push -f origin main',
  'git --git-dir=/tmp/r/.git --work-tree /tmp/r push -f',
  'FOO=1 git push -f',
  'timeout 60 git push --force origin main',
  'env -u X git push -f',
  'git push -uf origin main',
  'git push -fu origin main',
  'git push -vf',
  'git push -nf',
  '(cd x && git push -f)',
  'git push -f)',
  'git push "-f"',
  'git push origin "+main"',
  "git push origin 'a:b' '+x'",
  'git push -f`true`',
  'git push -f>out',
  '{ git push -f; }',
  'git push origin main 2>/dev/null --force',
  'git push \\\n  --force origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=other origin main',
  'git push --mirror origin',
  'git push --fo origin main',
  'git push --for origin main',
  'git push --forc origin main',
  'git commit -F - <<\'EOF\'\ngit push --force\nEOF\ngit push -f',
  'cat <<EOF\ntext\nEOF\ngit push -f',
  'echo "$(git push -f)"',
  'echo $((1 << 2))\ngit push -f',
  'echo ✅ && git push -f',
]

const accepted = [
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main',
  'git push origin main',
  'git status',
  'git fetch -f && git push origin main',
  'git push -o +foo origin main',
  'git push -o+foo -v origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=dev:' + 'a'.repeat(40) + ' origin main dev',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main 2>&1 | tail -3',
  'git commit -m "fix; git push -f later"',
  'gh pr create --body "rebase && git push --force is refused"',
  'git commit -F - <<\'EOF\'\nsubject\n\ngit push --force\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nsay \\"why; git push -f is refused\nEOF\n)"',
  'git push origin main # --force',
  'git push --force-with-lease=main:deadbeef origin main',
]

test('every forced form the orchestrator refuses is read as one', () => {
  for (const c of refused) expect(forces(c), c).not.toEqual([])
})

test('everything the orchestrator accepts is read as no force', () => {
  for (const c of accepted) expect(forces(c), c).toEqual([])
})

test('each simple command comes back as its argv, quotes removed, wrappers and assignments skipped', () => {
  expect(simpleCommands('git commit -m "fix: x" && gh pr create --title \'t\'')).toEqual([
    ['git', 'commit', '-m', 'fix: x'],
    ['gh', 'pr', 'create', '--title', 't'],
  ])
  expect(simpleCommands('env GIT_DIR=x git commit')).toEqual([['git', 'commit']])
  expect(simpleCommands('FOO=1 timeout 60 nice -n 5 gh pr comment 3 -b hi')).toEqual([['gh', 'pr', 'comment', '3', '-b', 'hi']])
  expect(simpleCommands('cat <<EOF\ngh pr create\nEOF')).toEqual([['cat']])
  expect(simpleCommands('echo "git commit" # gh pr create')).toEqual([['echo', 'git commit']])
  expect(simpleCommands('')).toEqual([])
})

test('git\'s valued global options are skipped to its subcommand', () => {
  expect(gitSubcommand(['git', '-C', '/r', '-c', 'user.name=x', 'commit'])).toEqual({ at: 5 })
  expect(gitSubcommand(['/usr/bin/git', '--no-pager', 'log'])).toEqual({ at: 2 })
  expect(gitSubcommand(['git', '-C', '/r'])).toBeUndefined()
  expect(gitSubcommand(['gh', 'pr', 'create'])).toBeUndefined()
})

test('the argument of bash -c, sh -c and zsh -c is read again, one level deep', () => {
  expect(simpleCommands('bash -c \'gh pr create --title t\'')).toEqual([
    ['bash', '-c', 'gh pr create --title t'],
    ['gh', 'pr', 'create', '--title', 't'],
  ])
  expect(simpleCommands('sh -c "git commit -m x"')).toContainEqual(['git', 'commit', '-m', 'x'])
  expect(simpleCommands('/bin/zsh -lc "git commit -m x"')).toContainEqual(['git', 'commit', '-m', 'x'])
  expect(forces('bash -c "git push -f"')).toEqual(['-f'])
  // One level only: the inner shell's own -c argument stays a word.
  expect(simpleCommands('bash -c "sh -c \'git commit\'"')).toEqual([
    ['bash', '-c', 'sh -c \'git commit\''],
    ['sh', '-c', 'git commit'],
  ])
  // A -c that is an argument of another command is no shell's.
  expect(simpleCommands('git -c x=y commit')).toEqual([['git', '-c', 'x=y', 'commit']])
  expect(simpleCommands('bash script.sh -c "git commit"')).toEqual([['bash', 'script.sh', '-c', 'git commit']])
})

test('the option a shell\'s -o or -O sets is no command line, the -c argument after it is', () => {
  expect(simpleCommands('bash -o pipefail -c \'git commit -m x\'')).toEqual([
    ['bash', '-o', 'pipefail', '-c', 'git commit -m x'],
    ['git', 'commit', '-m', 'x'],
  ])
  expect(simpleCommands('bash -O extglob -c "gh pr create"')).toContainEqual(['gh', 'pr', 'create'])
  expect(simpleCommands('bash -euo pipefail -c "git commit -m x"')).toContainEqual(['git', 'commit', '-m', 'x'])
})

test('the engine\'s valued global options are skipped to its subcommand', () => {
  for (const line of [
    'python3 "$GH" --repo o/r pr-merge 5',
    'python3 "$GH" -R o/r pr-merge 5',
    'python3 "$GH" --format raw --repo o/r pr-merge 5',
    'python3 /p/engine/gh.py --repo o/r pr-merge 5',
  ]) {
    const call = engineCall(simpleCommands(line)[0])
    expect(call?.command, line).toBe('pr-merge')
    expect(call?.positionals, line).toEqual(['5'])
    expect(call?.repo, line).toBe('o/r')
  }
})

test('the values of python\'s -W and -X are no script', () => {
  for (const line of ['python3 -W ignore engine/gh.py pr-merge 5', 'python3 -X dev -W error /p/engine/gh.py pr-merge 5']) {
    expect(engineCall(simpleCommands(line)[0])?.command, line).toBe('pr-merge')
  }
  expect(engineCall(simpleCommands('python3 -W ignore script.py pr-merge 5')[0])).toBeUndefined()
})

test('--stdin-json is a stdin call only when it is the sole engine argument', () => {
  expect(engineCall(simpleCommands('python3 engine/gh.py --stdin-json')[0])).toBeUndefined()
  for (const line of [
    'python3 engine/gh.py --repo o/r label-add 12 Ready -- --stdin-json',
    'python3 engine/gh.py label-add 12 Ready --stdin-json',
  ]) {
    const call = engineCall(simpleCommands(line)[0])
    expect(call?.command, line).toBe('label-add')
    expect(call?.positionals.slice(0, 2), line).toEqual(['12', 'Ready'])
  }
})
