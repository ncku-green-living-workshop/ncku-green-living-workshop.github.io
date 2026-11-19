#!/usr/bin/env bash
# 產生頁面用的縮圖：assets/{photos,forum}/X.jpg → assets/thumb/{photos,forum}/X.jpg
# 照片牆、每日照片、論壇照片在畫面上只顯示 110–370px 寬，原圖 1400px 太重；
# 原圖留給燈箱放大用。做法沿用 optimize-photos.sh（ffmpeg scale + -q:v）。
# ponytail: 固定 640px / q8（q5→q8 實測最重一張 72→約 50KB，放大兩倍才看得出差異），視網膜螢幕上 320px 顯示仍清晰；要更小改 WIDTH。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIDTH=640
QUALITY=8

made=0; skipped=0
for dir in photos forum; do
  mkdir -p "$ROOT/assets/thumb/$dir"
  for f in "$ROOT/assets/$dir"/*.jpg; do
    out="$ROOT/assets/thumb/$dir/$(basename "$f")"
    if [ -f "$out" ] && [ "${FORCE:-0}" != "1" ]; then skipped=$((skipped+1)); continue; fi
    ffmpeg -v error -i "$f" -vf "scale=${WIDTH}:-2" -q:v "$QUALITY" "$out" -y
    made=$((made+1))
  done
done
echo "產生 $made 張，跳過 $skipped 張既有縮圖（FORCE=1 可重做）"
du -sh "$ROOT/assets/thumb" | awk '{print "縮圖總大小: "$1}'
