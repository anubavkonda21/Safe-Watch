#!/usr/bin/env bash
# Builds the local visual-analysis helper (Apple Vision, macOS only) into bin/ (git-ignored).
#   scripts/build-vision-helper.sh
# Needs the Swift compiler (Xcode or Command Line Tools). Rebuilds only when the source is newer.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = "Darwin" ] || { echo "The Apple Vision helper builds on macOS only." >&2; exit 2; }
command -v swiftc >/dev/null || { echo "swiftc not found: install the Xcode Command Line Tools (xcode-select --install)." >&2; exit 2; }
mkdir -p bin
build() { # name source
  if [ ! -x "bin/$1" ] || [ "native/apple-vision/$2" -nt "bin/$1" ]; then
    echo "building bin/$1"
    swiftc -O -o "bin/$1" "native/apple-vision/$2"
  fi
}
build safewatch-vision main.swift
build render-text render-text.swift
