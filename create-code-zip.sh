#!/usr/bin/env bash
set -euo pipefail

# create-code-zip.sh lives directly inside PoGoRoutes/
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT_NAME="pogo-routes-source.zip"
OUTPUT_PATH="$REPO_ROOT/$OUTPUT_NAME"

if ! command -v zip >/dev/null 2>&1; then
    echo "Error: 'zip' is required but was not found in PATH." >&2
    exit 1
fi

cd "$REPO_ROOT"

# Files/directories that should be included in the source archive.
include_paths=(
    README.md
    assets
    JSON/Quest_List.json
    JSON/cities.json
    .gitignore
    index.html
    map_scraper.py
    requirements.txt
    script.js
    style.css
    tests
    worker.js
)

# Verify that everything we expect to archive exists.
for path in "${include_paths[@]}"; do
    if [[ ! -e "$path" ]]; then
        echo "Error: required repository path is missing: $path" >&2
        exit 1
    fi
done

# Remove the previous archive first.
# Otherwise zip may retain stale files that were renamed/deleted.
rm -f -- "$OUTPUT_PATH"

zip -r "$OUTPUT_PATH" "${include_paths[@]}" \
    -x \
    '.git/*' \
    '.github/*' \
    'JSON/archive/*' \
    'JSON/nyc_quests.json' \
    'JSON/sg_quests.json' \
    'JSON/syd_quests.json' \
    'JSON/uk_quests.json' \
    'JSON/vc_quests.json' \
    'create-code-zip.sh' \
    '*/__pycache__/' \
    '*/__pycache__/*' \
    '*.pyc' \
    '*.pyo' \
    "$OUTPUT_NAME"

echo
echo "Created: $OUTPUT_PATH"
echo
echo "Included:"
unzip -l "$OUTPUT_PATH"