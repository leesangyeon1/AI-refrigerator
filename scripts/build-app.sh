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

# Native window, not a browser: one compiled binary owning a WKWebView and the server
swiftc -O -target "$(uname -m)-apple-macosx11.0" \
  -o "$APP/Contents/MacOS/AIRefrigerator" "$ROOT/scripts/AIRefrigerator.swift"
chmod +x "$APP/Contents/MacOS/AIRefrigerator"

# App icon from the fridge logo, built with the OS's own tools
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ROOT/public/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ROOT/public/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

# Everything the server needs at runtime, and nothing else — no .git, no site/ mirror
for p in server.js package.json public data presets hooks LICENSE README.md docs; do
  cp -R "$ROOT/$p" "$APP/Contents/Resources/app/"
done

# Version in step with package.json; the packaged app runs the compiled binary and
# wants a Dock icon, unlike the repo bundle's background shell launcher
sed -i.bak \
  -e "s|<key>CFBundleVersion</key><string>[^<]*</string>|<key>CFBundleVersion</key><string>$VERSION</string>|" \
  -e "s|<key>CFBundleShortVersionString</key><string>[^<]*</string>|<key>CFBundleShortVersionString</key><string>$VERSION</string>|" \
  -e "s|<key>CFBundleExecutable</key><string>run</string>|<key>CFBundleExecutable</key><string>AIRefrigerator</string>|" \
  -e "/<key>LSUIElement<\/key><true\/>/d" \
  "$APP/Contents/Info.plist"
rm -f "$APP/Contents/Info.plist.bak"

# Unsigned build, so clear quarantine here; users get the same hint in the README
xattr -cr "$APP" 2>/dev/null || true

( cd "$OUT" && zip -qry "AI-Refrigerator-macOS-$VERSION.zip" "AI Refrigerator.app" )

echo "built: $APP"
echo "zip:   $OUT/AI-Refrigerator-macOS-$VERSION.zip"
