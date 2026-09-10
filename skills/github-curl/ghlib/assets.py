"""Store an image in the repository and return a URL that renders in a PR.

The GitHub web upload endpoint would produce a user-attachments URL, but it is
authenticated by browser session cookies rather than by a scoped token, so it
is deliberately not used here.
"""

import base64
import hashlib
import os

from . import errors, http, repo


def _blob_name(path):
    try:
        with open(path, "rb") as fh:
            payload = fh.read()
    except OSError as exc:
        raise errors.UsageError("cannot read image file: %s (%s)" % (path, exc))
    if not payload:
        raise errors.UsageError("image file is empty: " + path)
    digest = hashlib.sha256(payload).hexdigest()
    ext = os.path.splitext(path)[1].lower() or ".bin"
    return digest + ext, payload


def _ensure_branch(owner, name, branch):
    try:
        http.rest("GET", "/repos/%s/%s/git/ref/heads/%s" % (owner, name, branch))
        return
    except errors.NotFound:
        pass
    default = (http.rest("GET", "/repos/%s/%s" % (owner, name)) or {}).get("default_branch", "main")
    head = http.rest("GET", "/repos/%s/%s/git/ref/heads/%s" % (owner, name, default))
    sha = (head.get("object") or {}).get("sha")
    http.rest(
        "POST",
        "/repos/%s/%s/git/refs" % (owner, name),
        {"ref": "refs/heads/" + branch, "sha": sha},
    )


def image_upload(args):
    if not os.path.isfile(args.file):
        raise errors.UsageError("no such image file: " + args.file)
    owner, name = repo.owner_repo()
    blob, payload = _blob_name(args.file)
    branch = args.branch

    reused = False
    try:
        http.rest("GET", "/repos/%s/%s/contents/%s?ref=%s" % (owner, name, blob, branch))
        reused = True
    except errors.NotFound:
        _ensure_branch(owner, name, branch)
        http.rest(
            "PUT",
            "/repos/%s/%s/contents/%s" % (owner, name, blob),
            {
                "message": "Add review asset " + blob,
                "content": base64.b64encode(payload).decode(),
                "branch": branch,
            },
        )

    url = "https://raw.githubusercontent.com/%s/%s/%s/%s" % (owner, name, branch, blob)
    return {"url": url, "markdown": "![](%s)" % url, "path": blob, "reused": reused}


def register(subparsers):
    parser = subparsers.add_parser("image-upload", help="store an image and return its URL")
    parser.add_argument("file")
    parser.add_argument("--branch", default="pr-assets")
    parser.set_defaults(handler=image_upload)
