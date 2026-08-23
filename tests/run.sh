#!/usr/bin/env bash
# Everything that can be checked without a running Home Assistant.
set -euo pipefail
cd "$(dirname "$0")/.."

# Byte-compiling is a syntax check. The .pyc files it (and the tests) leave behind are
# for this machine's Python, not the one Home Assistant runs, so they are cleared at
# the end rather than shipped.
cleanup() { find custom_components tests -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true; }
trap cleanup EXIT

python3 -m compileall -q custom_components/tsvk_scheduler >/dev/null
node --check custom_components/tsvk_scheduler/frontend/tsvk-scheduler-panel.js
node tests/smoke.mjs | tail -1
python3 -m unittest discover -s tests -q
