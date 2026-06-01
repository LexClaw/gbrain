# Engine-Mode Capability Check (PGLite vs Postgres vs Supabase)

**TL;DR:** Before recommending or running any brain maintenance skill, check `gbrain config show` for the active engine. The same skill name can be functional, broken, or silently wrong depending on engine. This is the single biggest source of "I told the user this was easy and it wasn't" errors in brain hygiene work.

## The check (always run first)

```bash
gbrain config show
```

Look at the `engine:` line. Three possibilities:

| Engine | Brain lives in | Maintenance posture |
|--------|----------------|---------------------|
| `pglite` | Local PGLite DB (`~/.gbrain/pglite/`) usually paired with a `.md` brain dir under `~/gbrain/` or similar | Both filesystem-walking and DB-walking skills work. FS-walking skills are sometimes faster but DB is authoritative. |
| `postgres` | A Postgres server (Supabase, local, or remote) at `database_url` | Only DB-walking skills work. Filesystem-walking skills either scan the wrong dir (gbrain repo fixtures) or report nothing. |
| `supabase` | Hosted Postgres at Supabase | Same as `postgres`. DB-walking only. |

## Skill capability matrix

| Skill / Command | PGLite (with .md tree) | Postgres / Supabase |
|-----------------|------------------------|---------------------|
| `gbrain search` | ✅ works | ✅ works |
| `gbrain query` | ✅ works | ✅ works |
| `gbrain get <slug>` | ✅ works | ✅ works |
| `gbrain put <slug>` | ✅ works | ✅ works |
| `gbrain list` | ✅ works | ✅ works |
| `gbrain timeline-add` | ✅ works | ✅ works |
| `gbrain link / unlink` | ✅ works | ✅ works |
| `gbrain backlinks <slug>` | ✅ works | ✅ works |
| `gbrain orphans` | ✅ works (DB-side) | ✅ works (DB-side) |
| `gbrain doctor` | ✅ works | ✅ works |
| `gbrain extract --source db` | ✅ works | ✅ works |
| `gbrain extract --source fs` | ✅ works against the brain dir | ❌ no brain dir to walk |
| `gbrain lint <dir>` | ⚠️ works against the dir passed | ❌ walks the wrong tree (often the gbrain repo's `test/fixtures/`) |
| `gbrain check-backlinks check <dir>` | ✅ works against dir | ⚠️ also works (it talks to the engine, the dir is for output) |
| `citation-fixer` skill | ⚠️ FS-mode, works on PGLite + .md | ❌ no .md tree to walk |
| `frontmatter-guard` skill | ⚠️ FS-mode, works on PGLite + .md | ❌ no .md tree to walk |
| `wiki-bulk-enrichment` skill | ⚠️ FS-mode, works on PGLite + .md | ❌ no .md tree to walk |

❌ = the skill loads cleanly and runs without errors, but does NOT operate on the live brain. This is the dangerous case because there's no immediate signal that the work was no-op.

## Today's lesson (2026-05-12)

Lex offered TJ a "low-stakes brain quality menu" that included `citation-fixer`, `frontmatter-guard`, and `gbrain lint`. The brain has been on Postgres for weeks (`gbrain config show: engine: postgres`). All three skills were dead-on-arrival but loaded cleanly enough that the failure mode was "scan completes, reports issues in test fixtures, claim done."

Caught by running `gbrain lint .` from `~/gbrain` and seeing the report header:

> 488 pages scanned. 757 issue(s) in 487 page(s).

`gbrain list | wc -l` shows the actual brain has ~21K pages. 488 was the test fixture count. The lint had been walking the wrong tree.

**Mitigation:** This file now exists. Any future "let's run a low-stakes hygiene pass" session must check `gbrain config show` first, then pick from the right column of the matrix above.

## What to do when engine is Postgres and you need filesystem-style hygiene

The capability gap is real and worth filing. Two paths:

1. **Build DB-aware versions** of the FS-mode skills. The wrapper pattern: iterate via `gbrain list`, fetch via `gbrain get <slug>`, mutate via `gbrain put <slug>`. Slower than `find . -name '*.md' | xargs`, but works against the live brain. Filed as MC card `kn70pe27epm6dpxycynrdkr6h586mgaj` (assigned to Grant, 2026-05-12).

2. **Export-modify-import**: `gbrain export --dir ./out/`, run FS-mode skills against `./out/`, re-import. Wasteful for one-off cleanup but acceptable if the FS skill is much faster and the brain is small enough that round-tripping isn't expensive. Avoid for production unless the cleanup is a one-time migration.

## Quick probe template

When recommending any brain maintenance skill to TJ, paste this first to verify it actually applies:

```bash
echo "=== ENGINE ==="
gbrain config show | grep -E "^  (engine|database_url):"
echo "=== PAGE COUNT (DB-authoritative) ==="
gbrain list | wc -l
echo "=== SAMPLE PAGE TYPES ==="
gbrain list | awk -F'\t' '{print $2}' | sort | uniq -c | sort -rn | head -10
```

If the page count from `gbrain list` doesn't match the page count from `find <brain-dir> -name '*.md' | wc -l`, the brain is engine-authoritative and FS-mode skills will lie to you.
