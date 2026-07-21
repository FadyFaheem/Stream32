#!/usr/bin/env bash
set -euo pipefail

image_name="$(
  python -c \
    'import json; print(json.load(open("../board.json", encoding="utf-8"))["firmware"]["imageName"])'
)"
boards_directory="$(cd ../.. && pwd)"
output_directory="${boards_directory}/dist"

mkdir -p "${output_directory}"
idf.py build
idf.py merge-bin -o "${output_directory}/${image_name}"
cp dependencies.lock \
  "${output_directory}/${image_name%.bin}.dependencies.lock"
