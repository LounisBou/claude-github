"""Read a text body from a file.

Bodies never travel as command-line arguments: multi-line markdown with
backticks, quotes and $VAR sequences does not survive shell quoting intact,
and that failure is silent -- the request succeeds with mangled text.
"""

from . import errors


def read(path):
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            content = fh.read()
    except OSError as exc:
        raise errors.UsageError("cannot read --body-file %s: %s" % (path, exc))
    if not content.strip():
        raise errors.UsageError("--body-file %s is empty" % path)
    return content
