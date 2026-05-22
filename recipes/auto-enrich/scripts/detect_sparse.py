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
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Default parallelism for fan-out gbrain subprocess calls. The gbrain CLI is
# fork/exec heavy (Bun + PGLite open per call), so per-call latency is ~0.2s.
# Running candidates serially on a 200-slug pool takes 1-2 minutes; parallel
# fan-out to 16 workers drops that to <15s. Override via env var for tuning.
_SENSOR_PARALLELISM = max(1, int(os.environ.get("AUTO_ENRICH_SENSOR_WORKERS", "16")))

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


# Slug prefixes excluded from enrichment regardless of page_type. These are
# raw imports, source materials, or placeholder pages that the brain stores
# with concept/entity types but are NOT enrichable targets. The auto-enrich
# pipeline is for synthesizing entity pages (person/company/concept) from
# external research, not for refining session archives or YouTube transcripts.
#
# This denylist is the second filter layer on top of page_types. Two layers
# are necessary because real brain data has type-mislabeling: e.g.
# `business/raw/archive-*` slugs carry type=concept but are clearly raw
# imports. The type filter alone cannot catch this; the slug prefix can.
DEFAULT_SLUG_DENYLIST_PREFIXES: tuple[str, ...] = (
    "business/raw/",
    "sources/",
    "archive/",
    "raw/",
    "_archive/",
    "people/0",  # known placeholder/degenerate slug
)


def _slug_is_denylisted(slug: str, denylist: tuple[str, ...]) -> bool:
    """Return True if slug starts with any denylist prefix or contains /archive/ or /raw/ mid-path."""
    for prefix in denylist:
        if slug.startswith(prefix):
            return True
    # Also catch mid-path archive/raw markers (e.g. 'domain/x/archive/foo')
    if "/archive/" in slug or "/raw/" in slug:
        return True
    return False


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
    slug_denylist_prefixes: tuple[str, ...] = field(
        default_factory=lambda: DEFAULT_SLUG_DENYLIST_PREFIXES
    )

    @classmethod
    def from_yaml(cls, path: Path) -> "SensorConfig":
        import yaml

        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        sensor = (data.get("sensor") or {}) if isinstance(data, dict) else {}
        weights = sensor.get("ranking_weights") or {}
        denylist_raw = sensor.get("slug_denylist_prefixes")
        denylist = (
            tuple(str(p) for p in denylist_raw)
            if isinstance(denylist_raw, list)
            else DEFAULT_SLUG_DENYLIST_PREFIXES
        )
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
            slug_denylist_prefixes=denylist,
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
    bootstrap_mode: bool = False,
) -> float:
    body_penalty = _clamp01(1.0 - body_length / max(1, cfg.target_body_length))
    link_penalty = _clamp01(1.0 - inbound_count / max(1, cfg.target_inbound_links))

    if bootstrap_mode:
        # No page in the corpus has last_enriched yet. The age term degenerates
        # to a constant 1.0 across the pool, contributing 0.3 baseline to every
        # candidate and washing out body/link signal. Zero it and renormalize
        # the remaining weights so the score still spans [0, 1].
        denom = cfg.w_body + cfg.w_links
        if denom <= 0:
            return 0.0
        return (cfg.w_body / denom) * body_penalty + (cfg.w_links / denom) * link_penalty

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
    """Gather raw signal for one candidate. Scoring happens in detect() once the
    corpus-level bootstrap flag is known. Returns None on CLI failure for this
    slug so the caller can skip it without aborting the run."""
    try:
        page = run_gbrain(["get", slug])
    except GBrainCLIError:
        return None
    fm, body = parse_frontmatter(page, slug=slug)
    body_length = len(body)

    try:
        backlinks_json = run_gbrain(["backlinks", slug])
        backlinks = json.loads(backlinks_json) if backlinks_json.strip() else []
        if not isinstance(backlinks, list):
            backlinks = []
    except (GBrainCLIError, json.JSONDecodeError):
        backlinks = []

    last_enriched = fm.get("last_enriched") if isinstance(fm, dict) else None
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
        "body_length": body_length,
        "inbound_link_count": len(backlinks),
        "last_enriched": last_enriched,
        "reason": ", ".join(reason_parts) or "above_thresholds",
    }


def detect(*, cfg: SensorConfig, limit: int) -> list[dict[str, Any]]:
    """Enumerate candidates, score them, return top `limit` sorted desc by score.

    Two-pass: gather raw signal for the full candidate set, decide whether the
    run is in bootstrap mode (no page in the pool has `last_enriched`), then
    score with that flag. Bootstrap detection happens at the sensor level so
    every candidate in a given run uses the same scoring regime.

    Subprocess fan-out is parallelized: the per-type `gbrain list` calls and
    the per-candidate `get`+`backlinks` inspections each run on a thread pool
    (worker count from AUTO_ENRICH_SENSOR_WORKERS, default 16). The gbrain CLI
    is fork/exec heavy, so serial fan-out previously dominated wall-clock time
    (1-2 min on a 200-slug pool). Order of evaluation does not affect the
    final ranking: scoring is independent per candidate, results are sorted
    by score at the end, and the seen/denylist filters are deterministic.
    """
    # Phase 1: fetch the per-type candidate lists in parallel. `gbrain list`
    # is one of the slower verbs because it touches the page table; running
    # the 4 page-type queries serially adds ~1s per type for no reason.
    def _list_for_type(page_type: str) -> tuple[str, str]:
        return page_type, run_gbrain(
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

    list_results: list[tuple[str, str]] = []
    if cfg.page_types:
        with ThreadPoolExecutor(max_workers=min(_SENSOR_PARALLELISM, len(cfg.page_types))) as ex:
            # Re-raise the first GBrainCLIError so main() maps to exit code 1
            # rather than returning a partial pool. list() forces evaluation
            # of every future before we proceed.
            list_results = list(ex.map(_list_for_type, cfg.page_types))

    # Phase 2: collect the de-duplicated, denylist-filtered slug set. Order
    # is preserved by walking cfg.page_types in declaration order so the
    # bootstrap-mode decision below is stable across runs.
    targets: list[tuple[str, str]] = []  # (slug, page_type)
    seen: set[str] = set()
    for page_type, tsv in list_results:
        for row in _parse_list_tsv(tsv):
            slug = row["slug"]
            if slug in seen:
                continue
            seen.add(slug)
            if _slug_is_denylisted(slug, cfg.slug_denylist_prefixes):
                continue
            targets.append((slug, row.get("type", page_type)))

    # Phase 3: fan out `_inspect_candidate` (one `get` + one `backlinks` call
    # per slug) across the worker pool. This is the dominant cost on a real
    # brain (200 slugs * 2 calls * ~0.2s = ~80s serial); 16 workers drops
    # that to <10s.
    raw: list[dict[str, Any]] = []
    if targets:
        def _inspect(arg: tuple[str, str]) -> dict[str, Any] | None:
            slug, page_type = arg
            return _inspect_candidate(slug, page_type, cfg)

        with ThreadPoolExecutor(max_workers=min(_SENSOR_PARALLELISM, len(targets))) as ex:
            for entry in ex.map(_inspect, targets):
                if entry is not None:
                    raw.append(entry)

    bootstrap_mode = all(r.get("last_enriched") in (None, "") for r in raw) if raw else False

    candidates: list[dict[str, Any]] = []
    for entry in raw:
        score = compute_score(
            body_length=entry["body_length"],
            inbound_count=entry["inbound_link_count"],
            last_enriched=str(entry["last_enriched"]) if entry["last_enriched"] is not None else None,
            cfg=cfg,
            bootstrap_mode=bootstrap_mode,
        )
        scored = dict(entry)
        scored["score"] = round(score, 6)
        scored["bootstrap_mode"] = bootstrap_mode
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
