#!/usr/bin/env bash
# check-customizations.sh
# Preflight check: diff current master against an upstream reference, identify
# Lex-local files NOT in the manifest, fail closed if drift exists.
#
# Run this BEFORE any upstream upgrade. If it exits non-zero, the manifest is
# stale; update it before pulling.
#
# Born 2026-05-19 (card kn790wa0geb39f9ytdh48tn011871fva).
#
# Usage:
#   ./scripts/check-customizations.sh                  # default upstream=origin/master
#   ./scripts/check-customizations.sh fork/master      # compare against fork
#   ./scripts/check-customizations.sh pre-v036-rollback # validate against the audit seed
#
# Exit codes:
#   0  no drift, manifest is complete
#   1  setup error (missing jq, git, manifest)
#   2  drift found: files on master that look Lex-local but are missing from manifest
#   3  manifest references files that DON'T exist on master AND aren't recoverable (audit mode)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/lex-customizations-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "FATAL: manifest not found at $MANIFEST" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq required" >&2
  exit 1
fi

UPSTREAM_REF="${1:-origin/master}"

cd "$REPO_ROOT"

# Verify the upstream ref exists locally
if ! git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  echo "FATAL: upstream ref '$UPSTREAM_REF' not found. Try 'git fetch origin'." >&2
  exit 1
fi

CURRENT_HEAD="$(git rev-parse --short HEAD)"
UPSTREAM_HEAD="$(git rev-parse --short "$UPSTREAM_REF")"

echo "=========================================="
echo "GBrain check-customizations"
echo "Local HEAD: $CURRENT_HEAD"
echo "Compare against: $UPSTREAM_REF ($UPSTREAM_HEAD)"
echo "Manifest: $MANIFEST"
echo "=========================================="

# --- Build the set of files in the manifest ---
MANIFEST_PATHS_FILE=$(mktemp)
trap 'rm -f "$MANIFEST_PATHS_FILE" "$LOCAL_FILES_FILE" "$MODIFIED_FILES_FILE" "$DROPPED_AUDIT_FILE"' EXIT
jq -r '.entries[].path' "$MANIFEST" | sort -u > "$MANIFEST_PATHS_FILE"
MANIFEST_COUNT=$(wc -l < "$MANIFEST_PATHS_FILE" | tr -d ' ')
echo "Manifest entries: $MANIFEST_COUNT"

# --- Find files Added on HEAD vs upstream (Lex-local new files) ---
# Filter A only: files present on HEAD but absent on upstream. These are the
# files at risk of silent drop across upgrades and MUST appear in the manifest.
# Modified-upstream files (filter M) are tracked separately as advisory; they
# represent fork drift on upstream-owned paths and are not "new customizations".
LOCAL_FILES_FILE=$(mktemp)
git diff --name-only --diff-filter=A "$UPSTREAM_REF"..HEAD > "$LOCAL_FILES_FILE"
LOCAL_COUNT=$(wc -l < "$LOCAL_FILES_FILE" | tr -d ' ')
echo "New (Added) files on HEAD vs $UPSTREAM_REF: $LOCAL_COUNT"

# Also count modified-upstream files for the advisory tail.
MODIFIED_FILES_FILE=$(mktemp)
git diff --name-only --diff-filter=M "$UPSTREAM_REF"..HEAD > "$MODIFIED_FILES_FILE"
MODIFIED_COUNT=$(wc -l < "$MODIFIED_FILES_FILE" | tr -d ' ')
echo "Modified upstream files on HEAD vs $UPSTREAM_REF: $MODIFIED_COUNT"

# --- Build "audit mode" view: which manifest entries are MISSING on HEAD? ---
# This is the post-upgrade safety check. If a manifest row's path is absent
# from HEAD, that file got dropped and needs reapply.
DROPPED_AUDIT_FILE=$(mktemp)
while IFS= read -r path; do
  if [[ -n "$path" && ! -e "$REPO_ROOT/$path" ]]; then
    echo "$path" >> "$DROPPED_AUDIT_FILE"
  fi
done < "$MANIFEST_PATHS_FILE"
DROPPED_COUNT=0
if [[ -s "$DROPPED_AUDIT_FILE" ]]; then
  DROPPED_COUNT=$(wc -l < "$DROPPED_AUDIT_FILE" | tr -d ' ')
fi
echo "Manifest entries currently MISSING from HEAD: $DROPPED_COUNT"
echo "=========================================="

# --- Drift category A: Lex-local files on HEAD not declared in manifest ---
# Filter heuristics: ignore generated/build artifacts and upstream-owned files.
# A file qualifies as "needs manifest" if:
#   (a) it's added vs upstream
#   (b) NOT in the manifest
#   (c) NOT in the ignore patterns
# Note: ignore regex is grep -E (BRE+); patterns are matched against full path.
# Use alternation explicitly; do NOT anchor with ^ unless intended.
IGNORE_REGEX='(^admin/dist/|^llms\.txt$|^llms-full\.txt$|^bun\.lock$|^VERSION$|^CHANGELOG\.md$|^TODOS\.md$|^CLAUDE\.md$|^README\.md$|^package\.json$|^bunfig\.toml$|^docs/incidents/|^docs/architecture/|^docs/designs/|^docs/embedding-migrations\.md$|^docs/integrations/|^docs/operations/|^\.github/workflows/heavy-tests\.yml$|^recipes/auto-enrich|__pycache__/|\.pyc$)'

MISSING_FROM_MANIFEST=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if echo "$path" | grep -qE "$IGNORE_REGEX"; then
    continue
  fi
  if ! grep -qxF "$path" "$MANIFEST_PATHS_FILE"; then
    MISSING_FROM_MANIFEST+=("$path")
  fi
done < "$LOCAL_FILES_FILE"

# --- Drift category B: manifest entries with dropped files (audit/post-upgrade) ---
DROPPED_LIST=()
if [[ -s "$DROPPED_AUDIT_FILE" ]]; then
  while IFS= read -r path; do
    DROPPED_LIST+=("$path")
  done < "$DROPPED_AUDIT_FILE"
fi

# --- Report ---
EXIT_CODE=0

if [[ ${#DROPPED_LIST[@]} -gt 0 ]]; then
  echo ""
  echo "🔴 DROPPED-FILE AUDIT: ${#DROPPED_LIST[@]} manifest entries are MISSING from HEAD"
  echo "   These files need to be restored via ./scripts/reapply-customizations.sh"
  for p in "${DROPPED_LIST[@]}"; do
    echo "     - $p"
  done
  EXIT_CODE=3
fi

if [[ ${#MISSING_FROM_MANIFEST[@]} -gt 0 ]]; then
  echo ""
  echo "🟡 MANIFEST DRIFT: ${#MISSING_FROM_MANIFEST[@]} Lex-local files on HEAD NOT in manifest"
  echo "   Add these to lex-customizations-manifest.json before upgrading, or they will"
  echo "   be lost across the next upstream pull."
  for p in "${MISSING_FROM_MANIFEST[@]}"; do
    echo "     - $p"
  done
  # category A overrides category B (manifest is incomplete; can't trust audit yet)
  EXIT_CODE=2
fi

if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "✅ CLEAN: manifest covers every Lex-local path on HEAD."
  echo "   $MANIFEST_COUNT manifest entries verified."
fi

exit $EXIT_CODE
