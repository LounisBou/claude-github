// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

export const PANE_ID = 'github-prs'

// One entry per gh.py subcommand: the positional argument names, in order.
// A "name..." entry is variadic and takes an array. The tool's command enum
// is Object.keys(POSITIONALS) — there is no second list to keep in sync.
export const POSITIONALS: Record<string, string[]> = {
  'pr-get': [],
  'pr-list': [],
  'pr-status': ['pr'],
  'pr-checks': ['pr'],
  'pr-diff': ['pr'],
  'pr-files': ['pr'],
  'pr-commits': ['pr'],
  'file-at-ref': ['path', 'ref'],
  'pr-create': [],
  'pr-merge': ['pr'],
  'pr-threads': ['pr'],
  'pr-comments': ['pr'],
  'pr-issue-comments': ['pr'],
  'pr-reviews': ['pr'],
  'thread-reply': ['thread_id'],
  'pr-comment': ['pr'],
  'comment-edit': ['comment_id'],
  'comment-delete': ['comment_id'],
  'thread-resolve': ['thread_id'],
  'comment-resolve': ['node_id'],
  'comment-unresolve': ['node_id'],
  'comment-resolved': ['node_id'],
  'comments-resolved-batch': ['nodes'],
  'review-submit': ['pr'],
  'review-pending-create': ['pr'],
  'review-pending-add': ['pr'],
  'review-pending': ['pr'],
  'repo-review-comments': [],
  'pr-update': ['pr'],
  'pr-ready': ['pr'],
  'label-add': ['pr', 'label...'],
  'label-remove': ['pr', 'label'],
  'reviewer-add': ['pr', 'user...'],
  'reviewer-remove': ['pr', 'user...'],
  'assignee-add': ['pr', 'user...'],
  'assignee-remove': ['pr', 'user...'],
  'issue-view': ['number'],
  'issue-list': [],
  'issue-search': ['term...'],
  'pr-linked-issues': ['pr'],
  'image-upload': ['file...'],
  'auth-check': [],
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const root = $.plugin.root
    await $.tool.register({
      name: 'gh',
      description:
        'GitHub API: pull requests, review threads, comments, reviews, labels, '
        + 'issues, search, image uploads. Before first use, Read '
        + root + '/engine/REFERENCE.md for every subcommand. Before authoring any '
        + 'PR title, body, comment, review or commit message, Read '
        + root + '/engine/WRITING.md. Pass positionals by their documented name '
        + '(pr-checks: {"pr": 12}); other keys become --flags; text bodies go in "body".',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: Object.keys(POSITIONALS) },
          args: {
            type: 'object',
            description: 'subcommand arguments: positionals by name, flags as keys',
          },
          repo: { type: 'string', description: 'owner/name, overriding origin' },
        },
        required: ['command'],
      },
    })
    // Commands last: a taken name throws and would skip the rest of the hook.
    for (const spec of [
      { name: 'checks', description: 'CI status of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'threads', description: 'Open review threads of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'prs', description: 'Open the PR pane' },
    ]) {
      try {
        await $.command.register(spec)
      } catch {
        // Name already taken by another plugin; skip it.
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
