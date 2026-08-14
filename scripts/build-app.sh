#!/bin/bash
# Package AI Refrigerator as a self-contained macOS .app plus a zip to attach to a
# GitHub release. No build tooling: the bundle is a folder, the payload is a copy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
APP="$OUT/AI Refrigerator.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

cp "$ROOT/AI Refrigerator.app/Contents/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/AI Refrigerator.app/Contents/MacOS/run" "$APP/Contents/MacOS/run"
cp "$ROOT/AI Refrigerator.app/Contents/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
chmod +x "$APP/Contents/MacOS/run"

# Everything the server needs at runtime, and nothing else — no .git, no site/ mirror
for p in server.js package.json public data presets hooks LICENSE README.md docs; do
  cp -R "$ROOT/$p" "$APP/Contents/Resources/app/"
done

# Keep the bundle version in step with package.json
sed -i.bak \
  -e "s|<key>CFBundleVersion</key><string>[^<]*</string>|<key>CFBundleVersion</key><string>$VERSION</string>|" \
  -e "s|<key>CFBundleShortVersionString</key><string>[^<]*</string>|<key>CFBundleShortVersionString</key><string>$VERSION</string>|" \
  "$APP/Contents/Info.plist"
rm -f "$APP/Contents/Info.plist.bak"

# Unsigned build, so clear quarantine here; users get the same hint in the README
xattr -cr "$APP" 2>/dev/null || true

( cd "$OUT" && zip -qry "AI-Refrigerator-macOS-$VERSION.zip" "AI Refrigerator.app" )

echo "built: $APP"
echo "zip:   $OUT/AI-Refrigerator-macOS-$VERSION.zip"
