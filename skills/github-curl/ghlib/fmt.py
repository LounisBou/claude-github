"""Turn an API response into the shape a skill wants to read."""

import json

from . import errors


def _first(obj):
    if isinstance(obj, list):
        return obj[0] if obj else None
    return obj


def _raw(obj):
    return json.dumps(obj, indent=2, sort_keys=True)


def _error_check(obj):
    if isinstance(obj, dict) and "message" in obj and "documentation_url" in obj:
        raise errors.ApiError(obj["message"])
    return ""


def _pr_number(obj):
    item = _first(obj)
    return str(item["number"]) if item and "number" in item else ""


def _pr_url(obj):
    item = _first(obj)
    return item.get("html_url", "") if item else ""


def _pr_merge_status(obj):
    item = _first(obj) or {}
    if item.get("merged"):
        return "merged"
    return "open" if item.get("state") == "open" else "closed"


def _checks_status(obj):
    # "statuses" is the combined-status API's own response: {"state": ...,
    # "statuses": [{"state": ..., "context": ...}, ...]}. Its inner list is
    # what legacy commit statuses (as opposed to check runs) actually live in.
    check_runs = obj.get("check_runs", [])
    commit_statuses = (obj.get("statuses") or {}).get("statuses") or []

    failed = [
        run.get("name", "?")
        for run in check_runs
        if run.get("conclusion") in ("failure", "timed_out", "cancelled")
    ] + [
        status.get("context", "?")
        for status in commit_statuses
        if status.get("state") in ("failure", "error")
    ]
    pending = [run for run in check_runs if run.get("status") != "completed"] + [
        status for status in commit_statuses if status.get("state") == "pending"
    ]
    if failed:
        result = "FAILURE"
    elif pending:
        result = "PENDING"
    else:
        result = "SUCCESS"
    return json.dumps({"result": result, "failed_checks": failed}, sort_keys=True)


def _threads(obj, resolved):
    items = obj if isinstance(obj, list) else obj.get("threads", [])
    return json.dumps([t for t in items if bool(t.get("isResolved")) is resolved], sort_keys=True)


def _thread_summary(obj):
    items = json.loads(_threads(obj, False))
    if not items:
        return "No open review threads."
    lines = ["| thread | file | line | author |", "|---|---|---|---|"]
    for thread in items:
        first = ((thread.get("comments") or {}).get("nodes") or [{}])[0]
        lines.append(
            "| %s | %s | %s | %s |"
            % (
                thread.get("id", "?"),
                thread.get("path", "?"),
                thread.get("line", "?"),
                (first.get("author") or {}).get("login", "?"),
            )
        )
    return "\n".join(lines)


def _resolve_status(obj):
    thread = (obj.get("resolveReviewThread") or {}).get("thread") or {}
    if thread.get("isResolved"):
        return "resolved"
    thread = (obj.get("unresolveReviewThread") or {}).get("thread") or {}
    if thread and not thread.get("isResolved"):
        return "unresolved"
    raise errors.ApiError("thread was not resolved")


def _issue_comments_summary(obj):
    if not isinstance(obj, list) or not obj:
        return "No issue comments."
    lines = ["| id | author | first line |", "|---|---|---|"]
    for comment in obj:
        body = (comment.get("body") or "").strip().splitlines()
        lines.append(
            "| %s | %s | %s |"
            % (
                comment.get("id", "?"),
                (comment.get("user") or {}).get("login", "?"),
                body[0][:60] if body else "",
            )
        )
    return "\n".join(lines)


def _pr_details(obj):
    item = _first(obj) or {}
    return json.dumps(
        {
            "number": item.get("number"),
            "title": item.get("title"),
            "state": item.get("state"),
            "draft": item.get("draft"),
            "head": (item.get("head") or {}).get("ref"),
            "base": (item.get("base") or {}).get("ref"),
            "url": item.get("html_url"),
        },
        sort_keys=True,
    )


_FORMATTERS = {
    "raw": _raw,
    "error-check": _error_check,
    "pr-number": _pr_number,
    "pr-url": _pr_url,
    "pr-merge-status": _pr_merge_status,
    "pr-details": _pr_details,
    "checks-status": _checks_status,
    "open-threads": lambda obj: _threads(obj, False),
    "resolved-threads": lambda obj: _threads(obj, True),
    "thread-summary": _thread_summary,
    "resolve-status": _resolve_status,
    "issue-comments-summary": _issue_comments_summary,
}


def render(name, obj):
    if obj is None:
        return ""
    handler = _FORMATTERS.get(name)
    if handler is None:
        raise errors.UsageError(
            "unknown --format %r; known: %s" % (name, ", ".join(sorted(_FORMATTERS)))
        )
    return handler(obj)
