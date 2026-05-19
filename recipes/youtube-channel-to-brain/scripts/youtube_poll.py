#!/usr/bin/env python3
"""youtube_poll.py -- Entry point for the youtube-channel-to-brain recipe.

Modes:
  --subscribe @Handle [@Handle ...]   Add channels to channels.yaml (resolves UC id)
  --once                              Poll all subscribed channels once
  --once --dry-run                    Smoke-test poll: parse RSS, no writes
  --enrich-queue                      Drain enrichment queue files (consumed by second cron)
  --status                            Print cursor + queue summary
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow running from the recipe dir directly without install
sys.path.insert(0, str(Path(__file__).resolve().parent))

import youtube_lib as yl


def cmd_subscribe(handles: list[str]) -> int:
    rc = 0
    for h in handles:
        try:
            c = yl.subscribe(h)
            print(f"subscribed: {h} -> {c.channel_id} (author_slug={c.author_slug})")
        except (yl.ChannelResolutionError, yl.NetworkError, OSError) as e:
            print(f"FAILED to subscribe {h}: {e}", file=sys.stderr)
            rc = 1
    return rc


def cmd_once(dry_run: bool) -> int:
    channels = yl.load_channels()
    if not channels:
        print("no channels subscribed. Run --subscribe @Handle first.", file=sys.stderr)
        return 2

    with yl.poll_lock() as acquired:
        if not acquired:
            yl.log("concurrent poll skipped (lock held)")
            return 0

        try:
            cursors = yl.load_cursor()
        except (OSError, json.JSONDecodeError) as e:
            yl.log(f"cursor.json corrupt: {e}", level="ERROR")
            yl.heartbeat("cursor_corrupt", error=str(e))
            return 3

        total_ingested = 0
        per_channel = []
        for c in channels:
            summary = yl.poll_channel(c, cursors, dry_run=dry_run)
            total_ingested += summary["videos_ingested"]
            per_channel.append(summary)

        if not dry_run:
            try:
                yl.save_cursor(cursors)
            except OSError as e:
                yl.log(f"cursor save failed: {e}", level="ERROR")

        yl.heartbeat("poll_complete", total_ingested=total_ingested, per_channel=per_channel, dry_run=dry_run)
        print(json.dumps({"total_ingested": total_ingested, "per_channel": per_channel}, indent=2))
    return 0


def cmd_enrich_queue() -> int:
    """Drain the queue by spawning a one-shot Hermes subagent per video.

    Each queue file specifies the page slug + video metadata. We invoke
    `hermes -z <prompt> --skills media-ingest -t terminal,file` and on success
    delete the queue file; on non-zero exit move to failed/.

    Idempotent: if the page is already enriched the subagent should no-op.
    """
    files = yl.list_queue()
    if not files:
        print("queue empty")
        return 0

    hermes_bin = os.environ.get("HERMES_BIN") or shutil.which("hermes") or str(Path.home() / ".local/bin/hermes")
    if not Path(hermes_bin).exists():
        yl.log(f"hermes binary not found at {hermes_bin}; cannot dispatch enrichment", level="ERROR")
        return 4

    processed = 0
    failed = 0
    for qf in files:
        try:
            data = json.loads(qf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            yl.move_to_failed(qf, f"queue read: {e}")
            failed += 1
            continue

        slug = data["page_slug"]
        prompt = (
            f"Enrich the YouTube video brain page at slug `{slug}`. "
            f"Channel: {data['channel_handle']} (author slug `{data['author_slug']}`). "
            f"Video URL: {data['video_url']}. Title: {data['title']}.\n\n"
            "Steps (load the `media-ingest` skill first via skill_view):\n"
            f"1. `gbrain get {slug}` to read the page including the raw transcript.\n"
            "2. Produce a 5 to 10 bullet summary. Insert it under a new `## Summary` "
            "section ABOVE `## Raw transcript`.\n"
            "3. Extract every person and company mentioned. Create or back-link "
            "`people/<slug>.md` and `companies/<slug>.md` pages following media-ingest rules.\n"
            f"4. Update `people/{data['author_slug']}` with a timeline entry pointing at "
            f"this page (`gbrain timeline-add people/{data['author_slug']} {data['published'][:10]} "
            f"\"Posted: {data['title']}\"`).\n"
            "5. Set frontmatter `status: enriched` and write the page back with `gbrain put`.\n"
            "6. Verify links resolve with `gbrain backlinks` on the people page.\n\n"
            "Use ONLY the terminal toolset. Do not message TJ. Return a short JSON "
            "summary of entities created/linked on stdout."
        )

        try:
            proc = subprocess.run(
                [hermes_bin, "-z", prompt, "--skills", "media-ingest",
                 "-t", "terminal,file", "--ignore-rules"],
                capture_output=True, text=True, timeout=1200,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            yl.move_to_failed(qf, f"hermes dispatch: {e}")
            failed += 1
            continue

        if proc.returncode != 0:
            yl.move_to_failed(qf, f"hermes exit {proc.returncode}: {proc.stderr[:500]}")
            failed += 1
            continue

        yl.log(f"enriched: {slug}")
        try:
            qf.unlink()
        except OSError:
            pass
        processed += 1

    yl.heartbeat("enrich_complete", processed=processed, failed=failed)
    print(json.dumps({"processed": processed, "failed": failed}))
    return 0


def cmd_status() -> int:
    try:
        cursors = yl.load_cursor()
    except (OSError, json.JSONDecodeError) as e:
        print(f"cursor read error: {e}")
        return 1
    out = {
        "channels": yl.load_channels().__class__.__name__,
        "subscribed": [c.__dict__ for c in yl.load_channels()],
        "cursors": {cid: c.__dict__ for cid, c in cursors.items()},
        "queue_pending": len(yl.list_queue()),
        "queue_failed": len(list(yl.QUEUE_FAILED_DIR.glob("*.json"))) if yl.QUEUE_FAILED_DIR.exists() else 0,
    }
    print(json.dumps(out, indent=2))
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="youtube_poll")
    p.add_argument("--subscribe", nargs="+", metavar="HANDLE")
    p.add_argument("--once", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--enrich-queue", action="store_true")
    p.add_argument("--status", action="store_true")
    args = p.parse_args(argv)

    if args.subscribe:
        return cmd_subscribe(args.subscribe)
    if args.enrich_queue:
        return cmd_enrich_queue()
    if args.once:
        return cmd_once(args.dry_run)
    if args.status:
        return cmd_status()
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
