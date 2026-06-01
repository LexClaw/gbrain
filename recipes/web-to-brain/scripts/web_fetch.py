#!/usr/bin/env python3
"""web_fetch.py -- Entry point for the web-to-brain recipe.

Modes:
  --url <url> [--slug <slug>]   One-shot ingest a URL
  --url <url> --dry-run         Fetch + detect + extract; no brain writes
  --enrich-queue                Drain enrichment queue files (cron target, every 15m)
  --status                      Print queue summary
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

sys.path.insert(0, str(Path(__file__).resolve().parent))

import web_lib as wl  # noqa: E402


def cmd_url(url: str, slug: str | None, dry_run: bool) -> int:
    with wl.fetch_lock() as acquired:
        if not acquired:
            wl.log("concurrent fetch skipped (lock held)")
            return 0
        try:
            result = wl.ingest_url(url, slug_override=slug, dry_run=dry_run)
        except OSError as e:
            wl.log(f"ingest_url crashed: {e}", level="ERROR")
            wl.heartbeat("ingest_crash", url=url, error=str(e))
            return 1
    if result.status == "ok":
        return 0
    if result.status == "skip":
        return 0
    return 2


def cmd_enrich_queue() -> int:
    files = wl.list_queue()
    if not files:
        print("queue empty")
        wl.heartbeat("enrich_complete", processed=0, failed=0)
        return 0

    hermes_bin = os.environ.get("HERMES_BIN") or shutil.which("hermes") or str(Path.home() / ".local/bin/hermes")
    if not Path(hermes_bin).exists():
        wl.log(f"hermes binary not found at {hermes_bin}; cannot dispatch enrichment", level="ERROR")
        return 4

    processed = 0
    failed = 0
    for qf in files:
        try:
            data = json.loads(qf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            wl.move_to_failed(qf, f"queue read: {e}")
            failed += 1
            continue

        slug = data["page_slug"]
        url = data.get("url", "")
        target_override = data.get("target_slug_override") or ""

        prompt_parts = [
            f"Enrich the web page brain document at slug `{slug}`.",
            f"Source URL: {url}.",
        ]
        if target_override:
            prompt_parts.append(
                f"The user supplied a canonical entity slug `{target_override}`; "
                f"treat this draft as primary-subject content for that entity and "
                "relocate per media-ingest primary-subject rules."
            )
        prompt_parts.append("")
        prompt_parts.append("Steps (load the `ingest` skill first via skill_view):")
        prompt_parts.append(f"1. `gbrain get {slug}` to read the page.")
        prompt_parts.append(
            "2. If frontmatter already carries `enriched_at`, exit 0 with `already_enriched`. "
            "This is the idempotency contract; do not re-enrich."
        )
        prompt_parts.append(
            "3. Identify every person and company mentioned. Create or back-link "
            "`people/<slug>` and `companies/<slug>` pages following "
            "`skills/_brain-filing-rules.md`."
        )
        prompt_parts.append(
            "4. Add a `gbrain timeline-add` entry on each linked entity pointing at this page "
            "with the fetched date and a one-line summary."
        )
        prompt_parts.append(
            "5. Set frontmatter `status: enriched` and add `enriched_at: <iso>` then write the page "
            "back with `gbrain put`."
        )
        prompt_parts.append("6. Verify back-links with `gbrain backlinks` on the canonical entity page.")
        prompt_parts.append("")
        prompt_parts.append(
            "Use ONLY the terminal toolset. Do not message TJ. Return a short JSON "
            "summary of entities created/linked on stdout."
        )

        prompt = "\n".join(prompt_parts)

        try:
            proc = subprocess.run(
                [hermes_bin, "-z", prompt, "--skills", "ingest",
                 "-t", "terminal,file", "--ignore-rules"],
                capture_output=True, text=True, timeout=900,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            wl.move_to_failed(qf, f"hermes dispatch: {e}")
            failed += 1
            continue

        if proc.returncode != 0:
            wl.move_to_failed(qf, f"hermes exit {proc.returncode}: {proc.stderr[:500]}")
            failed += 1
            continue

        wl.log(f"enriched: {slug}")
        try:
            qf.unlink()
        except OSError:
            pass
        processed += 1

    wl.heartbeat("enrich_complete", processed=processed, failed=failed)
    print(json.dumps({"processed": processed, "failed": failed}))
    return 0


def cmd_status() -> int:
    out = {
        "queue_pending": len(wl.list_queue()),
        "queue_failed": len(list(wl.QUEUE_FAILED_DIR.glob("*.json"))) if wl.QUEUE_FAILED_DIR.exists() else 0,
        "state_dir": str(wl.STATE_DIR),
    }
    print(json.dumps(out, indent=2))
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="web_fetch")
    p.add_argument("--url", help="URL to ingest")
    p.add_argument("--slug", help="Canonical entity slug override (e.g. companies/acme)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--enrich-queue", action="store_true")
    p.add_argument("--status", action="store_true")
    args = p.parse_args(argv)

    if args.enrich_queue:
        return cmd_enrich_queue()
    if args.status:
        return cmd_status()
    if args.url:
        return cmd_url(args.url, args.slug, args.dry_run)
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
