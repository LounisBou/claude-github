"""Resolve the owner/name the subcommands act on."""

import os
import re
import subprocess

from . import errors

_OVERRIDE = None
_PATTERN = re.compile(r"(?:git@github\.com:|https://github\.com/)([^/]+)/(.+?)(?:\.git)?$")


def set_override(value):
    global _OVERRIDE
    _OVERRIDE = value


def owner_repo():
    candidate = _OVERRIDE or os.environ.get("GH_REPO")
    if candidate:
        if "/" not in candidate:
            raise errors.UsageError("--repo expects owner/name, got: " + candidate)
        owner, name = candidate.split("/", 1)
        return owner, name

    url = subprocess.run(
        ["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=False
    ).stdout.strip()
    match = _PATTERN.search(url)
    if not match:
        raise errors.UsageError("no GitHub origin remote; pass --repo owner/name")
    return match.group(1), match.group(2)


def nwo():
    return "%s/%s" % owner_repo()
