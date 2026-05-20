"""detect_sparse.py: rank sparse / orphan / stale entity pages.

Composes the gbrain CLI (no Python client exists):

  gbrain list --type <T> --sort updated_asc --limit <pool>
    -> TSV: slug\\ttype\\tdate\\ttitle

  gbrain get <slug>
    -> markdown: YAML frontmatter between --- fences, then body

  gbrain backlinks <slug>
    -> JSON array of edge records

Scoring is a weighted sum of three [0, 1] penalties:
  - body_length_penalty       (target body length, default 1500 chars)
  - link_starvation_penalty   (target inbound links, default 3)
  - enrichment_age_penalty    (target max age in days, default 90)

Exit codes: 0 success, 1 gbrain CLI error, 2 config parse error.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Allow running both as a script (python detect_sparse.py) and as a module.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
from auto_enrich_lib import (  # noqa: E402
    GBrainCLIError,
    Heartbeat,
    parse_frontmatter,
    run_gbrain,
)

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


@dataclass
class SensorConfig:
    page_types: list[str] = field(
        default_factory=lambda: ["concept", "entity", "person", "company"]
    )
    candidate_pool_per_type: int = 50
    target_body_length: int = 1500
    target_inbound_links: int = 3
    max_enrichment_age_days: int = 90
    w_body: float = 0.4
    w_links: float = 0.3
    w_age: float = 0.3
    max_candidates_per_run: int = 5

    @classmethod
    def from_yaml(cls, path: Path) -> "SensorConfig":
        import yaml

        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        sensor = (data.get("sensor") or {}) if isinstance(data, dict) else {}
        weights = sensor.get("ranking_weights") or {}
        return cls(
            page_types=list(sensor.get("page_types") or cls().page_types),
            candidate_pool_per_type=int(sensor.get("candidate_pool_per_type", 50)),
            target_body_length=int(sensor.get("target_body_length", 1500)),
            target_inbound_links=int(sensor.get("target_inbound_links", 3)),
            max_enrichment_age_days=int(sensor.get("max_enrichment_age_days", 90)),
            w_body=float(weights.get("body", 0.4)),
            w_links=float(weights.get("links", 0.3)),
            w_age=float(weights.get("age", 0.3)),
            max_candidates_per_run=int(sensor.get("max_candidates_per_run", 5)),
        )


def _clamp01(x: float) -> float:
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def compute_score(
    *,
    body_length: int,
    inbound_count: int,
    last_enriched: str | None,
    cfg: SensorConfig,
    now_iso: str | None = None,
) -> float:
    body_penalty = _clamp01(1.0 - body_length / max(1, cfg.target_body_length))
    link_penalty = _clamp01(1.0 - inbound_count / max(1, cfg.target_inbound_links))

    enriched_dt = _parse_iso(last_enriched)
    if enriched_dt is None:
        age_penalty = 1.0
    else:
        now = _parse_iso(now_iso) if now_iso else datetime.now(timezone.utc)
        if now is None:
            now = datetime.now(timezone.utc)
        delta_days = max(0.0, (now - enriched_dt).total_seconds() / 86400.0)
        age_penalty = _clamp01(delta_days / max(1, cfg.max_enrichment_age_days))

    return cfg.w_body * body_penalty + cfg.w_links * link_penalty + cfg.w_age * age_penalty


def _parse_list_tsv(tsv: str) -> list[dict[str, str]]:
    """Parse `gbrain list` TSV output. Columns: slug, type, date, title."""
    rows: list[dict[str, str]] = []
    for line in tsv.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 2:
            continue
        rows.append(
            {
                "slug": cols[0],
                "type": cols[1],
                "date": cols[2] if len(cols) > 2 else "",
                "title": cols[3] if len(cols) > 3 else "",
            }
        )
    return rows


def _inspect_candidate(slug: str, page_type: str, cfg: SensorConfig) -> dict[str, Any] | None:
    try:
        page = run_gbrain(["get", slug])
    except GBrainCLIError:
        return None
    fm, body = parse_frontmatter(page)
    body_length = len(body)

    try:
        backlinks_json = run_gbrain(["backlinks", slug])
        backlinks = json.loads(backlinks_json) if backlinks_json.strip() else []
        if not isinstance(backlinks, list):
            backlinks = []
    except (GBrainCLIError, json.JSONDecodeError):
        backlinks = []

    last_enriched = fm.get("last_enriched") if isinstance(fm, dict) else None
    score = compute_score(
        body_length=body_length,
        inbound_count=len(backlinks),
        last_enriched=str(last_enriched) if last_enriched is not None else None,
        cfg=cfg,
    )
    reason_parts = []
    if body_length < cfg.target_body_length:
        reason_parts.append(f"body={body_length}<{cfg.target_body_length}")
    if len(backlinks) < cfg.target_inbound_links:
        reason_parts.append(f"links={len(backlinks)}<{cfg.target_inbound_links}")
    if last_enriched is None:
        reason_parts.append("never_enriched")
    return {
        "slug": slug,
        "page_type": page_type,
        "score": round(score, 6),
        "body_length": body_length,
        "inbound_link_count": len(backlinks),
        "last_enriched": last_enriched,
        "reason": ", ".join(reason_parts) or "above_thresholds",
    }


def detect(*, cfg: SensorConfig, limit: int) -> list[dict[str, Any]]:
    """Enumerate candidates, score them, return top `limit` sorted desc by score."""
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page_type in cfg.page_types:
        try:
            tsv = run_gbrain(
                [
                    "list",
                    "--type",
                    page_type,
                    "--sort",
                    "updated_asc",
                    "--limit",
                    str(cfg.candidate_pool_per_type),
                ]
            )
        except GBrainCLIError:
            # Re-raise so main() can map to exit code 1 instead of silently empty
            raise
        for row in _parse_list_tsv(tsv):
            slug = row["slug"]
            if slug in seen:
                continue
            seen.add(slug)
            scored = _inspect_candidate(slug, row.get("type", page_type), cfg)
            if scored is not None:
                candidates.append(scored)
    candidates.sort(key=lambda r: r["score"], reverse=True)
    return candidates[:limit]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Detect sparse / orphan / stale brain pages.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument(
        "--types",
        type=str,
        default=None,
        help="Comma-separated page types (default: from config.yaml)",
    )
    parser.add_argument("--candidate-pool", type=int, default=None)
    args = parser.parse_args(argv)

    # Load config
    if args.config.exists():
        try:
            cfg = SensorConfig.from_yaml(args.config)
        except Exception as exc:  # noqa: BLE001
            print(f"config parse error: {exc}", file=sys.stderr)
            sys.exit(2)
    else:
        cfg = SensorConfig()

    if args.types:
        cfg.page_types = [t.strip() for t in args.types.split(",") if t.strip()]
    if args.candidate_pool is not None:
        cfg.candidate_pool_per_type = args.candidate_pool

    limit = args.limit if args.limit is not None else cfg.max_candidates_per_run

    hb = Heartbeat(path=auto_enrich_lib.DEFAULT_HEARTBEAT_PATH)
    try:
        results = detect(cfg=cfg, limit=limit)
    except GBrainCLIError as exc:
        hb.emit("sensor_run", status="error", error=str(exc))
        print(f"gbrain CLI error: {exc}", file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(results, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)

    hb.emit(
        "sensor_run",
        status="ok",
        details={
            "candidates_returned": len(results),
            "page_types": cfg.page_types,
            "pool_per_type": cfg.candidate_pool_per_type,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
