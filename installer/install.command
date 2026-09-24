#!/bin/bash
# Installs the Workpaper Reference Tool into Adobe Acrobat (macOS).
# Double-click this file in Finder (right-click > Open the first time).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/ReferenceTool.js"
[ -f "$SRC" ] || { echo "ReferenceTool.js not found next to this installer. Unzip the whole release first."; exit 1; }
VERSION="$(sed -n 's/.*var VERSION = "\([^"]*\)".*/\1/p' "$SRC" | head -1)"
ROOT="${REFTOOL_ACROBAT_ROOT:-$HOME/Library/Application Support/Adobe/Acrobat}"

echo "Workpaper Reference Tool $VERSION - installer"
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null || true

installed=0
if [ -d "$ROOT" ]; then
  for d in "$ROOT"/*/; do
    name="$(basename "$d")"
    if [[ "$name" =~ ^(DC|[0-9]{4}|[0-9]+\.[0-9]+)$ ]]; then
      mkdir -p "$d/JavaScripts"
      cp -f "$SRC" "$d/JavaScripts/ReferenceTool.js"
      echo "  Installed add-on to $d""JavaScripts"
      installed=1
    fi
  done
fi
if [ "$installed" = 0 ]; then
  mkdir -p "$ROOT/DC/JavaScripts"
  cp -f "$SRC" "$ROOT/DC/JavaScripts/ReferenceTool.js"
  echo "  Installed add-on to $ROOT/DC/JavaScripts"
fi

APPDIR="${REFTOOL_APP_DIR:-$HOME/Library/Application Support/ReferenceTool}"
mkdir -p "$APPDIR"
cp -f "$HERE/update.command" "$APPDIR/update.command" 2>/dev/null && chmod +x "$APPDIR/update.command" || true
echo "$VERSION" > "$APPDIR/version.txt"

echo ""
echo "Installed version $VERSION. Restart Acrobat, then look for Edit > Reference Tool."
echo "To update later, run: \"$APPDIR/update.command\""
