# Wave 1 Phase 1.1: x_handle backfill

Card: kn713xmc7vrv6rmzjw2k56vyhx87k85m

Backfill `frontmatter.x_handle` on `sources/<handle>/<date>-<slug>` pages that lacked it.

## SQL applied

```sql
BEGIN;
UPDATE pages
SET frontmatter = jsonb_set(frontmatter, '{x_handle}', to_jsonb(replace(split_part(slug, '/', 2), '-', '')))
WHERE slug LIKE 'sources/%/%'
  AND NOT (frontmatter ? 'x_handle')
  AND replace(split_part(slug, '/', 2), '-', '') ~ '^[A-Za-z0-9_]{1,15}$';
COMMIT;
```

## Result

- pre-count missing x_handle: 540
- updated rows: 539
- post-count missing x_handle: 1 (skipped: handle `khairallahalawady` exceeds 15 char X regex)

Report: /tmp/reid-w1p1.1-report.md
