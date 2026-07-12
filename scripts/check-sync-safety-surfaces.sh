#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re, sys
root = Path.cwd()
failures = []

sync = root / 'src/commands/sync.ts'
for lineno, line in enumerate(sync.read_text().splitlines(), 1):
    stripped = line.strip()
    if stripped.startswith('//') or stripped.startswith('*'):
        continue
    if 'engine.deletePage(' in line or 'engine.deletePages(' in line:
        failures.append(f'{sync}:{lineno}: normal sync must not call hard-delete primitives')

for path in list(root.glob('scripts/**/*')) + list(root.glob('recipes/**/*')):
    if path.is_dir() or path.name.endswith(('.png', '.jpg', '.jpeg', '.gif', '.pdf')):
        continue
    try:
        text = path.read_text(errors='ignore')
    except Exception:
        continue
    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith('#') or stripped.startswith('//'):
            continue
        if re.search(r'\bgbrain\s+sync\b', line) and '--repo' in line and '--source' not in line:
            failures.append(f'{path}:{lineno}: gbrain sync --repo must include explicit --source')

if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print('sync safety static guard passed')
PY
