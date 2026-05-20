"""Shared helpers for the auto-enrich recipe.

Subprocess wrapper around the gbrain CLI and a Heartbeat class that writes
JSONL lines to ~/.gbrain/integrations/auto-enrich/heartbeat.jsonl in the
shape that `gbrain integrations show / status` consumes.

No Python client for gbrain exists; everything is subprocess-only. The
wrapper raises GBrainCLIError on non-zero exit so callers can map to the
sensor's exit codes (0 ok, 1 CLI error, 2 config error).
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RECIPE_ID = "auto-enrich"
RECIPE_VERSION = "0.1.0"

DEFAULT_HEARTBEAT_PATH = Path.home() / ".gbrain" / "integrations" / RECIPE_ID / "heartbeat.jsonl"


class GBrainCLIError(RuntimeError):
    """Raised when a gbrain subprocess returns non-zero."""

    def __init__(self, argv: list[str], returncode: int, stdout: str, stderr: str):
        self.argv = argv
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(
            f"gbrain {' '.join(argv[1:])} exited {returncode}: {stderr.strip() or stdout.strip()}"
        )


def run_gbrain(args: list[str], *, timeout: int = 60) -> str:
    """Invoke `gbrain <args...>` and return stdout. Raises GBrainCLIError on
    non-zero. Pattern matches recipes/web-to-brain/scripts/web_lib.py."""
    argv = ["gbrain", *args]
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise GBrainCLIError(argv, 127, "", str(exc)) from exc
    if result.returncode != 0:
        raise GBrainCLIError(argv, result.returncode, result.stdout, result.stderr)
    return result.stdout


@dataclass
class Heartbeat:
    """Append-only JSONL heartbeat log. One line per recipe-run event.

    Matches the shape `gbrain integrations` reads in
    src/commands/integrations.ts::readHeartbeat (HeartbeatEntry).
    """

    path: Path = DEFAULT_HEARTBEAT_PATH
    recipe_id: str = RECIPE_ID
    source_version: str = RECIPE_VERSION

    def emit(
        self,
        event: str,
        status: str = "ok",
        details: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """Append one JSON line. Creates parent dirs on first write."""
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "event": event,
            "source_version": self.source_version,
            "status": status,
        }
        if details is not None:
            entry["details"] = details
        if error is not None:
            entry["error"] = error
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")


def parse_frontmatter(markdown: str) -> tuple[dict[str, Any], str]:
    """Split a page returned by `gbrain get` into (frontmatter_dict, body_str).

    The page format is:
        ---\n<yaml>\n---\n<body>

    Pages without leading frontmatter return ({}, full_text). YAML errors
    surface ({}, full_text) plus a logged warning rather than crashing the
    sensor on a single malformed page.
    """
    import yaml  # local import keeps top-level import side-effect free

    if not markdown.startswith("---"):
        return {}, markdown
    parts = markdown.split("---", 2)
    if len(parts) < 3:
        return {}, markdown
    _, fm_text, body = parts
    try:
        data = yaml.safe_load(fm_text) or {}
    except yaml.YAMLError:
        return {}, markdown
    if not isinstance(data, dict):
        return {}, markdown
    return data, body.lstrip("\n")
