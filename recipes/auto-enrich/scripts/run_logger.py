"""Structured per-run logger for auto-enrich pipeline.

Single public API: ``log_run(run_data: dict) -> None``.

Writes one JSON line to ``~/.hermes/logs/auto-enrich-runs.jsonl``. NEVER
raises: a logging failure must not block the pipeline. On any error the
logger prints a short diagnostic to stderr and returns ``None``.

Schema (see plan 2026-05-22-auto-enrich-structured-logger.md):

    {
      "run_id":     "<iso-utc-Z>",
      "run_mode":   "live" | "dry",
      "candidate":  {"slug": ..., "score": ..., "pool_size": ..., "pool_rank": ...},
      "stages_ms":  {"sensor": ..., "cal": ..., "gate": ..., "synthesize": ...,
                     "write": ..., "total": ...},
      "cal":        {"model": ..., "claims_returned": ..., "raw_response_chars": ...},
      "gate":       {"kept": ..., "dropped": ..., "drop_reasons": {...},
                     "per_claim": [...]},
      "outcome":    "written" | "dry_pass" | "refused" | "error",
      "write":      {"slug_written": ..., "facts_added": ..., "sections_added": [...],
                     "existing_preserved": ..., "partial_credit_applied": ...},
      "tools_used": {"gstack_browse": ..., "xurl": ..., "http": ...,
                     "fallback_chain_hits": ...},
      "errors":     [str, ...]
    }

stdlib only: ``json``, ``os``, ``pathlib``, ``datetime``, ``sys``.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Required top-level keys per spec. Missing keys are tolerated (warned to
# stderr, logged into the line's "errors" array, line still written).
REQUIRED_KEYS = ("run_id", "run_mode", "outcome")
REQUIRED_CANDIDATE_KEYS = ("slug",)

# Override hook for tests (set via env var, falls back to ~/.hermes/logs/...).
DEFAULT_LOG_PATH = Path.home() / ".hermes" / "logs" / "auto-enrich-runs.jsonl"


def _resolve_log_path() -> Path:
    """Return the target log path. ``AUTO_ENRICH_LOG_PATH`` overrides."""
    override = os.environ.get("AUTO_ENRICH_LOG_PATH")
    if override:
        return Path(override).expanduser()
    return DEFAULT_LOG_PATH


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _validate(run_data: dict[str, Any]) -> list[str]:
    """Return a list of validation-error strings (empty = clean)."""
    errs: list[str] = []
    for key in REQUIRED_KEYS:
        if key not in run_data:
            errs.append(f"missing required key: {key}")
    cand = run_data.get("candidate")
    if not isinstance(cand, dict):
        errs.append("missing required key: candidate.slug")
    else:
        for key in REQUIRED_CANDIDATE_KEYS:
            if key not in cand:
                errs.append(f"missing required key: candidate.{key}")
    return errs


def log_run(run_data: Any) -> None:
    """Append one JSON line describing this pipeline run. Never raises.

    Schema is validated; missing required keys produce a stderr warning and
    are recorded in the line's ``errors`` array, but the line is still
    written so partial data is preserved.
    """
    try:
        if not isinstance(run_data, dict):
            sys.stderr.write(
                f"[run_logger] run_data must be dict, got {type(run_data).__name__}; "
                "skipping log\n"
            )
            return
        # Shallow copy so we can append logger-internal errors without
        # mutating the caller's dict.
        payload = dict(run_data)
        existing_errors = payload.get("errors")
        if not isinstance(existing_errors, list):
            existing_errors = []
        else:
            existing_errors = list(existing_errors)

        validation_errs = _validate(payload)
        for err in validation_errs:
            sys.stderr.write(f"[run_logger] warning: {err}\n")
            existing_errors.append(f"logger: {err}")

        payload["errors"] = existing_errors

        # Default run_id if absent so the line is still queryable.
        if "run_id" not in payload:
            payload["run_id"] = _now_iso()

        try:
            line = json.dumps(payload, default=str, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            sys.stderr.write(f"[run_logger] json.dumps failed: {exc}; skipping log\n")
            return

        path = _resolve_log_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            sys.stderr.write(f"[run_logger] mkdir failed for {path.parent}: {exc}\n")
            return

        # Atomic single-line append: O_APPEND + one write() of full line.
        data = (line + "\n").encode("utf-8")
        try:
            fd = os.open(
                str(path),
                os.O_WRONLY | os.O_APPEND | os.O_CREAT,
                0o644,
            )
        except OSError as exc:
            sys.stderr.write(f"[run_logger] open failed for {path}: {exc}\n")
            return
        try:
            os.write(fd, data)
        except OSError as exc:
            sys.stderr.write(f"[run_logger] write failed for {path}: {exc}\n")
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
    except Exception as exc:  # noqa: BLE001 - logger MUST swallow everything
        sys.stderr.write(f"[run_logger] unexpected error: {exc}\n")
    return None


__all__ = ["log_run", "REQUIRED_KEYS", "DEFAULT_LOG_PATH"]
