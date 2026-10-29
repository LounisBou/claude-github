"""Pull request metadata: title, body, base, state, labels, people."""

import sys
from urllib.parse import quote

from . import bodies, errors, fmt, http, repo

_READY = """
mutation($id:ID!) {
  markPullRequestReadyForReview(input:{pullRequestId:$id}) {
    pullRequest { number isDraft }
  }
}
"""

# The two readiness labels, with the names and colours the house uses.
READY = "Ready"
NOT_READY = "Not Ready"
_HOUSE_LABELS = ((READY, "27e760"), (NOT_READY, "8c1455"))
_STATES = {"ready": (READY, NOT_READY), "not-ready": (NOT_READY, READY)}


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
    result = http.graphql(_READY, {"id": node_id})
    follow_readiness(owner, name, args.pr, "ready")
    return result


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


def _ensure(owner, name):
    """Create the missing house labels. Returns the output lines and the name
    each house label carries on the repository (compared case-insensitively)."""
    existing = {}
    for label in http.rest("GET", "/repos/%s/%s/labels" % (owner, name), paginate=True):
        existing.setdefault(label["name"].lower(), label)
    lines = []
    names = {}
    for house_name, house_colour in _HOUSE_LABELS:
        found = existing.get(house_name.lower())
        if found:
            names[house_name] = found["name"]
            colour = (found.get("color") or "").lower()
            suffix = " #" + colour if colour and colour != house_colour else ""
            lines.append("present %s%s" % (found["name"], suffix))
        else:
            http.rest(
                "POST",
                "/repos/%s/%s/labels" % (owner, name),
                {"name": house_name, "color": house_colour},
            )
            names[house_name] = house_name
            lines.append("created %s" % house_name)
    return lines, names


def labels_ensure(args):
    owner, name = repo.owner_repo()
    return fmt.Lines("\n".join(_ensure(owner, name)[0]))


def _set_readiness(owner, name, pr, state):
    """Put the label the state names on the pull request and take the other off.
    Returns the lines created and whether anything changed."""
    wanted, other = _STATES[state]
    lines, names = _ensure(owner, name)
    created = [line for line in lines if line.startswith("created ")]
    carried = {
        label["name"].lower(): label["name"]
        for label in http.rest("GET", "/repos/%s/%s/issues/%s/labels" % (owner, name, pr), paginate=True)
    }
    changed = False
    if names[wanted].lower() not in carried:
        http.rest("POST", "/repos/%s/%s/issues/%s/labels" % (owner, name, pr), {"labels": [names[wanted]]})
        changed = True
    if names[other].lower() in carried:
        http.rest(
            "DELETE",
            "/repos/%s/%s/issues/%s/labels/%s" % (owner, name, pr, quote(carried[names[other].lower()], safe="")),
        )
        changed = True
    return created, changed


def pr_readiness(args):
    owner, name = repo.owner_repo()
    created, changed = _set_readiness(owner, name, args.pr, args.state)
    return fmt.Lines("\n".join(created + [args.state + ("" if changed else " (unchanged)")]))


def follow_readiness(owner, name, pr, state):
    """The labelling a pull request command does after its own work. A failure
    here never fails that command: it is printed on its own line on stderr. A
    network failure is an OSError, which http._request does not convert."""
    try:
        _set_readiness(owner, name, pr, state)
    except errors.GhError as exc:
        print("error: label %s on pull request %s failed: %s" % (state, pr, exc.message), file=sys.stderr)
    except OSError as exc:
        print("error: label %s on pull request %s failed: %s" % (state, pr, exc), file=sys.stderr)


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

    parser = subparsers.add_parser("labels-ensure", help="create the Ready and Not Ready labels when missing")
    parser.set_defaults(handler=labels_ensure)

    parser = subparsers.add_parser("pr-readiness", help="mark a PR Ready or Not Ready with its label")
    parser.add_argument("pr", type=int)
    parser.add_argument("state", choices=tuple(_STATES))
    parser.set_defaults(handler=pr_readiness)

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
