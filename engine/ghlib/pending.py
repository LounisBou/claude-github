"""Reviews left PENDING: read one back, open one without submitting it, add a thread to it."""

import json

from . import bodies, errors, http, repo


def _token_login():
    return (http.rest("GET", "/user") or {}).get("login") or ""


def _pr(owner, name, pr):
    return http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, pr))


def _pending_review(owner, name, pr, login):
    reviews = http.rest("GET", "/repos/%s/%s/pulls/%s/reviews" % (owner, name, pr), paginate=True)
    for review in reviews:
        # A deleted account comes back as user: null; a PENDING review by
        # nobody matches no login and is skipped rather than raising.
        if review.get("state") == "PENDING" and (review.get("user") or {}).get("login") == login:
            return review
    return None


def _review_comments(owner, name, pr, review_id):
    return http.rest(
        "GET", "/repos/%s/%s/pulls/%s/reviews/%s/comments" % (owner, name, pr, review_id), paginate=True
    )


def _load_comments(path):
    try:
        with open(path, encoding="utf-8") as fh:
            comments = json.load(fh)
    except (OSError, ValueError) as exc:
        raise errors.UsageError("cannot read --comments-file: %s" % exc)
    if not isinstance(comments, list) or not comments:
        raise errors.UsageError("--comments-file must hold a non-empty JSON array of comment objects")
    for index, comment in enumerate(comments):
        if not isinstance(comment, dict):
            raise errors.UsageError("comment %d is not an object" % index)
        if not isinstance(comment.get("path"), str) or not comment["path"]:
            raise errors.UsageError("comment %d: path must be a non-empty string" % index)
        line = comment.get("line")
        if not isinstance(line, int) or isinstance(line, bool):
            raise errors.UsageError("comment %d: line must be an integer" % index)
        if not isinstance(comment.get("body"), str) or not comment["body"].strip():
            raise errors.UsageError("comment %d: body must be a non-empty string" % index)
        comment.setdefault("side", "RIGHT")
        if "start_line" in comment:
            start = comment["start_line"]
            if not isinstance(start, int) or isinstance(start, bool) or start >= line:
                raise errors.UsageError("comment %d: start_line must be an integer below line" % index)
            comment.setdefault("start_side", "RIGHT")
    return comments


def review_pending_create(args):
    owner, name = repo.owner_repo()
    comments = _load_comments(args.comments_file)
    existing = _pending_review(owner, name, args.pr, _token_login())
    if existing is not None:
        raise errors.UsageError(
            "a PENDING review already exists (id %s): add to it with review-pending-add" % existing.get("id")
        )
    head = ((_pr(owner, name, args.pr).get("head") or {}).get("sha")) or ""
    if not head:
        raise errors.ApiError("pull request %s has no head sha" % args.pr)
    # No "event" key: that is what leaves the review PENDING instead of
    # submitting it. Adding one here would publish the comments at once.
    payload = {"commit_id": head, "comments": comments}
    return http.rest("POST", "/repos/%s/%s/pulls/%s/reviews" % (owner, name, args.pr), payload)


_ADD_THREAD = """
mutation($review:ID!, $pr:ID!, $path:String!, $line:Int!, $side:DiffSide!,
         $startLine:Int, $startSide:DiffSide, $body:String!) {
  addPullRequestReviewThread(input:{pullRequestReviewId:$review, pullRequestId:$pr,
      path:$path, line:$line, side:$side, startLine:$startLine, startSide:$startSide,
      body:$body}) {
    thread { id comments(first:1) { nodes { id } } }
  }
}
"""


def review_pending_add(args):
    owner, name = repo.owner_repo()
    body = bodies.read(args.body_file)
    if args.start_line is not None and args.start_line >= args.line:
        raise errors.UsageError("--start-line must be below --line")
    review = http.rest("GET", "/repos/%s/%s/pulls/%s/reviews/%s" % (owner, name, args.pr, args.review_id))
    if not review or "id" not in review:
        raise errors.NotFound("review %s not found on pull request %s" % (args.review_id, args.pr))
    if review.get("state") != "PENDING":
        raise errors.UsageError("review %s is %s, not PENDING" % (args.review_id, review.get("state")))
    login = _token_login()
    author = (review.get("user") or {}).get("login")
    if author != login:
        raise errors.UsageError(
            "review %s belongs to %s, not to the token's user %s" % (args.review_id, author, login)
        )
    variables = {
        "review": review.get("node_id"),
        "pr": _pr(owner, name, args.pr).get("node_id"),
        "path": args.path,
        "line": args.line,
        "side": "RIGHT",
        "body": body,
    }
    if args.start_line is not None:
        variables["startLine"] = args.start_line
        variables["startSide"] = "RIGHT"
    return http.graphql(_ADD_THREAD, variables)


def review_pending(args):
    owner, name = repo.owner_repo()
    login = args.author or _token_login()
    review = _pending_review(owner, name, args.pr, login)
    comments = _review_comments(owner, name, args.pr, review["id"]) if review else []
    return {"login": login, "review": review, "comments": comments}


def repo_review_comments(args):
    owner, name = repo.owner_repo()
    # One page of the newest comments is enough to read a reviewer's habits;
    # walking every page of a large repository is not.
    comments = http.rest(
        "GET", "/repos/%s/%s/pulls/comments?sort=created&direction=desc&per_page=100" % (owner, name)
    )
    if not isinstance(comments, list):
        comments = []
    if args.author:
        comments = [c for c in comments if (c.get("user") or {}).get("login") == args.author]
    return comments[: args.limit]


def register(subparsers):
    parser = subparsers.add_parser("review-pending-create", help="open a review left PENDING, never submitted")
    parser.add_argument("pr", type=int)
    parser.add_argument(
        "--comments-file",
        dest="comments_file",
        required=True,
        help="JSON array of {path, line, body[, side, start_line, start_side]} objects",
    )
    parser.set_defaults(handler=review_pending_create)

    parser = subparsers.add_parser("review-pending-add", help="add an inline thread to a PENDING review")
    parser.add_argument("pr", type=int)
    parser.add_argument("--review-id", dest="review_id", type=int, required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--line", type=int, required=True)
    parser.add_argument("--start-line", dest="start_line", type=int, default=None)
    parser.add_argument("--body-file", dest="body_file", required=True)
    parser.set_defaults(handler=review_pending_add)

    parser = subparsers.add_parser("review-pending", help="a user's PENDING review on a PR, with its comments")
    parser.add_argument("pr", type=int)
    parser.add_argument("--author", default=None, help="login (default: the token's user)")
    parser.set_defaults(handler=review_pending)

    parser = subparsers.add_parser("repo-review-comments", help="the newest review comments of the repository")
    parser.add_argument("--author", default=None, help="keep only this login's comments")
    parser.add_argument("--limit", type=int, default=30)
    parser.set_defaults(handler=repo_review_comments)
