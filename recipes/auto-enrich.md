---
id: auto-enrich
name: Auto-Enrichment Recipe
version: 0.2.0
description: Nightly Cal dispatch that enriches sparse/orphan brain pages with research, citations, and cross-links via claude-haiku-4-5. Phase 2 wires research strategy + Cal dispatch to produce validated research artifacts.
category: sense
requires: []
secrets: []
health_checks:
  - type: env_exists
    name: HOME
    label: Heartbeat directory reachable
setup_time: 30 min
cost_estimate: "$3-5/mo (claude-haiku-4-5, nightly cadence)"
---

# Auto-Enrichment Recipe

Nightly sensor that detects sparse, orphan, or stale entity pages in your brain and (in later phases) dispatches a Cal subagent to research and enrich them. Phase 1 ships the sensor and the recipe scaffold only. Research, quality gate, merge, and cron registration arrive in Phases 2 and 3.

## What this is for

Your brain accumulates pages that start as stubs: a person mentioned once, a company with a name and nothing else, a concept that never got fleshed out. Auto-enrich finds those pages on a regular cadence, ranks them by how sparse they are, and (in Phase 3) feeds a research artifact back through a quality gate before merging.

Phase 1 (this PR) delivers:

- Recipe manifest discoverable via `gbrain integrations list`
- Sensor (`scripts/detect_sparse.py`) that ranks candidate pages via CLI composition (`gbrain list`, `gbrain get`, `gbrain backlinks`)
- Heartbeat logging to `~/.gbrain/integrations/auto-enrich/heartbeat.jsonl`
- TDD test suite for the sensor

## Usage (Phase 1, sensor only)

Run the sensor against your live brain:

```bash
bash recipes/auto-enrich/scripts/run_sensor.sh
```

Or directly:

```bash
python3 recipes/auto-enrich/scripts/detect_sparse.py --limit 5
```

Output is JSON to stdout: a ranked list of `{slug, score, reason, page_type}` records. The script also appends one heartbeat line per run to `~/.gbrain/integrations/auto-enrich/heartbeat.jsonl`.

## Ranking signal

For each candidate page the sensor computes:

- `body_length_penalty` from the body text length returned by `gbrain get <slug>` (target: 1500 chars)
- `link_starvation_penalty` from the inbound edge count returned by `gbrain backlinks <slug>` (target: 3 inbound links)
- `enrichment_age_penalty` from the `last_enriched` frontmatter field if present, otherwise treated as never enriched (target: 90 days)

The score is a weighted sum (defaults: 0.4 / 0.3 / 0.3) clamped to [0, 1]. Higher scores rank first.

## Schedule

Phase 1 has no cron registration. The cron is installed by `scripts/register-cron.sh` in Phase 3 (nightly at 03:00 local, delivered via Hermes cron, no Telegram noise on success).

## Config

See `config.yaml` for ranking weights, target thresholds, and runtime paths. Defaults are intentionally conservative; tune after the first dry-run sees real candidate distributions.

## Files

- `auto-enrich.md` (this manifest, flat at `recipes/` per integrations discovery contract)
- `auto-enrich/README.md` (human-readable extended docs)
- `auto-enrich/config.yaml` (tunables)
- `auto-enrich/scripts/detect_sparse.py` (sensor)
- `auto-enrich/scripts/auto_enrich_lib.py` (Heartbeat + subprocess wrapper)
- `auto-enrich/scripts/run_sensor.sh` (one-shot invoker)
- `auto-enrich/tests/` (pytest suite)
