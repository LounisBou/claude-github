#!/usr/bin/env python3
"""The former entry point, kept so callers that resolve this path still work.

Plugins written against earlier releases run skills/github-curl/gh.py. The
engine now lives in engine/gh.py, and this file runs it unchanged: same
arguments, same output, same exit codes.
"""

import os
import runpy

runpy.run_path(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine", "gh.py"),
    run_name="__main__",
)
