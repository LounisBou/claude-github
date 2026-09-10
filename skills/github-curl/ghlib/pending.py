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


def review_pending(args):
    owner, name = repo.owner_repo()
    login = args.author or _token_login()
    review = _pending_review(owner, name, args.pr, login)
    comments = _review_comments(owner, name, args.pr, review["id"]) if review else []
    return {"login": login, "review": review, "comments": comments}


def register(subparsers):
    parser = subparsers.add_parser("review-pending", help="a user's PENDING review on a PR, with its comments")
    parser.add_argument("pr", type=int)
    parser.add_argument("--author", default=None, help="login (default: the token's user)")
    parser.set_defaults(handler=review_pending)
