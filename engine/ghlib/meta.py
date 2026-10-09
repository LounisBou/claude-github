"""Pull request metadata: title, body, base, state, labels, people."""

from urllib.parse import quote

from . import bodies, errors, http, repo

_READY = """
mutation($id:ID!) {
  markPullRequestReadyForReview(input:{pullRequestId:$id}) {
    pullRequest { number isDraft }
  }
}
"""


def pr_update(args):
    owner, name = repo.owner_repo()
    payload = {}
    if args.title:
        payload["title"] = args.title
    if args.body_file:
        payload["body"] = bodies.read(args.body_file)
    if args.base:
        payload["base"] = args.base
    if args.state:
        payload["state"] = args.state
    if not payload:
        raise errors.UsageError("pr-update needs at least one of --title/--body-file/--base/--state")
    return http.rest("PATCH", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr), payload)


def pr_ready(args):
    owner, name = repo.owner_repo()
    pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
    # A fixture or a malformed API response can hand back a pull request with
    # no node_id. An unguarded pull["node_id"] would raise KeyError past the
    # error mapping and surface as a traceback instead of a mapped exit.
    node_id = pull.get("node_id")
    if not node_id:
        raise errors.ApiError("pull request %s has no node_id" % args.pr)
    return http.graphql(_READY, {"id": node_id})


def label_add(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "POST", "/repos/%s/%s/issues/%s/labels" % (owner, name, args.pr), {"labels": args.names}
    )


def label_remove(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "DELETE",
        "/repos/%s/%s/issues/%s/labels/%s" % (owner, name, args.pr, quote(args.name, safe="")),
    )


def reviewer_add(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "POST",
        "/repos/%s/%s/pulls/%s/requested_reviewers" % (owner, name, args.pr),
        {"reviewers": args.names},
    )


def reviewer_remove(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "DELETE",
        "/repos/%s/%s/pulls/%s/requested_reviewers" % (owner, name, args.pr),
        {"reviewers": args.names},
    )


def assignee_add(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "POST", "/repos/%s/%s/issues/%s/assignees" % (owner, name, args.pr), {"assignees": args.names}
    )


def assignee_remove(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "DELETE",
        "/repos/%s/%s/issues/%s/assignees" % (owner, name, args.pr),
        {"assignees": args.names},
    )


def register(subparsers):
    parser = subparsers.add_parser("pr-update", help="change title, body, base or state")
    parser.add_argument("pr", type=int)
    parser.add_argument("--title", default=None)
    parser.add_argument("--body-file", dest="body_file", default=None)
    parser.add_argument("--base", default=None)
    parser.add_argument("--state", default=None, choices=("open", "closed"))
    parser.set_defaults(handler=pr_update)

    parser = subparsers.add_parser("pr-ready", help="mark a draft PR ready for review")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_ready)

    parser = subparsers.add_parser("label-remove")
    parser.add_argument("pr", type=int)
    parser.add_argument("name", help="a single label; GitHub deletes one per call")
    parser.set_defaults(handler=label_remove)

    for cmd, handler in (
        ("label-add", label_add),
        ("reviewer-add", reviewer_add),
        ("reviewer-remove", reviewer_remove),
        ("assignee-add", assignee_add),
        ("assignee-remove", assignee_remove),
    ):
        parser = subparsers.add_parser(cmd)
        parser.add_argument("pr", type=int)
        parser.add_argument("names", nargs="+")
        parser.set_defaults(handler=handler)
