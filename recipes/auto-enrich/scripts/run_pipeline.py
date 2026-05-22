"""run_pipeline.py: end-to-end auto-enrich pipeline driver.

For each top-N sensor candidate:
  1. detect_sparse provides the candidate
  2. run_research dispatches Cal and writes a research artifact
  3. quality_check #1 (pre-synthesize): Iron Law + no-fabrication on artifact
  4. synthesize merges artifact into a draft markdown file
  5. quality_check #2 (post-synthesize): Rule #5 lint runs on the draft
  6. If passed: `gbrain put` writes the draft back. Heartbeat appended.
  7. If failed at any step: append issue list to escalations.jsonl. Continue.

Run-mode env toggle:
  CAL_DISPATCH_MODE=mock  -> run_research reads from fixtures (no live Cal)

CLI:
  --limit N                Number of candidates to process (default 5)
  --dry-run                Skip the final gbrain put; everything else runs
  --candidate-pool N       Passed through to detect_sparse

Exit codes:
  0 at least 1 page enriched
  1 candidates returned but all failed
  2 sensor returned 0 candidates
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
import detect_sparse  # noqa: E402
import quality_check  # noqa: E402
import run_research  # noqa: E402
import synthesize as synth_mod  # noqa: E402
from auto_enrich_lib import GBrainCLIError, Heartbeat  # noqa: E402

PIPELINE_VERSION = "0.3.0"
ESCALATIONS_PATH = (
    Path.home() / ".gbrain" / "integrations" / "auto-enrich" / "escalations.jsonl"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_escalation(record: dict[str, Any]) -> None:
    ESCALATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ESCALATIONS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def _gbrain_put(slug: str, draft_path: Path) -> tuple[bool, str]:
    """Call `gbrain put <slug> < draft_path`."""
    import subprocess
    try:
        with draft_path.open("r", encoding="utf-8") as fh:
            proc = subprocess.run(
                [os.environ.get("GBRAIN_BIN", "gbrain"), "put", slug],
                stdin=fh, capture_output=True, text=True,
                timeout=60, check=False,
            )
        if proc.returncode != 0:
            return False, (proc.stderr or proc.stdout or "").strip()
        return True, ""
    except (FileNotFoundError, OSError) as exc:
        return False, str(exc)


_RULE_TO_COUNTER = {
    "iron_law": "gated_iron_law",
    "non_destructive": "gated_non_destructive",
    "lint": "gated_lint",
    "fabricated_command": "gated_fabricated",
}


def _classify_issues(issues: list[dict]) -> dict[str, int]:
    """Bucket blocking issues by counter-key (heartbeat field name)."""
    out: dict[str, int] = {v: 0 for v in _RULE_TO_COUNTER.values()}
    for i in issues:
        if i.get("severity") not in quality_check.BLOCKING:
            continue
        rule = i.get("rule", "")
        ckey = _RULE_TO_COUNTER.get(rule)
        if ckey:
            out[ckey] += 1
    return out


def _run_research_for(candidate: dict, work_dir: Path) -> tuple[int, Path | None]:
    """Dispatch research for one candidate. Returns (exit_code, artifact_path).

    run_research handles the CAL_DISPATCH_MODE=mock env toggle itself; we
    just stage the candidate JSON and pass through.
    """
    slug = candidate.get("slug", "unknown")
    safe_slug = slug.replace("/", "_")
    cand_path = work_dir / f"candidate-{safe_slug}.json"
    art_path = work_dir / f"artifact-{safe_slug}.json"
    cand_path.write_text(json.dumps(candidate), encoding="utf-8")

    rc = run_research.run(str(cand_path), str(art_path))
    if rc != 0:
        return rc, None
    return 0, art_path


def _current_page_safe(slug: str) -> str:
    try:
        page = synth_mod.fetch_page(slug)
    except GBrainCLIError:
        return ""
    return page or ""


def process_candidate(
    candidate: dict,
    work_dir: Path,
    dry_run: bool,
    hb: Heartbeat,
    counters: dict[str, int],
) -> bool:
    """Process one candidate. Returns True on full success (page enriched)."""
    slug = candidate.get("slug", "unknown")

    # Step 1: research
    rc, art_path = _run_research_for(candidate, work_dir)
    if rc != 0 or art_path is None:
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "research",
            "exit_code": rc, "issues": [{"rule": "research_dispatch",
                                          "severity": "high",
                                          "detail": f"run_research exit {rc}"}],
        })
        hb.emit("pipeline_step", status="research_error",
                details={"slug": slug, "exit_code": rc})
        return False
    artifact = json.loads(art_path.read_text())

    # Step 2: pre-synthesize quality check (Iron Law + no-fabrication).
    # Lint is skipped here (no draft yet); we still pass current_page so
    # non-destructive rule is informed (it cannot trigger without a draft
    # narrative anyway, but consistency).
    current_page = _current_page_safe(slug)
    pre_passed, pre_issues = quality_check.check(artifact, current_page, draft_path=None)
    if not pre_passed:
        buckets = _classify_issues(pre_issues)
        for k, v in buckets.items():
            counters[k] += v
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "quality_pre",
            "issues": pre_issues,
        })
        hb.emit("pipeline_step", status="quality_pre_failed",
                details={"slug": slug, "issues_count": len(pre_issues)})
        return False

    # Step 3: synthesize
    draft_path = work_dir / f"draft-{slug.replace('/', '_')}.md"
    try:
        synth_rc = synth_mod.run(
            str(art_path), slug, dry_run=False, draft_out=str(draft_path),
        )
    except Exception as exc:  # noqa: BLE001
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "synthesize",
            "error": str(exc),
        })
        hb.emit("pipeline_step", status="synth_exception",
                details={"slug": slug, "error": str(exc)[:200]})
        return False
    if synth_rc != 0:
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "synthesize",
            "exit_code": synth_rc,
        })
        hb.emit("pipeline_step", status="synth_error",
                details={"slug": slug, "exit_code": synth_rc})
        return False

    # Step 4: post-synthesize quality check (Rule #5 lint).
    post_passed, post_issues = quality_check.check(
        artifact, current_page, draft_path=draft_path,
    )
    if not post_passed:
        buckets = _classify_issues(post_issues)
        for k, v in buckets.items():
            counters[k] += v
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "quality_post",
            "issues": post_issues,
        })
        hb.emit("pipeline_step", status="quality_post_failed",
                details={"slug": slug, "issues_count": len(post_issues)})
        return False

    # Step 5: gbrain put (unless dry-run).
    if dry_run:
        counters["passed_gate"] += 1
        hb.emit("pipeline_step", status="dry_run_passed",
                details={"slug": slug, "draft_path": str(draft_path)})
        return True

    ok, err = _gbrain_put(slug, draft_path)
    if not ok:
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "gbrain_put",
            "error": err,
        })
        hb.emit("pipeline_step", status="gbrain_put_failed",
                details={"slug": slug, "error": err[:200]})
        return False

    counters["passed_gate"] += 1
    hb.emit("pipeline_step", status="enriched",
            details={"slug": slug, "draft_path": str(draft_path)})
    return True


def run(limit: int = 5, dry_run: bool = False, candidate_pool: int | None = None) -> int:
    start = time.time()
    hb = Heartbeat()
    counters = {
        "total_candidates": 0,
        "passed_gate": 0,
        "gated_iron_law": 0,
        "gated_non_destructive": 0,
        "gated_lint": 0,
        "gated_fabricated": 0,
        "escalations_count": 0,
        "runtime_seconds": 0.0,
    }

    cfg = detect_sparse.SensorConfig()
    cfg_path = _SCRIPT_DIR.parent / "config.yaml"
    if cfg_path.exists():
        try:
            cfg = detect_sparse.SensorConfig.from_yaml(cfg_path)
        except Exception:  # noqa: BLE001
            pass
    if candidate_pool is not None:
        cfg.candidate_pool_per_type = candidate_pool

    try:
        candidates = detect_sparse.detect(cfg=cfg, limit=limit)
    except GBrainCLIError as exc:
        hb.emit("pipeline_run", status="sensor_error", error=str(exc))
        return 2
    counters["total_candidates"] = len(candidates)
    if not candidates:
        hb.emit("pipeline_run", status="no_candidates")
        counters["runtime_seconds"] = round(time.time() - start, 3)
        hb.emit("pipeline_run_summary", status="ok", details=counters)
        return 2

    work_dir = Path(os.environ.get("AUTO_ENRICH_WORK", "/tmp")) / "auto-enrich-pipeline"
    work_dir.mkdir(parents=True, exist_ok=True)

    for candidate in candidates:
        process_candidate(candidate, work_dir, dry_run, hb, counters)

    counters["runtime_seconds"] = round(time.time() - start, 3)
    hb.emit("pipeline_run_summary", status="ok", details=counters)

    if counters["passed_gate"] >= 1:
        return 0
    return 1


def main():
    parser = argparse.ArgumentParser(description="Auto-enrich nightly pipeline.")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--candidate-pool", type=int, default=None)
    args = parser.parse_args()
    sys.exit(run(
        limit=args.limit, dry_run=args.dry_run,
        candidate_pool=args.candidate_pool,
    ))


if __name__ == "__main__":
    main()
