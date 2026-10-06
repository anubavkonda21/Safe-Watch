#!/usr/bin/env bash
# Downloads a whisper.cpp (ggml) model into ./models and verifies its SHA-1 against the
# checksums published by the whisper.cpp project. Model weights are never committed to Git.
#
#   scripts/download-speech-model.sh          # multilingual "base" (141 MB), the SafeWatch default
#   scripts/download-speech-model.sh small    # multilingual "small" (465 MB): recommended for Hindi
set -euo pipefail

MODEL="${1:-base}"
case "$MODEL" in
  base)  SHA1="465707469ff3a37a2b9b8d8f89f2f99de7299dac" ;;
  small) SHA1="55356645c2b361a969dfd0ef2c5a50d530afd8d5" ;;
  *) echo "Unknown model '$MODEL'. Supported here: base, small." >&2; exit 2 ;;
esac

DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
FILE="$DIR/ggml-$MODEL.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
mkdir -p "$DIR"

if [ -f "$FILE" ] && [ "$(shasum -a 1 "$FILE" | cut -d' ' -f1)" = "$SHA1" ]; then
  echo "ggml-$MODEL.bin is already present and verified."
else
  echo "Downloading ggml-$MODEL.bin ..."
  curl -L --fail --progress-bar -o "$FILE.partial" "$URL"
  ACTUAL="$(shasum -a 1 "$FILE.partial" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$SHA1" ]; then
    rm -f "$FILE.partial"
    echo "Checksum mismatch (expected $SHA1, got $ACTUAL). The download was discarded." >&2
    exit 1
  fi
  mv "$FILE.partial" "$FILE"
  echo "Verified SHA-1 $SHA1"
fi
echo "Model ready: $FILE"
echo "Set SAFEWATCH_SPEECH_PROVIDER=whispercpp and SAFEWATCH_SPEECH_MODEL_PATH=$FILE"
