#!/usr/bin/env bash
# Prepares the test images for the REAL visual-inference tests in server/test/fixtures/vision-cache (git-ignored).
# Photos come from the COCO val2017 set (CC BY 2.0, https://cocodataset.org/#termsofuse) and are verified
# against pinned SHA-256 checksums; the text, black and corrupt frames are generated locally.
# Nothing here is committed: the cache is rebuilt from the pinned list.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=server/test/fixtures/vision-cache
mkdir -p "$DIR"
# The COCO image host's certificate does not validate on every machine; integrity is guaranteed by the checksum instead.
BASE="http://images.cocodataset.org/val2017"
ASSETS=(
  "000000000139.jpg ffe0f0cec3b2e27aab1967229cdf0a0d7751dcdd5800322f0b8ac0dffb3b8a8d"
  "000000000285.jpg f3a2974ce3686332609124c70e3e6a2e3aca43fccf1cd1bd7c5c03820977f57d"
  "000000000632.jpg a4cd7f45ac1ce27eaafb254b23af7c0b18a064be08870ceaaf03b2147f2ce550"
  "000000000724.jpg 5c0e559c75d3969c8e3e297b61f61063f78045c9d4802b526ba616361f3823fd"
  "000000000776.jpg 1dd31e9059c491992be2f562624eb4093e17aee08b4f7baf5ff9ea24543b0a33"
  "000000000785.jpg 83981537a7baeafbeb9c8cb67b3484dc26433f574b3685d021fa537e277e4726"
  "000000000872.jpg c2aa138ee3a59b057a7ba6fc5a6a18e62af531aa7dab78a7bfd33c1cd7e55eb6"
)
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
for entry in "${ASSETS[@]}"; do
  name=${entry%% *}; want=${entry##* }
  if [ -f "$DIR/$name" ] && [ "$(sum "$DIR/$name")" = "$want" ]; then continue; fi
  echo "downloading $name"
  curl -fsS --max-time 120 -o "$DIR/$name.part" "$BASE/$name"
  [ "$(sum "$DIR/$name.part")" = "$want" ] || { rm -f "$DIR/$name.part"; echo "checksum mismatch for $name" >&2; exit 1; }
  mv "$DIR/$name.part" "$DIR/$name"
done
# Generated frames (deterministic, tiny).
if [ ! -f "$DIR/textframe.jpg" ]; then
  bin/render-text "SAFEWATCH VISUAL TEST 2026" "$DIR/textframe.png"
  ffmpeg -v error -y -i "$DIR/textframe.png" -q:v 3 "$DIR/textframe.jpg"
fi
[ -f "$DIR/black.jpg" ] || ffmpeg -v error -y -f lavfi -i color=c=black:s=320x240 -frames:v 1 "$DIR/black.jpg"
[ -f "$DIR/corrupt.jpg" ] || { head -c 3000 /dev/urandom > "$DIR/corrupt.jpg"; printf '\xff\xd8\xff' | cat - "$DIR/corrupt.jpg" > "$DIR/corrupt.tmp" && mv "$DIR/corrupt.tmp" "$DIR/corrupt.jpg"; }
echo "vision test assets ready in $DIR"
