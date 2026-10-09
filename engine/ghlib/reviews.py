"""Submit a review, optionally with inline comments."""

import json

from . import bodies, errors, http, repo


def review_submit(args):
    owner, name = repo.owner_repo()
    payload = {"event": args.event}
    if args.body_file:
        payload["body"] = bodies.read(args.body_file)
    if args.comments_file:
        try:
            with open(args.comments_file, encoding="utf-8") as fh:
                comments = json.load(fh)
        except (OSError, ValueError) as exc:
            raise errors.UsageError("cannot read --comments-file: %s" % exc)
        if not isinstance(comments, list):
            raise errors.UsageError("--comments-file must hold a JSON array of comment objects")
        payload["comments"] = comments
    if args.event != "APPROVE" and "body" not in payload and "comments" not in payload:
        raise errors.UsageError("a %s review needs --body-file or --comments-file" % args.event)
    return http.rest("POST", "/repos/%s/%s/pulls/%s/reviews" % (owner, name, args.pr), payload)


def register(subparsers):
    parser = subparsers.add_parser("review-submit", help="submit a review")
    parser.add_argument("pr", type=int)
    parser.add_argument("--event", required=True, choices=("COMMENT", "APPROVE", "REQUEST_CHANGES"))
    parser.add_argument("--body-file", dest="body_file", default=None)
    parser.add_argument(
        "--comments-file",
        dest="comments_file",
        default=None,
        help="JSON array of {path, line, side, body} objects",
    )
    parser.set_defaults(handler=review_submit)
