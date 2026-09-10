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


def review_pending(args):
    owner, name = repo.owner_repo()
    login = args.author or _token_login()
    review = _pending_review(owner, name, args.pr, login)
    comments = _review_comments(owner, name, args.pr, review["id"]) if review else []
    return {"login": login, "review": review, "comments": comments}


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

    parser = subparsers.add_parser("review-pending", help="a user's PENDING review on a PR, with its comments")
    parser.add_argument("pr", type=int)
    parser.add_argument("--author", default=None, help="login (default: the token's user)")
    parser.set_defaults(handler=review_pending)
