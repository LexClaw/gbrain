# web-to-brain

One-shot URL ingest for GBrain. Fetch a page, extract main content
(`readability-lxml`), write a draft `sources/web/<host>/<slug>.md`,
queue a Hermes subagent to enrich it via the `ingest` skill.

See [`recipe.md`](./recipe.md) for the full architecture, gates,
exception discipline, stdout contract, and troubleshooting.

## Quick start

```bash
# Install Python deps (Hermes venv)
pip3 install beautifulsoup4 readability-lxml requests lxml

# One-shot ingest
gbrain ingest url https://stripe.com/about

# With canonical entity hint
gbrain ingest url https://stripe.com/about --slug companies/stripe

# Dry-run (no brain writes)
gbrain ingest url https://stripe.com/about --dry-run

# Drain enrichment queue (cron does this every 15m)
gbrain ingest url --enrich-queue

# Status
gbrain ingest url --status
```

## Where state lives

- Config + queue + cache: `~/.gbrain/integrations/web-to-brain/`
- Pages written: `sources/web/<host-slug>/<YYYY-MM-DD>-<slug>.md`
- Raw HTML sidecars: uploaded via `gbrain files upload-raw`

## Cron schedule

- `web-to-brain-enrich` - `*/15 * * * *` (drain the enrichment queue
  via Hermes subagents)

Note: v0.1.0 is one-shot only. There is no `*/Nh` poll cron; URLs
enter the pipeline through `gbrain ingest url <u>` on demand.

## Tests

```bash
python3 -m pytest tests/test_lib.py -v
```

43 cases against recorded HTML fixtures, no live network.

## Out of scope (v0.1.0)

- Mode B watchlist + snapshot diffing
- Hash-noise selector suppression (gate 7)
- JS rendering / headless browser
- Non-HTML content (PDF, JSON, video)
