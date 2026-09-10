"""REST and GraphQL transport.

When GH_FIXTURES is set, responses are read from that directory and no socket
is opened, which is what lets the suite run offline.
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.request

from . import errors

API = "https://api.github.com"
_MAX_RETRIES = 3


def token():
    tok = os.environ.get("GH_TOKEN")
    if not tok:
        try:
            tok = subprocess.run(
                ["gh", "auth", "token"], capture_output=True, text=True, check=False
            ).stdout.strip()
        except OSError:
            tok = ""
    if not tok:
        raise errors.AuthError("no GitHub token; run: gh auth login")
    return tok


def _slug(method, path):
    # The path's own leading "/" becomes a leading "_" once slashes are
    # replaced; strip that before joining with "METHOD_" so the separator
    # between method and path is a single underscore, not two.
    body = path.replace("/", "_").replace("?", "__").lstrip("_")
    return method + "_" + body


def _record(payload):
    dirname = os.environ.get("GH_FIXTURES")
    if not dirname:
        return
    with open(os.path.join(dirname, "sent.jsonl"), "a") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def _fixture(slug):
    dirname = os.environ["GH_FIXTURES"]
    try:
        with open(os.path.join(dirname, slug + ".json")) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def _raise_for(status, data):
    # .get substitutes the default only for an absent key; GitHub sends
    # "message": null on some error responses, and a present-but-null value
    # would still reach message.lower() below and raise.
    message = (data.get("message") or "request failed") if isinstance(data, dict) else "request failed"
    if status == 429 or (status in (401, 403) and "rate limit" in message.lower()):
        raise errors.RateLimited(message)
    if status in (401, 403):
        raise errors.AuthError(message)
    if status == 404:
        raise errors.NotFound(message)
    raise errors.ApiError("%s (HTTP %s)" % (message, status))


def _request(method, url, body, headers):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode()
            if not raw:
                return resp.status, {}
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                # Not every endpoint answers in JSON: the diff and patch media
                # types return plain text. Hand that body back as a string
                # instead of failing to parse it as an object.
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"message": raw[:200]}
        return exc.code, parsed


def _call(method, path, body=None, accept="application/vnd.github+json"):
    slug = _slug(method, path)
    _record({"method": method, "path": path, "body": body})

    if os.environ.get("GH_FIXTURES"):
        data = _fixture(slug)
        if data is None:
            return None
        if isinstance(data, dict) and "__status" in data:
            status = data.pop("__status")
            if status >= 400:
                _raise_for(status, data)
        return data

    headers = {
        "Authorization": "Bearer " + token(),
        "Accept": accept,
        "Content-Type": "application/json",
        "User-Agent": "pr-review-plugin",
    }
    for attempt in range(_MAX_RETRIES):
        status, data = _request(method, API + path, body, headers)
        if status in (403, 429) and attempt < _MAX_RETRIES - 1:
            time.sleep(2 ** attempt)
            continue
        # The last attempt falls through here, so the final response decides:
        # _raise_for maps a persistent 429 to RateLimited (exit 5). There is no
        # post-loop raise, because the loop cannot exhaust without returning or
        # raising, and a line that can never run is a lie about the control flow.
        if status >= 400:
            _raise_for(status, data)
        return data


def rest(method, path, body=None, paginate=False, accept="application/vnd.github+json"):
    if not paginate:
        result = _call(method, path, body, accept)
        return {} if result is None else result

    items = []
    page = 1
    size = int(os.environ.get("GH_PAGE_SIZE", "100"))
    while True:
        sep = "&" if "?" in path else "?"
        # per_page must travel on every request: GitHub's own default is 30,
        # not the value this loop compares chunk lengths against, so without
        # it a full-size first page still looks short and pagination silently
        # truncates.
        suffix = "%sper_page=%d" % (sep, size) if page == 1 else "%sper_page=%d&page=%d" % (sep, size, page)
        chunk = _call(method, path + suffix, body, accept)
        if not chunk:
            break
        items.extend(chunk)
        if len(chunk) < size:
            break
        page += 1
    return items


def graphql(query, variables):
    _record({"method": "POST", "path": "/graphql", "query": query, "variables": variables})
    if os.environ.get("GH_FIXTURES"):
        return _fixture("graphql") or {}
    headers = {
        "Authorization": "Bearer " + token(),
        "Content-Type": "application/json",
        "User-Agent": "pr-review-plugin",
    }
    status, data = _request(
        "POST", "https://api.github.com/graphql", {"query": query, "variables": variables}, headers
    )
    if status >= 400:
        _raise_for(status, data)
    if "errors" in data:
        raise errors.ApiError(data["errors"][0].get("message", "graphql error"))
    return data.get("data") or {}
