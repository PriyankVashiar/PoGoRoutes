#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for cmd in node python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: '$cmd' is required to run the regression suite." >&2
        exit 1
    fi
done

node --test tests/test_worker.js tests/test_script.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
