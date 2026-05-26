#!/usr/bin/env bash
set -euo pipefail

LABEL=com.hitnetwork.auto-enrich
JSONL=/Users/TJ/.hermes/logs/auto-enrich-runs.jsonl
ERR_LOG=/Users/TJ/.gbrain/integrations/auto-enrich/launchd.err.log

# Was there a JSONL row in the last 3 hours (StartInterval=7200 + 1h slack)?
NOW=$(date +%s)
THRESHOLD=$((NOW - 10800))
RECENT=$(python3 -c "
import json
from datetime import datetime
n = 0
with open('$JSONL') as f:
    for line in f:
        try:
            row = json.loads(line)
            ts = datetime.fromisoformat(row['run_id'].replace('Z','+00:00')).timestamp()
            if ts >= $THRESHOLD:
                n += 1
        except Exception: pass
print(n)")

# Check last-exit-code from launchd
LAST_EXIT=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep "last exit code" | awk '{print $NF}' || echo "-")

if [[ "$RECENT" -eq 0 ]] || [[ "$LAST_EXIT" != "0" && "$LAST_EXIT" != "-" ]]; then
  # Failure detected. Tail BOTH logs for the alert.
  TAIL_ERR=$(tail -30 "$ERR_LOG" 2>/dev/null || echo "(no err log)")
  TAIL_PIPELINE=$(tail -30 /Users/TJ/.gbrain/integrations/auto-enrich/pipeline.log 2>/dev/null || echo "(no pipeline log)")

  # Self-heal: bootout launchd, resume Hermes cron, alert TJ
  launchctl bootout "gui/$(id -u)/$LABEL" || true
  hermes cronjob action=resume job_id=ff688e4f0d19 || true

  # Emit structured alert (Hermes cron will deliver to LexTech topic 256)
  echo "AUTO_ENRICH_WATCHDOG_ALERT recent_rows=$RECENT last_exit=$LAST_EXIT"
  echo "--- last 30 lines launchd.err.log ---"
  echo "$TAIL_ERR"
  echo "--- last 30 lines pipeline.log ---"
  echo "$TAIL_PIPELINE"
  exit 1
fi

# All clear (silent in watchdog mode per HEARTBEAT_OK convention)
exit 0
