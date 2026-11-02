#!/usr/bin/env python3
"""Write one pull request record: a review, a norms check or an end-to-end run
at one head commit, as REFERENCE.md « Records » describes it.

The one writer of ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records/. Each record
is one JSON file under <owner>/<name>/<head>/, written under a temporary name
in that directory and then renamed, so a reader never sees half a file. It
prints the file's path, and exits 2 on a usage error with one error: line.
"""

import argparse
import datetime
import json
import os
import re
import sys
import tempfile

KINDS = ("review", "norms", "e2e")
RESULTS = ("pass", "fail", "waived")
DETAIL_MAX = 500
USAGE_EXIT = 2

_HEAD = re.compile(r"^[0-9a-fA-F]{40}$")
_PART = re.compile(r"^[A-Za-z0-9_.-]+$")
_PRODUCER = re.compile(r"^[a-z0-9-]+$")
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)

    def error(self, message):
        raise UsageError(message)


def build_parser():
    parser = _Parser(prog="record.py", description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--head", required=True, help="the full 40-hex head sha")
    parser.add_argument("--kind", required=True, choices=KINDS)
    parser.add_argument("--result", required=True, choices=RESULTS)
    parser.add_argument("--producer", required=True, help="the producer's slug, [a-z0-9-]")
    parser.add_argument("--detail", default="")
    parser.add_argument("--session", default=None, help="defaults to CLAUDE_CODE_SESSION_ID")
    return parser


def validate(args):
    """The record's fields, or a UsageError naming the first one wrong."""
    parts = args.repo.split("/")
    if len(parts) != 2 or not all(_PART.match(p) and p not in (".", "..") for p in parts):
        raise UsageError("--repo expects owner/name, got: " + args.repo)
    if args.pr < 1:
        raise UsageError("--pr expects a pull request number, got: %d" % args.pr)
    if not _HEAD.match(args.head):
        raise UsageError("--head must be the full 40-character sha, got: " + args.head)
    if not _PRODUCER.match(args.producer):
        raise UsageError("--producer must match [a-z0-9-]+, got: " + args.producer)
    if len(args.detail) > DETAIL_MAX:
        raise UsageError("--detail is %d characters, at most %d" % (len(args.detail), DETAIL_MAX))
    if args.result == "waived":
        if args.kind != "e2e":
            raise UsageError("only an e2e record can be waived")
        if not _DATE.search(args.detail):
            raise UsageError("a waiver needs a --detail carrying its date, YYYY-MM-DD")
    session = args.session if args.session is not None else os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    return {
        "v": 1,
        "repo": args.repo.lower(),
        "pr": args.pr,
        "head": args.head.lower(),
        "kind": args.kind,
        "result": args.result,
        "producer": args.producer,
        "detail": args.detail,
        "session": session,
        "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def records_root():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(config, "pr-records")


def write(record):
    """Write the record under its head's directory and return its path."""
    directory = os.path.join(records_root(), record["repo"], record["head"])
    os.makedirs(directory, exist_ok=True)
    stamp = record["at"].replace("-", "").replace(":", "")
    path = os.path.join(directory, "%s.%s.%s.json" % (record["kind"], stamp, record["producer"]))
    # A dot name: a reader listing the directory skips it until the rename.
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(record, fh, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return path


def main(argv):
    try:
        record = validate(build_parser().parse_args(argv))
    except UsageError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return USAGE_EXIT
    try:
        print(write(record))
    except OSError as exc:
        print("error: cannot write the record: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
