#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re, sys
root = Path.cwd()
failures = []

SCRIPT = root / 'scripts/check-sync-safety-surfaces.sh'
SYNC_PROTECTED = root / 'src/commands/sync.ts'
ALLOWED_DBA = {
    root / 'artifacts/dba/sync-reconciliation-roles.sql',
    root / 'artifacts/dba/sync-reconciliation-roles-rollback.sql',
}
INVENTORY = root / 'artifacts/destructive-path-inventory.md'
INVENTORY_TEXT = ''

if INVENTORY.exists():
    INVENTORY_TEXT = INVENTORY.read_text(errors='ignore')
else:
    failures.append(f'{INVENTORY}: missing destructive-path inventory')

def rel(path: Path) -> str:
    return path.relative_to(root).as_posix()

def is_scanned_surface(path: Path) -> bool:
    parts = path.relative_to(root).parts
    if not parts:
        return False
    if '.git' in path.parts or 'node_modules' in path.parts:
        return False
    if parts[0] in {'test', 'docs', 'skills', 'tasks', 'artifacts'}:
        return False
    if path.name in {'CHANGELOG.md', 'TODOS.md', 'llms.txt', 'llms-full.txt'}:
        return False
    if path.suffix in {'.png', '.jpg', '.jpeg', '.gif', '.pdf', '.lock', '.md', '.txt'}:
        return False
    return parts[0] in {'src', 'scripts', 'recipes', 'config', '.github'}

def is_inventory_represented(path: Path) -> bool:
    return f'`{rel(path)}`' in INVENTORY_TEXT

sync = SYNC_PROTECTED
for lineno, line in enumerate(sync.read_text().splitlines(), 1):
    stripped = line.strip()
    if stripped.startswith('//') or stripped.startswith('*'):
        continue
    if 'engine.deletePage(' in line or 'engine.deletePages(' in line:
        failures.append(f'{sync}:{lineno}: normal sync must not call hard-delete primitives')
    if '.softDeletePage(' in line and 'tx.softDeletePage(' not in line:
        failures.append(f'{sync}:{lineno}: filesystem-derived removals must use reconcileFilesystemRemovals/applySyncReconciliation')
    if 'UPDATE sources SET local_path' in line:
        failures.append(f'{sync}:{lineno}: normal sync must not write sources.local_path')
    if 'GBRAIN_SYNC_RECONCILE_OVERRIDE_REASON' in line:
        failures.append(f'{sync}:{lineno}: env override authorization is forbidden')

for path in [p for p in root.rglob('*') if p.is_file()]:
    if path == SCRIPT or not is_scanned_surface(path):
        continue
    try:
        text = path.read_text(errors='ignore')
    except Exception:
        continue
    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith('#') or stripped.startswith('//') or stripped.startswith('*'):
            continue
        if path == SCRIPT and ('CREATE\\s+ROLE' in line or 'DELETE\\s+FROM\\s+pages' in line or '.deletePage(' in line):
            continue
        if 'grep -nE' in line or 'grep -qE' in line:
            continue
        if re.search(r'\bCREATE\s+ROLE\b', line, re.I) and path not in ALLOWED_DBA:
            failures.append(f'{path}:{lineno}: CREATE ROLE is allowed only in reviewed DBA artifacts')
        if re.search(r'\bgbrain\s+sync\b', line) and '--repo' in line and '--source' not in line:
            failures.append(f'{path}:{lineno}: gbrain sync --repo must include explicit --source')
        destructive = (
            '.deletePage(' in line or '.deletePages(' in line or '.purgeDeletedPages(' in line or
            re.search(r'\bDELETE\s+FROM\s+pages\b', line, re.I)
        )
        if destructive and path != SYNC_PROTECTED and not is_inventory_represented(path):
            failures.append(f'{path}:{lineno}: destructive page operation must be represented in artifacts/destructive-path-inventory.md')

if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print('sync safety static guard passed')
PY
