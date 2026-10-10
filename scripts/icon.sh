#!/bin/sh
# Render build/icon.png from the g mark vendored from g-design
# (src/renderer/static/g/brand/icon.svg). Needs rsvg-convert: brew install librsvg.
set -e
cd "$(dirname "$0")/.."
rsvg-convert -w 1024 -h 1024 src/renderer/static/g/brand/icon.svg -o build/icon.png
