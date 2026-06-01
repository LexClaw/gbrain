---
id: web-to-brain
name: Web to Brain
version: 0.1.0
category: sense
description: One-shot URL ingest. Fetch a web page, run readability extraction, write a draft `sources/web/<host>/...` page, and queue a one-shot Hermes subagent to enrich it via the `ingest` skill.
secrets: none
setup_time: 5min
health_check: ~/.gbrain/integrations/web-to-brain/heartbeat.jsonl
cost_estimate: $0 / month (no API key). Enrichment uses your default agent provider.
---

# Web to Brain

One-shot URL ingest for GBrain. Given a single URL (company about page,
news article, pricing page, blog post), `web_fetch.py` fetches the page,
runs structural SPA detection, extracts main content with
`readability-lxml`, writes a draft `sources/web/<host>/<slug>.md` page,
and hands off to the `ingest` skill via a Hermes enrichment job.

Mode B (watchlist, snapshots, diffing, scheduled re-fetch) is OUT OF
SCOPE for v0.1.0. v0.1.0 is one-shot only.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  web-to-brain recipe                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ~/.gbrain/integrations/web-to-brain/                                │
│    ├── fetch.lock         (flock guard, single-runner per URL pass) │
│    ├── fetch.log          (rolling log)                              │
│    ├── heartbeat.jsonl    (status events; gbrain doctor reads)       │
│    ├── robots-cache/      (per-host robots.txt, 24h TTL)             │
│    └── enrichment-queue/                                             │
│        ├── <job_id>.json    (pending enrichment job)                 │
│        └── failed/<job_id>.json                                      │
│                                                                       │
│  ~/gbrain/recipes/web-to-brain/                                      │
│    ├── recipe.md          (this file)                                │
│    ├── README.md          (quick start)                              │
│    ├── scripts/                                                      │
│    │   ├── web_lib.py     (fetcher + SPA + readability + writer)     │
│    │   └── web_fetch.py   (entry point, CLI + cron target)           │
│    └── tests/                                                        │
│        ├── test_lib.py    (43 cases)                                 │
│        └── fixtures/      (recorded HTML: SPA, paywall, article, ...) │
│                                                                       │
│  Trigger paths:                                                      │
│    `gbrain ingest url <url>`                       (interactive)     │
│    Hermes cron `web-to-brain-enrich` every 15m     (queue drainer)   │
│                                                                       │
│  Pages produced:                                                     │
│    sources/web/<host-slug>/<YYYY-MM-DD>-<slug>.md  (draft)           │
│    enriched by the `ingest` skill in a Hermes subagent:              │
│      - back-links to companies/<slug> / people/<slug>                │
│      - timeline-add on each linked entity                            │
│      - `enriched_at` frontmatter set (idempotency contract)          │
└─────────────────────────────────────────────────────────────────────┘
```

## Setup flow

### 1. Install Python deps

`web_lib.py` requires `requests`, `beautifulsoup4`, `readability-lxml`,
`lxml`. They install into the Hermes venv:

```bash
pip3 install beautifulsoup4 readability-lxml requests lxml
```

(Same Python env that hosts `yt-dlp` for `youtube-channel-to-brain`.)

### 2. One-shot ingest

```bash
gbrain ingest url https://stripe.com/about
```

Or with a canonical entity hint (the enrichment subagent will treat the
draft as primary-subject content for that slug, similar to
media-ingest's primary-subject rule):

```bash
gbrain ingest url https://stripe.com/about --slug companies/stripe
```

Dry-run skips brain writes (no `gbrain put`, no queue file, no raw
upload) but exercises fetch + SPA detection + extraction end to end:

```bash
gbrain ingest url https://stripe.com/about --dry-run
```

### 3. Drain the enrichment queue

The 15-minute Hermes cron (`web-to-brain-enrich`) runs this on its own.
Manual drain for debugging:

```bash
gbrain ingest url --enrich-queue
```

### 4. Status

```bash
gbrain ingest url --status
```

## Gates (must all hold)

1. **Robots.txt respected.** Cache per-host for 24h. Disallow returns
   `RUN_COMPLETE status=skip reason=robots_disallowed`. Fail-open on
   network errors fetching robots.txt itself (RFC behavior).
2. **Idempotency.** Re-ingesting a URL whose page is already
   `enriched_at: <iso>` returns `RUN_COMPLETE status=skip
   reason=already_enriched`. No `gbrain put`, no new queue file.
3. **Bot-block surfaced.** 403 / Cloudflare challenge / "are you a
   human" interstitials emit `BOT_BLOCKED` and fail with
   `reason=BotBlocked` rather than silently saving an empty draft.
4. **Body cap.** 5 MB max body, 30s timeout, max 5 redirect hops,
   redirect-loop detection. Oversized bodies raise `ContentTooLarge`.
5. **Content-type allowlist.** Only `text/html` and `application/xhtml+xml`.
   PDFs, images, JSON feeds fail with `UnsupportedContentType` (out of
   scope for v0.1).
6. **Structural SPA detection.** Not length-based. Flags pages whose
   visible text is empty AND a known SPA root (`#__next`, `#root`,
   `#app`, `#__nuxt`, `#svelte`) is present with no rendered children,
   OR whose `script_bytes / text_bytes` ratio exceeds 10. Falls through
   on short-but-real articles.
7. **Hash-noise selector suppression: DEFERRED.** Not in v0.1.0.

## Exception discipline

`web_lib.py` catches a fixed set of typed errors only:

- `NetworkError`, `RobotsDisallowed`, `SPADetected`, `PaywallSuspected`,
  `BotBlocked`, `ContentTooLarge`, `UnsupportedContentType`,
  `RedirectLoop`, `ExtractionFailed`, `OSError`, `etree.ParseError`.

No bare `except Exception`. Bugs surface as crashes with traceback.

## Stdout contract

`web_fetch.py --url <u>` writes one event per line to stdout, in order:

```
RUN_START url=<u> job_id=<jid>
ROBOTS_CHECK host=<h> allowed=true|false
URL_FETCHED url=<final-u> bytes=<n> ms=<elapsed>
SPA_DETECTED url=<u> reason=<r>           # only if SPA
BOT_BLOCKED host=<h>                       # only if blocked
ENRICH_QUEUED job_id=<jid> page=<slug>     # only on success
RUN_COMPLETE job_id=<jid> status=ok|skip|fail reason=<r>
```

Heartbeat events (`fetch_failed`, `spa_detected`, `bot_blocked`,
`extraction_failed`, `ingest_ok`, `idempotent_skip`, `robots_disallow`,
`enrich_complete`) append to `heartbeat.jsonl` for `gbrain doctor`.

## Tests

```bash
cd ~/gbrain/recipes/web-to-brain
python3 -m pytest tests/ -v
```

43 cases against recorded HTML fixtures: SPA shells, short-but-real
articles, paywall markers, robots files, malformed HTML, article-valid
positive controls. No live network in CI.

## Wiring

- CLI: `gbrain ingest url <url>` -> `src/commands/ingest.ts` -> shells
  out to `scripts/web_fetch.py`.
- Cron: Hermes `web-to-brain-enrich` job runs
  `~/.hermes/scripts/web-to-brain-enrich.sh` every 15 minutes.
- Skill: `skills/ingest/SKILL.md` documents URL as a first-class entry
  point alongside file / clipboard / pasted text.

## Troubleshooting

- `bs4 ModuleNotFoundError`: `pip3 install beautifulsoup4 readability-lxml lxml`.
- `RUN_COMPLETE status=skip reason=spa:*`: target page is JS-rendered.
  Add a sitemap-resolved sub-URL or a server-rendered mirror. JS
  rendering is not in scope for v0.1.0.
- `RUN_COMPLETE status=skip reason=robots_disallowed`: respect it. Pull
  the data another way (RSS, API, manual paste).
- `RUN_COMPLETE status=fail reason=BotBlocked`: site is gating us at
  the edge. Cloudflare-style challenges cannot be bypassed by a polite
  fetcher.
- Queue file stuck in `failed/`: inspect the `error` field, fix root
  cause, `mv` back into `enrichment-queue/` to retry.

## Out of scope (v0.1.0)

- Mode B watchlist (`gbrain web-watch add`, snapshot diffing).
- Hash-noise selector suppression (gate 7).
- JS rendering / headless browser. SPA pages are skipped.
- Non-HTML content (PDF, JSON, video).
- Multi-URL batch ingest. Use shell `xargs` for now.
