"""Review threads and comments: reads, plus the resolve mutations."""

import json

from . import bodies, errors, http, repo

_THREADS_QUERY = """
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id isResolved isOutdated path line
          comments(first:50) { nodes { id body author { login } } }
        }
      }
    }
  }
}
"""


_RESOLVE = """
mutation($id:ID!) {
  resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } }
}
"""

_MINIMIZE = """
mutation($id:ID!) {
  minimizeComment(input:{subjectId:$id, classifier:RESOLVED}) {
    minimizedComment { isMinimized }
  }
}
"""

_UNMINIMIZE = """
mutation($id:ID!) {
  unminimizeComment(input:{subjectId:$id}) {
    unminimizedComment { isMinimized }
  }
}
"""

_MINIMIZED = """
query($id:ID!) { node(id:$id) { ... on IssueComment { isMinimized } } }
"""


def pr_threads(args):
    owner, name = repo.owner_repo()
    data = http.graphql(_THREADS_QUERY, {"owner": owner, "name": name, "number": int(args.pr)})
    nodes = (
        ((data.get("repository") or {}).get("pullRequest") or {})
        .get("reviewThreads") or {}
    ).get("nodes", [])
    return nodes


def pr_comments(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "GET", "/repos/%s/%s/pulls/%s/comments" % (owner, name, args.pr), paginate=True
    )


def pr_issue_comments(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "GET", "/repos/%s/%s/issues/%s/comments" % (owner, name, args.pr), paginate=True
    )


def pr_reviews(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "GET", "/repos/%s/%s/pulls/%s/reviews" % (owner, name, args.pr), paginate=True
    )


def comment_resolved(args):
    return http.graphql(_MINIMIZED, {"id": args.node_id})


def comments_resolved_batch(args):
    try:
        with open(args.json_file, encoding="utf-8") as fh:
            ids = json.load(fh)
    except (OSError, ValueError) as exc:
        raise errors.UsageError("cannot read %s: %s" % (args.json_file, exc))
    if not isinstance(ids, list):
        raise errors.UsageError("%s must hold a JSON array of node ids" % args.json_file)
    return {node_id: http.graphql(_MINIMIZED, {"id": node_id}) for node_id in ids}


def thread_resolve(args):
    return http.graphql(_RESOLVE, {"id": args.thread_id})


def comment_resolve(args):
    # An issue comment is minimised, not resolved: resolveReviewThread takes a
    # thread id and rejects a comment id. The read side already asks isMinimized,
    # so resolving through the thread mutation set a state nothing ever produced.
    return http.graphql(_MINIMIZE, {"id": args.node_id})


def comment_unresolve(args):
    return http.graphql(_UNMINIMIZE, {"id": args.node_id})


def thread_reply(args):
    body = bodies.read(args.body_file)
    return http.graphql(
        """
        mutation($id:ID!, $body:String!) {
          addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}) {
            comment { id url }
          }
        }
        """,
        {"id": args.thread_id, "body": body},
    )


def pr_comment(args):
    owner, name = repo.owner_repo()
    body = bodies.read(args.body_file)
    return http.rest(
        "POST", "/repos/%s/%s/issues/%s/comments" % (owner, name, args.pr), {"body": body}
    )


def comment_edit(args):
    owner, name = repo.owner_repo()
    body = bodies.read(args.body_file)
    return http.rest(
        "PATCH", "/repos/%s/%s/issues/comments/%s" % (owner, name, args.comment_id), {"body": body}
    )


def comment_delete(args):
    owner, name = repo.owner_repo()
    return http.rest("DELETE", "/repos/%s/%s/issues/comments/%s" % (owner, name, args.comment_id))


def register(subparsers):
    for cmd, handler, arg in (
        ("pr-threads", pr_threads, "pr"),
        ("pr-comments", pr_comments, "pr"),
        ("pr-issue-comments", pr_issue_comments, "pr"),
        ("pr-reviews", pr_reviews, "pr"),
        ("comment-resolved", comment_resolved, "node_id"),
        ("thread-resolve", thread_resolve, "thread_id"),
        ("comment-resolve", comment_resolve, "node_id"),
        ("comment-unresolve", comment_unresolve, "node_id"),
    ):
        parser = subparsers.add_parser(cmd)
        # A PR number is validated by argparse, which routes a bad value through
        # the overridden error() to a mapped usage exit instead of a traceback.
        parser.add_argument(arg, type=int if arg == "pr" else str)
        parser.set_defaults(handler=handler)

    parser = subparsers.add_parser("comments-resolved-batch")
    parser.add_argument("json_file", help="file holding a JSON array of node ids")
    parser.set_defaults(handler=comments_resolved_batch)

    parser = subparsers.add_parser("thread-reply", help="reply inside a review thread")
    parser.add_argument("thread_id")
    parser.add_argument("--body-file", dest="body_file", required=True)
    parser.set_defaults(handler=thread_reply)

    parser = subparsers.add_parser("pr-comment", help="post a general PR comment")
    parser.add_argument("pr", type=int)
    parser.add_argument("--body-file", dest="body_file", required=True)
    parser.set_defaults(handler=pr_comment)

    parser = subparsers.add_parser("comment-edit")
    parser.add_argument("comment_id")
    parser.add_argument("--body-file", dest="body_file", required=True)
    parser.set_defaults(handler=comment_edit)

    parser = subparsers.add_parser("comment-delete")
    parser.add_argument("comment_id")
    parser.set_defaults(handler=comment_delete)
