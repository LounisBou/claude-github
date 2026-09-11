#!/bin/bash
# Test suite. No network, no plugin installation, isolated HOME per case.
#
# Each case runs a script against a temporary state directory or a temporary
# HOME and compares its output or its side effects with an expected value.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# check <name> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$1"
    printf '       expected: %s\n' "$(printf '%s' "$2" | tr '\n' '⏎')"
    printf '       actual:   %s\n' "$(printf '%s' "$3" | tr '\n' '⏎')"
    fail=$((fail + 1))
  fi
}

# check_status <name> <expected-exit-code> <command...>
check_status() {
  local name="$1" expected="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local code=$?
  check "$name" "exit $expected" "exit $code"
}

echo "== manifests =="

check "plugin name" "github" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$ROOT/.claude-plugin/plugin.json")"

check "plugin license" "MIT" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["license"])' "$ROOT/.claude-plugin/plugin.json")"

check "marketplace lists the plugin" "github" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"][0]["name"])' "$ROOT/.claude-plugin/marketplace.json")"

# The product name belongs only in load-bearing identifiers: host paths, host
# environment variables, the plugin name and the manifest directory.

echo "== preflight: system tools =="

# A PATH containing none of the required tools.
mkdir -p "$WORK/emptybin"
check_status "missing python3 exits 11" 11 \
  env PATH="$WORK/emptybin" HOME="$WORK" /bin/bash "$ROOT/scripts/preflight.sh"

# Not a git repository at all.
mkdir -p "$WORK/norepo"
check_status "not a git repo exits 13" 13 \
  env HOME="$WORK" sh -c "cd '$WORK/norepo' && /bin/bash '$ROOT/scripts/preflight.sh'"

# A git repository whose origin is not GitHub.
mkdir -p "$WORK/gitlab" && git -C "$WORK/gitlab" init -q -b main
git -C "$WORK/gitlab" remote add origin https://gitlab.com/acme/thing.git
check_status "non-github origin exits 13" 13 \
  env HOME="$WORK" sh -c "cd '$WORK/gitlab' && /bin/bash '$ROOT/scripts/preflight.sh'"

# The failure message names the remedy.
msg=$(env PATH="$WORK/emptybin" HOME="$WORK" /bin/bash "$ROOT/scripts/preflight.sh" 2>&1 >/dev/null | grep -c '^fix:')
check "failure prints a fix line" "1" "$msg"

echo "== preflight: GitHub token =="

mkdir -p "$WORK/repo" && git -C "$WORK/repo" init -q -b main
git -C "$WORK/repo" remote add origin https://github.com/acme/thing.git

# Missing token, missing gh
mkdir -p "$WORK/fakebin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/fakebin/gh"
chmod +x "$WORK/fakebin/gh"
check_status "missing token exits 12" 12 \
  env -u GH_TOKEN HOME="$WORK" PATH="$WORK/fakebin:$PATH" \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

# Token via environment variable
check_status "GH_TOKEN set exits 0" 0 \
  env HOME="$WORK" GH_TOKEN="dummy-token-12345" \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

echo "== preflight has no plugin dependency check =="

check "no enabledPlugins read" "" \
  "$(grep -o 'enabledPlugins' "$ROOT/scripts/preflight.sh" | head -1)"

# The brief's suggested pipeline for this ("grep -o 'exit 10\|\" 10$|10$' | grep -c
# '^10$' | grep -v '^0$'") never actually fires: grep -o's alternation prints the
# *matched text itself* ("exit 10", not "10"), so the follow-up "^10$" line-match
# never sees a bare "10" and the check reads "" whether or not exit 10 is present.
# This version matches the token "10" as an exit-code argument directly (bounded by
# non-digits so it can't be fooled by "11"/"110"/etc.) and reports the offending
# line so a failure is legible instead of just a bare mismatch.
check "no exit 10 in preflight.sh" "" \
  "$(grep -nE '(^|[^0-9])10([^0-9]|$)' "$ROOT/scripts/preflight.sh")"

# A settings file naming no plugins at all must not stop this plugin.
printf '{"enabledPlugins":{}}' > "$WORK/empty-settings.json"
mkdir -p "$WORK/ghrepo" && git -C "$WORK/ghrepo" init -q 2>/dev/null
git -C "$WORK/ghrepo" remote add origin https://github.com/o/n.git 2>/dev/null
check_status "no plugins enabled still exits 0" 0 \
  env HOME="$WORK" GH_TOKEN=x PR_REVIEW_SETTINGS="$WORK/empty-settings.json" \
  /bin/bash -c "cd '$WORK/ghrepo' && bash '$ROOT/scripts/preflight.sh'"

echo "== http transport =="

GHDIR="$ROOT/skills/github-curl"
FIX="$WORK/fix"; mkdir -p "$FIX"

printf '%s' '{"number":42,"title":"A title"}' > "$FIX/GET_repos_acme_thing_pulls_42.json"

out=$(env GH_FIXTURES="$FIX" GH_TOKEN=x python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import http
print(http.rest('GET', '/repos/acme/thing/pulls/42')['title'])
")
check "reads a fixture instead of the network" "A title" "$out"

# Pagination: two pages joined into a single list.
printf '%s' '[{"id":1}]' > "$FIX/GET_repos_acme_thing_pulls_42_comments__per_page=1.json"
printf '%s' '[{"id":2}]' > "$FIX/GET_repos_acme_thing_pulls_42_comments__per_page=1&page=2.json"
# GH_PAGE_SIZE=1 makes a one-item page a full page, so a second is fetched.
# The third request finds no fixture, returns nothing, and ends the loop.
out=$(env GH_FIXTURES="$FIX" GH_TOKEN=x GH_PAGE_SIZE=1 python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import http
print(len(http.rest('GET', '/repos/acme/thing/pulls/42/comments', paginate=True)))
")
check "paginates until a short page" "2" "$out"

# The bug this guards against: GitHub's own default page size is 30, not the
# value the loop compares chunk lengths against. Without per_page on every
# request, a full 30-item first page still looks "short" against the default
# size of 100 and pagination silently truncates with no signal. Assert on the
# transmitted paths themselves, not on a page count that a fixture can fake.
paths=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$FIX/sent.jsonl')]
matches = [r['path'] for r in rows if r['path'].startswith('/repos/acme/thing/pulls/42/comments')]
print('|'.join(matches[:2]))
")
check "paginated requests carry per_page" \
  "/repos/acme/thing/pulls/42/comments?per_page=1|/repos/acme/thing/pulls/42/comments?per_page=1&page=2" \
  "$paths"

# Each HTTP status maps to its own exit code.
raises() {  # raises <name> <status> <message> <expected-exit>
  printf '{"__status":%s,"message":"%s"}' "$2" "$3" > "$FIX/GET_repos_acme_thing_err_$2.json"
  check_status "$1" "$4" \
    env GH_FIXTURES="$FIX" GH_TOKEN=x python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import http, errors
try:
    http.rest('GET', '/repos/acme/thing/err/$2')
except errors.GhError as e:
    sys.exit(e.code)
sys.exit(0)
"
}

raises "a 401 raises AuthError"          401 "Bad credentials"        2
raises "a 403 rate limit raises code 5"  403 "API rate limit exceeded" 5
raises "a 404 raises NotFound"           404 "Not Found"              4
raises "a 422 raises ApiError"           422 "Validation Failed"      3
raises "a 429 raises code 5"             429 "You have exceeded a secondary rate limit" 5

# Requests are recorded for later assertion.
sent=$(wc -l < "$FIX/sent.jsonl" | tr -d ' ')
check "records every request sent" "9" "$sent"

# GitHub sends "message": null on some error responses. .get("message", ...)
# substitutes its default only for an absent key, so a present null survives
# to reach message.lower() unguarded and raises AttributeError -- inside the
# error mapper itself, which is not a GhError and so prints as a bare
# traceback. That line only runs for a 401/403, where the rate-limit check
# short-circuits it for every other status.
printf '%s' '{"__status":401,"message":null}' > "$FIX/GET_repos_acme_thing_err_nullmsg.json"

check_status "a null message still maps to AuthError" 2 \
  env GH_FIXTURES="$FIX" GH_TOKEN=x python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import http, errors
try:
    http.rest('GET', '/repos/acme/thing/err/nullmsg')
except errors.GhError as e:
    sys.exit(e.code)
sys.exit(0)
"

out=$(env GH_FIXTURES="$FIX" GH_TOKEN=x python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import http, errors
try:
    http.rest('GET', '/repos/acme/thing/err/nullmsg')
except errors.GhError as e:
    print('error: ' + str(e.message))
    sys.exit(e.code)
" 2>&1)
check "a null message prints an error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "a null message has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|AttributeError')"

# Test that _request survives non-JSON responses (like diffs).
# Mock urllib.request.urlopen to return plain text, verify _request returns it as a string.
result=$(python3 -c "
import sys
sys.path.insert(0, '$GHDIR')
from unittest.mock import Mock, patch
from ghlib import http

# Mock response with plain text (like a diff)
mock_resp = Mock()
mock_resp.read.return_value = b'--- file\n+++ file\n'
mock_resp.status = 200
mock_resp.__enter__ = Mock(return_value=mock_resp)
mock_resp.__exit__ = Mock(return_value=False)

with patch('urllib.request.urlopen', return_value=mock_resp):
    status, data = http._request('GET', 'http://example.com/diff', None, {})
    # data should be a string, not a dict
    if isinstance(data, str) and data.startswith('---'):
        print('ok')
    else:
        print('fail')
")
check "transport survives non-JSON response" "ok" "$result"

echo "== cli skeleton =="

check "resolves owner/repo from the origin remote" "acme/thing" \
  "$(sh -c "cd '$WORK/repo' && python3 -c \"
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import repo
print(repo.nwo())
\"")"

check "--repo overrides the remote" "other/name" \
  "$(env GH_REPO=other/name python3 -c "
import sys; sys.path.insert(0, '$GHDIR')
from ghlib import repo
print(repo.nwo())
")"

check_status "an unknown subcommand exits 1" 1 \
  env GH_TOKEN=x python3 "$GHDIR/gh.py" no-such-command

check_status "no subcommand exits 1" 1 \
  env GH_TOKEN=x python3 "$GHDIR/gh.py"

echo "== formatters =="

render() {
  printf '%s' "$2" | python3 -c "
import json, sys
sys.path.insert(0, '$GHDIR')
from ghlib import fmt
print(fmt.render('$1', json.load(sys.stdin)))
"
}

check "pr-number from a list" "42" "$(render pr-number '[{"number":42}]')"
check "pr-number from an object" "42" "$(render pr-number '{"number":42}')"
check "pr-number when absent" "" "$(render pr-number '[]')"
check "pr-url" "https://x/1" "$(render pr-url '{"html_url":"https://x/1"}')"
check "pr-merge-status merged" "merged" "$(render pr-merge-status '{"state":"closed","merged":true}')"
check "pr-merge-status open" "open" "$(render pr-merge-status '{"state":"open","merged":false}')"
check "pr-merge-status closed" "closed" "$(render pr-merge-status '{"state":"closed","merged":false}')"

# checks-status must be genuinely combined: pr-checks fetches both legacy
# commit statuses and check runs, and the docs and the subcommand help both
# call the result "combined". A repo relying on statuses (not check runs)
# would otherwise read SUCCESS over a red CI. All check runs pass here; only
# the legacy status fails.
check "checks-status folds a failing commit status into the verdict" "FAILURE" \
  "$(render checks-status '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}],"statuses":{"state":"failure","statuses":[{"state":"failure","context":"ci/legacy"}]}}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')"

check "checks-status names the failing legacy status" "ci/legacy" \
  "$(render checks-status '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}],"statuses":{"state":"failure","statuses":[{"state":"failure","context":"ci/legacy"}]}}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["failed_checks"][0])')"
check "open-threads keeps only unresolved" "1" \
  "$(render open-threads '[{"id":"a","isResolved":false},{"id":"b","isResolved":true}]' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "resolve-status" "resolved" "$(render resolve-status '{"resolveReviewThread":{"thread":{"isResolved":true}}}')"

check "thread-summary with null author renders ?" "| ? |" \
  "$(render thread-summary '[{"id":"t1","path":"f.py","line":"10","comments":{"nodes":[{"author":null}]},"isResolved":false}]' | grep -o '| ? |')"

check "issue-comments-summary with null user renders ?" "| ? |" \
  "$(render issue-comments-summary '[{"id":"c1","user":null,"body":"test comment"}]' | grep -o '| ? |')"

check_status "resolve-status with null mutation payload exits 3" 3 \
  sh -c "printf '{\"resolveReviewThread\":null}' | python3 -c \"
import json, sys
sys.path.insert(0, '$GHDIR')
from ghlib import fmt, errors
try:
    fmt.render('resolve-status', json.load(sys.stdin))
except errors.GhError as e:
    sys.exit(e.code)
\""

check_status "an unknown formatter exits 1" 1 \
  sh -c "printf '{}' | python3 -c \"
import json, sys
sys.path.insert(0, '$GHDIR')
from ghlib import fmt, errors
try:
    fmt.render('nope', json.load(sys.stdin))
except errors.GhError as e:
    sys.exit(e.code)
\""

echo "== carried-over reads =="

F2="$WORK/fix2"; mkdir -p "$F2"
gh() { env GH_FIXTURES="$F2" GH_TOKEN=x GH_REPO=acme/thing python3 "$GHDIR/gh.py" "$@"; }

printf '%s' '{"login":"someone"}' > "$F2/GET_user.json"
check "auth-check reaches /user" "someone" "$(gh auth-check --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"

printf '%s' '[{"number":7,"title":"T","state":"open","html_url":"u","head":{"ref":"h"},"base":{"ref":"main"},"draft":false}]' \
  > "$F2/GET_repos_acme_thing_pulls__head=acme:feature-x.json"
check "pr-get resolves the branch PR number" "7" "$(gh pr-get --branch feature-x --format pr-number)"

# pr-get falls back to the current branch when none is given. Outside a git
# checkout (or in detached HEAD, where git prints nothing useful) that
# resolves to an empty string, and an unguarded request would go out as
# "head=owner:" -- probably matching every open PR. pr-create already guards
# this the same way; pr-get must too.
check_status "pr-get with no resolvable branch exits 1" 1 \
  sh -c "cd '$WORK/norepo' && env GH_FIXTURES='$F2' GH_TOKEN=x GH_REPO=acme/thing python3 '$GHDIR/gh.py' pr-get"

out=$(sh -c "cd '$WORK/norepo' && env GH_FIXTURES='$F2' GH_TOKEN=x GH_REPO=acme/thing python3 '$GHDIR/gh.py' pr-get" 2>&1)
check "unresolvable branch has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

printf '%s' '{"number":7,"state":"closed","merged":true}' > "$F2/GET_repos_acme_thing_pulls_7.json"
check "pr-status reports merged" "merged" "$(gh pr-status 7 --format pr-merge-status)"

printf '%s' '[{"id":11,"body":"hello","user":{"login":"bob"}}]' > "$F2/GET_repos_acme_thing_issues_7_comments__per_page=100.json"
check "pr-issue-comments returns the comments" "11" \
  "$(gh pr-issue-comments 7 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"

# --format is defined on the parent parser but also mirrored (via SUPPRESS) onto
# every subparser, so it must work on either side of the subcommand, and the
# parent's "raw" default must still apply when the flag is given on neither.
check "--format also works before the subcommand" "someone" \
  "$(gh --format raw auth-check | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"

check "--format defaults to raw when omitted on both sides" "someone" \
  "$(gh auth-check | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"

# comments-resolved-batch must map a missing or malformed file to a usage exit
# instead of leaking a raw FileNotFoundError/JSONDecodeError traceback.
check_status "comments-resolved-batch on a missing file exits 1" 1 \
  gh comments-resolved-batch "$F2/does-not-exist.json"

out=$(gh comments-resolved-batch "$F2/does-not-exist.json" 2>&1)
check "missing file prints an error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "missing file has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

printf 'not json' > "$F2/bad.json"
check_status "comments-resolved-batch on malformed json exits 1" 1 \
  gh comments-resolved-batch "$F2/bad.json"

out=$(gh comments-resolved-batch "$F2/bad.json" 2>&1)
check "malformed file prints an error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "malformed file has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

# A non-numeric pr must fail via argparse's own mapped usage exit, not an
# unguarded int() conversion inside the handler.
check_status "pr-threads with a non-numeric pr exits 1" 1 \
  gh pr-threads abc

out=$(gh pr-threads abc 2>&1)
check "non-numeric pr has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

echo "== body-file fidelity =="

F3="$WORK/fix3"; mkdir -p "$F3"
gh3() { env GH_FIXTURES="$F3" GH_TOKEN=x GH_REPO=acme/thing python3 "$GHDIR/gh.py" "$@"; }

# Every character class that breaks shell quoting, in one body.
BODY="$WORK/body.md"
{
  printf 'Line one with `backticks` and a $VAR sequence\n'
  printf 'A "double quoted" phrase and a '\''single quoted'\'' one\n'
  printf '\n'
  printf '```bash\n'
  printf 'echo "$(whoami)" && rm -rf /tmp/nothing\n'
  printf '```\n'
  printf 'Trailing line with an accent: éàü\n'
  # A CRLF line, so that removing newline="" from bodies.read is detectable.
  # Without one, the setting this test exists to protect is never exercised.
  printf 'A line ending in CRLF\r\n'
} > "$BODY"

printf '%s' '{"id":99}' > "$F3/POST_repos_acme_thing_issues_7_comments.json"
gh3 pr-comment 7 --body-file "$BODY" >/dev/null

# Compare through files, never through "$(...)": command substitution strips
# every trailing newline from BOTH sides before check() sees them, so a real
# stripping regression in bodies.read would compare equal and pass.
python3 -c "
import json, sys
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['path'].endswith('/issues/7/comments'):
        sys.stdout.write(row['body']['body'])
        break
" > "$WORK/sent-body.md"
check_status "body-file arrives byte-identical" 0 cmp -s "$BODY" "$WORK/sent-body.md"

check_status "a missing body file exits 1" 1 gh3 pr-comment 7 --body-file "$WORK/nope.md"
check_status "an empty body file exits 1" 1 sh -c ": > '$WORK/empty.md'; $(printf '%q ' env GH_FIXTURES="$F3" GH_TOKEN=x GH_REPO=acme/thing python3 "$GHDIR/gh.py") pr-comment 7 --body-file '$WORK/empty.md'"

echo "== review writes =="

printf '%s' '{"id":5,"state":"COMMENTED"}' > "$F3/POST_repos_acme_thing_pulls_7_reviews.json"
cat > "$WORK/inline.json" <<'JSON'
[{"path":"src/a.py","line":12,"side":"RIGHT","body":"Consider renaming this."}]
JSON
gh3 review-submit 7 --event COMMENT --body-file "$BODY" --comments-file "$WORK/inline.json" >/dev/null

payload=$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['path'].endswith('/pulls/7/reviews'):
        print(row['body']['event'], len(row['body']['comments']), row['body']['comments'][0]['path'])
")
check "review-submit sends event and inline comments" "COMMENT 1 src/a.py" "$payload"

# Task 5 overrode ArgumentParser.error() so argparse's own exit 2 becomes the
# CLI's documented usage code. An invalid --event choice therefore exits 1.
check_status "an invalid event exits 1 as a usage error" 1 gh3 review-submit 7 --event NOPE --body-file "$BODY"

echo "== pr content =="

printf '%s' '[{"filename":"src/a.py","status":"modified","patch":"@@ -1 +1 @@"}]' \
  > "$F3/GET_repos_acme_thing_pulls_7_files__per_page=100.json"
check "pr-files lists changed paths" "src/a.py" \
  "$(gh3 pr-files 7 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["filename"])')"

# pr-commits: returns a list
printf '%s' '[{"sha":"abc123","message":"Fix bug"}]' > "$F3/GET_repos_acme_thing_pulls_7_commits__per_page=100.json"
check "pr-commits returns commits list" "abc123" \
  "$(gh3 pr-commits 7 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["sha"])')"

# file-at-ref: valid UTF-8 content round-trips unchanged with binary=false
printf '%s' '{"content":"aGVsbG8=","encoding":"base64"}' \
  > "$F3/GET_repos_acme_thing_contents_README.md__ref=main.json"
check "file-at-ref decodes base64 content" "hello" \
  "$(gh3 file-at-ref README.md main --format raw | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["content"] if not d.get("binary") else "BINARY")')"

# file-at-ref: directory response (JSON array) exits 1 with error line, no traceback
printf '%s' '[{"name":"file1.txt"},{"name":"file2.txt"}]' \
  > "$F3/GET_repos_acme_thing_contents_docs__ref=main.json"
check_status "file-at-ref on directory exits 1" 1 gh3 file-at-ref docs main
out=$(gh3 file-at-ref docs main 2>&1)
check "directory error has error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "directory error has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

# file-at-ref: malformed base64 exits 3 with error line, no traceback
printf '%s' '{"content":"not-valid-base64!!!","encoding":"base64"}' \
  > "$F3/GET_repos_acme_thing_contents_broken.bin__ref=main.json"
check_status "file-at-ref on malformed base64 exits 3" 3 gh3 file-at-ref broken.bin main
out=$(gh3 file-at-ref broken.bin main 2>&1)
check "malformed base64 has error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "malformed base64 has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

# file-at-ref: binary content (non-UTF8) returns binary=true and base64-encoded content
# PNG magic bytes: 89 50 4E 47 = iVBORw== in base64
printf '%s' '{"content":"iVBORw==","encoding":"base64"}' \
  > "$F3/GET_repos_acme_thing_contents_image.png__ref=main.json"
out=$(gh3 file-at-ref image.png main --format raw)
binary_flag=$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("true" if d.get("binary") else "false")')
check "binary content returns binary=true" "true" "$binary_flag"
# Verify round-trip: base64-encode the content and it should match
content=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])')
check "binary content is base64-encoded" "iVBORw==" "$content"

# pr-diff: plain text response returns the diff (fixture as JSON string)
printf '%s' '"--- a/file\n+++ b/file\n@@ -1 +1 @@"' > "$F3/GET_repos_acme_thing_pulls_42.json"
check "pr-diff returns plain text diff" "--- a/file
+++ b/file" \
  "$(gh3 pr-diff 42 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["diff"][:21])')"

# pr-diff: dict response (missing fixture or wrong response) exits 3 with error line
# Fixture is a plain dict with no __status, so it flows through transport untouched to the handler
printf '%s' '{"diff":""}' \
  > "$F3/GET_repos_acme_thing_pulls_999.json"
check_status "pr-diff on dict response exits 3" 3 gh3 pr-diff 999
out=$(gh3 pr-diff 999 2>&1)
check "pr-diff dict response has error line" "1" "$(printf '%s' "$out" | grep -c '^error:')"
check "pr-diff dict response has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

echo "== metadata and issues =="

printf '%s' '{"number":7,"title":"New"}' > "$F3/PATCH_repos_acme_thing_pulls_7.json"
gh3 pr-update 7 --title "New" >/dev/null
title=$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'PATCH' and row['path'].endswith('/pulls/7'):
        print(row['body']['title'])
")
check "pr-update sends only the given fields" "New" "$title"

check_status "pr-update with no field exits 1" 1 gh3 pr-update 7

printf '%s' '[{"name":"bug"}]' > "$F3/POST_repos_acme_thing_issues_7_labels.json"
check "label-add returns the label set" "bug" \
  "$(gh3 label-add 7 bug --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["name"])')"

# label-remove interpolates the label name raw into a DELETE path. A
# multi-word label like "good first issue" carries a literal space, a control
# character to http.client, which previously escaped only as an uncaught
# http.client.InvalidURL -- not a GhError -- surfacing as a raw traceback on a
# live connection. quote() must run before the name reaches the URL. That
# InvalidURL only reproduces against a real socket, which this offline suite
# never opens, so -- exactly as the issue-search tests above do -- assert on
# the recorded outgoing path: it fails the moment quote() is dropped, because
# the request would then be recorded (and looked up) under a path with a
# literal space instead of "%20".
printf '%s' '{}' > "$F3/DELETE_repos_acme_thing_issues_7_labels_good%20first%20issue.json"
check_status "label-remove with a multi-word label exits 0" 0 \
  gh3 label-remove 7 "good first issue"

out=$(gh3 label-remove 7 "good first issue" 2>&1)
check "label-remove multi-word label has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

encoded_path=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$F3/sent.jsonl')]
matches = [r['path'] for r in rows if r['path'].startswith('/repos/acme/thing/issues/7/labels/')]
print(matches[-1])
")
check "label-remove percent-encodes a multi-word label" \
  "/repos/acme/thing/issues/7/labels/good%20first%20issue" "$encoded_path"

# GitHub's own API deletes one label per call, so a "names" list secretly
# dropped everything past the first. label-remove takes a single "name"
# positional instead, which makes a second label a usage error rather than a
# silent loss.
check_status "label-remove rejects a second label" 1 gh3 label-remove 7 foo bar

printf '%s' '{"number":3,"title":"An issue"}' > "$F3/GET_repos_acme_thing_issues_3.json"
check "issue-view fetches the issue" "An issue" \
  "$(gh3 issue-view 3 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])')"

# A non-numeric issue number must fail via argparse's own mapped usage exit,
# like every other numeric positional, not an unguarded conversion or a raw
# lookup miss inside the handler.
check_status "issue-view with a non-numeric number exits 1" 1 gh3 issue-view abc
out=$(gh3 issue-view abc 2>&1)
check "non-numeric issue number has no traceback" "0" "$(printf '%s' "$out" | grep -cE 'Traceback|^[A-Za-z]*Error:')"

printf '%s' '{"items":[{"number":9}]}' > "$F3/GET_search_issues__q=repo%3Aacme%2Fthing%20bug.json"
check "issue-search queries the search API" "9" \
  "$(gh3 issue-search bug --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["number"])')"

# issue-search must percent-encode the whole query, not just replace spaces
# with "+". A raw "#" opens a URL fragment (the server never sees anything
# after it) and a raw "&" starts a second query parameter -- both would
# silently change what is actually searched for. Assert on the transmitted
# path recorded in sent.jsonl, not on the (fixture-less) response, so the
# check fails if quote() is ever replaced by a plainer substitution.
gh3 issue-search 'C#' >/dev/null
hash_path=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$F3/sent.jsonl')]
matches = [r for r in rows if r['path'].startswith('/search/issues')]
print(matches[-1]['path'])
")
check "issue-search percent-encodes a # term" "/search/issues?q=repo%3Aacme%2Fthing%20C%23" "$hash_path"

gh3 issue-search 'foo&bar' >/dev/null
amp_path=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$F3/sent.jsonl')]
matches = [r for r in rows if r['path'].startswith('/search/issues')]
print(matches[-1]['path'])
")
check "issue-search percent-encodes a & term" "/search/issues?q=repo%3Aacme%2Fthing%20foo%26bar" "$amp_path"

echo "== image upload =="

printf 'not really a png' > "$WORK/shot.png"
SHA=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WORK/shot.png")

printf '%s' '{"__status":404,"message":"Not Found"}' > "$F3/GET_repos_acme_thing_contents_${SHA}.png__ref=pr-assets.json"
printf '%s' '{"ref":"refs/heads/pr-assets"}' > "$F3/GET_repos_acme_thing_git_ref_heads_pr-assets.json"
printf '%s' '{"content":{"path":"'"$SHA"'.png"}}' > "$F3/PUT_repos_acme_thing_contents_${SHA}.png.json"

out=$(gh3 image-upload "$WORK/shot.png" --format raw)
check "url points at the assets branch" \
  "https://raw.githubusercontent.com/acme/thing/pr-assets/$SHA.png" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
check "markdown is ready to paste" \
  "![](https://raw.githubusercontent.com/acme/thing/pr-assets/$SHA.png)" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["markdown"])')"

# An identical file already on the branch is not re-uploaded.
printf '%s' '{"sha":"abc","path":"'"$SHA"'.png"}' > "$F3/GET_repos_acme_thing_contents_${SHA}.png__ref=pr-assets.json"
check "an existing asset is reused" "True" \
  "$(gh3 image-upload "$WORK/shot.png" --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["reused"])')"

check_status "a missing image exits 1" 1 gh3 image-upload "$WORK/absent.png"

echo "== opening and merging a pull request =="

printf '%s' '{"number":12,"html_url":"https://github.com/acme/thing/pull/12"}' \
  > "$F3/POST_repos_acme_thing_pulls.json"
printf 'Body from a file with `backticks`\n' > "$WORK/prbody.md"

check "pr-create returns the new number" "12" \
  "$(gh3 pr-create --title 'A title' --body-file "$WORK/prbody.md" --head feature-x --format pr-number)"

# The title, base and head reach the request, and the body comes from the file.
created=$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'POST' and row['path'].endswith('/pulls'):
        b = row['body']
        print(b['title'], b['base'], b['head'], repr(b['body']))
")
check "pr-create sends title, base, head and the file body" \
  "A title main feature-x 'Body from a file with \`backticks\`\n'" "$created"

check "pr-create without --draft sends no draft key" "" \
  "$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'POST' and row['path'].endswith('/pulls'):
        print('draft' if 'draft' in row['body'] else '', end='')
")"

check "pr-create --draft returns the new number" "12" \
  "$(gh3 pr-create --title 'A title' --body-file "$WORK/prbody.md" --head feature-x --draft --format pr-number)"

draft_sent=$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'POST' and row['path'].endswith('/pulls'):
        last = row
print(last['body'].get('draft'))
")
check "pr-create --draft sends draft true" "True" "$draft_sent"

check_status "pr-create without a title exits 1" 1 gh3 pr-create --head feature-x

printf '%s' '{"merged":true,"message":"Pull Request successfully merged"}' \
  > "$F3/PUT_repos_acme_thing_pulls_7_merge.json"
check "pr-merge reports the merge" "True" \
  "$(gh3 pr-merge 7 --format raw | python3 -c 'import json,sys; print(json.load(sys.stdin)["merged"])')"

merged=$(python3 -c "
import json
for line in open('$F3/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'PUT' and row['path'].endswith('/merge'):
        print(row['body']['merge_method'])
")
check "pr-merge defaults to the merge method" "merge" "$merged"

check_status "pr-merge rejects an unknown method" 1 gh3 pr-merge 7 --method fast-forward
check_status "pr-merge rejects a non-numeric PR" 1 gh3 pr-merge abc


echo "== skill documents =="

SKILLDOC="$ROOT/skills/github-curl/SKILL.md"

echo "== pending reviews =="

# A fixture directory of its own, so the PR, user and reviews fixtures below
# never overwrite the ones earlier sections rely on.
F4="$WORK/fix4"; mkdir -p "$F4"
gh4() { env GH_FIXTURES="$F4" GH_TOKEN=x GH_REPO=acme/thing python3 "$GHDIR/gh.py" "$@"; }
# The shape of a failure: how many error: lines and how many tracebacks reached
# stderr. An exit code alone does not tell a mapped error from a crash.
errshape() {
  local out
  out=$("$@" 2>&1 >/dev/null)
  printf '%s %s' "$(printf '%s\n' "$out" | grep -c '^error:')" "$(printf '%s\n' "$out" | grep -c Traceback)"
}

printf '%s' '{"login":"me"}' > "$F4/GET_user.json"
printf '%s' '{"number":7,"node_id":"PR_kwDO","head":{"sha":"abc123"}}' > "$F4/GET_repos_acme_thing_pulls_7.json"
printf '%s' '[{"id":5,"node_id":"PRR_5","state":"PENDING","user":{"login":"me"}},{"id":6,"node_id":"PRR_6","state":"COMMENTED","user":{"login":"me"}},{"id":7,"node_id":"PRR_7","state":"PENDING","user":null}]' \
  > "$F4/GET_repos_acme_thing_pulls_7_reviews__per_page=100.json"
printf '%s' '[{"path":"src/a.py","position":3,"commit_id":"abc123","body":"x"},{"path":"src/b.py","position":9,"commit_id":"abc123","body":"y"}]' \
  > "$F4/GET_repos_acme_thing_pulls_7_reviews_5_comments__per_page=100.json"

check "login formatter prints the token login" "me" "$(gh4 auth-check --format login)"

check "review-pending returns the pending review and its comments" "5 2 me" \
  "$(gh4 review-pending 7 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["review"]["id"], len(d["comments"]), d["login"])')"

check "review-pending for another author finds nothing" "None 0 nobody" \
  "$(gh4 review-pending 7 --author nobody | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["review"], len(d["comments"]), d["login"])')"

printf '%s' '{"id":9,"node_id":"PRR_9","state":"PENDING","user":{"login":"me"}}' > "$F4/POST_repos_acme_thing_pulls_7_reviews.json"
cat > "$WORK/pending.json" <<'JSON'
[{"path":"src/a.py","line":12,"body":"Consider renaming this."},
 {"path":"src/b.py","line":30,"start_line":25,"body":"This block repeats the one above."}]
JSON

# No PENDING review by "me" yet: the fixture holds only a submitted one and a
# pending one by a deleted account.
printf '%s' '[{"id":6,"node_id":"PRR_6","state":"COMMENTED","user":{"login":"me"}},{"id":7,"node_id":"PRR_7","state":"PENDING","user":null}]' \
  > "$F4/GET_repos_acme_thing_pulls_7_reviews__per_page=100.json"
: > "$F4/sent.jsonl"
gh4 review-pending-create 7 --comments-file "$WORK/pending.json" >/dev/null
payload=$(python3 -c "
import json
for line in open('$F4/sent.jsonl'):
    row = json.loads(line)
    if row['method'] == 'POST' and row['path'].endswith('/pulls/7/reviews'):
        b = row['body']
        print(b['commit_id'], 'event' in b, len(b['comments']), b['comments'][0]['side'], b['comments'][1]['start_line'], b['comments'][1]['start_side'])
")
check "review-pending-create sends commit_id and comments, never event" "abc123 False 2 RIGHT 25 RIGHT" "$payload"

printf '%s' '[{"id":5,"node_id":"PRR_5","state":"PENDING","user":{"login":"me"}},{"id":6,"node_id":"PRR_6","state":"COMMENTED","user":{"login":"me"}},{"id":7,"node_id":"PRR_7","state":"PENDING","user":null}]' \
  > "$F4/GET_repos_acme_thing_pulls_7_reviews__per_page=100.json"
check_status "review-pending-create refuses when a PENDING review exists" 1 gh4 review-pending-create 7 --comments-file "$WORK/pending.json"
check "the refusal names the existing review and the add subcommand" "id 5 review-pending-add" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/pending.json" 2>&1 >/dev/null | grep -oE 'id 5|review-pending-add' | paste -sd' ' -)"
check "the refusal is one error line and no traceback" "1 0" "$(errshape gh4 review-pending-create 7 --comments-file "$WORK/pending.json")"

# Each malformed comments file is refused by the validator, before any request:
# the message names the defect, so a refusal by the guard above cannot pass for it.
printf '%s' '{"path":"x"}' > "$WORK/bad-object.json"
printf '%s' '[]' > "$WORK/bad-empty.json"
printf '%s' '[{"path":"a","line":3}]' > "$WORK/bad-nobody.json"
printf '%s' '[{"path":"a","line":"3","body":"b"}]' > "$WORK/bad-line.json"
printf '%s' '[{"path":"a","line":3,"start_line":3,"body":"b"}]' > "$WORK/bad-range.json"
for case in object empty nobody line range; do
  check_status "a bad comments file ($case) exits 1" 1 gh4 review-pending-create 7 --comments-file "$WORK/bad-$case.json"
  check "a bad comments file ($case) is one error line and no traceback" "1 0" "$(errshape gh4 review-pending-create 7 --comments-file "$WORK/bad-$case.json")"
done
check "the validator names the array rule (object)" "non-empty JSON array" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/bad-object.json" 2>&1 >/dev/null | grep -o 'non-empty JSON array' | head -1)"
check "the validator names the array rule (empty)" "non-empty JSON array" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/bad-empty.json" 2>&1 >/dev/null | grep -o 'non-empty JSON array' | head -1)"
check "the validator names the field" "body" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/bad-nobody.json" 2>&1 >/dev/null | grep -o 'body' | head -1)"
check "the validator names the line rule" "line must be an integer" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/bad-line.json" 2>&1 >/dev/null | grep -o 'line must be an integer' | head -1)"
check "the validator names the range rule" "start_line" \
  "$(gh4 review-pending-create 7 --comments-file "$WORK/bad-range.json" 2>&1 >/dev/null | grep -o 'start_line' | head -1)"
check "no request is sent for a bad comments file" "0" \
  "$(: > "$F4/sent.jsonl"; gh4 review-pending-create 7 --comments-file "$WORK/bad-range.json" >/dev/null 2>&1; wc -l < "$F4/sent.jsonl" | tr -d ' ')"
check_status "a missing comments file exits 1" 1 gh4 review-pending-create 7 --comments-file "$WORK/nope.json"

printf '%s' '{"id":5,"node_id":"PRR_5","state":"PENDING","user":{"login":"me"}}' > "$F4/GET_repos_acme_thing_pulls_7_reviews_5.json"
printf '%s' '{"id":6,"node_id":"PRR_6","state":"COMMENTED","user":{"login":"me"}}' > "$F4/GET_repos_acme_thing_pulls_7_reviews_6.json"
printf '%s' '{"id":8,"node_id":"PRR_8","state":"PENDING","user":{"login":"someone-else"}}' > "$F4/GET_repos_acme_thing_pulls_7_reviews_8.json"
printf '%s' '{"addPullRequestReviewThread":{"thread":{"id":"PRRT_1","comments":{"nodes":[{"id":"PRRC_1"}]}}}}' > "$F4/graphql.json"
printf 'Rename `foo` to say what it holds.\n' > "$WORK/thread.md"

: > "$F4/sent.jsonl"
gh4 review-pending-add 7 --review-id 5 --path src/a.py --line 12 --body-file "$WORK/thread.md" >/dev/null
mutation=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$F4/sent.jsonl') if '\"query\"' in l]
q, v = rows[-1]['query'], rows[-1]['variables']
print('addPullRequestReviewThread' in q, 'pullRequestReviewId' in q, v['review'], v['pr'], v['path'], v['line'], v['side'], 'startLine' in v, v['body'].startswith('Rename'))
")
check "review-pending-add sends the thread mutation with both ids" "True True PRR_5 PR_kwDO src/a.py 12 RIGHT False True" "$mutation"

: > "$F4/sent.jsonl"
gh4 review-pending-add 7 --review-id 5 --path src/a.py --line 12 --start-line 8 --body-file "$WORK/thread.md" >/dev/null
check "review-pending-add sends a range as startLine and startSide" "8 RIGHT" \
  "$(python3 -c "
import json
rows = [json.loads(l) for l in open('$F4/sent.jsonl') if '\"query\"' in l]
v = rows[-1]['variables']
print(v.get('startLine'), v.get('startSide'))
")"

check_status "a start line not below the line exits 1" 1 gh4 review-pending-add 7 --review-id 5 --path src/a.py --line 12 --start-line 12 --body-file "$WORK/thread.md"
check "a submitted review is refused by state" "not PENDING" \
  "$(gh4 review-pending-add 7 --review-id 6 --path src/a.py --line 12 --body-file "$WORK/thread.md" 2>&1 >/dev/null | grep -o 'not PENDING' | head -1)"
check "another user's pending review is refused by name" "someone-else" \
  "$(gh4 review-pending-add 7 --review-id 8 --path src/a.py --line 12 --body-file "$WORK/thread.md" 2>&1 >/dev/null | grep -o 'someone-else' | head -1)"
check "a refused add is one error line and no traceback" "1 0" \
  "$(errshape gh4 review-pending-add 7 --review-id 8 --path src/a.py --line 12 --body-file "$WORK/thread.md")"
check_status "a missing review exits 4" 4 gh4 review-pending-add 7 --review-id 404 --path src/a.py --line 12 --body-file "$WORK/thread.md"
check "no mutation is sent for a refused add" "0" \
  "$(: > "$F4/sent.jsonl"; gh4 review-pending-add 7 --review-id 6 --path src/a.py --line 12 --body-file "$WORK/thread.md" >/dev/null 2>&1; grep -c '"query"' "$F4/sent.jsonl")"
check_status "an empty body file exits 1" 1 sh -c ": > '$WORK/empty-thread.md'; $(printf '%q ' env GH_FIXTURES="$F4" GH_TOKEN=x GH_REPO=acme/thing python3 "$GHDIR/gh.py") review-pending-add 7 --review-id 5 --path src/a.py --line 12 --body-file '$WORK/empty-thread.md'"

printf '%s' '[{"user":{"login":"other"},"body":"Merci."},{"user":{"login":"me"},"body":"Please rename this."},{"user":{"login":"me"},"body":"Second one."},{"user":null,"body":"ghost"}]' \
  > "$F4/GET_repos_acme_thing_pulls_comments__sort=created&direction=desc&per_page=100.json"
check "repo-review-comments filters on the author" "2" \
  "$(gh4 repo-review-comments --author me | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "repo-review-comments honours --limit" "1" \
  "$(gh4 repo-review-comments --author me --limit 1 | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "a deleted-account author does not crash the filter" "2" \
  "$(gh4 repo-review-comments --author me | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "repo-review-comments asks for the newest first" "1" \
  "$(: > "$F4/sent.jsonl"; gh4 repo-review-comments >/dev/null; grep -c 'sort=created&direction=desc&per_page=100' "$F4/sent.jsonl")"
check "comment-bodies prints the bodies only" "Please rename this.|---|Second one." \
  "$(gh4 repo-review-comments --author me --format comment-bodies | paste -sd'|' -)"
check "comment-bodies on an empty list prints nothing" "" \
  "$(gh4 repo-review-comments --author nobody --format comment-bodies)"
check "login formatter on a list of comments prints empty" "" \
  "$(gh4 repo-review-comments --format login)"
check_status "login formatter on a list of comments exits 0" 0 gh4 repo-review-comments --format login

summary=$(gh4 review-pending 7 --format pending-review-summary)
check "pending-review-summary heads with id, node_id, state, count" "id 5 node_id PRR_5 state PENDING comments 2" \
  "$(printf '%s\n' "$summary" | head -4 | paste -sd' ' -)"
check "pending-review-summary tables path, position and commit" "| src/b.py | 9 | abc123 |" \
  "$(printf '%s\n' "$summary" | tail -1)"
check "pending-review-summary prints none without a review" "none" \
  "$(gh4 review-pending 7 --author nobody --format pending-review-summary)"

# A separate fixture write, restored right after: the review-5 comments
# fixture above is shared with the count and table checks just above, so a
# third entry here would change their expected values.
cp "$F4/GET_repos_acme_thing_pulls_7_reviews_5_comments__per_page=100.json" "$WORK/reviews-5-comments-orig.json"
printf '%s' '[{"path":"src/a.py","position":3,"commit_id":"abc123","body":"x"},{"path":"src/b.py","position":9,"commit_id":"abc123","body":"y"},{"path":"src/c.py","line":4,"body":"z"}]' \
  > "$F4/GET_repos_acme_thing_pulls_7_reviews_5_comments__per_page=100.json"
check "pending-review-summary uses a sentinel for a missing commit_id" "| src/c.py | 4 | ? |" \
  "$(gh4 review-pending 7 --format pending-review-summary | tail -1)"
cp "$WORK/reviews-5-comments-orig.json" "$F4/GET_repos_acme_thing_pulls_7_reviews_5_comments__per_page=100.json"

check "manifest version" "0.2.1" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/.claude-plugin/plugin.json")"
check "marketplace version matches" "0.2.1 0.2.1" \
  "$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["metadata"]["version"], m["plugins"][0]["version"])' "$ROOT/.claude-plugin/marketplace.json")"

# Read the live parser: a subcommand that exists but is not written down is one
# no skill will ever call, so the suite enforces the documentation rather than
# trusting the author to remember.
undocumented=$(python3 - "$GHDIR" "$SKILLDOC" <<'PYDOC'
import sys
sys.path.insert(0, sys.argv[1])
import gh
parser = gh.build_parser()
actions = [a for a in parser._actions if a.dest == "command"]
names = sorted(actions[0].choices) if actions else []
doc = open(sys.argv[2], encoding="utf-8").read()
print(" ".join(n for n in names if "`%s`" % n not in doc))
PYDOC
)
check "every subcommand is documented" "" "$undocumented"

undocumented_formats=$(python3 - "$GHDIR" "$SKILLDOC" <<'PYFMT'
import sys
sys.path.insert(0, sys.argv[1])
from ghlib import fmt
doc = open(sys.argv[2], encoding="utf-8").read()
print(" ".join(n for n in sorted(fmt._FORMATTERS) if "`%s`" % n not in doc))
PYFMT
)
check "every formatter is documented" "" "$undocumented_formats"

# No relative .claude/skills path may survive the move into a plugin.
stale=$(grep -rn '\.claude/skills/' "$ROOT/skills" 2>/dev/null || true)
check "no relative skill paths" "" "$stale"


echo "== writing rules =="

WRITINGDOC="$ROOT/skills/github-curl/WRITING.md"

check "WRITING.md exists" "yes" "$([ -f "$WRITINGDOC" ] && echo yes || echo no)"

# Fence-aware: a "## " inside a fenced example (the PR description template)
# is not a section heading of the document itself.
headings=$(python3 - "$WRITINGDOC" <<'PYHEAD'
import sys
FENCE = chr(96) * 3
in_fence = False
found = []
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.rstrip("\n")
    if stripped.startswith(FENCE):
        in_fence = not in_fence
        continue
    if in_fence:
        continue
    if stripped.startswith("## "):
        found.append(stripped[3:])
print(" | ".join(found))
PYHEAD
)
check "WRITING.md headings are in order" \
  "Commit messages | Pull request titles | Pull request descriptions | Review comments" \
  "$headings"

check "SKILL.md names a Writing rules section" "1" \
  "$(grep -c '^## Writing rules' "$SKILLDOC")"

for needle in '--draft' 'Related PR:' 'no semicolon' 'never edited without' 'heading'; do
  check "WRITING.md mentions '$needle'" "1" \
    "$(grep -qF -- "$needle" "$WRITINGDOC" && echo 1 || echo 0)"
done

titles_concise=$(python3 - "$WRITINGDOC" <<'PYTITLES'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
start = lines.index("## Pull request titles")
end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("## "))
section = "\n".join(lines[start:end])
print(1 if "concise" in section else 0)
PYTITLES
)
check "titles section says short and concise" "1" "$titles_concise"

# Same fence-aware pass, counting ";" instead of "## " lines.
semicolons=$(python3 - "$WRITINGDOC" <<'PYSEMI'
import sys
FENCE = chr(96) * 3
in_fence = False
count = 0
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.rstrip("\n")
    if stripped.startswith(FENCE):
        in_fence = not in_fence
        continue
    if in_fence:
        continue
    count += stripped.count(";")
print(count)
PYSEMI
)
check "no semicolon outside fences in WRITING.md" "0" "$semicolons"


echo "== install =="

# commands/install.md and commands/doctor.md both tell the user to run
# "${CLAUDE_PLUGIN_ROOT}/install.sh" directly, and their allowed-tools scope
# Bash to that exact executable path. Invoking it through "/bin/bash" (as the
# rest of this suite does, below) works regardless of the file's own mode and
# would never catch a missing execute bit, so this checks the mode itself.
check "install.sh is executable" "executable" \
  "$([ -x "$ROOT/install.sh" ] && echo executable || echo not-executable)"

mkdir -p "$WORK/cfg"

inst() {
  env HOME="$WORK" GH_SKIP_AUTH=1 \
    sh -c "cd '$WORK/repo' && /bin/bash '$ROOT/install.sh'"
}

check_status "install.sh succeeds" 0 inst

# It must write nothing: compare the whole listing before and after.
before=$(find "$WORK/cfg" -type f | sort)
inst >/dev/null 2>&1
check "install.sh writes nothing" "$before" "$(find "$WORK/cfg" -type f | sort)"

check "both commands declare a description" "2" \
  "$(grep -l '^description:' "$ROOT"/commands/*.md 2>/dev/null | wc -l | tr -d ' ')"

check "no uninstall script exists" "" \
  "$(ls "$ROOT/uninstall.sh" 2>/dev/null || true)"

echo "== doctor.md matches the retired exit code =="

check "doctor.md documents no exit 10" "" \
  "$(grep -c '^| `10`' "$ROOT/commands/doctor.md" | grep -v '^0$')"

echo "== repository policy =="

check "no attribution trailers in history" "0" \
  "$(cd "$ROOT" && git log --format='%B' | grep -ciE 'claude-session|co-authored-by|generated with')"

# The old plugin (the one this tool was extracted from) must not still be named
# anywhere a user or Claude actually reads or runs: the manifests, the command
# docs, the skill doc, the README, install.sh's own output, and the
# preflight/CLI code whose User-Agent header is sent to GitHub on every
# request. tests/run-tests.sh itself is deliberately excluded: it is a
# developer-only harness (never shipped to, or read by, a plugin user), and it
# necessarily spells out the very string this check searches for in its own
# source. A prior version of a similar check filtered grep -r output by the
# repository's own path, which happened to contain the string being searched
# for -- every line matched the exclusion and nothing was left to examine, so
# the check passed on broken code. This check never filters by path: it reads
# each file's content directly through git ls-files, so the search string
# appearing in this very file (or in $ROOT) cannot silently swallow a real hit.
# "pr-reviews" (the GitHub review-list subcommand and its docs) is a genuine,
# unrelated feature name that happens to start with the same prefix, so the
# pattern requires the character after "pr-review" not be "s".
#
# The file set is every file this repository ships and tracks (git ls-files),
# minus this test suite itself -- a developer-only harness, never installed
# or read as part of using the plugin, and the one file guaranteed to spell
# out the search string in its own source.
old_name_hits=""
for f in $(cd "$ROOT" && git ls-files); do
  case "$f" in
    tests/run-tests.sh) continue ;;
  esac
  hit=$(grep -inE 'pr-review([^s]|$)' "$ROOT/$f" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    old_name_hits="$old_name_hits
$f: $hit"
  fi
done
check "no user-facing file names the old plugin" "" "$old_name_hits"


echo "== comment minimisation =="

# comment-resolve must minimise a comment, not resolve a thread: the read side
# asks isMinimized, so using the thread mutation set a state nothing produced.
printf '%s' '{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}' > "$F3/graphql.json"
gh3 comment-resolve IC_abc123 >/dev/null

mutation=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$F3/sent.jsonl') if '\"query\"' in l]
q = rows[-1]['query']
print('minimize' if 'minimizeComment' in q and 'unminimize' not in q else
      'resolveThread' if 'resolveReviewThread' in q else 'other')
")
check "comment-resolve minimises the comment" "minimize" "$mutation"

gh3 comment-unresolve IC_abc123 >/dev/null
unmutation=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$F3/sent.jsonl') if '\"query\"' in l]
print('unminimize' if 'unminimizeComment' in rows[-1]['query'] else 'other')
")
check "comment-unresolve restores the comment" "unminimize" "$unmutation"

# thread-resolve keeps using the thread mutation — the two are not interchangeable.
gh3 thread-resolve PRRT_xyz >/dev/null
tmutation=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$F3/sent.jsonl') if '\"query\"' in l]
print('resolveThread' if 'resolveReviewThread' in rows[-1]['query'] else 'other')
")
check "thread-resolve still resolves a thread" "resolveThread" "$tmutation"


echo "== skills call only what exists =="

# The reverse of the documentation check. That one asks "is everything that exists
# written down"; this one asks "does everything written down exist". Its absence is
# what let process-comments ship calling ten subcommands that were never there.
phantom=$(python3 - "$GHDIR" "$ROOT" <<'PYREV'
import os, re, sys
sys.path.insert(0, sys.argv[1])
import gh
from ghlib import fmt
subs = set([a for a in gh.build_parser()._actions if a.dest == "command"][0].choices)
fmts = set(fmt._FORMATTERS)
bad = []
for name in ("github-curl",):
    path = os.path.join(sys.argv[2], "skills", name, "SKILL.md")
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        m = re.search(r'python3\s+"\$GH"\s+([a-z][a-z0-9-]+)', line)
        if m and m.group(1) not in subs:
            bad.append("%s:%d subcommand %s" % (name, i, m.group(1)))
        for f in re.finditer(r'--format\s+([a-z][a-z0-9-]+)', line):
            if f.group(1) not in fmts:
                bad.append("%s:%d format %s" % (name, i, f.group(1)))
print(" ".join(bad))
PYREV
)
check "every skill invocation names something real" "" "$phantom"


echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
