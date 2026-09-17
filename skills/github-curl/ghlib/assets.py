"""Store an image in the repository and return a URL that renders in a PR.

The GitHub web upload endpoint would produce a user-attachments URL, but it is
authenticated by browser session cookies rather than by a scoped token, so it
is deliberately not used here.
"""

import base64
import hashlib
import os

from . import errors, http, repo

MAX_TITLE_LENGTH = 60
BLOCK_SEPARATOR = "\n\n---\n\n"


def _clean_title(title):
    if title is None:
        return None
    stripped = title.strip()
    if not stripped or "\n" in stripped:
        raise errors.UsageError("image title must be a short, single-line label")
    if len(stripped) > MAX_TITLE_LENGTH:
        raise errors.UsageError(
            "image title is longer than %d characters: shorten it" % MAX_TITLE_LENGTH
        )
    return stripped


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


def _upload_one(owner, name, branch, path):
    if not os.path.isfile(path):
        raise errors.UsageError("no such image file: " + path)
    blob, payload = _blob_name(path)

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

    url = "https://github.com/%s/%s/blob/%s/%s?raw=true" % (owner, name, branch, blob)
    return url, blob, reused


def _block(url, title):
    if title:
        return "**%s**\n![%s](%s)" % (title, title, url)
    return "![](%s)" % url


def image_upload(args):
    files = args.file
    if args.title is not None and len(args.title) != len(files):
        raise errors.UsageError(
            "expected %d --title value(s), one per file, got %d" % (len(files), len(args.title))
        )
    titles = [_clean_title(t) for t in args.title] if args.title is not None else [None] * len(files)

    owner, name = repo.owner_repo()
    branch = args.branch

    if len(files) == 1:
        url, blob, reused = _upload_one(owner, name, branch, files[0])
        title = titles[0]
        result = {"url": url, "markdown": _block(url, title), "path": blob, "reused": reused}
        if title:
            result["title"] = title
        return result

    images = []
    blocks = []
    for path, title in zip(files, titles):
        url, blob, reused = _upload_one(owner, name, branch, path)
        entry = {"url": url, "path": blob, "reused": reused}
        if title:
            entry["title"] = title
        images.append(entry)
        blocks.append(_block(url, title))
    return {"images": images, "markdown": BLOCK_SEPARATOR.join(blocks)}


def register(subparsers):
    parser = subparsers.add_parser("image-upload", help="store one or more images and return their URLs")
    parser.add_argument("file", nargs="+")
    parser.add_argument("--branch", default="pr-assets")
    parser.add_argument(
        "--title",
        action="append",
        help="short label (max %d characters) shown above its image; repeat once per file"
        % MAX_TITLE_LENGTH,
    )
    parser.set_defaults(handler=image_upload)
