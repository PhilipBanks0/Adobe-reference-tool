#!/bin/bash
# Builds the downloadable release into dist/:
#   dist/ReferenceTool-vX.Y.Z.zip   installer package (Windows + Mac)
#   dist/ReferenceTool.js           the add-on on its own
#   dist/SHA256SUMS.txt             checksums the updater verifies
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
JSVER="$(sed -n 's/.*var VERSION = "\([^"]*\)".*/\1/p' src/ReferenceTool.js | head -1)"
if [ "$VERSION" != "$JSVER" ]; then
  echo "Version mismatch: package.json=$VERSION ReferenceTool.js=$JSVER (run: node scripts/bump-version.js $VERSION)"; exit 1
fi
if [ -n "${RELEASE_TAG:-}" ] && [ "${RELEASE_TAG#v}" != "$VERSION" ]; then
  echo "Tag $RELEASE_TAG doesn't match version $VERSION"; exit 1
fi

NAME="ReferenceTool-v$VERSION"
rm -rf dist && mkdir -p "dist/$NAME/samples"
cp src/ReferenceTool.js "dist/$NAME/"
cp installer/Install.cmd installer/Update.cmd installer/Uninstall.cmd \
   installer/install.ps1 installer/update.ps1 installer/uninstall.ps1 \
   installer/install.command installer/update.command "dist/$NAME/"
cp samples/*.pdf "dist/$NAME/samples/"
sed "s/{{VERSION}}/$VERSION/g" installer/QUICKSTART.txt > "dist/$NAME/QUICKSTART.txt"
chmod +x "dist/$NAME/"*.command

(cd dist && zip -qrX "$NAME.zip" "$NAME")
cp src/ReferenceTool.js dist/ReferenceTool.js
(cd dist && sha256sum "$NAME.zip" ReferenceTool.js > SHA256SUMS.txt)

# Release notes = this version's section of CHANGELOG.md
awk -v v="$VERSION" '
  $0 ~ "^## \\[?v?" v "\\]?" { on=1; next }
  on && /^## / { exit }
  on { print }' CHANGELOG.md > dist/RELEASE_NOTES.md
[ -s dist/RELEASE_NOTES.md ] || echo "Release $VERSION" > dist/RELEASE_NOTES.md

rm -rf "dist/$NAME"
echo "Built release $VERSION:"; ls -l dist
