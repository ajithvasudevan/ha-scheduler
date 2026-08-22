#!/usr/bin/env bash
# Pull the panel and its test suite in from the working copy in ../panel, then run
# everything. ../panel is where the frontend is developed; this repository is what
# gets installed, so the two must not drift.
set -euo pipefail
cd "$(dirname "$0")"
SRC=../panel

cp "$SRC/tsvk-scheduler-panel.js" custom_components/tsvk_scheduler/frontend/

# The suite loads the panel from its own directory in ../panel; point it at the copy
# this repository ships instead.
sed "s|fs.readFileSync('tsvk-scheduler-panel.js','utf8')|fs.readFileSync(new URL('../custom_components/tsvk_scheduler/frontend/tsvk-scheduler-panel.js', import.meta.url),'utf8')|" \
  "$SRC/smoke.mjs" > tests/smoke.mjs

./tests/run.sh
