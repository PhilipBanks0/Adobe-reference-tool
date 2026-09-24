#!/bin/bash
# End-to-end test for install.command / update.command against a mock GitHub.
# Runs on macOS or Linux; touches only a temp folder.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
export REFTOOL_ACROBAT_ROOT="$T/Acrobat" REFTOOL_APP_DIR="$T/App"
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1"; fi; }
jsver() { sed -n 's/.*var VERSION = "\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1; }
pkg() { # version outdir
  local d="$2/ReferenceTool-v$1"; mkdir -p "$d"
  cp "$ROOT"/installer/* "$d/"; sed "s/var VERSION = \"[^\"]*\"/var VERSION = \"$1\"/" "$ROOT/src/ReferenceTool.js" > "$d/ReferenceTool.js"
  (cd "$2" && zip -qr "ReferenceTool-v$1.zip" "ReferenceTool-v$1")
}
CUR="$(jsver "$ROOT/src/ReferenceTool.js")"
echo "Mac installer tests (current $CUR)"
mkdir -p "$REFTOOL_ACROBAT_ROOT/DC" "$REFTOOL_ACROBAT_ROOT/Other"
pkg "$CUR" "$T/cur" && bash "$T/cur/ReferenceTool-v$CUR/install.command" >/dev/null
check "installs into DC" '[ "$(jsver "$REFTOOL_ACROBAT_ROOT/DC/JavaScripts/ReferenceTool.js")" = "$CUR" ]'
check "skips unrelated folders" '[ ! -d "$REFTOOL_ACROBAT_ROOT/Other/JavaScripts" ]'
check "installs updater" '[ -x "$REFTOOL_APP_DIR/update.command" ]'

mkdir -p "$T/rel" && pkg 9.9.9 "$T/rel"
(cd "$T/rel" && (shasum -a 256 ReferenceTool-v9.9.9.zip 2>/dev/null || sha256sum ReferenceTool-v9.9.9.zip) > SHA256SUMS.txt)
PORT=$((20000 + RANDOM % 20000)); B="http://127.0.0.1:$PORT"
cat > "$T/rel/latest.json" <<J
{"tag_name": "v9.9.9", "body": "notes", "assets": [
 {"name": "ReferenceTool-v9.9.9.zip", "browser_download_url": "$B/download/ReferenceTool-v9.9.9.zip"},
 {"name": "SHA256SUMS.txt", "browser_download_url": "$B/download/SHA256SUMS.txt"}]}
J
python3 "$ROOT/test/mock_github.py" "$PORT" "$T/rel" & SRV=$!; sleep 1.5
export REFTOOL_API="$B" REFTOOL_REPO=o/r
"$REFTOOL_APP_DIR/update.command" --check >/dev/null; rc=$?
check "check reports update (exit 10)" '[ $rc = 10 ]'
cp "$T/rel/SHA256SUMS.txt" "$T/good"; echo "0000  ReferenceTool-v9.9.9.zip" > "$T/rel/SHA256SUMS.txt"
"$REFTOOL_APP_DIR/update.command" --yes >/dev/null; rc=$?
check "bad checksum refused" '[ $rc = 1 ] && [ "$(jsver "$REFTOOL_ACROBAT_ROOT/DC/JavaScripts/ReferenceTool.js")" = "$CUR" ]'
cp "$T/good" "$T/rel/SHA256SUMS.txt"
"$REFTOOL_APP_DIR/update.command" --yes >/dev/null; rc=$?
check "update installs 9.9.9" '[ $rc = 0 ] && [ "$(jsver "$REFTOOL_ACROBAT_ROOT/DC/JavaScripts/ReferenceTool.js")" = "9.9.9" ]'
"$REFTOOL_APP_DIR/update.command" --check >/dev/null; rc=$?
check "up to date afterwards" '[ $rc = 0 ]'
echo; echo "$pass passed, $fail failed"; [ $fail = 0 ]
