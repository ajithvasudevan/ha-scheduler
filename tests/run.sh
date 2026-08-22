#!/usr/bin/env bash
# Everything that can be checked without a running Home Assistant.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -m compileall -q custom_components/tsvk_scheduler >/dev/null
node --check custom_components/tsvk_scheduler/frontend/tsvk-scheduler-panel.js
node tests/smoke.mjs | tail -1
python3 -m unittest discover -s tests -q
