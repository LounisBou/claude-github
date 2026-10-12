// The github plugin's values in the session ($.state), read by its PR pane.

export type GithubPaneRow = {
  number: number
  title: string
  url: string
  draft: boolean
  // null when the PR was not looked up in detail, or the lookup failed.
  comments: number | null
  // SUCCESS, FAILURE or PENDING from checks-status; "?" when the checks could
  // not be read, "–" past the PRs looked up in detail.
  ci: string
  // The failed checks' names, when ci is FAILURE.
  failed: string[]
}

export type GithubPane = {
  rows: GithubPaneRow[]
  // The last read's error, shown under the rows from the last good read.
  error: string | null
  refreshing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    github: { pane: GithubPane }
  }
}
