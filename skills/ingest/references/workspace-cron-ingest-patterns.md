# Workspace Cron Ingest Patterns

Operational patterns for running the workspace ingest cron (or any batch
ingest of files-from-disk into the brain). Captures lessons from
production runs against `~/hermes-workspace/Lex-Workspace/` directories.

## Pattern 1: Check for collector-prior pages BEFORE creating

Several workspace directories are already swept by background collectors
that create canonical brain pages on a schedule:

| Workspace path | Collector creates | Slug pattern |
|---|---|---|
| `memory/YYYY-MM-DD.md` | `lex-workspace-collector.py` | `lex-workspace/daily/YYYY-MM-DD` |
| `decisions/YYYY-MM.md` | `lex-workspace-collector.py` | `lex-workspace/decisions/YYYY-MM` |
| `TJ-TRAINING.md` synthesis | `migrate-synthesis-to-brain.py` | `lex-workspace/tj-training` |
| `.learnings/LEARNINGS.md` | collector | `lex-workspace/learnings/promoted` |

**Before creating a new page from a workspace file, run:**

```bash
gbrain search "<file's primary subject>" --limit 3 --output files-only
```

If a `lex-workspace/...` slug already exists with content matching the
file, **do NOT re-create it under a different slug**. Instead:

1. Verify the brain page is current (`gbrain get <slug>` — compare to
   the workspace file's mtime or `source_sha256` in frontmatter).
2. Add cross-links from the canonical brain page to other entities
   you create or update from sibling files.
3. Add timeline entries on related entity pages (e.g., `people/wiki/tj-shedd`)
   citing the canonical brain slug as source, not the workspace path.
4. Mark the workspace file processed in `.gbrain-ingested.log` anyway,
   so the next run skips it.

**Why:** creating a duplicate page under `workspace/...` or `research/...`
when `lex-workspace/daily/...` already exists fractures the back-link
graph and breaks the brain-first read hook's slug resolution.

## Pattern 2: Writing pages via `gbrain put <slug> < file.md`

The CLI accepts page content on stdin. For multi-paragraph pages with
YAML frontmatter, write to a tempfile and redirect:

```python
import tempfile, subprocess, os

content = """---
type: business
title: MyOS
status: launching
---

# MyOS

> Short description.

## State (YYYY-MM-DD)

Body with [Source: ...] citations.
"""

tmp = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
tmp.write(content)
tmp.close()
subprocess.run(f"gbrain put <type/slug> < {tmp.name}", shell=True, check=True)
os.unlink(tmp.name)
```

**Why tempfile + redirect over heredoc:**
- Heredoc bash blocks containing YAML frontmatter or markdown headers
  trip the cron safety gate (see `gbrain-cron-ops` P11).
- Python tempfile + shell redirect runs through `execute_code` subprocess
  cleanly with no quoting hazards.
- Multi-line content with backticks, dollar signs, or `${...}` patterns
  survives the file write without bash interpretation.

**Verification after put:**

```bash
gbrain get <slug> | head -20      # confirm frontmatter + state section
gbrain backlinks <slug>            # confirm linked entities back-link
gbrain timeline <slug>             # confirm timeline entries persisted
gbrain stats | grep "^Pages:"      # confirm count delta
```

## Pattern 3: Auto-links vs hand-authored links

`gbrain put` returns an `auto_links` block:

```json
"auto_links": {
  "created": 3,
  "removed": 0,
  "errors": 0,
  "unresolved": [{"field": "source", "name": "workspace/..."}]
}
```

- `created`: links the writer detected from `[[wikilinks]]` and frontmatter
  fields (parent_org, attendees, etc.) and persisted automatically.
- `unresolved`: fields the writer could not resolve to a slug. Common for
  `source: workspace/<path>.md` frontmatter values (workspace paths are
  not brain slugs). Safe to ignore for source provenance; the citation
  in body text carries the real source.

**Hand-authored links are still required** for relationships the writer
can't infer: `led-by`, `operated-by`, `built-on`, `requested-by`, etc.
Auto-links handle the obvious (wikilinks in body), hand-authored handle
the semantic.

## Pattern 4: Timeline date semantics

`gbrain timeline-add <slug> YYYY-MM-DD "<text>"` accepts the date as
local-date and stores it as `<previous-day> 20:00:00 ET` in the timeline
view. This is cosmetic display, not a real off-by-one. The timeline
query and graph still correlate correctly. Do not adjust the input date
to compensate.

## Pattern 5: Filter agent persona slugs (cross-cluster)

When the workspace file mentions agent personas (Reid, Grant, Cal, Ed,
Max, Nora, Sage, Buzz), do NOT create `people/wiki/<agent>` links.
These pages do not exist and `gbrain link` returns `{"status":"ok"}`
without persisting. See `gbrain-architecture-ops` Step 3 for the full
trap explanation. Real person pages that exist: `people/wiki/tj-shedd`,
`people/wiki/kelly-kellam`, `people/wiki/tim-shedd`,
`people/wiki/drew-weidert`, `people/wiki/nick-valdez-deezy`, plus
others — verify via `gbrain search "<name>"` per session.

## Pattern 6: `.gbrain-ingested.log` hygiene

The log at `~/hermes-workspace/Lex-Workspace/.gbrain-ingested.log` stores
**absolute paths**, one per line. Append on success, never on partial-
failure. The cron's set-difference (all_files minus log_lines) is what
drives the next run's queue; a stale log line silently drops a file
from future runs.

### Path-normalization trap (2026-05-16, learned the hard way)

The log stores absolute paths. `find` from inside `Lex-Workspace/` emits
relative paths. A naive `comm -23 <(find ...) <(sort log)` reports
**every file as unprocessed** because no string matches across the two
sides. Symptom on a previously-drained workspace: backlog count equals
total file count (e.g. 241/241), and you re-ingest the entire history.
Each redundant run adds duplicate timeline entries (`timeline-add` is
not idempotent per `gbrain-cron-ops` idempotency contract).

**Always normalize to absolute paths on BOTH sides before set-diff:**

```python
# Correct: both sides absolute
import os
WS = os.path.expanduser("~/hermes-workspace/Lex-Workspace")
LOG = f"{WS}/.gbrain-ingested.log"

all_files = set()
for d in ["research","reports","briefs","people","specs","memory","decisions","guides"]:
    base = f"{WS}/{d}"
    if not os.path.isdir(base): continue
    for root, _, files in os.walk(base):
        for f in files:
            if f.endswith(".md"):
                all_files.add(os.path.join(root, f))  # absolute

with open(LOG) as f:
    logged = set(l.strip() for l in f if l.strip())  # already absolute

remaining = all_files - logged
```

Or in shell, force `find` to emit absolute paths via `find "$PWD/..."`:

```bash
find "$HOME/hermes-workspace/Lex-Workspace/research" \
     "$HOME/hermes-workspace/Lex-Workspace/reports" \
     ... -name "*.md" -type f | sort -u > /tmp/all.txt
sort -u ~/hermes-workspace/Lex-Workspace/.gbrain-ingested.log > /tmp/log.txt
comm -23 /tmp/all.txt /tmp/log.txt
```

**Sanity check before processing:** if the backlog count equals the
total file count AND the log has nonzero lines, you have a path-
normalization mismatch, not a real backlog. Sample one log line:

```bash
head -1 ~/hermes-workspace/Lex-Workspace/.gbrain-ingested.log
# Should start with /Users/... — if so, your scan side must too.
```

If you've already done redundant writes when you catch this: don't try
to roll back the timeline entries (forward-only per cron-ops). Note
the duplicate count in the report, dedupe the log
(`sort -u .gbrain-ingested.log`), and move on. The damage is bounded
to one run's worth of additive timeline entries.

### Recovery if you logged something that did NOT actually land

```bash
grep -v "<bad-path>" ~/hermes-workspace/Lex-Workspace/.gbrain-ingested.log \
  > /tmp/log.fixed && mv /tmp/log.fixed \
  ~/hermes-workspace/Lex-Workspace/.gbrain-ingested.log
```

## Verification checklist (per run)

- [ ] **Pre-flight path-normalization check (Pattern 6).** Sample one
      line from `.gbrain-ingested.log`; confirm it starts with `/Users/`.
      Confirm your scan emits absolute paths too. If backlog count
      equals total file count on a workspace known to be drained, STOP
      and re-check normalization before processing.
- [ ] `gbrain stats` baseline captured BEFORE any writes.
- [ ] For each workspace file: searched for collector-prior page first.
- [ ] New pages created only when no canonical brain slug exists.
- [ ] Hand-authored links use real person slugs (no agent personas).
- [ ] `gbrain stats` after: pages, links, timeline deltas reported.
- [ ] `.gbrain-ingested.log` appended only for successful files.
- [ ] Report leads with delta, not narrative.
