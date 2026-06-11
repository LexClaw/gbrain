# Root-cause: GBrain facts table wiped after every insertion

Task: t_f30cefdb | Reviewer: Grant | Investigation: read-only / no-spend | 2026-06-11

## Verdict

**Root cause found and proven.** The nightly conversation-facts pass works correctly
and inserts facts. A *different* phase in the same cycle — `extract_facts` — deletes
them. The two phases share a keyspace, but `extract_facts` treats the markdown
`## Facts` fence as the sole source of truth and wipes any DB row keyed to a slug it
reconciles, **regardless of which `source` wrote it**. Conversation-mined facts live
only in the DB index (no markdown fence on session pages), so they are deleted and
never re-inserted. The drain is monotonic: once a session's facts are wiped they
cannot come back.

This is a code defect in an unscoped DELETE, not a cron/config problem.

## Primary evidence

### 1. What was wiped (DB, read-only)
```
facts (now)               : 0 rows
facts_backup_20260606     : 9039 rows
  source breakdown of backup:
    cli:extract-conversation-facts            7973 rows  (279 slugs)
    cli:extract-conversation-facts:terminal   1066 rows  (1066 slugs)
  source_markdown_slug set : 9039 / 9039  (ALL rows)
  sample slugs             : sessions/2026-04-28-1505-4a816e, sessions/2026-04-25-..., ...
```
Every wiped row is conversation-mined and keyed to a `sessions/...` slug. No
fence-origin rows were in the table.

### 2. The two colliding writers
- **conversation_facts_backfill** (cycle phase, runs LATE): inserts via
  `extract-conversation-facts` with `source = 'cli:extract-conversation-facts'`
  (+`:terminal`) and `source_markdown_slug = <session slug>`.
  - Its own replay cleanup (`deleteOrphanFactsForPage`,
    `src/commands/extract-conversation-facts.ts:587-617`) is correctly scoped:
    `... AND source LIKE 'cli:extract-conversation-facts%'`.
- **extract_facts** (cycle phase, runs EARLIER): reconciles the DB index from each
  page's `## Facts` markdown fence. Fence facts get `source = 'fence:reconcile'`
  (`src/core/facts/extract-from-fence.ts:57,216`).

### 3. The unscoped DELETE (the bug)
`src/core/cycle/extract-facts.ts:215` calls:
```ts
const deleted = await engine.deleteFactsForPage(slug, sourceId);
```
which runs (`src/core/postgres-engine.ts:3477-3482`):
```sql
DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
```
**No `source` filter.** For every reconciled slug it deletes ALL rows with that
`source_markdown_slug` — including the `cli:extract-conversation-facts` rows. Then,
because session pages have no `## Facts` fence, `parsed.facts.length === 0` and the
loop `continue`s at line 218 without re-inserting anything (net wipe).

The phase's own doc comment (lines 19-22) only reasons about NULL-slug legacy rows
surviving; it never anticipated a *second writer* populating `source_markdown_slug`
with a non-fence source. That is exactly what `conversation_facts_backfill` does.

### 4. Phase ordering inside one cycle (`src/core/cycle.ts`)
`sync (1513) → extract (1575) → extract_facts (1607) → ... → conversation_facts_backfill (1941)`
`extract_facts` runs with `slugs = syncPagesAffected` (cycle.ts:1530,1627). Any session
page re-synced from disk enters that set, so its conversation facts are deleted on the
spot. Within a single cycle the late backfill re-inserts a few (e.g. 18 on 06-11), but
the NEXT cycle's `extract_facts` wipes them again the moment that slug re-appears in
`syncPagesAffected`. Autopilot cycles every 300s; over enough cycles every session slug
gets re-touched, draining the table to 0.

### 5. Log confirmation (`~/.gbrain/dream-native.log`, 2026-06-11 02:00 run)
```
"phase": "extract_facts"           factsInserted: 0, factsDeleted: 22   <- wipes, no fence to re-insert
"phase": "conversation_facts_backfill"  facts_inserted: 18, ~$0.2236   <- re-mines a few, which the next cycle wipes
```
The 22 deleted by `extract_facts` are the prior night's conversation facts on that
session; the 18 inserted by backfill are next night's wipe fodder.

## Which process is deleting facts
The `extract_facts` cycle phase, via `BrainEngine.deleteFactsForPage`, executing under
the `com.gbrain.autopilot` launchd daemon
(`/Users/TJ/.gbrain/autopilot-run.sh` → `gbrain autopilot --repo .../wiki`) and the
nightly native dream (`dream-native.log`). Same code path in both PGLite
(`pglite-engine.ts:3376`) and Postgres (`postgres-engine.ts:3477`) engines.

## Proposed fix (code-only, NOT applied — needs review)

Scope the reconcile-loop delete to fence-origin rows only, mirroring how
`extract-conversation-facts` scopes its own cleanup. Two options:

**Option A (preferred, surgical).** Add an optional source-scope arg to the reconcile
delete so `extract_facts` only removes what it owns. In `extract-facts.ts:215`, instead
of `engine.deleteFactsForPage(slug, sourceId)`, delete only
`source IN ('fence:reconcile', '') OR source LIKE 'fence%' OR source IS NULL` for that
slug. Conversation/terminal-sourced rows are then untouched by the reconcile pass and
survive. This preserves the fence-is-canonical contract for fence facts while ending the
cross-source collateral wipe.

**Option B.** Change `deleteFactsForPage` itself to accept a `sourcePrefix`/`sources`
param and pass `'fence%'` from the reconcile loop; leave phantom-redirect
(`phantom-redirect.ts:481`) and consolidate (`consolidate.ts:152`) callers explicit
about which sources they intend to clear. Wider blast radius, needs each caller audited.

Recommendation: Option A, plus a regression test asserting that a page with no fence
but with `cli:extract-conversation-facts` rows keyed to its slug retains those rows
after `runExtractFacts`. There is already test scaffolding deleting by source prefix
(`test/extract-conversation-facts.test.ts:302`) to model from.

**Data recovery is separate and out of scope here.** `facts_backup_20260606` (9039 rows)
exists, but per `REID-facts-fix-deliverable.md` the directive was to re-mine fresh rather
than restore. Whether to restore or re-mine is a TJ decision; either way the fix above
must land FIRST or the next cycle re-wipes whatever is restored/mined.

## Boundaries honored
- No paid extraction run.
- No truncate/restore/mutation of facts or facts_backup_20260606 (read-only SELECTs only).
- No crons/daemons changed.
- Fix proposed, not applied (touches upstream-fork src/ under fork-hygiene; needs review).
