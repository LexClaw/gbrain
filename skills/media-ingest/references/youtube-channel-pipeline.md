# YouTube Channel-to-Brain Subscription Pipeline (ops)

Distinct from one-off video ingest. This is the **subscription** pipeline: add a
channel once, the 4h poll cron ingests new videos forever, and a backfill flag
pulls historical videos. Use this when the ask is "add this channel to the youtube
ingest pipeline" / "ingest the last N days/months of <channel>".

## Where the pipeline lives

- **Recipe + scripts:** `~/gbrain/recipes/youtube-channel-to-brain/scripts/youtube_poll.py`
  (entry point) + `youtube_lib.py` (resolver/RSS/transcript/writer).
- **Shared state (both copies read this):** `~/.gbrain/integrations/youtube-channel-to-brain/`
  — `channels.yaml` (subscriptions), `cursor.json` (last-seen per channel),
  `enrichment-queue/` (pending media-ingest jobs), `heartbeat.jsonl`.
- **Wrapper crons:** `~/.hermes/scripts/youtube-channel-poll.sh` (4h, `--once`),
  `youtube-channel-enrich.sh` (15m, `--enrich-queue`). Bulk backfills:
  `~/.hermes/scripts/yt-bulk-backfill.sh` (a per-channel `--backfill` template).
- **Pages produced:** draft `sources/youtube/<author-slug>/<date>-<video-id>-<slug>.md`,
  then enriched in place by the `media-ingest` skill (summary + entity back-links +
  author timeline entry). Author page at `people/<author-slug>`.

## Standard add-a-channel + backfill flow

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd ~/gbrain/recipes/youtube-channel-to-brain   # SEE PITFALL #1 — use the gbrain copy

# 1. Subscribe (resolves @handle -> UC... channel_id, appends to shared channels.yaml; idempotent)
python3 scripts/youtube_poll.py --subscribe @somehandle
# -> "subscribed: @somehandle -> UC... (author_slug=...)"

# 2. Backfill last 90 days (date = today minus 90). Background it + notify; transcript
#    fetch per video is slow, a real run takes minutes, NOT seconds.
python3 scripts/youtube_poll.py --backfill UC... --since YYYY-MM-DD --no-include-streams

# 3. Enrichment is automatic: the 15-min enrich cron drains the queue. Or force it:
python3 scripts/youtube_poll.py --enrich-queue
```

Verify: `gbrain list --limit 8000 | grep -c "sources/youtube/<author-slug>"` should be > 0.

## PITFALL #1 — two diverged copies of the recipe (run from the gbrain one)

There are (at least) two copies of `youtube_poll.py` on disk:
- `~/hermes-workspace/recipes/youtube-channel-to-brain/...` — OLDER, smaller, arg
  parser only has `--subscribe --once --dry-run --enrich-queue --status`. **No
  `--backfill`.** The `youtube-channel-poll.sh` cron wrapper points HERE.
- `~/gbrain/recipes/youtube-channel-to-brain/...` — NEWER, has `--backfill
  CHANNEL_ID --since YYYY-MM-DD --max N --include-streams --no-include-streams`.

Symptom of running the wrong one: `youtube_poll: error: unrecognized arguments:
--backfill ...` (exit 2), finishes in ~1s, 0 pages. Both copies read the SAME
`~/.gbrain/integrations/.../channels.yaml`, so `--subscribe` works from either and
the subscription is shared — only the backfill flag is missing from the old copy.

**Rule:** for any `--backfill` / `--since` work, `cd ~/gbrain/recipes/youtube-channel-to-brain`.
Confirm with `python3 scripts/youtube_poll.py --help | grep backfill` before running.
This drift is worth a cleanup card (reconcile to one canonical copy per
`upstream-recipe-relocation`); until then, this is the discipline.

## PITFALL #2 — `--include-streams` hard-errors on channels with no streams tab

`yt-bulk-backfill.sh` uses `--include-streams` (built for Discover Crypto's daily
livestreams). On a standard video channel that has never streamed, yt-dlp errors:
`ERROR: [youtube:tab] UC...: This channel does not have a streams tab` (backfill
exit 4, 0 pages). yt-dlp does NOT skip the missing tab gracefully — it aborts.

**Rule:** default to `--no-include-streams`. Only add `--include-streams` for
channels you KNOW livestream (the daily-show / 1hr+ creators). When in doubt, omit
it — a pure-video channel loses nothing.

## Notes

- RSS-only poll returns the 15 most recent videos (no API key/quota). The
  `--backfill` path uses yt-dlp flat-playlist enumeration to go past that window,
  which is why historical/N-day backfills MUST use `--backfill`, not `--once`.
- `--since` is the floor date (YYYY-MM-DD). For "last 90 days" compute today-minus-90.
- Shorts are filtered by `min_duration_seconds: 60` per channel; set 0 to include.
- A backfill that exits 0 in ~1-4s with 0 pages is a FAILURE, not an empty channel —
  read the log (`~/.hermes/logs/yt-backfill-*.log`) for the real error.
