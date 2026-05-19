# youtube-channel-to-brain

Subscribe to YouTube channels, get their new videos into GBrain as enriched
pages with author back-links and timeline entries. Polls public RSS (no API
key, no quota), pulls transcripts via `yt-dlp`, hands off to the
`media-ingest` skill for summary + entity extraction.

See [`recipe.md`](./recipe.md) for the full architecture, setup, and
troubleshooting reference.

## Quick start

```bash
cd ~/gbrain/recipes/youtube-channel-to-brain

# Subscribe
python3 scripts/youtube_poll.py --subscribe @AlexHormozi
python3 scripts/youtube_poll.py --subscribe @AlexFinnX

# Dry-run smoke test
python3 scripts/youtube_poll.py --once --dry-run

# Real first poll
python3 scripts/youtube_poll.py --once

# Drain the enrichment queue (the 15-min cron does this automatically)
python3 scripts/youtube_poll.py --enrich-queue

# Status
python3 scripts/youtube_poll.py --status
```

## Where state lives

- Config + cursor + queue: `~/.gbrain/integrations/youtube-channel-to-brain/`
- Pages written: `sources/youtube/<channel-slug>/<date>-<video-id>-<slug>.md`
- Author pages: `people/<channel-author-slug>.md`
- Raw VTT sidecars: uploaded via `gbrain files upload-raw`

## Cron schedule

- `youtube-poll`   - `0 */4 * * *` (poll RSS + write draft pages)
- `youtube-enrich` - `*/15 * * * *` (drain the enrichment queue via subagents)

## Tests

```bash
python3 -m pytest tests/test_lib.py -v
```
