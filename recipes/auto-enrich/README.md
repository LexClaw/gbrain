# Auto-Enrichment Recipe

Phase 1 (sensor + scaffold).

## What this directory contains

```
recipes/auto-enrich.md            # discoverable manifest (flat per integrations contract)
recipes/auto-enrich/
  README.md                        # this file
  config.yaml                      # tunables: weights, thresholds, paths
  scripts/
    auto_enrich_lib.py             # Heartbeat class + gbrain subprocess wrapper
    detect_sparse.py               # sensor: ranks sparse/orphan/stale pages
    run_sensor.sh                  # one-shot bash entry point
  tests/
    test_detect_sparse.py          # TDD coverage for the sensor
```

Runtime state lives at `~/.gbrain/integrations/auto-enrich/` (not committed):

- `heartbeat.jsonl` (append-only health log, pruned to 30 days by `gbrain integrations`)
- `metrics.jsonl` (Phase 3)
- `escalations.jsonl` (Phase 3)

## Running the sensor

```bash
python3 recipes/auto-enrich/scripts/detect_sparse.py --limit 5
```

CLI flags:

- `--limit N`: maximum candidates to return after ranking (default: from config, 5)
- `--config PATH`: alternate config.yaml location
- `--output PATH`: write JSON to file instead of stdout
- `--types T1,T2`: comma-separated page types to scan (default: concept,entity,person,company)
- `--candidate-pool N`: how many oldest-updated pages to inspect per type before scoring (default: 50)

Exit codes:

- 0: success, ranked JSON on stdout (or written to `--output`)
- 1: gbrain subprocess error
- 2: config parse error

## How the sensor works

1. Enumerate candidates per page type using `gbrain list --type <T> --sort updated_asc --limit <pool>`. The TSV columns are `slug, type, date, title`.
2. For each candidate, `gbrain get <slug>` returns the markdown. Parse the YAML frontmatter (between the first two `---` fences) with `yaml.safe_load`. The body length is `len(body_string)`, computed client-side.
3. For each candidate, `gbrain backlinks <slug>` returns a JSON edge array. The inbound link count is the array length.
4. Score each candidate:

   ```
   score =   w_body  * clamp(1 - body_length / target_body_length, 0, 1)
           + w_links * clamp(1 - inbound_count / target_inbound_links, 0, 1)
           + w_age   * clamp(days_since(last_enriched) / max_age_days, 0, 1)
   ```

   When `last_enriched` is absent from the frontmatter (the common case until Phase 3 starts writing it), the age penalty maxes out at 1.0.
5. Sort descending, truncate to `--limit`, emit JSON.

## Discovery contract

Integrations discovery in `src/commands/integrations.ts::loadAllRecipes` walks `recipes/*.md` (flat .md files only, no subdirectory recursion). The manifest is therefore at `recipes/auto-enrich.md`, not `recipes/auto-enrich/recipe.md`. The supporting tree under `recipes/auto-enrich/` is for code, not discovery.

## Heartbeat contract

`auto_enrich_lib.Heartbeat.emit(event, status, details)` appends one JSON line per call to `~/.gbrain/integrations/auto-enrich/heartbeat.jsonl`. Shape matches the format `gbrain integrations` consumes:

```json
{"ts": "2026-05-20T03:00:00Z", "event": "sensor_run", "source_version": "0.1.0", "status": "ok", "details": {"candidates_scanned": 50, "candidates_returned": 5}}
```

`gbrain integrations show auto-enrich` and `gbrain integrations status auto-enrich` read this file and surface the most recent entry.

## Tests

```bash
cd recipes/auto-enrich
python3 -m pytest tests/ -v
```

The test suite mocks the `gbrain` subprocess boundary so it does not touch the live brain. Live verification is documented in the deliverable report.

## Development

Install the recipe's Python deps (scoped to this recipe; gbrain core is TypeScript):

```bash
pip install -r recipes/auto-enrich/requirements.txt
```

Override the gbrain binary for local iteration with the `GBRAIN_BIN` env var. When unset, the sensor calls `gbrain` on `PATH`.

```bash
GBRAIN_BIN=/Users/me/gbrain/bin/gbrain.js python3 recipes/auto-enrich/scripts/detect_sparse.py --limit 5
```

## Phase boundaries

- Phase 1 (this PR): sensor + recipe scaffold + heartbeat. No writes.
- Phase 2: research strategy + Cal dispatch + research artifact schema.
- Phase 3: quality gate + synthesize merge + cron registration + live smoke test.
