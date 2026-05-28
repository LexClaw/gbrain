#!/usr/bin/env bash
set -euo pipefail

LABEL=com.hitnetwork.auto-enrich
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_PLIST="$SCRIPT_DIR/$LABEL.plist"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"
LOGDIR="$HOME/.gbrain/integrations/auto-enrich"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"

# 1. Source files must exist and be non-empty
[[ -s "$SRC_PLIST" ]] || { echo "ERROR: plist source missing or empty: $SRC_PLIST"; exit 1; }
[[ -x "$WRAPPER" ]] || { echo "ERROR: wrapper not executable: $WRAPPER"; exit 1; }

# 2. plist lints clean
plutil -lint "$SRC_PLIST" || exit 1

# 3. Ensure target dirs exist
mkdir -p "$LAUNCHAGENTS" "$LOGDIR"

# 4. Bootout if already loaded (idempotent)
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Bootout existing $LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" || true
fi

# 5. Copy plist + bootstrap
cp "$SRC_PLIST" "$DEST_PLIST"
launchctl bootstrap "gui/$(id -u)" "$DEST_PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

# 6. Exact-match assertions on launchctl print
PRINT_OUT="$(launchctl print "gui/$(id -u)/$LABEL")"
echo "$PRINT_OUT" | grep -E 'state = (waiting|running|not running)' || { echo "ERROR: job not in expected state"; exit 1; }
echo "$PRINT_OUT" | grep -F "program = $WRAPPER" || { echo "ERROR: program path mismatch"; exit 1; }

# 7. Idempotency self-test (only when --self-test passed)
if [[ "${1:-}" == "--self-test" ]]; then
  echo "Self-test: re-running install once to verify idempotency"
  bash "$0"
  COUNT=$(launchctl list | grep -c "$LABEL" || true)
  [[ "$COUNT" -eq 1 ]] || { echo "ERROR: expected exactly 1 $LABEL job, found $COUNT"; exit 1; }
  echo "Idempotency self-test passed"
fi

echo "Install complete: $LABEL"
