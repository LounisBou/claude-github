"""Build a gh.py argument vector from one JSON request read on stdin.

The mod sends {"command", "args", "repo"} instead of an argument vector, so
the mapping from names to positionals and flags lives here, next to the
parser it reads, and nothing outside the engine keeps a second copy of it.

Every value lands either as a positional after "--" or glued to its flag as
"--name=value", so no value can be read as an option. Text bodies and JSON
arrays are written to files in a private directory the caller removes.
"""

import argparse
import json
import os

from . import errors

# Names the mod has always used for positionals whose argparse dest differs.
_ALIASES = {
    "label": ("names", "name"),
    "user": ("names",),
    "term": ("terms",),
}

# Keys that name a file the engine reads: only this module writes them.
_MANAGED = ("body-file", "body_file", "comments-file", "comments_file", "json_file", "json-file")


def _scalar(key, value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise errors.UsageError('"%s" takes a string or a number' % key)
    return str(value)


def _write(tmpdir, name, text):
    path = os.path.join(tmpdir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return path


def _positional(sub, key):
    by_dest = {a.dest: a for a in sub._actions if not a.option_strings}
    if key in by_dest:
        return by_dest[key]
    for dest in _ALIASES.get(key, ()):
        if dest in by_dest:
            return by_dest[dest]
    return None


def _option(sub, key):
    wanted = "--" + key
    for action in sub._actions:
        if wanted in action.option_strings:
            return action
    return None


def build_argv(parser, request, tmpdir):
    if not isinstance(request, dict):
        raise errors.UsageError("stdin must hold a JSON object")
    command = request.get("command")
    args = request.get("args") or {}
    repo = request.get("repo")
    subs = [a for a in parser._actions if a.dest == "command"][0].choices
    if command not in subs:
        raise errors.UsageError("unknown command: %s" % command)
    if not isinstance(args, dict):
        raise errors.UsageError('"args" must be an object')
    sub = subs[command]

    flags = []
    values = {}
    for key, value in args.items():
        if value is None:
            continue
        if key in _MANAGED:
            raise errors.UsageError('"%s" is managed by the engine; pass body, comments or nodes' % key)
        if key == "body":
            if not isinstance(value, str):
                raise errors.UsageError("body must be a string")
            if _option(sub, "body-file") is None:
                raise errors.UsageError("%s takes no body" % command)
            flags.append("--body-file=" + _write(tmpdir, "body.md", value))
        elif key == "comments":
            if not isinstance(value, list):
                raise errors.UsageError("comments must be an array")
            if _option(sub, "comments-file") is None:
                raise errors.UsageError("%s takes no comments" % command)
            flags.append("--comments-file=" + _write(tmpdir, "comments.json", json.dumps(value)))
        elif key == "nodes" and _positional(sub, "json_file") is not None:
            if not isinstance(value, list):
                raise errors.UsageError("nodes must be an array")
            values["json_file"] = [_write(tmpdir, "nodes.json", json.dumps(value))]
        elif _positional(sub, key) is not None:
            action = _positional(sub, key)
            if action.nargs in ("+", "*"):
                items = value if isinstance(value, list) else [value]
                values[action.dest] = [_scalar(key, v) for v in items]
            elif isinstance(value, list):
                raise errors.UsageError('"%s" takes a single value, not an array' % key)
            else:
                values[action.dest] = [_scalar(key, value)]
        elif _option(sub, key) is not None and key != "help":
            action = _option(sub, key)
            if isinstance(action, argparse._StoreTrueAction):
                if not isinstance(value, bool):
                    raise errors.UsageError('"%s" takes true or false' % key)
                if value:
                    flags.append("--" + key)
            elif isinstance(action, argparse._AppendAction):
                items = value if isinstance(value, list) else [value]
                flags.extend("--%s=%s" % (key, _scalar(key, v)) for v in items)
            elif isinstance(value, list):
                raise errors.UsageError('"%s" takes a single value, not an array' % key)
            else:
                flags.append("--%s=%s" % (key, _scalar(key, value)))
        else:
            raise errors.UsageError('unknown argument "%s" for %s' % (key, command))

    positionals = []
    for action in sub._actions:
        if action.option_strings:
            continue
        got = values.get(action.dest)
        if not got:
            raise errors.UsageError('missing argument "%s" for %s' % (action.dest, command))
        positionals.extend(got)

    argv = [command] + flags
    if repo is not None:
        argv.append("--repo=" + _scalar("repo", repo))
    # "--" with nothing after it is itself refused by argparse.
    return argv + (["--"] + positionals if positionals else [])
