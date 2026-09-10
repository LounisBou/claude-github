"""Issues and cross-repository search."""

from urllib.parse import quote

from . import http, repo

_LINKED = """
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      closingIssuesReferences(first:20) { nodes { number title url } }
    }
  }
}
"""


def issue_view(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/issues/%s" % (owner, name, args.number))


def issue_list(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "GET", "/repos/%s/%s/issues?state=%s" % (owner, name, args.state), paginate=True
    )


def issue_search(args):
    # Percent-encode the whole query. Replacing spaces with "+" leaves every
    # other reserved character raw, and the failure is silent: "C#" truncates
    # at the fragment marker and searches for "C", while "foo&bar" injects a
    # second query parameter. A wrong search result looks like an answer.
    query = "repo:%s %s" % (repo.nwo(), " ".join(args.terms))
    return http.rest("GET", "/search/issues?q=" + quote(query, safe=""))


def pr_linked_issues(args):
    owner, name = repo.owner_repo()
    data = http.graphql(_LINKED, {"owner": owner, "name": name, "number": int(args.pr)})
    return (
        ((data.get("repository") or {}).get("pullRequest") or {})
        .get("closingIssuesReferences") or {}
    )


def register(subparsers):
    parser = subparsers.add_parser("issue-view")
    parser.add_argument("number", type=int)
    parser.set_defaults(handler=issue_view)

    parser = subparsers.add_parser("issue-list")
    parser.add_argument("--state", default="open", choices=("open", "closed", "all"))
    parser.set_defaults(handler=issue_list)

    parser = subparsers.add_parser("issue-search")
    parser.add_argument("terms", nargs="+")
    parser.set_defaults(handler=issue_search)

    parser = subparsers.add_parser("pr-linked-issues")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_linked_issues)
