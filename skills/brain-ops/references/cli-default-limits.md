# CLI default limits and silent truncation

## The trap

`gbrain list` defaults to **50 results** with NO indication the response is truncated. No "showing 50 of N", no warning, no exit code change. The agent reads the output, assumes it's complete, and reports a wrong total to the user.

Same pattern likely applies to `gbrain search` and `gbrain query` (both have `--limit` flags with low defaults). Verify before quoting any count.

## Real-world failure (2026-05-14)

TJ asked "how many people do we have under people in GBrain?"

Wrong workflow:
```
gbrain list | grep -c "^people/"
→ 24
```

Reported "24 people." TJ pushed back from gut: "I thought we should have at least 70."

Real answer:
```
gbrain list --type person --limit 100000 | wc -l
→ 71

psql postgres://localhost:5432/gbrain -c "SELECT count(*) FROM pages WHERE type='person';"
→ 71
```

`gbrain list` had silently returned only the first 50 pages of ALL types, and only 24 of those happened to live under `people/`. The other 47 person pages were past the cutoff.

## Workflow rule

For ANY question of the form "how many X in GBrain" or "what's the total count of Y":

1. **Use the type filter + a huge limit:**
   ```
   gbrain list --type <type> --limit 100000
   ```
   The CLI will still cap at whatever it caps at internally, but you get explicit intent.

2. **Cross-check against Postgres directly** when the engine is `postgres`:
   ```
   psql postgres://localhost:5432/gbrain -c "SELECT count(*) FROM pages WHERE type='<type>';"
   psql postgres://localhost:5432/gbrain -c "SELECT type, count(*) FROM pages GROUP BY type ORDER BY 2 DESC;"
   ```
   This is the source of truth. The CLI is a view on top.

3. **NEVER report a count from a raw `gbrain list` or `gbrain list | wc -l`** without either (a) the `--limit 100000` flag or (b) a Postgres cross-check. The default-50 silently lies.

4. **For PGLite engines** the same default-50 applies. The fallback is to count files on disk under the brain dir, but PGLite + gbrain list is what most non-prod brains use, so the rule is the same: pass an explicit limit.

## Same class as namespace-fallback

This is a sibling pitfall to namespace-fallback-discipline.md: in both cases the CLI gives a partial-truth answer that an unwary agent will treat as complete-truth. The general rule: **GBrain CLI outputs are views, never trusted as complete without explicit limits or a DB cross-check.**

## Cross-reference

- See `references/namespace-fallback-discipline.md` for the sibling pitfall (404 from one namespace ≠ no page anywhere).
- See `gbrain doctor --fast` + `gbrain stats` (if available) for built-in count queries that DON'T have the truncation problem.
