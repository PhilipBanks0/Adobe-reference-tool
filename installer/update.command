#!/bin/bash
# Updates the Workpaper Reference Tool from the latest GitHub release (macOS).
#   update.command            check, show what's new, ask, install
#   update.command --check    report only (exit 10 = update available)
#   update.command --yes      install without asking
set -uo pipefail
REPO="${REFTOOL_REPO:-PhilipBanks0/Adobe-reference-tool}"
API="${REFTOOL_API:-https://api.github.com}"
ROOT="${REFTOOL_ACROBAT_ROOT:-$HOME/Library/Application Support/Adobe/Acrobat}"
MODE="${1:-}"

vernum() { echo "${1#v}" | cut -d- -f1 | awk -F. '{ printf "%d%06d%06d", $1, $2, $3 }'; }

installed=""
for f in "$ROOT"/*/JavaScripts/ReferenceTool.js; do
  [ -f "$f" ] && installed="$(sed -n 's/.*var VERSION = "\([^"]*\)".*/\1/p' "$f" | head -1)" && break
done
echo "Installed version: ${installed:-not installed}"

json="$(curl -fsSL -H 'User-Agent: ReferenceTool-Updater' "$API/repos/$REPO/releases/latest")" || {
  echo "Couldn't reach GitHub. Download manually from https://github.com/$REPO/releases"; exit 2; }
field() { printf '%s' "$json" | tr ',' '\n' | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1; }
tag="$(field tag_name)"; latest="${tag#v}"
echo "Latest release:    $latest"

if [ -n "$installed" ] && [ "$(vernum "$latest")" -le "$(vernum "$installed")" ]; then
  echo "You're up to date."; exit 0
fi
[ "$MODE" = "--check" ] && exit 10
if [ "$MODE" != "--yes" ]; then
  read -r -p "Install version $latest now? (y/N) " a
  [[ "$a" =~ ^[Yy] ]] || { echo "No changes made."; exit 0; }
fi

urls="$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p')"
zipurl="$(echo "$urls" | grep '/ReferenceTool-[^/]*\.zip$' | head -1)"
sumurl="$(echo "$urls" | grep '/SHA256SUMS.txt$' | head -1)"
[ -n "$zipurl" ] || { echo "This release has no installer zip."; exit 3; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
zipname="$(basename "$zipurl")"
curl -fsSL -o "$work/$zipname" "$zipurl" || { echo "Download failed."; exit 1; }
if [ -n "$sumurl" ]; then
  curl -fsSL -o "$work/SHA256SUMS.txt" "$sumurl" || { echo "Checksum download failed."; exit 1; }
  expected="$(grep " \*\{0,1\}$zipname\$" "$work/SHA256SUMS.txt" | awk '{print $1}')"
  actual="$(shasum -a 256 "$work/$zipname" 2>/dev/null || sha256sum "$work/$zipname")"; actual="${actual%% *}"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Download failed its integrity check. Nothing was installed."; exit 1; }
  echo "Download verified."
fi
unzip -q "$work/$zipname" -d "$work/u"
inst="$(find "$work/u" -name install.command | head -1)"
[ -n "$inst" ] || { echo "install.command not found in release."; exit 1; }
bash "$inst" && echo "Updated to version $latest."
