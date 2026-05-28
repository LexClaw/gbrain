#!/usr/bin/env bash
# launchd entrypoint for auto-enrich pipeline. Invoked by
# ~/Library/LaunchAgents/com.hitnetwork.auto-enrich.plist.
# Exit code propagates to launchd (pipefail enforced).

set -euo pipefail

# Absolute paths; launchd does not inherit shell PATH.
PYTHON=/usr/bin/python3
RECIPE_DIR="$HOME/gbrain/recipes/auto-enrich"
PIPELINE_LOG="$HOME/.gbrain/integrations/auto-enrich/pipeline.log"

mkdir -p "$(dirname "$PIPELINE_LOG")"
cd "$RECIPE_DIR"

# Run pipeline. tee preserves the pipeline log AND the launchd
# StandardOutPath. set -o pipefail (above) propagates python exit code.
"$PYTHON" scripts/run_pipeline.py --limit "${AUTO_ENRICH_LIMIT:-3}" 2>&1 | tee -a "$PIPELINE_LOG"
