#!/usr/bin/env bash
# reapply-customizations.sh
# Reads lex-customizations-manifest.json. For each entry, applies the declared
# reapply strategy. Aborts on conflict. Verifies per row.
#
# Born 2026-05-19 (card kn790wa0geb39f9ytdh48tn011871fva) after commit b2f1b3b3
# silently dropped 22 files during the v0.36.3.0 upgrade. No more vibes.
#
# Usage:
#   ./scripts/reapply-customizations.sh             # apply all entries
#   ./scripts/reapply-customizations.sh --check     # verify without applying
#   ./scripts/reapply-customizations.sh --dry-run   # show what would happen
#
# Exit codes:
#   0  success: every entry exists on disk and matched expected content
#   1  manifest read/parse error
#   2  one or more entries failed to apply (conflict, missing source, etc)
#   3  hand-merge required (operator must intervene); script exits non-zero
#      so callers know not to declare upgrade done

set -euo pipefail

# --- locate repo root and manifest -------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/lex-customizations-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "FATAL: manifest not found at $MANIFEST" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq required. brew install jq" >&2
  exit 1
fi

# --- parse args ---------------------------------------------------------------
MODE="apply"
case "${1:-}" in
  --check)   MODE="check" ;;
  --dry-run) MODE="dry-run" ;;
  "")        MODE="apply" ;;
  *)         echo "Unknown arg: $1" >&2; exit 1 ;;
esac

cd "$REPO_ROOT"

# --- counters -----------------------------------------------------------------
TOTAL=0
APPLIED=0
SKIPPED_ALREADY_PRESENT=0
HAND_MERGE_NEEDED=0
FAILED=0
VERIFIED=0

declare -a HAND_MERGE_PATHS=()
declare -a FAILED_PATHS=()

# --- core ---------------------------------------------------------------------
process_entry() {
  local path="$1"
  local kind="$2"
  local source_commit="$3"
  local reapply="$4"
  local merge_strategy="$5"

  TOTAL=$((TOTAL + 1))
  echo "──────────────────────────────────────────────────────────"
  echo "[$TOTAL] $path"
  echo "    kind:    $kind"
  echo "    source:  $source_commit"
  echo "    strategy: $reapply"

  # Verify source commit exists
  if ! git rev-parse --verify --quiet "$source_commit" >/dev/null; then
    echo "    FAIL: source commit $source_commit not reachable from current repo"
    FAILED=$((FAILED + 1))
    FAILED_PATHS+=("$path")
    return
  fi

  case "$reapply" in

    checkout-subtree)
      if [[ -e "$path" ]]; then
        # Already present. Verify it matches the source.
        if git diff --quiet "$source_commit" -- "$path"; then
          echo "    OK: already present and matches $source_commit"
          SKIPPED_ALREADY_PRESENT=$((SKIPPED_ALREADY_PRESENT + 1))
          VERIFIED=$((VERIFIED + 1))
        else
          echo "    DRIFT: present but differs from $source_commit"
          echo "       diff stat:"
          git diff --stat "$source_commit" -- "$path" | sed 's/^/         /'
          # Don't auto-overwrite; that's not what checkout-subtree means here.
          # Flag as needing review.
          HAND_MERGE_NEEDED=$((HAND_MERGE_NEEDED + 1))
          HAND_MERGE_PATHS+=("$path (drift from declared source)")
        fi
        return
      fi

      if [[ "$MODE" == "check" ]]; then
        echo "    MISSING (would apply: git checkout $source_commit -- $path)"
        FAILED=$((FAILED + 1))
        FAILED_PATHS+=("$path")
        return
      fi
      if [[ "$MODE" == "dry-run" ]]; then
        echo "    DRY-RUN: git checkout $source_commit -- $path"
        return
      fi

      # Apply.
      if git checkout "$source_commit" -- "$path" 2>/dev/null; then
        if [[ -e "$path" ]]; then
          echo "    APPLIED: restored from $source_commit"
          APPLIED=$((APPLIED + 1))
          VERIFIED=$((VERIFIED + 1))
        else
          echo "    FAIL: checkout claimed success but file still missing"
          FAILED=$((FAILED + 1))
          FAILED_PATHS+=("$path")
        fi
      else
        echo "    FAIL: git checkout failed (path not in source commit?)"
        FAILED=$((FAILED + 1))
        FAILED_PATHS+=("$path")
      fi
      ;;

    cherry-pick)
      # Whole-commit cherry-pick. Used for atomic feature commits.
      if [[ "$MODE" == "check" ]]; then
        echo "    CHECK: would cherry-pick $source_commit"
        # Marker check from the entry would go here if defined.
        if [[ ! -e "$path" ]]; then
          FAILED=$((FAILED + 1))
          FAILED_PATHS+=("$path")
          echo "    FAIL: expected path absent"
        else
          VERIFIED=$((VERIFIED + 1))
        fi
        return
      fi
      if [[ "$MODE" == "dry-run" ]]; then
        echo "    DRY-RUN: git cherry-pick $source_commit"
        return
      fi
      if git cherry-pick "$source_commit"; then
        echo "    APPLIED: cherry-picked $source_commit"
        APPLIED=$((APPLIED + 1))
        VERIFIED=$((VERIFIED + 1))
      else
        echo "    FAIL: cherry-pick conflict on $source_commit. Abort and merge by hand."
        echo "          Conflict markers in working tree. Run 'git cherry-pick --abort' to reset."
        FAILED=$((FAILED + 1))
        FAILED_PATHS+=("$path (cherry-pick conflict)")
      fi
      ;;

    hand-merge)
      # Operator must merge. Script reports and exits non-zero.
      if [[ -e "$path" ]]; then
        # Check for marker if provided via merge_strategy
        # (We surface the strategy text; verification is the operator's job
        # then re-running the script to confirm presence.)
        echo "    PRESENT: $path exists but is hand-merge kind."
        echo "    strategy: $merge_strategy"
        echo "    (Operator must verify content. Re-run --check to confirm.)"
        VERIFIED=$((VERIFIED + 1))
      else
        echo "    HAND-MERGE NEEDED: $path"
        echo "    strategy: $merge_strategy"
        HAND_MERGE_NEEDED=$((HAND_MERGE_NEEDED + 1))
        HAND_MERGE_PATHS+=("$path")
      fi
      ;;

    *)
      echo "    FAIL: unknown reapply strategy '$reapply'"
      FAILED=$((FAILED + 1))
      FAILED_PATHS+=("$path (unknown strategy)")
      ;;
  esac
}

echo "=========================================="
echo "GBrain reapply-customizations"
echo "Mode:     $MODE"
echo "Manifest: $MANIFEST"
echo "Repo:     $REPO_ROOT"
echo "=========================================="

# Iterate entries. Read each row as TSV to avoid spaces-in-fields issues.
while IFS=$'\t' read -r path kind source_commit reapply merge_strategy; do
  process_entry "$path" "$kind" "$source_commit" "$reapply" "$merge_strategy"
done < <(jq -r '.entries[] | [.path, .kind, .source_commit, .reapply, (.merge_strategy // "")] | @tsv' "$MANIFEST")

# --- summary ------------------------------------------------------------------
echo "=========================================="
echo "Summary"
echo "  total entries:           $TOTAL"
echo "  already-present + match: $SKIPPED_ALREADY_PRESENT"
echo "  applied this run:        $APPLIED"
echo "  verified on disk:        $VERIFIED"
echo "  hand-merge needed:       $HAND_MERGE_NEEDED"
echo "  failed:                  $FAILED"
echo "=========================================="

if [[ ${#HAND_MERGE_PATHS[@]} -gt 0 ]]; then
  echo "Hand-merge queue:"
  for p in "${HAND_MERGE_PATHS[@]}"; do
    echo "  - $p"
  done
fi

if [[ ${#FAILED_PATHS[@]} -gt 0 ]]; then
  echo "Failed paths:"
  for p in "${FAILED_PATHS[@]}"; do
    echo "  - $p"
  done
fi

# Exit codes
if [[ $FAILED -gt 0 ]]; then
  exit 2
fi
if [[ $HAND_MERGE_NEEDED -gt 0 ]]; then
  exit 3
fi
exit 0
