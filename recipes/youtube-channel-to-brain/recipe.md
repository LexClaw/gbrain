---
id: youtube-channel-to-brain
name: YouTube Channel to Brain
version: 0.1.0
category: sense
description: Subscribe to YouTube channels and ingest new videos (transcripts + metadata) into GBrain as draft `sources/youtube/...` pages, then enrich via the `media-ingest` skill.
secrets: none
setup_time: 10min
health_check: ~/.gbrain/integrations/youtube-channel-to-brain/heartbeat.jsonl
cost_estimate: $0 / month (no API key, RSS only). Enrichment uses your default agent provider.
---

# YouTube Channel to Brain

Subscription-style ingest for YouTube. Polls public channel RSS feeds every
4 hours, pulls transcripts via `yt-dlp` (no API key, no quota), writes draft
`sources/youtube/<channel>/<date>-<video-id>-<slug>.md` pages, and queues a
one-shot Hermes subagent to run the `media-ingest` skill against each page
(summary, entity extraction, back-links, author timeline entries).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│              youtube-channel-to-brain recipe                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ~/.gbrain/integrations/youtube-channel-to-brain/                    │
│    ├── channels.yaml      (subscription list)                        │
│    ├── cursor.json        (last-seen video_id per channel)           │
│    ├── poll.lock          (flock guard, single-runner)               │
│    ├── poll.log           (rolling log)                              │
│    ├── heartbeat.jsonl    (status events; gbrain doctor reads)       │
│    └── enrichment-queue/                                             │
│        ├── <video_id>.json  (pending enrichment job)                 │
│        └── failed/<video_id>.json                                    │
│                                                                       │
│  ~/gbrain/recipes/youtube-channel-to-brain/                          │
│    ├── recipe.md          (this file)                                │
│    ├── scripts/                                                      │
│    │   ├── youtube_lib.py   (resolver + RSS + transcript + writer)   │
│    │   └── youtube_poll.py  (entry point, cron target)               │
│    └── tests/                                                        │
│                                                                       │
│  Hermes cron (every 4h) ──► python3 youtube_poll.py --once           │
│  Hermes cron (every 15m) ──► python3 youtube_poll.py --enrich-queue  │
│                                                                       │
│  Pages produced:                                                     │
│    sources/youtube/<channel-slug>/<YYYY-MM-DD>-<video-id>-<slug>.md  │
│    people/<channel-author>.md  (stub then enriched by media-ingest)  │
└─────────────────────────────────────────────────────────────────────┘
```

## Setup flow

### 1. Subscribe to a channel

```bash
cd ~/gbrain/recipes/youtube-channel-to-brain
python3 scripts/youtube_poll.py --subscribe @AlexHormozi
python3 scripts/youtube_poll.py --subscribe @AlexFinnX
```

`--subscribe` resolves the `@handle` (or full URL or raw `UC...` id) to a
canonical channel id by fetching the channel HTML and matching one of three
regex patterns in order: `"channelId"`, `"externalId"`, `og:url`. All three
missing → fails loud with an actionable error (YouTube markup probably
drifted).

Idempotent: re-subscribing the same handle refreshes the channel id and
author slug without duplicating the entry.

### 2. Dry-run poll (smoke test)

```bash
python3 scripts/youtube_poll.py --once --dry-run
```

Parses the RSS feed for every subscribed channel but writes nothing. Confirms
network + RSS + cursor logic.

### 3. Real poll

```bash
python3 scripts/youtube_poll.py --once
```

For each subscribed channel:

1. `GET https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>` (15 most
   recent videos, no API key, no quota).
2. Diff against `cursor.json` (advances oldest-first for timeline coherence).
3. For each new video, skip premieres and Shorts (< `min_duration_seconds`).
4. `yt-dlp --skip-download --write-auto-sub` (tier 1) → `--write-sub` (tier 2)
   → optional Whisper (tier 3, off by default in v1). Empty/whitespace VTT
   counted as a miss (< `MIN_CUES = 3` cues) and falls through.
5. `gbrain put sources/youtube/...` with full frontmatter, raw transcript in a
   fenced block, and an `## Enrichment instructions` section pointing the next
   subagent at the `media-ingest` skill.
6. `gbrain files upload-raw <vtt>` for the raw VTT sidecar.
7. Drop an enrichment job file at `enrichment-queue/<video_id>.json`.
8. Atomic cursor update (`tmp + fsync + rename`).

### 4. Drain enrichment queue

```bash
python3 scripts/youtube_poll.py --enrich-queue
```

For every queue file, spawn a one-shot Hermes subagent with the `media-ingest`
skill and a prompt that:

- Reads the page.
- Inserts a 5-10 bullet `## Summary` above the raw transcript.
- Extracts every person and company, creates / back-links pages.
- Adds a `## Videos` / timeline entry to the author's `people/` page.
- Sets `status: enriched` and writes back.

Non-zero exit moves the queue file to `enrichment-queue/failed/<video_id>.json`
with the failure reason. Idempotent: re-running on an already-enriched page is
a subagent-side no-op.

### 5. Register Hermes cron jobs

Both jobs in `~/.hermes/cron/jobs.json` (managed via `hermes cron create`):

```text
youtube-poll       0 */4 * * *    youtube_poll.py --once          no_agent  local
youtube-enrich    */15 * * * *    youtube_poll.py --enrich-queue  agent     local
```

### 6. Verify in brain

```bash
gbrain search "alex hormozi"
gbrain get people/alex-hormozi
gbrain query "what did Hormozi recently discuss"
```

## Production patterns

- **Atomic cursor.** Cursor writes use tmp file + `fsync` + `os.replace`. Read
  failures (file missing, JSON corrupt) fail loud per the Grant gate;
  `gbrain doctor` is the recovery surface, not auto-repair.
- **Lockfile.** `~/.gbrain/integrations/youtube-channel-to-brain/poll.lock` is
  acquired non-blocking via `fcntl.LOCK_EX | LOCK_NB`. A second runner gets
  `False` and exits 0 (the poll cadence covers it).
- **Shorts filter.** `min_duration_seconds: 60` by default. Set to 0 to include
  Shorts. RSS does not always carry duration; when missing we accept the
  video to be safe.
- **Deletion resistance.** Videos that ship to brain stay in brain after the
  creator deletes them on YouTube; the transcript sidecar (raw VTT) is the
  long-term provenance artifact.
- **Premiere / scheduled.** Skipped at ingest; the next poll catches them once
  they air and the RSS feed drops the `media:status` marker.

## Implementation notes

- **Why RSS, not the Data API.** Zero auth, zero quota, 15 most recent videos
  per channel (enough for a 4 h poll cadence). Migrating to the API is a v1.1
  upgrade if we ever need to backfill past the 15-video window.
- **Tiered transcript.** Auto-CC → manual CC → Whisper. Whisper is opt-in
  (set `transcript_fallback: whisper` on a channel) AND requires the
  `whisper` binary on PATH; v1 ships with Whisper deferred.
- **Handoff via queue files, not in-process LLM.** Poll stays deterministic
  and fast; enrichment runs in a separate subagent that can be debugged,
  retried, and replayed without re-fetching transcripts.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ChannelResolutionError` on subscribe | YouTube markup drifted past all 3 regex patterns | Inspect `https://www.youtube.com/@handle` source, add a 4th pattern to `_CHANNEL_PATTERNS` in `youtube_lib.py` |
| `RSS empty for ...` warning | First poll on a brand-new channel with no public videos | Wait, or unsubscribe |
| `cursor video <id> aged out of feed` warning | Channel posted >15 videos since the last successful poll | Treated as "all visible are new"; expected after long downtime |
| All transcripts unavailable | yt-dlp binary missing or wrong path | `which yt-dlp`; set `YT_DLP_BIN` env var to override |
| `gbrain put` exit nonzero | brain not initialised, or slug rule violation | `gbrain doctor`; check page path against schema |
| Enrichment queue piling up | enrich cron not firing, or hermes binary not on PATH | `hermes cron list`; set `HERMES_BIN` env var |

## State files (for `gbrain doctor` integration)

- `heartbeat.jsonl` (append-only, one JSON event per line)
  - `event: poll_complete` with `total_ingested`, `per_channel`, `dry_run`
  - `event: enrich_complete` with `processed`, `failed`
  - `event: cursor_corrupt` (rare; should fire `gbrain doctor` alert)
- `poll.log` (rolling text log, ISO timestamps, levels INFO/WARN/ERROR)
- `cursor.json` per-channel: `last_video_id`, `last_polled`, `last_success`,
  `consecutive_failures`

## Cost estimate

- **RSS poll:** free, no auth.
- **yt-dlp transcript fetch:** free.
- **`gbrain put` + `upload-raw`:** local writes.
- **Enrichment subagent:** ~5-15k tokens per video at your default provider.

A 6-channel subscription with one new video / channel / day = ~6 videos/day =
~50-100k tokens/day for enrichment. Negligible.
