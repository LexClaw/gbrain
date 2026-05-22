#!/bin/bash
# End-to-end smoke for auto-enrich pipeline.
# DRY-RUN mode (default): runs sensor + research + quality gate + synthesize.
# Does NOT call gbrain put. Reviews draft on disk, prints diff.
# Live mode (run with SMOKE_LIVE=1) writes to the brain. TJ approval required.
#
# Mock-Cal toggle: set CAL_DISPATCH_MODE=mock to bypass the live `hermes -z`
# dispatch and have run_research.py read from
# tests/fixtures/research_artifact_good.json instead. Documented in
# run_research.py (run() docstring). Use this when Cal dispatch is
# environmentally blocked but the pipeline plumbing still needs to be
# exercised end-to-end.
set -uo pipefail
cd "$HOME/gbrain/recipes/auto-enrich" || exit 1

DRY_FLAG="--dry-run"
if [ "${SMOKE_LIVE:-0}" = "1" ]; then
  echo "[smoke] LIVE MODE: this WILL write to the brain. 5s safety pause..."
  sleep 5
  DRY_FLAG=""
fi

python3 scripts/run_pipeline.py --limit 1 $DRY_FLAG
