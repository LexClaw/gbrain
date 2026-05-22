# Auto-Enrichment Recipe

Phase 2 (research strategy + Cal dispatch).

## What this directory contains

```
recipes/auto-enrich.md            # discoverable manifest (flat per integrations contract)
recipes/auto-enrich/
  README.md                        # this file
  config.yaml                      # tunables: weights, thresholds, paths
  docs/
    research-artifact-schema.md    # research artifact JSON contract (Phase 2)
  scripts/
    auto_enrich_lib.py             # Heartbeat class + gbrain subprocess wrapper
    detect_sparse.py               # sensor: ranks sparse/orphan/stale pages
    research_strategy.py           # per-type research query plan builder (Phase 2)
    run_research.py                # Cal dispatch + artifact validation (Phase 2)
    run_sensor.sh                  # one-shot bash entry point
  tests/
    test_detect_sparse.py          # TDD coverage for the sensor (15 tests)
    test_research_strategy.py      # TDD for query-plan builder (12 tests)
    test_run_research.py           # TDD for Cal dispatch (16 tests)
    fixtures/                      # research artifact test fixtures (Phase 2)
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

   ### Bootstrap mode

   Until any page in the brain carries `last_enriched`, every candidate hits the maximum age penalty and the term degenerates to a constant 0.3 baseline. That floor washes out body/link signal and ranks a well-developed 8K-char concept page identically to a 200-char stub. To avoid that, the sensor inspects the candidate pool first: if NO page has `last_enriched`, the run flips to `bootstrap_mode=True`, the age term is zeroed, and the body/links weights renormalize (0.4/0.7 and 0.3/0.7) so the score still spans [0, 1]. Once any page in the pool has `last_enriched`, scoring reverts to the original three-term formula. The flag is per-run and visible on each emitted candidate as `bootstrap_mode`.
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

## Phase 2: Research

The research pipeline composes as:

```
sensor candidate -> build_query_plan -> run_research -> artifact
```

1. **Sensor** (Phase 1) identifies sparse pages and emits candidate JSON.
2. **Research strategy** (`scripts/research_strategy.py`) builds a type-specific query plan
   from the candidate's frontmatter and current page content.
   - Person: X handle + LinkedIn + employer website + news
   - Company: website + Crunchbase + news + founder verification
   - Concept: academic + Wikipedia + primary source
   - Other: skip
3. **Cal dispatch** (`scripts/run_research.py`) compiles the query plan and schema into a
   prompt, spawns `hermes -z` with Cal (claude-haiku-4-5), and validates the returned JSON.
4. **Artifact** is written to disk for Phase 3 quality-gate + synthesize.

### Research artifact schema

See `docs/research-artifact-schema.md` for the full schema, field reference, and Iron Law
requirements. Brief summary:

- Cal returns a JSON object with: `target_slug`, `researched_at`, `researcher`, `queries_run`,
  `claims` (each with `citation.url` and `citation.quote`), `structured_facts`,
  `suggested_links`, `narrative_additions`.
- Iron Law: every claim MUST cite. Empty citation -> artifact rejected.

#### X (Twitter) URL handling in the Iron Law gate

The Iron Law gate detects `x.com` and `twitter.com` status URLs (pattern
`<domain>/<handle>/status/<numeric_id>`) and verifies the cited quote via the X
API (`xurl /2/tweets/<id>?tweet.fields=text,note_tweet`) instead of a plain
HTTP fetch. The plain HTTP path cannot see tweet text because `x.com` is a
JavaScript app, so without this branch every claim sourced from a tweet failed
"quote not found on page". For long-form tweets the gate concatenates
`data.text` (truncated at ~280 chars) with `data.note_tweet.text` (full body)
before substring matching. Both sides of the comparison pass through a
normalizer that unescapes HTML entities, applies Unicode NFKC, and collapses
whitespace, so `&gt;` vs `>` and curly vs straight quotes do not produce false
negatives. If `xurl` is missing, times out, or returns a non-2xx, the gate
falls back to the plain HTTP path with the existing fail-open warning.

### Running research

```bash
# Dry-run (prints the planned Cal prompt)
python3 recipes/auto-enrich/scripts/run_research.py \
  --candidate-json /path/to/candidate.json \
  --output-artifact /tmp/artifact.json \
  --dry-run

# Live dispatch (spawns Cal)
python3 recipes/auto-enrich/scripts/run_research.py \
  --candidate-json /path/to/candidate.json \
  --output-artifact /tmp/artifact.json
```

Exit codes: 0 ok, 1 dispatch error, 2 schema validation error, 3 CLI/config error.

## Phase boundaries

- Phase 1 (this PR): sensor + recipe scaffold + heartbeat. No writes.
- Phase 2: research strategy + Cal dispatch + research artifact schema.
- Phase 3: quality gate + synthesize merge + cron registration + live smoke test.
