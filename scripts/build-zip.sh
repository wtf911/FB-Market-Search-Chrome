#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip from an explicit allow-list, so a future
# tests/ or package.json can never ship by accident. Output:
#   marketplace-description-search-v<version>.zip in the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(manifest.json background.js shared.js collector.js content.js popup.html popup.js
       gallery.html gallery.js parked.html panel.css icon16.png icon48.png icon128.png)
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "build-zip: missing $f" >&2; exit 1; }
done
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version")
OUT="marketplace-description-search-v${VERSION}.zip"
rm -f "$OUT"
zip -X -9 "$OUT" "${FILES[@]}" >/dev/null
echo "Built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
