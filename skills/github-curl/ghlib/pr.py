"""Pull request reads, plus opening and merging one."""

import base64
import binascii
import os
import re
import subprocess
import time
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
    if args.draft:
        payload["draft"] = True
    return http.rest("POST", "/repos/%s/%s/pulls" % (owner, name), payload)


_MERGE_POLL = 3
_FULL_SHA = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


def pr_merge(args):
    owner, name = repo.owner_repo()
    payload = {"merge_method": args.method}
    if args.sha:
        # A short or malformed sha would come back from GitHub as a moved head,
        # which reads as a race rather than as a typo.
        if not _FULL_SHA.match(args.sha):
            raise errors.UsageError("--sha must be the full 40-character head sha")
        payload["sha"] = args.sha
    try:
        return http.rest("PUT", "/repos/%s/%s/pulls/%s/merge" % (owner, name, args.pr), payload)
    except errors.AuthError as exc:
        # GitHub answers 403 for a PR that is part of a stack and names the
        # asynchronous endpoint. That refusal is the only one followed: any
        # other 403 is a real refusal and surfaces as it is.
        if not _is_stacked_refusal(exc):
            raise
    return _merge_async(owner, name, args.pr, payload)


def _is_stacked_refusal(exc):
    text = exc.message.lower()
    return "stacked" in text and "asynchronous merge" in text


def _merge_wait():
    raw = os.environ.get("GH_MERGE_WAIT", "60")
    try:
        seconds = float(raw)
    except ValueError:
        seconds = -1
    if seconds < 0:
        raise errors.UsageError("GH_MERGE_WAIT must be a number of seconds, got %r" % raw)
    return seconds


def _async_state(base, uuid):
    try:
        status = http.rest("GET", "%s/merge-async/%s" % (base, uuid))
    except errors.GhError:
        # The status read is a shortcut to an early failure, not the authority:
        # the PR's own merged_at decides, so a status that does not answer, or
        # answers with any error, leaves the wait to the PR and its timeout.
        return None
    return status.get("status") if isinstance(status, dict) else None


def _merge_async(owner, name, number, payload):
    wait = _merge_wait()
    base = "/repos/%s/%s/pulls/%s" % (owner, name, number)
    accepted = http.rest("PUT", base + "/merge-async", payload)
    details = accepted.get("details") if isinstance(accepted, dict) else None
    uuid = details.get("uuid") if isinstance(details, dict) else None
    if not uuid:
        raise errors.ApiError(
            "merge-async did not return a uuid under details; read the PR with pr-status %s" % number
        )

    deadline = time.monotonic() + wait
    while True:
        pull = http.rest("GET", base)
        if pull.get("merged_at"):
            return {
                "merged": True,
                "sha": pull.get("merge_commit_sha"),
                "message": "Pull Request merged asynchronously",
                "uuid": uuid,
            }
        if _async_state(base, uuid) == "failed":
            raise errors.ApiError("the asynchronous merge failed (uuid %s)" % uuid)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise errors.ApiError(
                "timed out after %g seconds without seeing PR %s merged (uuid %s); "
                "read it with pr-status %s" % (wait, number, uuid, number)
            )
        time.sleep(min(_MERGE_POLL, remaining))


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
    parser.add_argument("--draft", action="store_true", help="open as a draft (the house default)")
    parser.set_defaults(handler=pr_create)

    parser = subparsers.add_parser("pr-merge", help="merge a PR")
    parser.add_argument("pr", type=int)
    parser.add_argument("--method", default="merge", choices=("merge", "squash", "rebase"))
    parser.add_argument(
        "--sha", default=None, help="full head sha that was verified; the merge is refused if the head moved"
    )
    parser.set_defaults(handler=pr_merge)
