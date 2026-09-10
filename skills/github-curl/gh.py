#!/usr/bin/env python3
"""GitHub API calls for the pr-review plugin.

Every text body is passed with --body-file, never as an argument, because
multi-line markdown containing backticks and quotes does not survive a shell
argument reliably.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ghlib import assets, comments, errors, fmt, issues, meta, pr, repo, reviews  # noqa: E402

_MODULES = (pr, comments, reviews, meta, issues, assets)


class _ArgumentParser(argparse.ArgumentParser):
    """Routes argparse's own usage failures through the same exit-code
    mapping as every other usage error, instead of argparse's own exit(2)."""

    def error(self, message):
        self.print_usage(sys.stderr)
        raise errors.UsageError(message)


def build_parser():
    parser = _ArgumentParser(prog="gh.py", description=__doc__)
    parser.add_argument("--repo", help="owner/name, overriding the origin remote")
    parser.add_argument("--format", default="raw", help="output formatter (default: raw)")
    subparsers = parser.add_subparsers(dest="command")
    for module in _MODULES:
        module.register(subparsers)
    # Accept the global flags after the subcommand as well, because
    # `gh.py pr-get --format pr-number` is the form every caller writes and the
    # form the skills document. SUPPRESS is what makes this safe: without it the
    # subparser would overwrite the parent's value with a second default
    # whenever the flag is omitted after the subcommand.
    for sub in subparsers.choices.values():
        sub.add_argument("--repo", default=argparse.SUPPRESS)
        sub.add_argument("--format", default=argparse.SUPPRESS)
    return parser


def main(argv):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if not args.command:
            parser.print_help(sys.stderr)
            return 1
        if args.repo:
            repo.set_override(args.repo)
        result = args.handler(args)
        rendered = fmt.render(args.format, result)
        if rendered:
            print(rendered)
        return 0
    except errors.GhError as exc:
        print("error: " + exc.message, file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
