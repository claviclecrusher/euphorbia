#!/bin/bash
# Render the two icons to every size the builds need. Run from the repo root.
#   build/icon.svg        full icon: README and the project loading screen
#   build/icon-small.svg  round icon: the app icon at every size
# Output: build/icon.png (1024), build/icons/NxN.png (Linux), build/icon.ico
# (Windows, all sizes), src/icon.png and src/icon-small.png (windows).
set -e
E=node_modules/electron/dist/electron
TMP=$(mktemp -d)
cat > "$TMP/render.js" <<'EOF'
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [svg, out, size] = process.argv.slice(-3);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const n = Number(size);
  const w = new BrowserWindow({ width: n, height: n, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const data = fs.readFileSync(svg, 'utf8');
  await w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(data).toString('base64')}" width="${n}" height="${n}"></body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: n, height: n });
  fs.writeFileSync(out, img.resize({ width: n, height: n }).toPNG());
  app.quit();
});
EOF
render() { "$E" --no-sandbox --disable-gpu "$TMP/render.js" "$1" "$2" "$3" >/dev/null 2>&1; }
mkdir -p build/icons
# The app icon (exe, shortcuts, desktop, taskbar, Linux menus) is the round
# icon at every size; Windows picks 128/256 px for desktop icons on scaled
# displays, so the large sizes must be round too.
for n in 1024 512 256 128 64 48 32 24 16; do render build/icon-small.svg build/icons/${n}x${n}.png $n; done
cp build/icons/1024x1024.png build/icon.png
render build/icon.svg src/icon.png 256
render build/icon-small.svg src/icon-small.png 256
convert build/icons/256x256.png build/icons/128x128.png build/icons/64x64.png build/icons/48x48.png \
  build/icons/32x32.png build/icons/24x24.png build/icons/16x16.png build/icon.ico
rm -rf "$TMP"
echo "icons rendered"
