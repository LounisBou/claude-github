"""Pull request reads, plus opening and merging one."""

import base64
import binascii
import subprocess
from urllib.parse import quote

from . import bodies, errors, http, repo


def _current_branch():
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, check=False
    ).stdout.strip()


def auth_check(args):
    return http.rest("GET", "/user")


def pr_get(args):
    owner, name = repo.owner_repo()
    branch = args.branch or _current_branch()
    if not branch:
        raise errors.UsageError("cannot determine the branch; pass --branch")
    return http.rest(
        "GET", "/repos/%s/%s/pulls?head=%s:%s" % (owner, name, owner, quote(branch, safe=""))
    )


def pr_list(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls?state=open" % (owner, name), paginate=True)


def pr_status(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))


def pr_checks(args):
    owner, name = repo.owner_repo()
    pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
    sha = (pull.get("head") or {}).get("sha", "")
    statuses = http.rest("GET", "/repos/%s/%s/commits/%s/status" % (owner, name, sha))
    runs = http.rest("GET", "/repos/%s/%s/commits/%s/check-runs" % (owner, name, sha))
    return {"statuses": statuses, "check_runs": runs.get("check_runs", [])}


def pr_diff(args):
    owner, name = repo.owner_repo()
    result = http.rest(
        "GET",
        "/repos/%s/%s/pulls/%s" % (owner, name, args.pr),
        accept="application/vnd.github.v3.diff",
    )
    # A diff media type always answers in plain text. Anything else means the
    # response was not what was asked for, and an empty diff would read as
    # "no changes" rather than as a failure.
    if not isinstance(result, str):
        raise errors.ApiError("expected a plain-text diff, got %s" % type(result).__name__)
    return {"diff": result}


def pr_files(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls/%s/files" % (owner, name, args.pr), paginate=True)


def pr_commits(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls/%s/commits" % (owner, name, args.pr), paginate=True)


def file_at_ref(args):
    owner, name = repo.owner_repo()
    data = http.rest(
        "GET",
        "/repos/%s/%s/contents/%s?ref=%s"
        % (owner, name, quote(args.path, safe="/"), quote(args.ref, safe="")),
    )
    # A directory path makes this endpoint answer with a JSON array, not an object.
    if not isinstance(data, dict):
        raise errors.UsageError("%s is a directory, not a file" % args.path)

    raw = data.get("content") or ""
    binary = False
    if data.get("encoding") == "base64":
        try:
            payload = base64.b64decode(raw)
        except (ValueError, binascii.Error) as exc:
            raise errors.ApiError("cannot decode %s: %s" % (args.path, exc))
        try:
            raw = payload.decode("utf-8")
        except UnicodeDecodeError:
            # Do not decode with "replace": that turns a binary file into
            # replacement characters, exits 0 and looks like a successful read
            # while the content is destroyed. Hand back the base64 and say so.
            raw = base64.b64encode(payload).decode("ascii")
            binary = True
    return {"path": args.path, "ref": args.ref, "content": raw, "binary": binary}


def pr_create(args):
    owner, name = repo.owner_repo()
    payload = {
        "title": args.title,
        "head": args.head or _current_branch(),
        "base": args.base,
        "body": bodies.read(args.body_file) if args.body_file else "",
    }
    if not payload["head"]:
        raise errors.UsageError("cannot determine the head branch; pass --head")
    return http.rest("POST", "/repos/%s/%s/pulls" % (owner, name), payload)


def pr_merge(args):
    owner, name = repo.owner_repo()
    return http.rest(
        "PUT",
        "/repos/%s/%s/pulls/%s/merge" % (owner, name, args.pr),
        {"merge_method": args.method},
    )


def register(subparsers):
    parser = subparsers.add_parser("auth-check", help="verify the token works")
    parser.set_defaults(handler=auth_check)

    parser = subparsers.add_parser("pr-get", help="get the PR for a branch")
    parser.add_argument("--branch", default=None, help="defaults to the current branch")
    parser.set_defaults(handler=pr_get)

    parser = subparsers.add_parser("pr-list", help="list open PRs")
    parser.set_defaults(handler=pr_list)

    parser = subparsers.add_parser("pr-status", help="get PR state")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_status)

    parser = subparsers.add_parser("pr-checks", help="combined status and check runs")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_checks)

    for cmd, handler in (("pr-diff", pr_diff), ("pr-files", pr_files), ("pr-commits", pr_commits)):
        parser = subparsers.add_parser(cmd)
        parser.add_argument("pr", type=int)
        parser.set_defaults(handler=handler)

    parser = subparsers.add_parser("file-at-ref", help="read a file at a ref")
    parser.add_argument("path")
    parser.add_argument("ref")
    parser.set_defaults(handler=file_at_ref)

    parser = subparsers.add_parser("pr-create", help="open a PR from the current branch")
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", dest="body_file", default=None)
    parser.add_argument("--base", default="main")
    parser.add_argument("--head", default=None, help="defaults to the current branch")
    parser.set_defaults(handler=pr_create)

    parser = subparsers.add_parser("pr-merge", help="merge a PR")
    parser.add_argument("pr", type=int)
    parser.add_argument("--method", default="merge", choices=("merge", "squash", "rebase"))
    parser.set_defaults(handler=pr_merge)
