#!/usr/bin/env bash
# Phase 1 entry point: run the sparse-page sensor once.
# Writes ranked JSON to stdout and appends a heartbeat line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

exec python3 scripts/detect_sparse.py "$@"
