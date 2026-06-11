# Review: Timeline Coverage Backfill Orchestration Plan

**Plan reviewed:** `docs/plans/2026-06-10-timeline-coverage-backfill.md`

## Verdict

APPROVED for orchestration.

## Review checklist

- PASS: Uses the correct execution vehicle for the work shape: `terminal(background=true, notify_on_complete=true)`.
- PASS: Does not shrink work to fit the scheduler. Full DB extractor remains the canonical path.
- PASS: Avoids synthetic timeline spam; uses real DB extraction first and manual batches only as fallback.
- PASS: Includes stale-lock and sync-freshness preflight.
- PASS: Includes post-run doctor verification.
- PASS: Includes direct engine health verification.
- PASS: Includes manual-batch slug preflight if fallback becomes necessary.
- PASS: Uses log capture for the long-running command.

## Required execution adjustment before launch

Use `set -o pipefail` around the `gbrain extract ... | tee` pipeline so the background process exits non-zero if `gbrain extract` fails. Without `pipefail`, `tee` can mask an upstream failure.

Approved command pattern:

```bash
set -o pipefail
gbrain extract timeline --source db 2>&1 | tee "$LOG"
```

## Follow-up after job completion

- Read the final log line and capture pages processed / entries created.
- Run doctor JSON verification.
- Run direct `engine.getHealth()` verification.
- If coverage is still low but moved upward, plan the next targeted real-data pass.
- If coverage does not move, diagnose extractor coverage math before any manual `timeline-add` fallback.
